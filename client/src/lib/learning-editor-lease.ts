import { useCallback, useEffect, useId, useSyncExternalStore } from 'react';

type Entry = { owner: string; ready: boolean; dropped: boolean; pending: number; release?: () => void };
const editors = new Map<string, Entry>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function releaseIfIdle(key: string, entry: Entry) {
  if (!entry.dropped || entry.pending || editors.get(key) !== entry) return;
  editors.delete(key); entry.release?.(); notify();
}

/** One writable view per durable recovery key. An unmounted view keeps ownership
 * until its pending I/O settles, so the next view sees the exact retry request. */
export function useLearningEditorLease(scope: string, resource: string) {
  const key = JSON.stringify([scope, resource]);
  const owner = useId();
  const acquire = useCallback(() => {
    if (editors.has(key)) return;
    const next: Entry = { owner, ready: false, dropped: false, pending: 0 };
    editors.set(key, next); notify();
    if (!navigator.locks) { next.ready = true; notify(); return; }
    void navigator.locks.request(`dovun-learning:${key}`, { ifAvailable: true }, async lock => {
      if (!lock || next.dropped || editors.get(key) !== next) {
        if (editors.get(key) === next) { editors.delete(key); notify(); }
        return;
      }
      await new Promise<void>(resolve => {
        next.release = resolve; next.ready = true;
        // The snapshot is the owner/status string below; mutating this entry is observable via notify.
        notify();
      });
    }).catch(() => { if (editors.get(key) === next) { editors.delete(key); notify(); } });
  }, [key, owner]);
  // A scalar snapshot changes when the native lock becomes ready, even though the entry is stable.
  const status = useSyncExternalStore(subscribe, () => { const value = editors.get(key); return value ? `${value.owner}:${value.ready}` : ''; }, () => '');
  useEffect(() => { acquire(); return () => {
    const current = editors.get(key);
    if (current?.owner === owner) { current.dropped = true; releaseIfIdle(key, current); }
  }; }, [acquire, key, owner]);
  const run = useCallback(async <T,>(operation: () => Promise<T>): Promise<T> => {
    const current = editors.get(key);
    if (!current || current.owner !== owner || !current.ready || current.dropped) throw new Error('Learning editor is no longer active');
    current.pending++;
    try { return await operation(); }
    finally { current.pending--; releaseIfIdle(key, current); }
  }, [key, owner]);
  return { owned: status === `${owner}:true`, acquire, run };
}
export type LearningEditorLease = ReturnType<typeof useLearningEditorLease>;
