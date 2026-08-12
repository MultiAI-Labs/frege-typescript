import { VERSION } from './version.js';

/** Frege production. */
export const DEFAULT_BASE_URL = 'https://frege.io';
/** Frege dev. Same API, separate world: separate projects, keys and clients. */
export const DEV_BASE_URL = 'https://frege.uz';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Supplies the bearer token for each request.
 *
 * Called before every attempt, so a rotating credential (a short-lived user
 * access token, a secret fetched from a vault) can be handed over as a function
 * and stay fresh without rebuilding the client.
 */
export type TokenProvider = () => string | Promise<string>;

/**
 * The subset of `fetch` this SDK uses. `globalThis.fetch` satisfies it, and so
 * does any stand-in you pass for tests, tracing, or a proxy agent.
 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** How idempotent reads back off when Frege is busy or broken. */
export interface RetryOptions {
  /** Extra attempts after the first. Default 2 (so 3 attempts at most). */
  maxRetries?: number;
  /** First backoff step, doubled per attempt. Default 250ms. */
  baseDelayMs?: number;
  /** Ceiling for one backoff step. Default 8000ms. */
  maxDelayMs?: number;
  /**
   * Longest `Retry-After` this SDK will sleep through. Beyond it the 429 is
   * thrown instead, carrying `retryAfterMs`, so a caller can schedule the work
   * rather than have a process held hostage. Default 30000ms.
   */
  maxRetryAfterMs?: number;
}

export interface FregeOptions {
  /**
   * Which project's tools to call. It is the number in the dashboard URL, and
   * a project API key is bound to exactly one of them.
   */
  projectId: number;

  /**
   * A project API key (`frege_sk_…`) or a user access token — or a function
   * returning one, for credentials that rotate.
   *
   * Treat a key like a password: whoever holds it can run that project's tools.
   * This SDK never logs it, never puts it in an error, and never sends it
   * anywhere but the `Authorization` header of `baseUrl`.
   */
  token: string | TokenProvider;

  /**
   * Defaults to {@link DEFAULT_BASE_URL}. Trailing slashes are trimmed.
   *
   * Must be `https`, because the bearer token is sent on every request. The one
   * exception is a loopback host (`localhost`, `127.0.0.1`, `[::1]`), where
   * plain `http` never leaves the machine — that is what a local test server
   * and a recorded-fixture proxy need.
   */
  baseUrl?: string;

  /** Per-attempt budget in milliseconds. Default 30000. */
  timeoutMs?: number;

  /** Override the `fetch` implementation. Defaults to the global one. */
  fetch?: FetchLike;

  /** Retry policy for idempotent reads. Writes are never retried. */
  retry?: RetryOptions;

  /** Extra headers on every request. `Authorization` cannot be overridden. */
  headers?: Record<string, string>;
}

export interface ResolvedConfig {
  baseUrl: string;
  getToken: TokenProvider;
  fetch: FetchLike;
  timeoutMs: number;
  headers: Record<string, string>;
  retry: Required<RetryOptions>;
}

export function resolveConfig(options: FregeOptions): ResolvedConfig {
  if (!Number.isInteger(options.projectId) || options.projectId <= 0) {
    throw new TypeError('frege: projectId must be a positive integer');
  }
  if (typeof options.token !== 'function' && !options.token) {
    throw new TypeError('frege: a token is required (a project API key, or a function returning one)');
  }

  // Typed as possibly absent on purpose: the types promise a global `fetch`,
  // but Node 16 and older browsers do not have one, and a missing-function
  // TypeError at the first call is a worse message than the one below.
  const fetchImpl: FetchLike | undefined = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new TypeError('frege: no global fetch found — use Node 18+, or pass { fetch }');
  }

  const token = options.token;
  return {
    baseUrl: checkBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL),
    getToken: typeof token === 'function' ? token : () => token,
    // Bound so a caller-supplied `fetch` and the global one behave the same;
    // an unbound globalThis.fetch throws "Illegal invocation" in browsers.
    fetch: fetchImpl === globalThis.fetch ? fetchImpl.bind(globalThis) : fetchImpl,
    timeoutMs: checkDuration(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs', { min: 1 }),
    headers: {
      Accept: 'application/json',
      // Forbidden in browsers, where fetch drops it silently. Everywhere else
      // it is how support pins a call down to a build.
      'User-Agent': `frege-typescript/${VERSION}`,
      ...options.headers,
    },
    retry: {
      // Nothing here may be NaN or negative. `maxRetries: NaN` used to make
      // `attempt >= NaN - 1` false forever: an unset `Number(process.env.X)`
      // turned one 503 into thousands of requests a second against Frege.
      maxRetries: checkCount(options.retry?.maxRetries ?? 2, 'retry.maxRetries'),
      baseDelayMs: checkDuration(options.retry?.baseDelayMs ?? 250, 'retry.baseDelayMs'),
      maxDelayMs: checkDuration(options.retry?.maxDelayMs ?? 8_000, 'retry.maxDelayMs'),
      maxRetryAfterMs: checkDuration(options.retry?.maxRetryAfterMs ?? 30_000, 'retry.maxRetryAfterMs'),
    },
  };
}

/** A finite, non-negative number of milliseconds. */
export function checkDuration(value: number, name: string, opts: { min?: number } = {}): number {
  const min = opts.min ?? 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new TypeError(`frege: ${name} must be a finite number >= ${String(min)} (got ${String(value)})`);
  }
  return value;
}

/** A non-negative whole number, small enough that a human meant it. */
function checkCount(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new TypeError(`frege: ${name} must be a whole number between 0 and 100 (got ${String(value)})`);
  }
  return value;
}

/**
 * The token rides on every request to this origin, so cleartext is not a
 * configuration choice a caller gets to make by accident.
 */
function checkBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError(`frege: baseUrl must be an absolute URL (got ${JSON.stringify(raw)})`);
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new TypeError(
      `frege: baseUrl must be https — the API key is sent on every request (got ${JSON.stringify(raw)})`,
    );
  }
  return raw.replace(/\/+$/, '');
}
