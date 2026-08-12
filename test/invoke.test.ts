import { describe, expect, it } from 'vitest';
import { Frege } from '../src/index.js';
import { apiError, envelope, testClient, toolResponse } from './helpers.js';

describe('invoke', () => {
  it('posts to the tool path and unwraps the data envelope', async () => {
    const { frege, calls } = testClient(() => envelope(toolResponse()));

    const result = await frege.invoke('get_account_profile');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://frege.test/v1/projects/3/tools/get_account_profile/invoke');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ arguments: {} });
    expect(result.toolName).toBe('get_account_profile');
    expect(result.url).toBe('https://api.broker.example/v1/accounts/me');
  });

  it('parses the upstream body, which arrives as a JSON string', async () => {
    interface Account {
      account_id: string;
      cash: number;
    }
    const { frege } = testClient(() => envelope(toolResponse()));

    const result = await frege.invoke<Account>('get_account_profile');

    expect(result.raw).toBe('{"account_id":"A-1","cash":1234.56}');
    expect(result.data).toEqual({ account_id: 'A-1', cash: 1234.56 });
    // `data` is `Account | string | undefined`, because a 204 and an HTML error
    // page are both real answers. The compiler makes the caller look first.
    if (typeof result.data !== 'object') throw new Error('expected the parsed account');
    expect(result.data.cash).toBe(1234.56);
  });

  it('hands back the raw text when the upstream body is not JSON', async () => {
    const { frege } = testClient(() => envelope(toolResponse({ status_code: 502, body: '<html>Bad Gateway</html>' })));

    const result = await frege.invoke('list_orders');

    expect(result.data).toBe('<html>Bad Gateway</html>');
    expect(result.raw).toBe('<html>Bad Gateway</html>');
  });

  it('keeps an empty upstream body from becoming a parse error', async () => {
    const { frege } = testClient(() => envelope(toolResponse({ status_code: 204, body: '' })));

    const result = await frege.invoke('cancel_order');

    expect(result.status).toBe(204);
    expect(result.data).toBeUndefined();
    expect(result.raw).toBe('');
  });

  it('reports an upstream refusal inside a successful Frege call', async () => {
    // Frege answered 200 because it made the call; the broker answered 403.
    // Flattening the two would turn "your customer lacks permission" into
    // "Frege is broken".
    const { frege } = testClient(() =>
      envelope(toolResponse({ status_code: 403, body: JSON.stringify({ error: 'insufficient_scope' }) })),
    );

    const result = await frege.invoke('list_orders');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.data).toEqual({ error: 'insufficient_scope' });
  });

  it('sends client_id when acting as a connected customer', async () => {
    const { frege, calls } = testClient(() => envelope(toolResponse()));

    await frege.invoke('list_orders', { status: 'open' }, { asClient: 4021 });

    expect(calls[0]?.body).toEqual({ arguments: { status: 'open' }, client_id: 4021 });
  });

  it('drops null and undefined arguments instead of sending them', async () => {
    const { frege, calls } = testClient(() => envelope(toolResponse()));

    await frege.invoke('list_orders', {
      status: 'open',
      symbol: undefined,
      since: null,
      limit: 0,
      includeClosed: false,
    });

    // 0 and false are values the caller meant; only the absent ones are cut.
    expect(calls[0]?.body).toEqual({ arguments: { status: 'open', limit: 0, includeClosed: false } });
  });

  it('escapes the tool name in the path', async () => {
    const { frege, calls } = testClient(() => envelope(toolResponse()));

    await frege.invoke('orders/list orders');

    expect(calls[0]?.url).toBe('https://frege.test/v1/projects/3/tools/orders%2Flist%20orders/invoke');
  });

  it('never retries — one invoke is one upstream call', async () => {
    // The whole point: an invoke can place an order or move money. A retry the
    // caller did not ask for could do it twice.
    const { frege, calls } = testClient(() => apiError(503, 'server_error', 'upstream unavailable'));

    await expect(frege.invoke('place_order', { symbol: 'AAPL', qty: 1 })).rejects.toMatchObject({
      kind: 'api',
      status: 503,
    });
    expect(calls).toHaveLength(1);
  });

  it('sends the auth header, the SDK user agent, and a JSON content type', async () => {
    const { frege, calls } = testClient(() => envelope(toolResponse()));

    await frege.invoke('get_account_profile');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer frege_sk_secret_value');
    expect(headers['User-Agent']).toMatch(/^frege-typescript\/\d+\.\d+\.\d+$/);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('asks the token provider again on every call, so rotation is picked up', async () => {
    let issued = 0;
    const { frege, calls } = testClient(() => envelope(toolResponse()), {
      token: () => `token-${String(++issued)}`,
    });

    await frege.invoke('get_account_profile');
    await frege.invoke('get_account_profile');

    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
    expect((calls[1]?.init.headers as Record<string, string>).Authorization).toBe('Bearer token-2');
  });

  it('will not let caller headers overwrite the Authorization header', async () => {
    const { frege, calls } = testClient(() => envelope(toolResponse()), {
      headers: { Authorization: 'Bearer not-my-token', 'X-Trace': 'abc' },
    });

    await frege.invoke('get_account_profile');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer frege_sk_secret_value');
    expect(headers['X-Trace']).toBe('abc');
  });
});

describe('client construction', () => {
  it('rejects a missing token before any request is made', () => {
    expect(() => new Frege({ projectId: 3, token: '' })).toThrow(TypeError);
  });

  it('rejects a project id that is not a positive integer', () => {
    expect(() => new Frege({ projectId: 0, token: 'k' })).toThrow(TypeError);
  });

  it('trims trailing slashes off the base URL', async () => {
    const { frege, calls } = testClient(() => envelope(toolResponse()), { baseUrl: 'https://frege.test/' });

    await frege.invoke('get_account_profile');

    expect(calls[0]?.url).toBe('https://frege.test/v1/projects/3/tools/get_account_profile/invoke');
  });

  it('withProject keeps the credential and swaps the project', async () => {
    const { frege, calls } = testClient(() => envelope(toolResponse()));

    const other = frege.withProject(9);
    await other.invoke('get_account_profile');

    expect(other.projectId).toBe(9);
    expect(calls[0]?.url).toContain('/v1/projects/9/');
  });

  it('copies the options it was given instead of watching them change', async () => {
    // Aliasing the caller's object meant a later edit reached `withProject` but
    // not the already-built transport — one client, two configurations.
    const calls: string[] = [];
    const options = {
      projectId: 3,
      token: 'k',
      baseUrl: 'https://frege.test',
      fetch: (url: string) => {
        calls.push(url);
        return Promise.resolve(envelope(toolResponse()));
      },
    };
    const frege = new Frege(options);

    options.projectId = 99;
    options.baseUrl = 'https://elsewhere.test';
    await frege.withProject(4).invoke('get_account_profile');

    expect(calls[0]).toBe('https://frege.test/v1/projects/4/tools/get_account_profile/invoke');
  });
});
