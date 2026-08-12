import { checkDuration, type ResolvedConfig } from './config.js';
import { FregeAPIError, FregeConnectionError, FregeProtocolError, FregeTimeoutError, isFregeError } from './errors.js';
import { sleep, unrefTimer } from './sleep.js';

/** Per-call overrides accepted by every method on the client. */
export interface RequestOptions {
  /** Cancel the call — and any backoff sleep it is in the middle of. */
  signal?: AbortSignal;
  /**
   * Budget for ONE attempt, overriding the client's own. Retries each get a
   * fresh one, so this is not a ceiling on the call — see `totalTimeoutMs`.
   */
  timeoutMs?: number;
  /**
   * Budget for the WHOLE call: every attempt and every backoff between them.
   * Unset by default, which is why `timeoutMs: 50` on a call that retries twice
   * can still take a second and a half.
   */
  totalTimeoutMs?: number;
}

type Query = Record<string, string | number | undefined>;

interface Send {
  method: 'GET' | 'POST';
  path: string;
  query?: Query;
  body?: unknown;
}

/** One round trip: a decoded payload, or the error that might be retried. */
type Attempt = { value: unknown } | { error: FregeAPIError | FregeConnectionError };

/** Beyond this the doubling stops mattering and starts overflowing to Infinity. */
const MAX_BACKOFF_EXPONENT = 31;

/** JSON transport for one Frege environment: envelope, retries, timeouts. */
export class HttpClient {
  readonly #config: ResolvedConfig;

  constructor(config: ResolvedConfig) {
    this.#config = config;
  }

  /** The client-wide per-attempt budget, for callers that stack their own. */
  get timeoutMs(): number {
    return this.#config.timeoutMs;
  }

  /** Answers `unknown` on purpose: nothing here has seen the payload's shape. */
  async get(path: string, query: Query, options: RequestOptions = {}): Promise<unknown> {
    return this.#send({ method: 'GET', path, query }, options);
  }

  async post(path: string, body: unknown, options: RequestOptions = {}): Promise<unknown> {
    return this.#send({ method: 'POST', path, body }, options);
  }

  async #send(req: Send, options: RequestOptions): Promise<unknown> {
    // Only GETs are retried, and every GET on this API is a plain read.
    //
    // `invoke` and `cancel` are POSTs and are NEVER retried automatically: an
    // invoke spends a real credential against a real third-party API and can
    // move money, place an order, or send a message. A retry that the caller
    // did not ask for could do it twice.
    const maxAttempts = req.method === 'GET' ? this.#config.retry.maxRetries + 1 : 1;

    const perAttemptMs = checkDuration(options.timeoutMs ?? this.#config.timeoutMs, 'timeoutMs', { min: 1 });
    const totalMs =
      options.totalTimeoutMs === undefined
        ? undefined
        : checkDuration(options.totalTimeoutMs, 'totalTimeoutMs', { min: 1 });
    const startedAt = Date.now();
    const deadline = totalMs === undefined ? Infinity : startedAt + totalMs;

    for (let attempt = 0; ; attempt++) {
      if (totalMs !== undefined && Date.now() >= deadline) {
        throw new FregeTimeoutError(totalMs, 'request', Date.now() - startedAt);
      }
      // An attempt never outlives the whole call's budget.
      let outcome: Attempt;
      try {
        outcome = await this.#attempt(req, options, Math.min(perAttemptMs, deadline - Date.now()));
      } catch (err) {
        // The attempt was cut short by what was left of the whole-call budget,
        // so report that budget and the time really spent — not the slice this
        // one attempt happened to get.
        if (totalMs !== undefined && isFregeError(err) && err.kind === 'timeout' && Date.now() >= deadline) {
          throw new FregeTimeoutError(totalMs, 'request', Date.now() - startedAt);
        }
        throw err;
      }
      if ('value' in outcome) return outcome.value;

      const isLast = attempt >= maxAttempts - 1;
      const delay = isLast ? undefined : this.#retryDelay(outcome.error, attempt);
      // Out of budget: the error we already have says more about what went
      // wrong than a timeout would, so it is what the caller gets.
      if (delay === undefined || Date.now() + delay >= deadline) throw outcome.error;
      await sleep(delay, options.signal);
    }
  }

  async #attempt(req: Send, options: RequestOptions, timeoutMs: number): Promise<Attempt> {
    const url = this.#config.baseUrl + req.path + encodeQuery(req.query);
    // Resolved per attempt so a rotating token stays valid across backoff.
    const token = await this.#config.getToken();
    // A provider that hands back '' would send `Authorization: Bearer ` and earn
    // a 401 nobody can explain. The constructor rejects an empty literal token
    // for the same reason; a function has to be checked where it is called.
    if (typeof token !== 'string' || token === '') {
      throw new TypeError('frege: the token provider returned an empty token');
    }
    const link = linkSignals(timeoutMs, options.signal);

