# @frege/sdk

TypeScript client for the [Frege](https://frege.io) API.

Frege turns a business's OpenAPI spec into callable tools and runs them against
the upstream API with the right credential injected. This SDK lets ordinary code
— a bot, a cron job, a voice agent, a backend service — call those tools
directly, with no AI model in the loop.

Zero runtime dependencies. Node 18+, Deno, Bun, and edge runtimes.

It runs in a browser too, but **do not ship a project API key to one**: the key
runs that project's tools for whoever holds it, and anything in a browser bundle
is public. Call Frege from your own server, or from an edge function that keeps
the key server-side.


## Environments

Every project has two environments, `staging` and `live`. A project-scoped call
is answered by one of them.

```ts
const frege = new Frege({ projectId: 53, token: process.env.FREGE_KEY!, stage: 'staging' });
```

**Omitting this means live.** That is the server's default, not this SDK's
choice. A test that means to exercise staging and never sets a stage reads
production's spec and spends production's credential, and every response looks
perfectly normal.

An API key is bound to one environment when it is issued, so a key and a stage
that disagree fail rather than crossing over.

## Install

```bash
npm install @frege/sdk
```

## 30 seconds

Mint a key in the dashboard (**Project → API keys**). It is shown once, starts
with `frege_sk_`, and belongs to that one project.

```ts
import { Frege } from '@frege/sdk';

const frege = new Frege({ token: process.env.FREGE_API_KEY!, projectId: 3 });

const account = await frege.invoke('get_account_profile');
console.log(account.status, account.data);
```

`account.data` is the broker's own JSON, already parsed. `account.status` is the
broker's own HTTP status.

## Auth

Every call is a bearer token in one header. Two things fit:

| Credential                   | Get it from           | Reaches                      |
| ---------------------------- | --------------------- | ---------------------------- |
| Project API key `frege_sk_…` | Project → API keys    | that project's tools only    |
| User access token            | your own sign-in flow | everything that user can see |

A key is a static credential your code holds, so there is nothing to refresh.
For a token that rotates, pass a function — it is called before every request:

```ts
const frege = new Frege({
  projectId: 3,
  token: async () => vault.read('frege/access-token'),
});
```

The token is only ever sent in the `Authorization` header of `baseUrl`. It is
never logged, never put in an error, and never in a serialized client. Treat a
key like a password: whoever holds it can run that project's tools. Revoke it in
the dashboard if it leaks.

## Acting as one of your customers

This is the part that makes Frege different. One agent, one project key, acting
as **any** connected customer — Frege injects that person's own credential at
the upstream, and the audit log records both parties: which key asked, and whose
account was reached.

```ts
// Alice's broker credential, not the project's.
const orders = await frege.invoke('list_orders', { status: 'open' }, { asClient: 4021 });
```

The id comes from the project's client list in the dashboard. Where every
credential belongs to an individual end customer and the project has no shared
one of its own, `asClient` is required, and omitting it returns a validation
error saying so.

## Two different statuses

A tool call has two outcomes stacked on top of each other, and this SDK never
flattens them:

```ts
const orders = await frege.invoke('list_orders'); // throws if FREGE failed
if (!orders.ok) {
  // Frege ran the call fine; the broker refused it.
  console.error(`broker said ${orders.status}`, orders.raw);
}
```

- **Frege failed** — no such tool, bad arguments, a rejected token: the call
  **throws** a `FregeAPIError`.
- **The upstream answered non-2xx** — 403, 404, 422 from the broker: the call
  **resolves**, and `result.status` / `result.ok` carry that answer.

Frege delivers the upstream body as a JSON _string_. This SDK parses it once for
you into `result.data` and keeps the exact text in `result.raw`.

`data` is typed `T | string | undefined`, and it means all three: `T` when the
upstream sent JSON, the raw `string` when it sent something else — an HTML
maintenance page, a CSV — and `undefined` for an empty body, as a 204 sends. The
compiler makes you look before you reach into it, because the morning the
upstream breaks is exactly when a `for (const x of data)` would throw.

```ts
interface Order {
  id: string;
  symbol: string;
  quantity: number;
}

const orders = await frege.invoke<Order[]>('list_orders', { status: 'open' });
if (!orders.ok) throw new Error(`broker said ${orders.status}: ${orders.raw}`);
if (!Array.isArray(orders.data)) throw new Error(`broker did not answer with JSON: ${orders.raw}`);

for (const order of orders.data) console.log(order.symbol);
```

Nothing validates the JSON against `T` — that is your claim about the upstream,
not something this SDK can check.

## Discovering the tools

```ts
for (const op of await frege.listOperations()) {
  console.log(op.toolName, op.method, op.path, op.summary);
  console.log(op.inputSchema); // JSON Schema for invoke's arguments
}
```

Without `limit` the full list comes back in one response. For a very large spec,
walk it a page at a time:

```ts
for await (const op of frege.iterateOperations({ pageSize: 200 })) {
  console.log(op.toolName);
}
```

## Errors

Every error is a subclass of `FregeError` with a `kind` discriminator, so a
`switch` covers the whole surface:

```ts
import { isFregeError } from '@frege/sdk';

try {
  await frege.invoke('place_order', { symbol: 'AAPL', quantity: 1 });
} catch (err) {
  if (!isFregeError(err)) throw err;
  switch (err.kind) {
    case 'api':
      console.error(err.status, err.code, err.message);
      console.error('request id:', err.requestId); // quote this to support
      if (err.isValidationError) console.error(err.fields);
      break;
    case 'protocol':
      // Frege answered, but not with anything this SDK can read: a proxy's
      // HTML in place of the envelope, a task that completed carrying nothing.
      console.error('unreadable answer from Frege', err.message);
      break;
    case 'timeout':
      console.error(`gave up after ${err.elapsedMs}ms of a ${err.timeoutMs}ms budget`);
      break;
    case 'connection':
      console.error('could not reach Frege', err.cause);
      break;
    case 'task':
      console.error(`task ended ${err.task.status}`, err.task.statusMessage);
      break;
  }
}
```

`requestId` is what support asks for first. It is preserved even when the error
body is malformed.

## Long-running calls: tasks

Some tools do not answer in milliseconds — a withdrawal, a statement to
generate. Run those as a task instead of holding a connection open:

```ts
const statement = await frege.invokeAndWait('generate_statement', { year: 2026 }, { asClient: 4021 });
console.log(statement.status, statement.data);
```

That starts the task, polls at the server's own `pollIntervalMs`, and throws a
`FregeTaskError` if the task ends `failed` or `cancelled`. When you would rather
drive it yourself:

```ts
const task = await frege.invokeAsync('generate_statement', { year: 2026 });

const finished = await frege.tasks.wait(task.taskId, {
  totalTimeoutMs: 120_000, // the whole wait, polls included
  onPoll: (t) => console.log(t.status, t.statusMessage),
});

switch (finished.status) {
  case 'completed':
    console.log(finished.result);
    break;
  case 'failed':
    console.error(finished.error.message);
    break;
  case 'cancelled':
    console.warn('someone cancelled it');
    break;
  default:
    // A status this SDK has not been taught. The server's own word for it is
    // on `rawStatus`; the union has a branch for it rather than pretending it
    // is one of the three above.
    console.warn('unrecognised final status', finished.rawStatus);
}
```

`Task` is a discriminated union on `status`, so `finished.result` and
`finished.error` only exist on the branches that actually have them.

The rest of the task surface:

```ts
await frege.tasks.list({ limit: 20 }); // newest first, server caps at 200
await frege.tasks.get(taskId);
await frege.tasks.cancel(taskId); // records the intent; nothing is killed mid-flight
```

## Configuration

```ts
const frege = new Frege({
  projectId: 3,
  token: process.env.FREGE_API_KEY!,
  baseUrl: 'https://frege.uz', // dev; default is https://frege.io
  timeoutMs: 30_000, // per attempt — see the two budgets below
  headers: { 'X-Trace-Id': traceId },
  fetch: myInstrumentedFetch,
  retry: { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 8_000, maxRetryAfterMs: 30_000 },
});
```

Every one of these is checked when the client is built, not when a request
fails: `baseUrl` must be `https` (loopback excepted) because the token is on
every request, and a `retry` value that is `NaN` or negative — the shape
`Number(process.env.FREGE_RETRIES)` produces when the variable is unset —
throws a `TypeError` here rather than retrying forever later.

| Environment | Base URL                     |
| ----------- | ---------------------------- |
| Production  | `https://frege.io` (default) |
| Dev         | `https://frege.uz`           |

Both are exported as `DEFAULT_BASE_URL` and `DEV_BASE_URL`.

### Two budgets, and which one you want

| Option           | Covers                                           |
| ---------------- | ------------------------------------------------ |
| `timeoutMs`      | one HTTP attempt. Each retry gets a fresh one.   |
| `totalTimeoutMs` | the whole call: every attempt and every backoff. |

`timeoutMs: 50` on a call that retries twice can still take well over a second,
which is why `totalTimeoutMs` exists. `tasks.wait` and `invokeAndWait` use the
same two words: `timeoutMs` is one poll, `totalTimeoutMs` is the whole wait, and
it defaults to 300000ms — the server's own task deadline.

```ts
await frege.listOperations({ timeoutMs: 5_000, totalTimeoutMs: 12_000 });
```

Every method also takes a per-call `signal`, so a request — and any backoff it
is sleeping through — can be cancelled:

```ts
await frege.invoke('list_orders', {}, { signal: AbortSignal.timeout(5_000) });
```

### What gets retried

Only **GET** requests, only on 429 and 5xx and network failures, with
exponential backoff, full jitter, and `Retry-After` honoured. A `Retry-After`
longer than `maxRetryAfterMs` is surfaced as a 429 carrying `retryAfterMs`
rather than silently holding your process.

`invoke` and `tasks.cancel` are **never** retried automatically. An invoke
spends a real credential against a real API and can place an order or move
money; a retry nobody asked for could do it twice. If a call is safe to repeat,
repeat it yourself.

## Types

Everything a consumer touches is exported: `Frege`, `FregeOptions`,
`TokenProvider`, `FetchLike`, `RetryOptions`, `RequestOptions`, `InvokeOptions`,
`Operation`, `ToolResult`, `ToolArguments`, `Task` (and each of its branches,
including `UnknownTask`, plus `PendingTask` / `TerminalTask`), `TaskStatus`,
`TaskError`, and the error classes — `FregeAPIError`, `FregeProtocolError`,
`FregeConnectionError`, `FregeTimeoutError`, `FregeTaskError` — with the
`AnyFregeError` union.

## When you want an agent, not a script

This SDK is the deterministic path: your code picks the tool. If you want an AI
agent to pick and chain tools instead, a Frege project is already a standard MCP
server — point an MCP client at

```
https://frege.io/mcp/{org-slug}/{project-slug}
```

That door takes a different token (an MCP-audience OAuth token, not this one).

## Contributing

```bash
npm install
npm run check   # lint + format:check + typecheck + test + build
```

## License

MIT © 2026 MultiAI Labs
