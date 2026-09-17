import { checkDuration, resolveConfig, type FregeOptions } from './config.js';
import { FregeTaskError, FregeTimeoutError, isFregeError } from './errors.js';
import { HttpClient, type RequestOptions } from './http.js';
import { sleep } from './sleep.js';
import type { Operation, Task, TerminalTask, ToolArguments, ToolResult } from './types.js';
import { asArray, toOperation, toTask, toToolResult } from './wire.js';

/** Options for a single tool call. */
export interface InvokeOptions extends RequestOptions {
  /**
   * Run the tool as ONE connected end-customer, injecting that person's own
   * stored upstream credential instead of the project's.
   *
   * This is the point of Frege: one agent, one project key, acting as any
   * customer, with both parties on the audit record. Where the project has no
   * shared credential of its own, it is required.
   *
   * The id comes from the project's client list in the dashboard.
   */
  asClient?: number;
}

/** Options for one page of operations. */
export interface ListOperationsOptions extends RequestOptions {
  /** Max operations to return (server caps at 500). Omit for the full list. */
  limit?: number;
  /** How many to skip. Only meaningful together with `limit`. */
  offset?: number;
}

/** Options for walking every operation. */
export interface IterateOperationsOptions extends RequestOptions {
  /** Operations per request. Default 200; anything above the server's cap of 500 is clamped to it. */
  pageSize?: number;
}

/** Options for listing tasks. */
export interface ListTasksOptions extends RequestOptions {
  /** Max tasks, newest first. Server default 50, cap 200. */
  limit?: number;
}

/**
 * Options for waiting on a task.
 *
 * `timeoutMs` means what it means everywhere else in this SDK — one HTTP
 * request. The budget for the whole wait is `totalTimeoutMs`, and it defaults
 * to 300000ms, the server's own task deadline.
 */
export interface WaitOptions extends RequestOptions {
  /** Override the server's `pollIntervalMs` hint. */
  pollIntervalMs?: number;
  /** Called after every poll — a progress bar's hook. */
  onPoll?: (task: Task) => void;
}

/** Options for starting a tool call as a task and waiting for it. */
export interface InvokeAndWaitOptions extends WaitOptions {
  /** See {@link InvokeOptions.asClient}. */
  asClient?: number;
}

const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const MIN_POLL_INTERVAL_MS = 100;
/** The server's own cap. Asking for more silently gets you this many. */
const MAX_PAGE_SIZE = 500;

/**
 * A Frege client bound to one project.
 *
 * ```ts
 * const frege = new Frege({ token: process.env.FREGE_API_KEY!, projectId: 3 });
 * const account = await frege.invoke('get_account_profile');
 * ```
 */
export class Frege {
  /** The project every call on this client is made against. */
  readonly projectId: number;

  /** Long-running calls: list, read, cancel, wait. */
  readonly tasks: TasksAPI;

  readonly #options: FregeOptions;
  readonly #http: HttpClient;
  readonly #base: string;

