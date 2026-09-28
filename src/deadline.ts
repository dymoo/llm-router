// Only the controller is captured by the timer. Call clear() when the operation ends,
// including when a stream finishes after its Response has already been returned.
export function createDeadline(timeoutMs: number, signals: readonly AbortSignal[] = []) {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      ),
    timeoutMs,
  );
  timer.unref();
  return {
    signal:
      signals.length === 0 ? controller.signal : AbortSignal.any([...signals, controller.signal]),
    clear: () => clearTimeout(timer),
  };
}
