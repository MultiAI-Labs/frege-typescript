export { Frege } from './client.js';
// Type-only: a `TasksAPI` is reached as `frege.tasks` and cannot be built by a
// consumer — its constructor takes the internal `HttpClient`. Exporting the
// class as a value only advertised a `new TasksAPI(…)` nobody could write.
export type {
  InvokeAndWaitOptions,
  InvokeOptions,
  IterateOperationsOptions,
  ListOperationsOptions,
  ListTasksOptions,
  TasksAPI,
  WaitOptions,
} from './client.js';

export { DEFAULT_BASE_URL, DEV_BASE_URL , STAGE_HEADER } from './config.js';
export type { FetchLike, FregeOptions, RetryOptions, TokenProvider } from './config.js';

export type { RequestOptions } from './http.js';

export {
  FregeAPIError,
  FregeConnectionError,
  FregeError,
  FregeProtocolError,
  FregeTaskError,
  FregeTimeoutError,
  isFregeError,
} from './errors.js';
export type { AnyFregeError, FregeErrorKind } from './errors.js';

export type {
  CancelledTask,
  CompletedTask,
  FailedTask,
  InputRequiredTask,
  Operation,
  PendingTask,
  Task,
  TaskError,
  TaskStatus,
  TerminalTask,
  ToolArguments,
  ToolResult,
  UnknownPendingTask,
  UnknownTask,
  UnknownTerminalTask,
  WorkingTask,
} from './types.js';

export { VERSION } from './version.js';
export type { Stage } from './config.js';
