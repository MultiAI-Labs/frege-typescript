import { describe, expect, it, vi } from 'vitest';
import { FregeTaskError, FregeTimeoutError, type Task } from '../src/index.js';
import { apiError, envelope, hangUntilAborted, taskResponse, testClient, toolResponse } from './helpers.js';

describe('tasks', () => {
  it('starts an async invoke and returns the handle', async () => {
    const { frege, calls } = testClient(() => envelope(taskResponse(), 202));

    const task = await frege.invokeAsync('generate_statement', { year: 2026 }, { asClient: 77 });

    expect(calls[0]?.body).toEqual({ arguments: { year: 2026 }, client_id: 77, async: true });
    expect(task.status).toBe('working');
    expect(task.terminal).toBe(false);
    expect(task.taskId).toBe('tsk_1');
    expect(task.createdAt).toBeInstanceOf(Date);
  });

  it('narrows a completed task to its result', async () => {
    const { frege } = testClient(() =>
      envelope(taskResponse({ status: 'completed', terminal: true, result: toolResponse() })),
    );

    const task = await frege.tasks.get('tsk_1');

    expect(task.status).toBe('completed');
    if (task.status !== 'completed') throw new Error('unreachable');
    expect(task.result).toMatchObject({ tool_name: 'get_account_profile' });
  });

  it('narrows a failed task to its JSON-RPC error', async () => {
    const { frege } = testClient(() =>
      envelope(
        taskResponse({
          status: 'failed',
          terminal: true,
          status_message: 'connection refused',
          error: { code: -32603, message: 'connection refused' },
        }),
      ),
    );

    const task = await frege.tasks.get('tsk_1');

    if (task.status !== 'failed') throw new Error('unreachable');
    expect(task.error.code).toBe(-32603);
    expect(task.error.message).toBe('connection refused');
  });

  it('polls until terminal, honouring the server poll interval', async () => {
    const seen: Task[] = [];
    const { frege, calls } = testClient((_call, index) =>
      envelope(
        index < 2
          ? taskResponse({ poll_interval_ms: 1 })
          : taskResponse({ status: 'completed', terminal: true, result: toolResponse() }),
      ),
    );

    const task = await frege.tasks.wait('tsk_1', { onPoll: (t) => seen.push(t) });

    expect(task.status).toBe('completed');
    expect(calls).toHaveLength(3);
    expect(seen).toHaveLength(3);
    expect(calls[0]?.url).toBe('https://frege.test/v1/projects/3/tasks/tsk_1');
  });

  it('gives up on a task that never settles', async () => {
    const { frege } = testClient(() => envelope(taskResponse()));

    const error = (await frege.tasks
      .wait('tsk_1', { totalTimeoutMs: 15 })
      .catch((e: unknown) => e)) as FregeTimeoutError;

    expect(error).toBeInstanceOf(FregeTimeoutError);
    expect(error.timeoutMs).toBe(15);
  });

  it('spends the wait budget on the poll itself, not only on the gaps between polls', async () => {
    // The deadline used to be checked only between polls, so a 10ms wait sat
    // inside a 30-second request first and then reported "timed out after
    // 10ms" for something that took half a minute.
    const { frege } = testClient(hangUntilAborted, { timeoutMs: 30_000 });

    const startedAt = Date.now();
    const error = (await frege.tasks
      .wait('tsk_1', { totalTimeoutMs: 30 })
      .catch((e: unknown) => e)) as FregeTimeoutError;
    const took = Date.now() - startedAt;

    expect(error).toBeInstanceOf(FregeTimeoutError);
    expect(error.timeoutMs).toBe(30);
    // Both the number it reports and the time it actually spent are honest.
    expect(took).toBeLessThan(2000);
    expect(error.elapsedMs).toBeGreaterThanOrEqual(30);
    expect(error.message).toContain('waiting for task tsk_1');
  });

  it('says so when the task is parked on input this SDK cannot supply', async () => {
    const { frege } = testClient(() => envelope(taskResponse({ status: 'input_required' })));

    const error = (await frege.tasks
      .wait('tsk_1', { totalTimeoutMs: 15 })
      .catch((e: unknown) => e)) as FregeTimeoutError;

    expect(error.message).toContain('waiting for input');
  });

  it('invokeAndWait returns the upstream response once the task completes', async () => {
    const { frege } = testClient((_call, index) =>
      index === 0
        ? envelope(taskResponse(), 202)
        : envelope(
            taskResponse({
              status: 'completed',
              terminal: true,
              result: toolResponse({ tool_name: 'generate_statement', status_code: 201 }),
            }),
          ),
    );

    const result = await frege.invokeAndWait('generate_statement', { year: 2026 });

    expect(result.status).toBe(201);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ account_id: 'A-1', cash: 1234.56 });
  });

  it('invokeAndWait throws a task error when the task fails', async () => {
    const { frege } = testClient((_call, index) =>
      index === 0
        ? envelope(taskResponse(), 202)
        : envelope(
            taskResponse({
              status: 'failed',
              terminal: true,
              status_message: 'the upstream refused the credential',
              error: { code: -32603, message: 'the upstream refused the credential' },
            }),
          ),
    );

    const error = (await frege.invokeAndWait('generate_statement').catch((e: unknown) => e)) as FregeTaskError;

    expect(error).toBeInstanceOf(FregeTaskError);
    expect(error.kind).toBe('task');
    expect(error.task.status).toBe('failed');
    expect(error.message).toContain('the upstream refused the credential');
  });

  it('lists tasks and sends the limit', async () => {
    const { frege, calls } = testClient(() => envelope([taskResponse(), taskResponse({ task_id: 'tsk_2' })]));

    const tasks = await frege.tasks.list({ limit: 10 });

    expect(calls[0]?.url).toBe('https://frege.test/v1/projects/3/tasks?limit=10');
    expect(tasks.map((t) => t.taskId)).toEqual(['tsk_1', 'tsk_2']);
  });

  it('cancel posts and tolerates the empty 204 body', async () => {
    const { frege, calls } = testClient(() => new Response(null, { status: 204 }));

    await expect(frege.tasks.cancel('tsk_1')).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe('https://frege.test/v1/projects/3/tasks/tsk_1/cancel');
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('passes an unknown status through as its own branch instead of forging one', async () => {
    // Casting it into the closed union let `finished.result` typecheck on a
    // task that has no result, and let an exhaustive switch fall through every
    // arm with the compiler saying nothing.
    const { frege } = testClient(() => envelope(taskResponse({ status: 'quantum', terminal: true })));

    const task = await frege.tasks.wait('tsk_1');

    expect(task.status).toBe('unknown');
    if (task.status !== 'unknown') throw new Error('unreachable');
    expect(task.rawStatus).toBe('quantum');
    expect(task.terminal).toBe(true);
  });

  it('reports an unknown terminal status as a task failure, quoting the server word', async () => {
    const { frege } = testClient((_call, index) =>
      index === 0
        ? envelope(taskResponse(), 202)
        : envelope(taskResponse({ status: 'expired', terminal: true, status_message: '' })),
    );

    const error = (await frege.invokeAndWait('generate_statement').catch((e: unknown) => e)) as FregeTaskError;

    expect(error).toBeInstanceOf(FregeTaskError);
    expect(error.message).toContain('expired');
  });

  it('rejects a task payload that is not a task', async () => {
    const { frege } = testClient(() => envelope({ status: 'working' }));

    await expect(frege.tasks.get('tsk_1')).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('rejects a task whose timestamps cannot be read, rather than handing back an Invalid Date', async () => {
    const { frege } = testClient(() => envelope(taskResponse({ created_at: null })));

    await expect(frege.tasks.get('tsk_1')).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('keeps an unknown non-terminal status pollable', async () => {
    const { frege } = testClient(() => envelope(taskResponse({ status: 'queued', terminal: false })));

    const task = await frege.tasks.get('tsk_1');

    expect(task.status).toBe('unknown');
    expect(task.terminal).toBe(false);
  });

  it('narrows a cancelled task', async () => {
    const { frege } = testClient(() => envelope(taskResponse({ status: 'cancelled', terminal: true })));

    const task = await frege.tasks.get('tsk_1');

    expect(task.status).toBe('cancelled');
    expect(task.terminal).toBe(true);
  });

  it('hands a failing poll straight back instead of dressing it as a timeout', async () => {
    const { frege } = testClient(() => apiError(404, 'not_found', 'no such task'));

    await expect(frege.tasks.wait('tsk_1', { totalTimeoutMs: 5000 })).rejects.toMatchObject({
      kind: 'api',
      status: 404,
    });
  });

  it('stops a wait when the caller aborts', async () => {
    const controller = new AbortController();
    const onPoll = vi.fn(() => {
      controller.abort(new Error('shutting down'));
    });
    const { frege } = testClient(() => envelope(taskResponse({ poll_interval_ms: 5000 })));

    await expect(frege.tasks.wait('tsk_1', { signal: controller.signal, onPoll })).rejects.toThrow('shutting down');
    expect(onPoll).toHaveBeenCalledTimes(1);
  });
});
