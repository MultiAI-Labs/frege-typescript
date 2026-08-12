/** Arguments for one tool call, keyed by the tool's `inputSchema` properties. */
export type ToolArguments = Record<string, unknown>;

/** One tool generated from the project's active OpenAPI spec. */
export interface Operation {
  /** Stable operation id from the spec (its `operationId`, or a derived one). */
  id: string;
  /** The name to pass to `invoke` — this is what an MCP client sees too. */
  toolName: string;
  /** Upstream HTTP method the tool performs. */
  method: string;
  /** Upstream path template, e.g. `/accounts/{id}/orders`. */
  path: string;
  summary: string;
  description: string;
  tags: string[];
  /** JSON Schema describing this tool's arguments. */
  inputSchema: Record<string, unknown>;
}

/**
 * What the upstream API answered when Frege ran a tool.
 *
 * Frege's own HTTP status and this one are different things and are kept apart
 * on purpose: Frege answers 200 whenever it successfully *made* the call, so a
 * `ToolResult` with `status: 403` means the upstream refused, not that anything
 * went wrong with Frege. Frege's own failures throw a `FregeAPIError`.
 */
export interface ToolResult<T = unknown> {
  toolName: string;
  /** Upstream HTTP method that was performed. */
  method: string;
  /** Fully resolved upstream URL that was called. */
  url: string;
  /** The UPSTREAM's HTTP status. */
  status: number;
  /** `true` when {@link ToolResult.status} is 2xx. */
  ok: boolean;
  /**
   * The upstream body, parsed.
   *
   * Frege sends this field as a JSON *string* rather than an object, so it is
   * parsed here once instead of by every caller. Three outcomes, and the type
   * says so rather than pretending `T` always arrives:
   *
   * - `T` — the body was JSON. Nothing validates it against `T`; that is your
   *   claim about the upstream, not this SDK's.
   * - `string` — the body was not JSON at all: an HTML maintenance page, a
   *   plain-text message, a CSV export. The text is handed back intact.
   * - `undefined` — the body was empty, as a 204 sends.
   *
   * Narrow before you use it. A tool that answers JSON today answers an HTML
   * error page the morning its upstream goes down.
   */
  data: T | string | undefined;
  /** The body exactly as the upstream sent it, before parsing. */
  raw: string;
}

/**
 * Where a task is in its life, as this SDK understands it.
 *
 * `completed`, `cancelled` and `failed` are terminal — stop polling. Prefer the
 * `terminal` flag on the task itself over re-deriving it from this list.
 *
 * `unknown` is not a status the server sends: it is this SDK's honest label for
 * a status it has not been taught, with the server's own word kept on
 * {@link UnknownTask.rawStatus}. A `switch` that covers the other four still
 * needs a `default`.
 */
export type TaskStatus = 'working' | 'input_required' | 'completed' | 'cancelled' | 'failed' | 'unknown';

/** The JSON-RPC error object a failed task carries. */
export interface TaskError {
  code: number;
  message: string;
  data?: unknown;
}

interface TaskBase {
  taskId: string;
  /**
   * Server-authored free text: what the task is doing, what it is blocked on,
   * or why it failed. Render it as-is.
   */
  statusMessage: string;
  /** The tool this task is running, for a task started by `invokeAsync`. */
  toolName?: string;
  /** Who started it — a user's email, or an API key's name and id. */
  actorEmail?: string;
  /** Which door started it, e.g. `invoke`. */
  door?: string;
  /** How long to wait before polling again. May change between polls. */
  pollIntervalMs: number;
  /** Server-side deadline for the whole task, or `null` when uncapped. */
  ttlMs: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Still running. */
export interface WorkingTask extends TaskBase {
  status: 'working';
  terminal: false;
}

/**
 * Paused until something is supplied. There is no way to supply it through this
 * SDK yet, so a `wait` on one of these can only end in a timeout — one that
 * says as much, rather than leaving the caller to guess.
 */
export interface InputRequiredTask extends TaskBase {
  status: 'input_required';
  terminal: false;
}

/** Finished successfully. */
export interface CompletedTask extends TaskBase {
  status: 'completed';
  terminal: true;
  /** For a task started by `invokeAsync`, the raw invoke response payload. */
  result: unknown;
}

/** Stopped because someone asked it to. */
export interface CancelledTask extends TaskBase {
  status: 'cancelled';
  terminal: true;
}

/** Finished unsuccessfully. */
export interface FailedTask extends TaskBase {
  status: 'failed';
  terminal: true;
  error: TaskError;
}

/**
 * A status this SDK does not know.
 *
 * A server is free to grow a status before a client is rebuilt, and a poll loop
 * must not break when it does. Rather than forge a member of the closed union
 * above — which would let `finished.result` typecheck on a task that has no
 * result — such a task arrives here, with the server's own word on `rawStatus`
 * and the server's own `terminal` flag deciding when to stop.
 */
interface UnknownTaskBase extends TaskBase {
  status: 'unknown';
  /** Exactly what the server called it. */
  rawStatus: string;
}

/** An unrecognised status the server says is still moving. */
export interface UnknownPendingTask extends UnknownTaskBase {
  terminal: false;
}

/** An unrecognised status the server says is final. */
export interface UnknownTerminalTask extends UnknownTaskBase {
  terminal: true;
}

/** Split in two so that `if (task.terminal)` narrows it like every other task. */
export type UnknownTask = UnknownPendingTask | UnknownTerminalTask;

/** A long-running call, as a discriminated union over {@link TaskStatus}. */
export type Task =
  | WorkingTask
  | InputRequiredTask
  | CompletedTask
  | CancelledTask
  | FailedTask
  | UnknownPendingTask
  | UnknownTerminalTask;

/** A task that is still moving. */
export type PendingTask = WorkingTask | InputRequiredTask | UnknownPendingTask;

/** A task that will never change again. */
export type TerminalTask = CompletedTask | CancelledTask | FailedTask | UnknownTerminalTask;
