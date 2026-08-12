import { Frege, type FetchLike, type FregeOptions } from '../src/index.js';

export interface RecordedCall {
  url: string;
  init: RequestInit;
  /** Parsed request body, for the POSTs. */
  body: Record<string, unknown> | undefined;
}

export type Handler = (call: RecordedCall, index: number) => Response | Promise<Response>;

export interface TestClient {
  frege: Frege;
  calls: RecordedCall[];
}

/**
 * A client whose only I/O is the handler you pass. Nothing here touches the
 * network, and retry delays are zeroed so the suite stays fast.
 */
export function testClient(handler: Handler, options: Partial<FregeOptions> = {}): TestClient {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = (url, init) => {
    const call: RecordedCall = {
      url,
      init,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
    calls.push(call);
    return Promise.resolve(handler(call, calls.length - 1));
  };

  const frege = new Frege({
    projectId: 3,
    token: 'frege_sk_secret_value',
    baseUrl: 'https://frege.test',
    retry: { baseDelayMs: 0, maxDelayMs: 0 },
    ...options,
    fetch,
  });

  return { frege, calls };
}

/** A `{"data": …}` success envelope, the shape every Frege 2xx uses. */
export function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A Frege error envelope. */
export function apiError(
  status: number,
  code: string,
  message: string,
  extra: { fields?: Record<string, string>; request_id?: string; retryAfter?: string } = {},
): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (extra.retryAfter !== undefined) headers['Retry-After'] = extra.retryAfter;
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
        ...(extra.fields ? { fields: extra.fields } : {}),
        ...(extra.request_id ? { request_id: extra.request_id } : {}),
      },
    }),
    { status, headers },
  );
}

/** The wire shape of a tool invocation result: note `body` is a JSON string. */
export function toolResponse(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    tool_name: 'get_account_profile',
    method: 'GET',
    url: 'https://api.broker.example/v1/accounts/me',
    status_code: 200,
    body: JSON.stringify({ account_id: 'A-1', cash: 1234.56 }),
    ...overrides,
  };
}

/** The wire shape of a task. */
export function taskResponse(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    task_id: 'tsk_1',
    status: 'working',
    status_message: 'calling the upstream',
    tool_name: 'list_orders',
    poll_interval_ms: 1,
    ttl_ms: 300000,
    terminal: false,
    created_at: '2026-08-12T10:00:00Z',
    updated_at: '2026-08-12T10:00:01Z',
    ...overrides,
  };
}

/** A fetch that never answers until the request is aborted. */
export const hangUntilAborted: Handler = (call) =>
  new Promise<Response>((_resolve, reject) => {
    const abort = () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    // A signal can arrive already aborted; `fetch` rejects straight away then.
    if (call.init.signal?.aborted) abort();
    else call.init.signal?.addEventListener('abort', abort, { once: true });
  });
