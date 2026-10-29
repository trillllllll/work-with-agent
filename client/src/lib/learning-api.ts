import { api, ApiError } from './api.js';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { EditorRuntime } from './task-editor-runtime.js';
import { t } from '../i18n/index.js';
import { readLearningRecord, writeLearningRecord, pruneFinishedLearningCaches } from './learning-storage.js';
export type * from '../../../server/src/domain/learning-practice.js';
import type { LearningOverviewView, PracticeMutation, PracticeSessionView } from '../../../server/src/domain/learning-practice.js';

export const learningKey = (scope: string, ...parts: unknown[]) => ['learning-workflow', scope, ...parts];
/** Probe a collection endpoint: a missing individual session/job never means an old server. */
export async function loadLearningOverview(scope: string): Promise<LearningOverviewView | null> {
  const assertScope = () => { if (EditorRuntime.current()?.scopeKey !== scope) throw new ApiError(t('chat:errors.workspaceChanged'), 'WORKSPACE_CHANGED', 409); };
  assertScope();
  try {
    const overview = await api<LearningOverviewView>('/api/v1/learning/overview');
    assertScope();
    return overview;
  } catch (error) {
    assertScope();
    if (error instanceof ApiError && [404, 405, 501].includes(error.status ?? 0)) return null;
    throw error;
  }
}
export const learningOverviewOptions = (scope: string) => queryOptions({
  queryKey: learningKey(scope, 'overview'), queryFn: () => loadLearningOverview(scope), staleTime: 30_000,
  retry: (count, error) => count < 2 && (!(error instanceof ApiError) || !error.status || error.status >= 500),
});
export function useLearningCapabilities(scope: string) {
  const overview = useQuery(learningOverviewOptions(scope));
  return { overview, unsupported: overview.data === null };
}
export function learningWrite<T extends object>(path: string, input: object) {
  return api<PracticeMutation<T>>(`/api/v1/learning${path}`, { method: 'POST', body: JSON.stringify(input) });
}
export function isLearningNetworkFailure(error: unknown) {
  return !(error instanceof ApiError) || error.status === undefined || error.status === 0 || error.status >= 500;
}
export async function loadPracticeSession(scope: string, id: string): Promise<{ session: PracticeSessionView; offline: boolean; storageFailed?: boolean }> {
  const assertScope = () => { if (EditorRuntime.current()?.scopeKey !== scope) throw new ApiError(t('chat:errors.workspaceChanged'), 'WORKSPACE_CHANGED', 409); };
  try {
    assertScope();
    const session = await api<PracticeSessionView>(`/api/v1/learning/practice/sessions/${encodeURIComponent(id)}`);
    assertScope();
    let storageFailed = false;
    try {
      try { await writeLearningRecord(scope, 'session', id, session); }
      catch {
        if (!await pruneFinishedLearningCaches(scope, id, true)) throw new Error('No recoverable cache space');
        await writeLearningRecord(scope, 'session', id, session);
      }
      if (session.state === 'finished') await pruneFinishedLearningCaches(scope, id);
    } catch { storageFailed = true; }
    return { session, offline: false, storageFailed };
  } catch (error) {
    // Authentication and deleted/invalid resources must never be disguised as an offline cache hit.
    if (!isLearningNetworkFailure(error)) throw error;
    assertScope();
    const session = await readLearningRecord<PracticeSessionView>(scope, 'session', id).catch(() => undefined);
    if (!session) throw error;
    return { session, offline: true };
  }
}
export const practiceAnswerEqual = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