  constructor(options: FregeOptions) {
    // Copied, not aliased: a caller who reuses and then edits their options
    // object would otherwise change what `withProject` inherits while leaving
    // this client's own already-resolved config behind.
    this.#options = { ...options };
    this.#http = new HttpClient(resolveConfig(this.#options));
    this.projectId = options.projectId;
    this.#base = `/v1/projects/${String(options.projectId)}`;
    this.tasks = new TasksAPI(this.#http, this.#base);
  }

  /**
   * A second client for another project, same credential and settings.
   *
   * Only useful with a user access token: a project API key is bound to one
   * project and any other id answers 404.
   */
  withProject(projectId: number): Frege {
    return new Frege({ ...this.#options, projectId });
  }

  /**
   * Run one tool and return what the upstream answered.
   *
   * The result's `status` is the UPSTREAM's — a 403 there means the third-party
   * API refused the call, which is a successful Frege call. Frege's own
   * failures (no such tool, bad arguments, a rejected token) throw a
   * `FregeAPIError` instead.
   *
   * ```ts
   * const orders = await frege.invoke<Order[]>('list_orders', { status: 'open' });
   * if (!orders.ok) throw new Error(`broker said ${orders.status}`);
   * // `data` is T only when the upstream really sent JSON — narrow it.
   * if (!Array.isArray(orders.data)) throw new Error('expected a JSON array');
   * for (const order of orders.data) console.log(order.symbol);
   * ```
   *
   * Never retried automatically — see the note in `http.ts`.
   */
  async invoke<T = unknown>(
    toolName: string,
    args: ToolArguments = {},
    options: InvokeOptions = {},
  ): Promise<ToolResult<T>> {
    const wire = await this.#http.post(
      `${this.#base}/tools/${encodeURIComponent(toolName)}/invoke`,
      invokeBody(args, options.asClient),
      options,
    );
    return toToolResult<T>(wire);
  }

  /**
   * Start a tool call as a task and return its handle immediately.
   *
   * For the calls that do not answer in milliseconds — a withdrawal, a report —
   * where holding a connection open is what fails first. Follow the returned
   * task with `tasks.wait`, or poll `tasks.get` on your own schedule.
   */
  async invokeAsync(toolName: string, args: ToolArguments = {}, options: InvokeOptions = {}): Promise<Task> {
    const wire = await this.#http.post(
      `${this.#base}/tools/${encodeURIComponent(toolName)}/invoke`,
      { ...invokeBody(args, options.asClient), async: true },
      options,
    );
    return toTask(wire);
  }

  /**
   * Start a tool call as a task, wait for it, and return the upstream response.
   *
   * Throws a `FregeTaskError` if the task ends anything but `completed`, and a
   * `FregeProtocolError` if it completes carrying no tool result. Use
   * `invokeAsync` plus `tasks.wait` when you would rather inspect that yourself.
   */
  async invokeAndWait<T = unknown>(
    toolName: string,
    args: ToolArguments = {},
    options: InvokeAndWaitOptions = {},
  ): Promise<ToolResult<T>> {
    const { asClient, ...wait } = options;
    const started = await this.invokeAsync(toolName, args, {
      ...(asClient === undefined ? {} : { asClient }),
      ...(wait.signal === undefined ? {} : { signal: wait.signal }),
      ...(wait.timeoutMs === undefined ? {} : { timeoutMs: wait.timeoutMs }),
    });
    // A task can be born terminal — a tool that failed before it ever ran.
    const finished = started.terminal ? started : await this.tasks.wait(started.taskId, wait);
    if (finished.status !== 'completed') throw new FregeTaskError(finished);
    // `result` is `unknown` on the task, and a completed task with nothing in
    // it is a real answer from the server. Checked, never cast.
    return toToolResult<T>(finished.result);
  }

  /**
   * The project's tools: names, methods, and the JSON Schema for each one's
   * arguments. Without `limit` the full list comes back in one response.
   */
  async listOperations(options: ListOperationsOptions = {}): Promise<Operation[]> {
    const wire = await this.#http.get(
      `${this.#base}/operations`,
      { limit: options.limit, offset: options.offset },
      options,
    );
    return asArray(wire, 'a list of operations').map(toOperation);
  }

  /**
   * Every operation, a page at a time — for specs too large to hold at once.
   *
   * ```ts
   * for await (const op of frege.iterateOperations()) console.log(op.toolName);
   * ```
   */
  async *iterateOperations(options: IterateOperationsOptions = {}): AsyncGenerator<Operation, void, undefined> {
    const { pageSize = 200, ...request } = options;
    // Ask for more than the server's cap and it quietly answers 500. Treating
    // that short page as the end of the list is how a walk of 4000 operations
    // used to stop at 500 and report success.
    const limit = Math.max(1, Math.min(Math.trunc(pageSize) || 1, MAX_PAGE_SIZE));
    for (let offset = 0; ;) {
      const page = await this.listOperations({ ...request, limit, offset });
      // An empty page is the only end-of-list signal this endpoint gives that
      // does not depend on the server having honoured `limit`.
      if (page.length === 0) return;
      yield* page;
      offset += page.length;
    }
  }
}

/** The task half of the API, reached as `frege.tasks`. */
export class TasksAPI {
  readonly #http: HttpClient;
  readonly #base: string;

  /** @internal Built by {@link Frege}; `HttpClient` is not part of the public API. */
  constructor(http: HttpClient, base: string) {
    this.#http = http;
    this.#base = base;
  }

  /** Recent tasks for this project, newest first. */
  async list(options: ListTasksOptions = {}): Promise<Task[]> {
    const wire = await this.#http.get(`${this.#base}/tasks`, { limit: options.limit }, options);
    return asArray(wire, 'a list of tasks').map(toTask);
  }

