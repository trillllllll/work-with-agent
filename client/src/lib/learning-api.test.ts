import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
const state = vi.hoisted(() => ({ scope: 'a' }));
vi.mock('./task-editor-runtime.js', () => ({ EditorRuntime: { current: () => ({ scopeKey: state.scope }) } }));
vi.mock('./api.js', async importOriginal => ({ ...await importOriginal<typeof import('./api.js')>(), api: vi.fn() }));
vi.mock('./learning-storage.js', () => ({ readLearningRecord: vi.fn(), writeLearningRecord: vi.fn(), pruneFinishedLearningCaches: vi.fn() }));
import { api, ApiError } from './api.js';
import { readLearningRecord, writeLearningRecord } from './learning-storage.js';
import { learningKey, learningOverviewOptions, loadLearningOverview, loadPracticeSession } from './learning-api.js';

afterEach(() => { state.scope = 'a'; vi.resetAllMocks(); });
it('does not send an old workspace query after switching scope', async () => {
  state.scope = 'b';
  await expect(loadPracticeSession('a', 'session')).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' });
  expect(api).not.toHaveBeenCalled();
  expect(readLearningRecord).not.toHaveBeenCalled();
});
it('does not cache a late response under the previous workspace after scope changes', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = loadPracticeSession('a', 'session');
  state.scope = 'b';
  finish({ id: 'session', state: 'active', items: [] });
  await expect(pending).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' });
  expect(writeLearningRecord).not.toHaveBeenCalled();
  expect(readLearningRecord).not.toHaveBeenCalled();
});
it('uses downloaded practice only for a network failure in the same scope, never for rejected access', async () => {
  const cached = { id: 'session', state: 'active', items: [] };
  vi.mocked(readLearningRecord).mockResolvedValue(cached);
  vi.mocked(api).mockRejectedValueOnce(new ApiError('Unavailable', 'UNAVAILABLE', 503));
  expect(await loadPracticeSession('a', 'session')).toEqual({ session: cached, offline: true });
  vi.mocked(readLearningRecord).mockClear();
  vi.mocked(api).mockRejectedValueOnce(new ApiError('Expired', 'UNAUTHORIZED', 401));
  await expect(loadPracticeSession('a', 'session')).rejects.toMatchObject({ status: 401 });
  expect(readLearningRecord).not.toHaveBeenCalled();
});
it.each([404, 405, 501])('treats overview HTTP %s as unsupported without touching saved practice', async status => {
  vi.mocked(api).mockRejectedValueOnce(new ApiError('Legacy endpoint unavailable', undefined, status));
  const client = new QueryClient();
  try {
    expect(await client.fetchQuery(learningOverviewOptions('a'))).toBeNull();
    expect(await client.fetchQuery(learningOverviewOptions('a'))).toBeNull();
    expect(api).toHaveBeenCalledTimes(1);
    expect(readLearningRecord).not.toHaveBeenCalled();
    expect(writeLearningRecord).not.toHaveBeenCalled();
  } finally { client.clear(); }
});
it.each([401, 403, 409, 500, 503])('does not confuse overview HTTP %s with unsupported capability', async status => {
  const error = new ApiError('Request failed', undefined, status);
  vi.mocked(api).mockRejectedValueOnce(error);
  await expect(loadLearningOverview('a')).rejects.toBe(error);
});
it('keeps a transport failure distinct from an unsupported server', async () => {
  const error = new TypeError('Network unavailable');
  vi.mocked(api).mockRejectedValueOnce(error);
  await expect(loadLearningOverview('a')).rejects.toBe(error);
});
it('isolates support by workspace and permits a server upgrade to be checked again', async () => {
  const supported = { sessions: [], pendingGenerationJobs: [], counts: { due: 0 }, resume: null, checkpoint: null };
  vi.mocked(api).mockRejectedValueOnce(new ApiError('Missing route', undefined, 404)).mockResolvedValue(supported);
  const client = new QueryClient();
  try {
    expect(await client.fetchQuery(learningOverviewOptions('a'))).toBeNull();
    state.scope = 'b';
    expect(await client.fetchQuery(learningOverviewOptions('b'))).toEqual(supported);
    expect(client.getQueryData(learningKey('a', 'overview'))).toBeNull();
    state.scope = 'a';
    await client.invalidateQueries({ queryKey: learningKey('a', 'overview') });
    expect(await client.fetchQuery(learningOverviewOptions('a'))).toEqual(supported);
  } finally { client.clear(); }
});
it('does not cache a late unsupported result after switching workspace', async () => {
  let fail!: (reason: unknown) => void;
  vi.mocked(api).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const pending = loadLearningOverview('a');
  state.scope = 'b';
  fail(new ApiError('Missing route', undefined, 404));
  await expect(pending).rejects.toMatchObject({ code: 'WORKSPACE_CHANGED' });
});
it('does not turn an individual missing session into a capability result or offline cache hit', async () => {
  vi.mocked(api).mockRejectedValueOnce(new ApiError('Session missing', 'NOT_FOUND', 404));
  await expect(loadPracticeSession('a', 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  expect(readLearningRecord).not.toHaveBeenCalled();
});
