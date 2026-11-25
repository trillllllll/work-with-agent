import { randomUUID } from 'node:crypto';

let cursor = randomUUID();
const waiters = new Map<string, Set<() => void>>();

export function harnessWakeCursor() { return cursor; }

export function notifyHarnessNode(nodeId: string) {
  cursor = randomUUID();
  for (const finish of waiters.get(nodeId) ?? []) finish();
}

export function waitForHarnessWork(nodeId: string, after: string, delay: number, signal: AbortSignal) {
  if (after !== cursor || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const waiting = waiters.get(nodeId) ?? new Set<() => void>();
    waiters.set(nodeId, waiting);
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      waiting.delete(finish);
      if (!waiting.size) waiters.delete(nodeId);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    waiting.add(finish);
    signal.addEventListener('abort', finish, { once: true });
  });
}
