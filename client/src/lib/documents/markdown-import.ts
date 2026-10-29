import { api } from '../api.js';
import { isEditorRuntimeActive } from '../task-editor-runtime.js';
import type { UploadRecord } from '../../components/library/upload.js';
import { loadResource } from './api.js';
import { markdownAssetPaths, resolveBatchAsset, type RelativeReference } from './markdown-assets.js';

export async function associateMarkdownImports(records: UploadRecord[], scopeKey: string) {
  const resources = new Map<string, { resourceId: string; revision: number }>();
  for (const record of records) {
    if (!isEditorRuntimeActive(scopeKey)) throw new Error('DOCUMENT_SCOPE_INACTIVE');
    if (record.status !== 'done' || !record.uploadId) continue;
    const upload = await api<{ materialId?: string; state: string }>(`/api/v1/library/uploads/${encodeURIComponent(record.uploadId)}`);
    if (upload.state !== 'committed' || !upload.materialId) continue;
    const resource = await loadResource(upload.materialId);
    resources.set(record.relativePath, { resourceId: resource.id, revision: resource.revision });
  }
  let missing = 0;
  for (const record of records.filter((item) => /\.md(?:own|arkdown)?$/i.test(item.name))) {
    const target = resources.get(record.relativePath); if (!target) continue;
    if (!isEditorRuntimeActive(scopeKey)) throw new Error('DOCUMENT_SCOPE_INACTIVE');
    const resource = await loadResource(target.resourceId);
    if (resource.format !== 'markdown' || typeof resource.content !== 'string') continue;
    const relativeReferences: RelativeReference[] = [];
    for (const path of markdownAssetPaths(resource.content)) {
      const key = resolveBatchAsset(record.relativePath, path); const mapped = key ? resources.get(key) : undefined;
      if (mapped) relativeReferences.push({ path, ...mapped }); else missing += 1;
    }
    if (!relativeReferences.length) continue;
    const payload = { expectedRevision: resource.revision, format: 'markdown', content: resource.content, relativeReferences };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload)));
    const requestId = `md-assets:${resource.id}:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    // Identical retry reuses the receipt; an intervening edit fails CAS without replacing that edit.
    if (!isEditorRuntimeActive(scopeKey)) throw new Error('DOCUMENT_SCOPE_INACTIVE');
    await api(`/api/v1/library/resources/${encodeURIComponent(resource.id)}/content`, { method: 'PUT', body: JSON.stringify({ requestId, ...payload }) });
  }
  return { missing };
}
