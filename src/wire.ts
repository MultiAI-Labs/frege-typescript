/**
 * The API's own JSON shapes and how they become the exported types.
 *
 * Everything snake_case stops here: no consumer of this package should have to
 * write `tool_name`.
 *
 * Every mapper takes `unknown`. The transport hands over whatever was inside
 * the `{"data": …}` envelope, and that is the last place a cast could be told
 * apart from a promise — a `{"data": null}` cast to `WireOperation[]` becomes a
 * `TypeError: … .map is not a function` three frames later, in the caller's
 * code, blaming the caller. These functions check instead, and say what they
 * expected.
 */
import { FregeProtocolError } from './errors.js';
import type { Operation, Task, TaskError, ToolResult } from './types.js';

export interface WireOperation {
  id: string;
  tool_name: string;
  method: string;
  path: string;
  summary?: string;
  description?: string;
  tags?: string[] | null;
  input_schema?: Record<string, unknown> | null;
}

export interface WireToolResult {
  tool_name: string;
  method: string;
  url: string;
  status_code: number;
  body: string;
}

export interface WireTask {
  task_id: string;
  status: string;
  status_message?: string;
  tool_name?: string;
  result?: unknown;
  error?: unknown;
  actor_email?: string;
  door?: string;
  poll_interval_ms?: number;
  ttl_ms?: number | null;
  terminal?: boolean;
  created_at: string;
  updated_at: string;
}

export function toOperation(wire: unknown): Operation {
  const rec = asRecord(wire, 'an operation');
  return {
    id: str(rec['id']) ?? '',
    toolName: required(str(rec['tool_name']), 'an operation', 'tool_name'),
    method: str(rec['method']) ?? '',
    path: str(rec['path']) ?? '',
    summary: str(rec['summary']) ?? '',
    description: str(rec['description']) ?? '',
    tags: Array.isArray(rec['tags']) ? rec['tags'].filter((t): t is string => typeof t === 'string') : [],
    inputSchema: isRecord(rec['input_schema']) ? rec['input_schema'] : {},
  };
}

export function toToolResult<T>(wire: unknown): ToolResult<T> {
  const rec = asRecord(wire, 'a tool result');
  const status = required(num(rec['status_code']), 'a tool result', 'status_code');
  const raw = str(rec['body']) ?? '';
  return {
    toolName: str(rec['tool_name']) ?? '',
    method: str(rec['method']) ?? '',
    url: str(rec['url']) ?? '',
    status,
    ok: status >= 200 && status < 300,
    data: parseBody<T>(raw),
    raw,
  };
}

/**
 * Frege delivers the upstream body as a JSON *string*, not as an object, so
 * that a body which is not JSON at all still survives the trip intact. Parsing
 * it here is the difference between `result.data.balance` and every caller
 * writing their own `JSON.parse` — and forgetting the try/catch.
 *
 * The return type admits all three outcomes rather than claiming `T`: see
 * {@link ToolResult.data}.
 */
function parseBody<T>(raw: string): T | string | undefined {
  if (raw === '') return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Not JSON: an HTML error page, a plain-text message, a CSV export. The
    // string itself is the most useful thing we can hand back.
    return raw;
  }
}

export function toTask(wire: unknown): Task {
  const rec = asRecord(wire, 'a task');
  const taskId = required(str(rec['task_id']), 'a task', 'task_id');
  const pollIntervalMs = num(rec['poll_interval_ms']);
  const statusMessage = str(rec['status_message']) ?? '';
  const toolName = str(rec['tool_name']);
  const actorEmail = str(rec['actor_email']);
  const door = str(rec['door']);
  const base = {
    taskId,
    statusMessage,
    pollIntervalMs: pollIntervalMs !== undefined && pollIntervalMs > 0 ? pollIntervalMs : 1000,
    ttlMs: num(rec['ttl_ms']) ?? null,
    createdAt: date(rec['created_at'], taskId, 'created_at'),
    updatedAt: date(rec['updated_at'], taskId, 'updated_at'),
    ...(toolName === undefined ? {} : { toolName }),
    ...(actorEmail === undefined ? {} : { actorEmail }),
    ...(door === undefined ? {} : { door }),
  };

  switch (rec['status']) {
    case 'completed':
      return { ...base, status: 'completed', terminal: true, result: rec['result'] };
    case 'failed':
      return { ...base, status: 'failed', terminal: true, error: toTaskError(rec['error'], statusMessage) };
    case 'cancelled':
      return { ...base, status: 'cancelled', terminal: true };
    case 'input_required':
      return { ...base, status: 'input_required', terminal: false };
    case 'working':
      return { ...base, status: 'working', terminal: false };
    default:
      // A status this SDK has not been taught must not break a poll loop, so it
      // is passed through — as its own branch of the union, not disguised as
      // one of the five above — and the server-derived `terminal` flag, which
      // every wait here consults, decides when to stop.
      return rec['terminal'] === true
        ? { ...base, status: 'unknown', rawStatus: str(rec['status']) ?? '', terminal: true }
        : { ...base, status: 'unknown', rawStatus: str(rec['status']) ?? '', terminal: false };
  }
}

function toTaskError(raw: unknown, statusMessage: string): TaskError {
  if (isRecord(raw) && 'message' in raw) {
    return {
      code: num(raw['code']) ?? -32603,
      message: str(raw['message']) ?? statusMessage,
      ...(raw['data'] === undefined ? {} : { data: raw['data'] }),
    };
  }
  return { code: -32603, message: statusMessage || 'the task failed' };
}

/** A JSON array, or a protocol error naming what was expected instead. */
export function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new FregeProtocolError(`expected ${what} in the response, got ${describe(value)}`);
  }
  return value;
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new FregeProtocolError(`expected ${what} in the response, got ${describe(value)}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function required<T>(value: T | undefined, what: string, field: string): T {
  if (value === undefined) {
    throw new FregeProtocolError(`${what} in the response is missing its ${field}`);
  }
  return value;
}

function date(value: unknown, taskId: string, field: string): Date {
  const text = str(value);
  const at = text === undefined ? NaN : Date.parse(text);
  if (Number.isNaN(at)) {
    throw new FregeProtocolError(`task ${taskId} carried an unreadable ${field} (${describe(value)})`);
  }
  return new Date(at);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `a string (${JSON.stringify(value.slice(0, 60))})`;
  return typeof value;
}