  /** One task's current state. */
  async get(taskId: string, options: RequestOptions = {}): Promise<Task> {
    const wire = await this.#http.get(`${this.#base}/tasks/${encodeURIComponent(taskId)}`, {}, options);
    return toTask(wire);
  }

  /**
   * Ask a task to stop.
   *
   * Records the intent; nothing is killed mid-flight, so an upstream write
   * already in progress is never left half-done. Poll until the task reports
   * `cancelled`. A task that already finished answers 404.
   *
   * Never retried automatically: it is a POST, and a second one on a task that
   * has since settled would raise a 404 the caller did not cause.
   */
  async cancel(taskId: string, options: RequestOptions = {}): Promise<void> {
    await this.#http.post(`${this.#base}/tasks/${encodeURIComponent(taskId)}/cancel`, undefined, options);
  }

  /**
   * Poll a task until it stops moving, honouring the server's own
   * `pollIntervalMs` hint.
   *
   * Returns the terminal task whatever its outcome — a failure is data here,
   * not an exception. Throws `FregeTimeoutError` once `totalTimeoutMs` is gone,
   * and that budget covers the polls themselves, not just the gaps between
   * them: a wait given 10ms does not sit inside a 30-second request first.
   */
  async wait(taskId: string, options: WaitOptions = {}): Promise<TerminalTask> {
    const budgetMs = checkDuration(options.totalTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, 'totalTimeoutMs', { min: 1 });
    const hint =
      options.pollIntervalMs === undefined ? undefined : checkDuration(options.pollIntervalMs, 'pollIntervalMs');
    const startedAt = Date.now();
    const deadline = startedAt + budgetMs;
    // The per-poll budget, which the remaining wall clock can only shorten.
    const perPollMs = options.timeoutMs ?? this.#http.timeoutMs;
    let last: Task | undefined;

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw this.#waitedTooLong(taskId, budgetMs, startedAt, last);

      let task: Task;
      try {
        task = await this.get(taskId, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          // Both floored at 1ms: what is left of the budget can be a fraction
          // of a millisecond, and a duration of 0 is not a legal one.
          timeoutMs: Math.max(1, Math.min(perPollMs, remaining)),
          totalTimeoutMs: Math.max(1, remaining),
        });
      } catch (err) {
        // The poll ran out the wait's own budget: report the budget the caller
        // set, not the slice of it this one request was given.
        if (isFregeError(err) && err.kind === 'timeout' && Date.now() >= deadline) {
          throw this.#waitedTooLong(taskId, budgetMs, startedAt, last);
        }
        throw err;
      }

      last = task;
      options.onPoll?.(task);
      if (task.terminal) return task;

      // The server may change its hint between polls; the latest one wins. The
      // floor stops a zero from turning this into a busy loop.
      const interval = Math.max(MIN_POLL_INTERVAL_MS, hint ?? task.pollIntervalMs);
      await sleep(Math.min(interval, deadline - Date.now()), options.signal);
    }
  }

  #waitedTooLong(taskId: string, budgetMs: number, startedAt: number, last: Task | undefined): FregeTimeoutError {
    // `input_required` is the one status this SDK cannot move along, so a wait
    // on it can only ever end here. Say so instead of leaving the caller to
    // guess why their task never finished.
    const stuck =
      last?.status === 'input_required'
        ? ` — the task is waiting for input, which this SDK cannot supply`
        : last === undefined
          ? ''
          : ` (last status: ${last.status === 'unknown' ? last.rawStatus : last.status})`;
    return new FregeTimeoutError(budgetMs, `waiting for task ${taskId}${stuck}`, Date.now() - startedAt);
  }
}

function invokeBody(args: ToolArguments, asClient: number | undefined): Record<string, unknown> {
  return {
    arguments: dropNullish(args),
    ...(asClient === undefined ? {} : { client_id: asClient }),
  };
}

/**
 * Optional arguments that are `null` or `undefined` are dropped rather than
 * sent. An omitted argument means "use the upstream's default"; an explicit
 * null usually means "set this field to null", which is a different request.
 * Only the top level is filtered — nested nulls are the caller's own data.
 */
function dropNullish(args: ToolArguments): ToolArguments {
  const out: ToolArguments = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}
