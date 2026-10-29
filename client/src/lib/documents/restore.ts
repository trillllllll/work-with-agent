import { ApiError, api } from '../api.js';
import { isEditorRuntimeActive } from '../task-editor-runtime.js';
import type { ResourceDocument } from './types.js';

type RestoreRequest = { requestId: string; expectedRevision: number; sourceRevision: number };

/** A lost reply must retry the same immutable restore request, including after refresh. */
export async function restoreResourceVersion(scopeKey: string, resourceId: string, sourceRevision: number, expectedRevision: number) {
  const assertScope = () => { if (!isEditorRuntimeActive(scopeKey)) throw new ApiError('The document workspace changed.', 'SCOPE_CHANGED', 409); };
  assertScope();
  const key = `dovun.documents.restore:${JSON.stringify([scopeKey, resourceId, sourceRevision])}`;
  const saved = localStorage.getItem(key);
  const pending = saved ? JSON.parse(saved) as RestoreRequest : null;
  if (pending && (typeof pending.requestId !== 'string' || !Number.isInteger(pending.expectedRevision) || pending.sourceRevision !== sourceRevision)) throw new Error('The saved version restore request is invalid.');
  const body = pending ?? { requestId: crypto.randomUUID(), expectedRevision, sourceRevision };
  localStorage.setItem(key, JSON.stringify(body));
  try {
    const restored = await api<ResourceDocument>(`/api/v1/library/resources/${encodeURIComponent(resourceId)}/restore`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    assertScope();
    localStorage.removeItem(key);
    return restored;
  } catch (error) {
    // Rejections cannot have committed. Unknown network/server outcomes retain the exact request.
    if (error instanceof ApiError && error.status && error.status >= 400 && error.status < 500 && error.code !== 'SCOPE_CHANGED') localStorage.removeItem(key);
    throw error;
  }
}
