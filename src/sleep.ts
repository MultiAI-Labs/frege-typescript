/**
 * `setTimeout` as a promise that a caller's AbortSignal can cut short.
 *
 * Both places this SDK waits — retry backoff and task polling — must stay
 * cancellable, or an abort would only take effect after the sleep.
 *
 * The timer is deliberately NOT unref'd. Someone is awaiting the call this
 * sleep sits inside, so it is exactly as much a reason to keep the process
 * alive as an in-flight request is. Unref'ing it lets Node drain and exit
 * mid-backoff in a cron job, a CLI, or a Lambda handler: the awaited promise
 * never settles, nothing is logged, and the exit code is 0 — a dropped call
 * that looks like a successful one.
 */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      // The reason is the caller's to define — `abort('stop')` throws 'stop',
      // not something this SDK dressed up as an Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Node's timers hold the event loop open; the DOM's have no `unref`.
 *
 * Right for a timer that only *watches* work someone else is already keeping
 * the process alive for — the request-timeout timer, which sits beside an
 * in-flight fetch. Wrong for a timer that IS the work; see {@link sleep}.
 */
export function unrefTimer(timer: unknown): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref: () => void }).unref();
  }
}
