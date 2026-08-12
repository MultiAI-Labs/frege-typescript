import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Frege,
  FregeProtocolError,
  FregeTimeoutError,
  type FregeAPIError,
  type FregeOptions,
  type Operation,
} from '../src/index.js';
import { sleep } from '../src/sleep.js';
import { apiError, envelope, hangUntilAborted, testClient, type Handler } from './helpers.js';

const operation = {
  id: 'getAccountProfile',
  tool_name: 'get_account_profile',
  method: 'GET',
  path: '/accounts/me',
  summary: 'The signed-in account',
  description: '',
  tags: ['accounts'],
  input_schema: { type: 'object', properties: {} },
};

/**
 * The gaps between attempts, in milliseconds, on a fake clock.
 *
 * The suite pins `baseDelayMs: 0` everywhere else so it stays fast, which means
 * the backoff arithmetic is never executed with real values. Everything below
 * runs it with real values and measures what a caller would actually wait:
 * delete the doubling, the cap, the jitter, or `Retry-After`, and one of these
 * fails.
 */
async function attemptGaps(retry: NonNullable<FregeOptions['retry']>, handler: Handler): Promise<number[]> {
  vi.useFakeTimers();
  try {
    const at: number[] = [];
    const { frege } = testClient(
      (call, index) => {
        at.push(Date.now());
        return handler(call, index);
      },
      { retry, timeoutMs: 60_000 },
    );

    const pending = frege.listOperations();
    await vi.runAllTimersAsync();
    await pending;

    return at.slice(1).map((stamp, i) => stamp - (at[i] ?? 0));
  } finally {
    vi.useRealTimers();
  }
}

/** Fails `count` times with `first`, then succeeds. */
const failThen =
  (count: number, first: () => Response): Handler =>
  (_call, index) =>
    index < count ? first() : envelope([]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('retry policy', () => {
  it('retries an idempotent GET through 5xx and returns the eventual success', async () => {
    const { frege, calls } = testClient((_call, index) =>
      index < 2 ? apiError(503, 'server_error', 'temporarily unavailable') : envelope([operation]),
    );

    const operations = await frege.listOperations();

    expect(calls).toHaveLength(3);
    expect(operations[0]?.toolName).toBe('get_account_profile');
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const { frege, calls } = testClient(() => apiError(500, 'server_error', 'boom'), {
      retry: { maxRetries: 1, baseDelayMs: 0 },
    });

    await expect(frege.listOperations()).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 4xx that is not 429 — the answer will not change', async () => {
    const { frege, calls } = testClient(() => apiError(403, 'forbidden', 'no access to this project'));

    await expect(frege.listOperations()).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(1);
  });

  it('retries a 429', async () => {
    const { frege, calls } = testClient((_call, index) =>
      index === 0 ? apiError(429, 'too_many_requests', 'slow down') : envelope([]),
    );

    await frege.listOperations();

    expect(calls).toHaveLength(2);
  });

  it('surfaces a 429 instead of sleeping through a Retry-After longer than the cap', async () => {
    // Better to hand the caller a 429 carrying retryAfterMs than to hold their
    // process for a minute inside what looked like a fast call.
    const { frege, calls } = testClient(() => apiError(429, 'too_many_requests', 'slow down', { retryAfter: '60' }), {
      retry: { maxRetryAfterMs: 1000, baseDelayMs: 0 },
    });

    const error = (await frege.listOperations().catch((e: unknown) => e)) as FregeAPIError;

    expect(calls).toHaveLength(1);
    expect(error.retryAfterMs).toBe(60_000);
  });

  it('retries a GET that never got an answer at all', async () => {
    const { frege, calls } = testClient((_call, index) =>
      index === 0 ? Promise.reject(new TypeError('fetch failed')) : envelope([]),
    );

    await frege.listOperations();

    expect(calls).toHaveLength(2);
  });

  it('never retries cancel — a second one would 404 on a task that just settled', async () => {
    const { frege, calls } = testClient(() => apiError(503, 'server_error', 'temporarily unavailable'));

    await expect(frege.tasks.cancel('tsk_1')).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
  });

  it('does not retry a timeout — that budget belongs to the caller', async () => {
    const { frege, calls } = testClient(hangUntilAborted, { timeoutMs: 20 });

    await expect(frege.listOperations()).rejects.toMatchObject({ kind: 'timeout' });
    expect(calls).toHaveLength(1);
  });
});

describe('backoff arithmetic', () => {
  it('doubles the delay per attempt and stops at maxDelayMs', async () => {
    // Full jitter at its ceiling, so the schedule itself is what is measured.
    vi.spyOn(Math, 'random').mockReturnValue(1);

    const gaps = await attemptGaps(
      { maxRetries: 4, baseDelayMs: 100, maxDelayMs: 400 },
      failThen(4, () => apiError(503, 'server_error', 'temporarily unavailable')),
    );

    expect(gaps).toEqual([100, 200, 400, 400]);
  });

  it('spreads each delay across the whole window below its ceiling', async () => {
    // Clients that failed together must not come back together: the delay is a
    // random point in [0, ceiling), not the ceiling itself.
    vi.spyOn(Math, 'random').mockReturnValue(0.25);

    const gaps = await attemptGaps(
      { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 8_000 },
      failThen(2, () => apiError(503, 'server_error', 'temporarily unavailable')),
    );

    expect(gaps).toEqual([25, 50]);
  });

  it('sleeps the Retry-After the server asked for, not its own backoff', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);

    const gaps = await attemptGaps(
      { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 8_000, maxRetryAfterMs: 30_000 },
      failThen(1, () => apiError(429, 'too_many_requests', 'slow down', { retryAfter: '2' })),
    );

    expect(gaps).toEqual([2000]);
  });

  it('sleeps until an HTTP-date Retry-After', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);

    const gaps = await attemptGaps({ maxRetries: 1, baseDelayMs: 100, maxDelayMs: 8_000 }, (_call, index) =>
      index === 0
        ? apiError(429, 'too_many_requests', 'slow down', {
            retryAfter: new Date(Date.now() + 3000).toUTCString(),
          })
        : envelope([]),
    );

    // The date has second resolution, so the sleep lands within a second of it.
    expect(gaps[0]).toBeGreaterThan(2000);
    expect(gaps[0]).toBeLessThanOrEqual(3000);
  });

  it('ignores a Retry-After that is not delta-seconds or a date', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);

    // `Number('1e3')` is finite: read as delta-seconds it would sleep for 16
    // minutes. It is not a legal Retry-After, so the normal backoff applies.
    const gaps = await attemptGaps(
      { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 8_000 },
      failThen(1, () => apiError(503, 'server_error', 'slow down', { retryAfter: '1e3' })),
    );

    expect(gaps).toEqual([100]);
  });

  it('holds the event loop open while it backs off, but not while a fetch is in flight', async () => {
    const created: ReturnType<typeof setTimeout>[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, delay?: number) => {
      const timer = real(handler, delay);
      created.push(timer);
      return timer;
    }) as typeof setTimeout);
    const refd = (timer: ReturnType<typeof setTimeout> | undefined) =>
      typeof timer === 'object' && timer !== null && 'hasRef' in timer ? timer.hasRef() : undefined;

    // A backoff sleep IS the work someone is awaiting. Unref'ing it lets Node
    // drain and exit mid-retry: the promise never settles, nothing is logged,
    // and the exit code is 0 — a dropped call that looks like a successful one.
    const pending = sleep(5, undefined);
    expect(refd(created.at(-1))).toBe(true);
    await pending;

    // The request-timeout timer only watches a fetch that is already holding
    // the process open, so that one is right to unref.
    let duringFetch: boolean | undefined;
    const { frege } = testClient(
      () => {
        duringFetch = refd(created.at(-1));
        return envelope([]);
      },
      { timeoutMs: 30_000 },
    );

    await frege.listOperations();

    expect(duringFetch).toBe(false);
  });
});

