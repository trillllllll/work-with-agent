const listeners = new Set<() => void>();

export function notifyRuns() {
  for (const listener of [...listeners]) listener();
}

export function waitRuns(timeoutMs = 200) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      listeners.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    listeners.add(done);
  });
}