    try {
      const response = await this.#config.fetch(url, {
        method: req.method,
        headers: {
          ...this.#config.headers,
          ...(req.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          // Last, and never from caller-supplied headers: the token source is
          // the only authority for this one.
          Authorization: `Bearer ${token}`,
        },
        signal: link.signal,
        ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      });

      if (response.ok) return { value: await unwrapEnvelope(response) };
      return { error: await toAPIError(response) };
    } catch (err) {
      // The caller's abort reason is theirs, and is handed back untouched:
      // `abort('stop')` throws 'stop', not something dressed up as an Error.
      if (options.signal?.aborted) throw options.signal.reason;
      // A timeout is the caller's own budget. Retrying one would quietly spend
      // that budget two more times, so it is reported instead.
      if (link.timedOut) throw new FregeTimeoutError(timeoutMs);
      // A response that decoded badly is our own complaint about the payload,
      // not a failure to reach the server — do not relabel it as one.
      if (isFregeError(err)) throw err;
      // A request that never got an answer: DNS, TLS, a reset mid-flight.
      // Retryable for a GET, since nothing upstream can have happened twice.
      return { error: new FregeConnectionError(`could not reach ${this.#config.baseUrl}`, { cause: err }) };
    } finally {
      link.dispose();
    }
  }

  /** How long to wait before the next attempt, or `undefined` to give up. */
  #retryDelay(error: FregeAPIError | FregeConnectionError, attempt: number): number | undefined {
    if (error.kind === 'api') {
      // 429 and 5xx are the only statuses worth trying again: a 4xx will fail
      // identically no matter how long we wait.
      if (error.status !== 429 && error.status < 500) return undefined;
      if (error.retryAfterMs !== undefined) {
        // Honour the server's own number, but do not disappear for a minute
        // inside a call. Past the cap the 429 is thrown, carrying retryAfterMs,
        // so the caller can schedule the work themselves.
        return error.retryAfterMs > this.#config.retry.maxRetryAfterMs ? undefined : error.retryAfterMs;
      }
    }
    const { baseDelayMs, maxDelayMs } = this.#config.retry;
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt, MAX_BACKOFF_EXPONENT));
    // Full jitter: clients that failed together must not come back together.
    return Math.random() * ceiling;
  }
}

/** `{"data": …}` in, payload out. A 204 or an empty body yields `undefined`. */
async function unwrapEnvelope(response: Response): Promise<unknown> {
  const text = await response.text();
  if (response.status === 204 || text.trim() === '') return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FregeProtocolError('the server did not answer with a Frege envelope (expected JSON)', response.status);
  }
  if (typeof parsed !== 'object' || parsed === null || !('data' in parsed)) {
    throw new FregeProtocolError(
      'the server did not answer with a Frege envelope (expected a {"data": …} object)',
      response.status,
    );
  }
  return parsed.data;
}

async function toAPIError(response: Response): Promise<FregeAPIError> {
  const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
  const text = await response.text().catch(() => '');

  let payload: Partial<WireErrorPayload> = {};
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === 'object' && body !== null && 'error' in body) {
      payload = (body as { error: Partial<WireErrorPayload> }).error;
    }
  } catch {
    // A gateway or a proxy can answer in HTML. Falls through to the raw text
    // below, which is more useful than "unknown error".
  }

  // A body that carried no message at all still has to say something useful.
  const fallback = text.trim().slice(0, 500) || response.statusText;

  return new FregeAPIError({
    status: response.status,
    code: payload.code ?? 'unknown',
    message: payload.message ?? fallback,
    fields: payload.fields,
    requestId: payload.request_id,
    retryAfterMs,
  });
}

interface WireErrorPayload {
  code: string;
  message: string;
  fields?: Record<string, string>;
  request_id?: string;
}

/** `Retry-After` is either delta-seconds or an HTTP date; both are accepted. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  // Digits only. `Number` would read the non-standard `1e3` as 1,000,000ms.
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function encodeQuery(query: Query | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

interface LinkedSignal {
  signal: AbortSignal;
  /** True when the timeout — not the caller — is what aborted. */
  timedOut: boolean;
  dispose(): void;
}

/**
 * One signal that fires on either the timeout or the caller's own signal.
 *
 * `AbortSignal.any` would do this in a line, but it only arrived in Node 20 and
 * this package supports 18.
 */
function linkSignals(timeoutMs: number, external: AbortSignal | undefined): LinkedSignal {
  const controller = new AbortController();
  const link: LinkedSignal = {
    signal: controller.signal,
    timedOut: false,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };

  const timer = setTimeout(() => {
    link.timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Safe to unref: this timer only watches a fetch that is already holding the
  // process open. Unlike a backoff sleep, it is never the work itself.
  unrefTimer(timer);

  const onExternalAbort = () => {
    controller.abort(external?.reason);
  };
  if (external?.aborted) onExternalAbort();
  else external?.addEventListener('abort', onExternalAbort, { once: true });

  return link;
}