describe('the whole-call budget', () => {
  it('stops retrying once totalTimeoutMs is gone and hands back the last real error', async () => {
    // `timeoutMs` is one attempt. Without `totalTimeoutMs` a 50ms per-attempt
    // budget could still take a second and a half across three tries.
    const { frege, calls } = testClient(() => apiError(503, 'server_error', 'still down'), {
      timeoutMs: 1000,
      retry: { maxRetries: 20, baseDelayMs: 40, maxDelayMs: 40 },
    });

    const startedAt = Date.now();
    const error = (await frege.listOperations({ totalTimeoutMs: 150 }).catch((e: unknown) => e)) as FregeAPIError;
    const took = Date.now() - startedAt;

    expect(error.status).toBe(503);
    expect(took).toBeLessThan(400);
    expect(calls.length).toBeLessThan(21);
  });

  it('cuts an in-flight attempt short at the whole-call budget', async () => {
    // Without this the per-attempt budget wins and a 40ms ceiling waits 5s.
    const { frege } = testClient(hangUntilAborted, { timeoutMs: 5_000 });

    const startedAt = Date.now();
    const error = (await frege.listOperations({ totalTimeoutMs: 40 }).catch((e: unknown) => e)) as FregeTimeoutError;

    expect(error).toBeInstanceOf(FregeTimeoutError);
    expect(error.timeoutMs).toBe(40);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(error.message).toContain('timed out after');
  });

  it('reports a timeout when the budget runs out inside the backoff', async () => {
    // A controlled clock, because this is about wall time rather than timers:
    // the attempt eats most of the budget and the sleep overruns the rest.
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) =>
      realSetTimeout(() => {
        now += 60; // the sleep took longer than it was asked for
        fn();
      }, ms)) as typeof setTimeout);

    const { frege } = testClient(
      () => {
        now += 95;
        return apiError(503, 'server_error', 'slow and down');
      },
      { timeoutMs: 1000, retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 1 } },
    );

    const error = (await frege.listOperations({ totalTimeoutMs: 100 }).catch((e: unknown) => e)) as FregeTimeoutError;

    expect(error).toBeInstanceOf(FregeTimeoutError);
    expect(error.timeoutMs).toBe(100);
    expect(error.elapsedMs).toBeGreaterThanOrEqual(100);
  });
});

