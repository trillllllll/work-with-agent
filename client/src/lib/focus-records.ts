import { networkApiMutation, type FocusSession } from './api.js';

export type FocusSessionInput = Omit<FocusSession, 'id' | 'createdAt'>;
export const focusRecordKind = 'focus-session';

const recordFields = ['taskId', 'kind', 'startedAt', 'endedAt', 'durationMinutes', 'plannedMinutes', 'completed'] as const;
const localLocks = new Map<string, Promise<void>>();

export async function withFocusRecordLock(scope: string, id: string, work: () => Promise<void>) {
  const key = `dovun-focus:${JSON.stringify([scope, id])}`;
  if (navigator.locks) {
    await navigator.locks.request(key, work);
    return;
  }
  const job = (localLocks.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  localLocks.set(key, job);
  try {
    await job;
  } finally {
    if (localLocks.get(key) === job) localLocks.delete(key);
  }
}

/** The current server does not accept a request ID for focus records. Read live history before retrying. */
export async function hasSavedFocusRecord(input: FocusSessionInput) {
  const day = input.startedAt.slice(0, 10);
  const params = new URLSearchParams({ from: day, to: day, limit: '500' });
  if (input.taskId) params.set('taskId', input.taskId);
  const { data } = await networkApiMutation<FocusSession[]>(`/api/focus-sessions?${params}`, { cache: 'no-store' });
  return data.some((session) => recordFields.every((field) => session[field] === input[field]));
}
