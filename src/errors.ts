import type { TerminalTask } from './types.js';

/** Discriminator carried by every error this SDK throws. */
export type FregeErrorKind = 'api' | 'protocol' | 'connection' | 'timeout' | 'task';

/**
 * Base class for everything this SDK throws. Prefer {@link isFregeError} plus a
 * `switch` on `kind` over `instanceof` chains — see {@link AnyFregeError}.
 */
export abstract class FregeError extends Error {
  abstract readonly kind: FregeErrorKind;

  protected constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    // Every subclass repeats its own name as a literal, and none of them read
    // it off the constructor: a minifier renames classes, and `error.name` is
    // what Sentry and most log aggregators group by. Derived names collapse the
    // whole surface into one bucket called "h".
    this.name = 'FregeError';
  }
}

/**
 * Frege itself answered with a non-2xx status.
 *
 * This is never the upstream API's own failure: a tool call that reaches the
 * upstream and comes back 403 is a *successful* Frege call carrying an upstream
 * status, reported on `ToolResult.status` instead.
 */
export class FregeAPIError extends FregeError {
  readonly kind = 'api';

  /** HTTP status Frege answered with. Always non-2xx. */
  readonly status: number;
  /** Machine-readable code, e.g. `validation_failed`, `not_found`. */
  readonly code: string;
  /** Per-field messages, present on `validation_failed` (422). */
  readonly fields: Readonly<Record<string, string>> | undefined;
  /** Quote this to Frege support. Never dropped, even when the body is odd. */
  readonly requestId: string | undefined;
  /** Parsed `Retry-After`, when the response carried one. */
  readonly retryAfterMs: number | undefined;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    fields?: Record<string, string> | undefined;
    requestId?: string | undefined;
    retryAfterMs?: number | undefined;
  }) {
    // The token is deliberately absent from this string, and from every field
    // above: an error object ends up in logs, in Sentry, and in bug reports.
    super(`frege: ${init.status} ${init.code}: ${init.message}`);
    this.name = 'FregeAPIError';
    this.status = init.status;
    this.code = init.code;
    this.fields = init.fields;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
  }

  /** The token was missing, expired, or revoked. */
  get isAuthError(): boolean {
    return this.status === 401;
  }

  /** No such project, tool, or task — or the caller cannot see it. */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** The arguments did not satisfy the tool's input schema; see `fields`. */
  get isValidationError(): boolean {
    return this.status === 422;
  }

  /** Too many requests; `retryAfterMs` says how long to wait. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/**
 * Frege answered, but not with a payload this SDK can read: a proxy's HTML in
 * place of the envelope, a task that completed carrying no result, a list
 * endpoint that answered `null`.
 *
 * Kept apart from {@link FregeAPIError} because the status is not the
 * complaint — a 200 can land here, and a 500 never does.
 */
export class FregeProtocolError extends FregeError {
  readonly kind = 'protocol';

  /** Frege's own HTTP status, when this came from a response at all. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(`frege: ${message}`);
    this.name = 'FregeProtocolError';
    this.status = status;
  }
}

/** The request never got an answer: DNS, TLS, a reset, or an offline device. */
export class FregeConnectionError extends FregeError {
  readonly kind = 'connection';

  constructor(message: string, options?: { cause?: unknown }) {
    super(`frege: ${message}`, options);
    this.name = 'FregeConnectionError';
  }
}

/** The request outlived its timeout budget. */
export class FregeTimeoutError extends FregeError {
  readonly kind = 'timeout';

  /** The budget that was exceeded. */
  readonly timeoutMs: number;
  /** How long it actually took. Never smaller than {@link timeoutMs}. */
  readonly elapsedMs: number;

  constructor(timeoutMs: number, what = 'request', elapsedMs?: number) {
    const took = elapsedMs === undefined ? timeoutMs : Math.max(elapsedMs, timeoutMs);
    super(`frege: ${what} timed out after ${took}ms`);
    this.name = 'FregeTimeoutError';
    this.timeoutMs = timeoutMs;
    this.elapsedMs = took;
  }
}

/** A task reached a terminal state that was not `completed`. */
export class FregeTaskError extends FregeError {
  readonly kind = 'task';

  /** The final task, so the caller can read `statusMessage` and `error`. */
  readonly task: TerminalTask;

  constructor(task: TerminalTask) {
    const outcome = task.status === 'unknown' ? task.rawStatus : task.status;
    const detail = task.statusMessage || (task.status === 'failed' ? task.error.message : outcome);
    super(`frege: task ${task.taskId} ${outcome}: ${detail}`);
    this.name = 'FregeTaskError';
    this.task = task;
  }
}

/**
 * Every error this SDK throws, as a discriminated union.
 *
 * ```ts
 * try {
 *   await frege.invoke('list_orders');
 * } catch (err) {
 *   if (!isFregeError(err)) throw err;
 *   switch (err.kind) {
 *     case 'api':        console.error(err.status, err.code, err.requestId); break;
 *     case 'protocol':   console.error('unreadable answer', err.message); break;
 *     case 'timeout':    console.error('slow upstream', err.timeoutMs); break;
 *     case 'connection': console.error('network', err.cause); break;
 *     case 'task':       console.error(err.task.statusMessage); break;
 *   }
 * }
 * ```
 */
export type AnyFregeError =
  FregeAPIError | FregeProtocolError | FregeConnectionError | FregeTimeoutError | FregeTaskError;

/** Type guard that narrows `unknown` to the {@link AnyFregeError} union. */
export function isFregeError(value: unknown): value is AnyFregeError {
  return value instanceof FregeError;
}