describe('retry configuration', () => {
  // `retry: { maxRetries: Number(process.env.FREGE_RETRIES) }` with the variable
  // unset used to mean `attempt >= NaN - 1`, which is false forever: one 503
  // became thousands of requests a second against Frege.
  it.each([
    ['maxRetries', { maxRetries: Number.NaN }],
    ['a negative maxRetries', { maxRetries: -1 }],
    ['a fractional maxRetries', { maxRetries: 1.5 }],
    ['an absurd maxRetries', { maxRetries: 1_000_000 }],
    ['baseDelayMs', { baseDelayMs: Number.NaN }],
    ['maxDelayMs', { maxDelayMs: Number.POSITIVE_INFINITY }],
    ['maxRetryAfterMs', { maxRetryAfterMs: -5 }],
  ])('refuses %s at construction rather than at 4000 requests a second', (_name, retry) => {
    expect(() => new Frege({ projectId: 3, token: 'k', retry })).toThrow(TypeError);
  });

  it('refuses a timeout that is not a positive number', () => {
    expect(() => new Frege({ projectId: 3, token: 'k', timeoutMs: Number.NaN })).toThrow(TypeError);
    expect(() => new Frege({ projectId: 3, token: 'k', timeoutMs: 0 })).toThrow(TypeError);
  });
});

describe('operations', () => {
  it('sends limit and offset only when asked for', async () => {
    const { frege, calls } = testClient(() => envelope([operation]));

    await frege.listOperations();
    await frege.listOperations({ limit: 50, offset: 100 });

    expect(calls[0]?.url).toBe('https://frege.test/v1/projects/3/operations');
    expect(calls[1]?.url).toBe('https://frege.test/v1/projects/3/operations?limit=50&offset=100');
  });

  it('maps the wire shape into camelCase and fills the absent fields', async () => {
    const { frege } = testClient(() => envelope([{ id: 'x', tool_name: 'list_orders', method: 'GET', path: '/o' }]));

    const [op] = await frege.listOperations();

    expect(op).toEqual({
      id: 'x',
      toolName: 'list_orders',
      method: 'GET',
      path: '/o',
      summary: '',
      description: '',
      tags: [],
      inputSchema: {},
    });
  });

  it('pages until an empty page ends the walk', async () => {
    const page = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => ({ ...operation, id: `op-${String(from + i)}` }));
    const { frege, calls } = testClient((_call, index) =>
      envelope(index === 0 ? page(2, 0) : index === 1 ? page(1, 2) : []),
    );

    const seen: Operation[] = [];
    for await (const op of frege.iterateOperations({ pageSize: 2 })) seen.push(op);

    expect(seen.map((op) => op.id)).toEqual(['op-0', 'op-1', 'op-2']);
    expect(calls[1]?.url).toContain('offset=2');
    expect(calls[2]?.url).toContain('offset=3');
  });

  it('walks past the server page cap instead of stopping at it', async () => {
    // The server clamps `limit` to 500 without saying so. Treating that short
    // page as the end of the list truncated a 900-operation spec at 500 and
    // reported success.
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ ...operation, id: `op-${String(i)}` }));
    const { frege, calls } = testClient((_call, index) =>
      envelope(index === 0 ? page(500) : index === 1 ? page(400) : []),
    );

    const seen: Operation[] = [];
    for await (const op of frege.iterateOperations({ pageSize: 1000 })) seen.push(op);

    expect(seen).toHaveLength(900);
    // Clamped to the documented cap, so the request matches what the server does.
    expect(calls[0]?.url).toContain('limit=500');
    expect(calls[1]?.url).toContain('offset=500');
  });

  it('rejects a list endpoint that answers something other than a list', async () => {
    // `{"data": null}` used to be cast straight to an array: the caller got
    // `TypeError: Cannot read properties of null (reading 'map')`, from inside
    // this SDK, with nothing saying which call produced it.
    const { frege } = testClient(() => envelope(null));

    const error = (await frege.listOperations().catch((e: unknown) => e)) as FregeProtocolError;

    expect(error).toBeInstanceOf(FregeProtocolError);
    expect(error.kind).toBe('protocol');
    expect(error.message).toContain('a list of operations');
  });
});
