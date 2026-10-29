import { ApiError, api, authHeaders } from '../api.js';
import { submitCommands } from '../platform.js';
import type { DocumentFailure, DocumentReceipt, DocumentTransport, DocumentWrite, ResourceDocument } from './types.js';

const resourcePath = '/api/v1/library/resources';
export function loadResource(id: string, revision?: number) {
  return api<ResourceDocument>(`${resourcePath}/${encodeURIComponent(id)}${revision ? `?revision=${revision}` : ''}`);
}
function rejection(error: unknown): DocumentFailure | null {
  if (!(error instanceof ApiError) || !error.status || error.status >= 500) return null;
  return { code: error.code ?? 'SAVE_REJECTED', message: error.message, status: error.status };
}

/** Existing HTTP/relay/auth helpers remain the only network path; every phase rechecks the captured scope. */
export function documentTransport(isActive: () => boolean): DocumentTransport {
  const assertScope = () => { if (!isActive()) throw new ApiError('The document workspace changed.', 'SCOPE_CHANGED', 409); };
  return {
    async send(write: DocumentWrite) {
      try {
        assertScope();
        const result = await api<ResourceDocument & { requestId: string }>(write.resourceId ? `${resourcePath}/${encodeURIComponent(write.resourceId)}/content` : resourcePath, {
          method: write.resourceId ? 'PUT' : 'POST', body: write.bodyJson,
          headers: { 'X-Request-ID': write.requestId }, signal: AbortSignal.timeout(15_000),
        });
        return { kind: 'success', receipt: { requestId: result.requestId ?? write.requestId, resourceId: result.id, revision: result.revision, contentHash: result.contentHash, organizationRevision: result.organizationRevision } };
      } catch (error) {
        const denied = rejection(error);
        return denied ? { kind: 'rejected', error: denied } : { kind: 'unknown' };
      }
    },
    async organize(write) {
      try {
        assertScope();
        const result = await api<ResourceDocument & { requestId: string }>(`${resourcePath}/${encodeURIComponent(write.resourceId)}/organization`, {
          method: 'PATCH', body: write.bodyJson, headers: { 'X-Request-ID': write.requestId }, signal: AbortSignal.timeout(15_000),
        });
        return { kind: 'success', receipt: { requestId: result.requestId ?? write.requestId, resourceId: result.id, revision: result.revision, contentHash: result.contentHash, organizationRevision: result.organizationRevision } };
      } catch (error) {
        const denied = rejection(error);
        return denied ? { kind: 'rejected', error: denied } : { kind: 'unknown' };
      }
    },
    async receipt(requestId) {
      try {
        assertScope();
        const receipt = await api<DocumentReceipt>(`${resourcePath}/receipts/${encodeURIComponent(requestId)}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
        assertScope();
        return { kind: 'found', receipt };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return { kind: 'missing' };
        const denied = rejection(error);
        return denied ? { kind: 'rejected', error: denied } : { kind: 'unknown' };
      }
    },
    async read(resourceId) { assertScope(); const result = await loadResource(resourceId); assertScope(); return result; },
    async upload(upload, file, context, checkpoint) {
      assertScope();
      const opened = upload.uploadId
        ? await api<{ id: string; state: string; materialId?: string | null; resultRevision?: number | null }>(`/api/v1/library/uploads/${encodeURIComponent(upload.uploadId)}`)
        : await api<{ id: string; state: string; materialId?: string | null; resultRevision?: number | null }>('/api/v1/library/uploads', {
          method: 'POST', body: JSON.stringify({ requestKey: upload.requestId, fileName: upload.fileName, mimeType: upload.mimeType, size: upload.size }),
        });
      assertScope();
      await checkpoint(opened.id);
      if (opened.state === 'committed' && opened.materialId) {
        return { resourceId: opened.materialId, revision: opened.resultRevision ?? (await loadResource(opened.materialId)).revision };
      }
      if (opened.state !== 'ready') {
        assertScope();
        const response = await fetch(`/api/v1/library/uploads/${encodeURIComponent(opened.id)}/content`, {
          method: 'PUT', body: file, credentials: 'include', headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream' }, signal: AbortSignal.timeout(120_000),
        });
        const result = await response.json().catch(() => null) as { data?: unknown; error?: { message?: string; code?: string }; code?: string } | null;
        if (!response.ok || !result?.data) throw new ApiError(result?.error?.message ?? 'Attachment upload failed.', result?.code ?? result?.error?.code, response.status);
      }
      assertScope();
      const committed = await submitCommands([{ kind: 'material.create', input: {
        uploadId: opened.id, duplicateAction: 'create', topicId: context.topicId, folderId: context.folderId ?? null, managed: context.managed ?? true, taskIds: [],
      } }], `${upload.requestId}:commit`);
      if (committed.status !== 'applied') throw new ApiError('Attachment has not been committed.', 'ATTACHMENT_NOT_COMMITTED', 409);
      const resource = committed.results?.[0] as { id?: string; revision?: number } | undefined;
      if (!resource?.id || !resource.revision) throw new Error('Attachment commit did not return a resource version.');
      return { resourceId: resource.id, revision: resource.revision };
    },
  };
}
