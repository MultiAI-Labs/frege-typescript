import { format, inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  Frege,
  FregeAPIError,
  FregeConnectionError,
  FregeProtocolError,
  FregeTaskError,
  FregeTimeoutError,
  isFregeError,
} from '../src/index.js';
import { apiError, envelope, hangUntilAborted, taskResponse, testClient, toolResponse } from './helpers.js';

describe('error mapping', () => {
  it('maps a validation failure to a typed error with fields and request id', async () => {
    const { frege } = testClient(() =>
      apiError(422, 'validation_failed', 'one or more fields failed validation', {
        fields: { symbol: 'this argument is required by the tool schema' },
        request_id: 'req_abc123',
      }),
    );

    const error = await frege.invoke('place_order').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FregeAPIError);
    const api = error as FregeAPIError;
    expect(api.status).toBe(422);
    expect(api.code).toBe('validation_failed');
    expect(api.isValidationError).toBe(true);
    expect(api.fields).toEqual({ symbol: 'this argument is required by the tool schema' });
    // Support asks for this; losing it costs the customer a support round trip.
    expect(api.requestId).toBe('req_abc123');
  });

  it('flags 401 and 404 through their own predicates', async () => {
    const unauthorized = (await testClient(() => apiError(401, 'unauthorized', 'invalid token'))
      .frege.listOperations()
      .catch((e: unknown) => e)) as FregeAPIError;
    const missing = (await testClient(() => apiError(404, 'not_found', 'no such tool'))
      .frege.invoke('nope')
      .catch((e: unknown) => e)) as FregeAPIError;

    expect(unauthorized.isAuthError).toBe(true);
    expect(missing.isNotFound).toBe(true);
  });

  it('survives an error body that is not a Frege envelope', async () => {
    const { frege } = testClient(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    const error = (await frege.invoke('list_orders').catch((e: unknown) => e)) as FregeAPIError;

    expect(error.status).toBe(502);
    expect(error.code).toBe('unknown');
    expect(error.message).toContain('502 Bad Gateway');
  });

  it('rejects a 2xx body that is not the data envelope, without calling it an API error', async () => {
    // A 200 is not what went wrong here, so this is not a `FregeAPIError` —
    // that class promises Frege answered non-2xx.
    const { frege } = testClient(() => new Response('{"tool_name":"x"}', { status: 200 }));

    const error = (await frege.invoke('list_orders').catch((e: unknown) => e)) as FregeProtocolError;

    expect(error).toBeInstanceOf(FregeProtocolError);
    expect(error).not.toBeInstanceOf(FregeAPIError);
    expect(error.kind).toBe('protocol');
    expect(error.status).toBe(200);
  });

  it('rejects a 2xx that is not JSON at all', async () => {
    // A proxy or a load balancer answering 200 with its own HTML.
    const { frege } = testClient(() => new Response('<html>maintenance</html>', { status: 200 }));

    const error = (await frege.listOperations().catch((e: unknown) => e)) as FregeProtocolError;

    expect(error).toBeInstanceOf(FregeProtocolError);
    expect(error.message).toContain('expected JSON');
  });

  it('never puts the token in the error, its message, or its stack', async () => {
    const { frege } = testClient(() => apiError(401, 'unauthorized', 'the token was rejected'));

    const error = (await frege.invoke('list_orders').catch((e: unknown) => e)) as FregeAPIError;

    const exposed = `${error.message}${String(error.stack)}${JSON.stringify(error)}${String(error)}`;
    expect(exposed).not.toContain('frege_sk_secret_value');
  });

  it('keeps the token out of every way a client can be printed', () => {
    const { frege } = testClient(() => envelope(toolResponse()));

    // `JSON.stringify` alone proves almost nothing here — every field is a
    // `#private` one, so it returns `{"projectId":3,"tasks":{}}` whatever the
    // client holds. These are the ways a token actually reaches a log file.
    const printed = [
      JSON.stringify(frege),
      format('%o', frege),
      format('%j', frege),
      inspect(frege, { depth: 8 }),
      inspect(frege, { depth: 8, showHidden: true }),
      Object.keys(frege).join(','),
      inspect(frege.tasks, { depth: 8, showHidden: true }),
    ].join('\n');

    expect(printed).not.toContain('frege_sk_secret_value');
  });

  it('names each error class as a literal, so a minifier cannot rename it', () => {
    // Sentry and most log aggregators group by `error.name`. Deriving it from
    // the constructor collapses every Frege error into one bucket called "h"
    // in any bundled consumer — which is every browser and edge one.
    const original = Object.getOwnPropertyDescriptor(FregeAPIError, 'name');
    try {
      Object.defineProperty(FregeAPIError, 'name', { value: 'h', configurable: true });
      const minified = new FregeAPIError({ status: 500, code: 'server_error', message: 'boom' });

      expect(minified.name).toBe('FregeAPIError');
      expect(String(minified)).toContain('FregeAPIError:');
    } finally {
      if (original) Object.defineProperty(FregeAPIError, 'name', original);
    }

    expect(new FregeTimeoutError(5).name).toBe('FregeTimeoutError');
    expect(new FregeConnectionError('offline').name).toBe('FregeConnectionError');
    expect(new FregeProtocolError('unreadable').name).toBe('FregeProtocolError');
    expect(
      new FregeTaskError({
        taskId: 't',
        status: 'cancelled',
        terminal: true,
        statusMessage: 'stopped',
        pollIntervalMs: 1000,
        ttlMs: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).name,
    ).toBe('FregeTaskError');
  });

  it('refuses a base URL that would put the key on the wire in cleartext', () => {
    expect(() => new Frege({ projectId: 3, token: 'k', baseUrl: 'http://evil.example' })).toThrow(TypeError);
    expect(() => new Frege({ projectId: 3, token: 'k', baseUrl: 'frege.io' })).toThrow(TypeError);
    // Loopback never leaves the machine, and a local test server needs it.
    expect(() => new Frege({ projectId: 3, token: 'k', baseUrl: 'http://localhost:4000' })).not.toThrow();
  });

  it('refuses a token provider that hands back an empty string', async () => {
    // `Authorization: "Bearer "` earns a 401 nobody can explain.
    const { frege, calls } = testClient(() => envelope(toolResponse()), { token: () => '' });

    await expect(frege.invoke('list_orders')).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it('reports a task that completed carrying no tool result', async () => {
    // `CompletedTask.result` is `unknown` — the SDK's own type says this can
    // happen. Casting it used to surface as a bare TypeError about `body`.
    const { frege } = testClient((_call, index) =>
      index === 0
        ? envelope(taskResponse(), 202)
        : envelope(taskResponse({ status: 'completed', terminal: true, result: undefined })),
    );

    const error = (await frege.invokeAndWait('generate_statement').catch((e: unknown) => e)) as FregeProtocolError;

    expect(error).toBeInstanceOf(FregeProtocolError);
    expect(error.message).toContain('a tool result');
  });

  it('reports a network failure as a connection error', async () => {
    const { frege } = testClient(() => Promise.reject(new TypeError('fetch failed')));

    const error = (await frege.invoke('list_orders').catch((e: unknown) => e)) as FregeConnectionError;

    expect(error).toBeInstanceOf(FregeConnectionError);
    expect(error.kind).toBe('connection');
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it('times a slow call out with the configured budget', async () => {
    const { frege } = testClient(hangUntilAborted, { timeoutMs: 20 });

    const error = (await frege.invoke('slow_report').catch((e: unknown) => e)) as FregeTimeoutError;

    expect(error).toBeInstanceOf(FregeTimeoutError);
    expect(error.timeoutMs).toBe(20);
  });

  it("propagates the caller's own abort rather than dressing it up", async () => {
    const controller = new AbortController();
    const { frege } = testClient(hangUntilAborted);

    const pending = frege.invoke('slow_report', {}, { signal: controller.signal });
    controller.abort(new Error('caller changed their mind'));

    await expect(pending).rejects.toThrow('caller changed their mind');
  });

  it('narrows through the discriminated union', async () => {
    const { frege } = testClient(() => apiError(429, 'too_many_requests', 'slow down', { retryAfter: '2' }));

    const thrown: unknown = await frege.invoke('list_orders').catch((e: unknown) => e);

    expect(isFregeError(thrown)).toBe(true);
    if (!isFregeError(thrown)) throw new Error('unreachable');
    switch (thrown.kind) {
      case 'api':
        expect(thrown.isRateLimited).toBe(true);
        expect(thrown.retryAfterMs).toBe(2000);
        break;
      default:
        throw new Error(`unexpected error kind: ${thrown.kind}`);
    }
  });
});
