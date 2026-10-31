import { inspectRichDocument, type RichBlock, type RichDocument } from '../../../../server/src/domain/document-content.js';
import { ApiError, api } from '../api.js';
import { isEditorRuntimeActive } from '../task-editor-runtime.js';
import { loadResource } from './api.js';
import type { DocumentSnapshot, ResourceDocument } from './types.js';
import type { RelativeReference } from './markdown-assets.js';

export type SaveAsFormat = 'markdown' | 'text';
type ConversionRequest = {
  requestId: string; title: string; format: SaveAsFormat; content: string;
  topicId: string | null; folderId: string | null; relativeReferences: RelativeReference[];
  conversionSource: { resourceId: string; revision: number };
};

export function saveAsFormats(resource: ResourceDocument | undefined): SaveAsFormat[] {
  if (!resource || resource.supported === false) return [];
  if (resource.format === 'richdoc-v1') return inspectedSupported(resource) ? ['markdown', 'text'] : [];
  return resource.format === 'text' ? ['markdown'] : resource.format === 'markdown' ? ['text'] : [];
}

/**
 * The save-as entry renders with every editor snapshot, and each poll returns a new copy of the same version,
 * so a version is inspected once per id, revision and content hash rather than per object.
 */
const inspected = new Map<string, boolean>();
function inspectedSupported(resource: ResourceDocument) {
  const key = resource.revision && resource.contentHash ? JSON.stringify([resource.id, resource.revision, resource.contentHash]) : null;
  const cached = key ? inspected.get(key) : undefined;
  if (cached !== undefined) return cached;
  const supported = inspectRichDocument(resource.content).supported;
  if (key) { if (inspected.size > 200) inspected.clear(); inspected.set(key, supported); }
  return supported;
}

export function canSaveDocumentAs(resource: ResourceDocument | undefined, snapshot?: DocumentSnapshot) {
  if (!resource || !saveAsFormats(resource).length || !resource.revision) return false;
  if (!snapshot) return true;
  return snapshot.status === 'saved' && snapshot.resourceId === resource.id && snapshot.revision === resource.revision
    && !snapshot.conflict && !snapshot.error && snapshot.staleBranches.length === 0
    && snapshot.uploads.every((upload) => upload.state === 'ready' || upload.state === 'removed');
}

function plainBlocks(blocks: RichBlock[], pathFor: (id: string, revision: number) => string): string {
  return blocks.map((block) => {
    const text = (block.text ?? []).map((run) => { const link = run.marks?.find((mark) => mark.kind === 'link')?.href; return run.break ? '\n' : `${run.text}${link ? ` (${link})` : ''}`; }).join('');
    if (block.kind === 'image' || block.kind === 'file') return `${block.label || block.alt || block.kind}${block.caption ? ` — ${block.caption}` : ''} (${pathFor(block.target!.resourceId, block.target!.revision)})`;
    if (block.kind === 'tableRow') return (block.children ?? []).map((cell) => plainBlocks(cell.children ?? [], pathFor).replace(/\n/g, ' ')).join('\t');
    if (block.kind === 'horizontalRule') return '---';
    const children = plainBlocks(block.children ?? [], pathFor);
    return `${block.kind === 'taskItem' ? block.checked ? '[x] ' : '[ ] ' : ''}${[text, children].filter(Boolean).join('\n')}`;
  }).join('\n');
}

/** This conversion creates a copy; it never normalizes the source document or source text. */
export async function convertDocumentCopy(resource: ResourceDocument, format: SaveAsFormat) {
  if (!saveAsFormats(resource).includes(format)) throw new Error('DOCUMENT_CONVERSION_UNSUPPORTED');
  if (typeof resource.content === 'string') return { content: resource.content, relativeReferences: [] as RelativeReference[] };
  const references: RelativeReference[] = [];
  const pathFor = (resourceId: string, revision: number) => {
    let reference = references.find((entry) => entry.resourceId === resourceId && entry.revision === revision);
    if (!reference) { reference = { path: `assets/resource-${references.length + 1}`, resourceId, revision }; references.push(reference); }
    return reference.path;
  };
  if (format === 'text') return { content: plainBlocks(resource.content.blocks, (id, revision) => `wwa-material:${id} · v${revision}`), relativeReferences: [] as RelativeReference[] };
  // The shared exporter emits raw HTML tables. Application Markdown intentionally blocks raw HTML,
  // so flatten tables explicitly to code text instead of silently dropping their cells on reading.
  const markdownBlocks = (blocks: RichBlock[]): RichBlock[] => blocks.map((block) => block.kind === 'table'
    ? { id: block.id, kind: 'codeBlock', text: [{ text: plainBlocks(block.children ?? [], pathFor) }] }
    : { ...block, ...(block.children ? { children: markdownBlocks(block.children) } : {}) });
  const document: RichDocument = { ...resource.content, blocks: markdownBlocks(resource.content.blocks) };
  const { readableCopies } = await import('./bundle.js');
  return { content: readableCopies(document, pathFor).markdown, relativeReferences: references };
}

const journalKey = (scope: string, resource: Pick<ResourceDocument, 'id' | 'revision'>) => `dovun.documents.save-as:${JSON.stringify([scope, resource.id, resource.revision])}`;
export function pendingSaveAs(scope: string, resource: Pick<ResourceDocument, 'id' | 'revision'>): ConversionRequest | null {
  const json = localStorage.getItem(journalKey(scope, resource));
  if (!json) return null;
  const pending = JSON.parse(json) as ConversionRequest;
  if (typeof pending.requestId !== 'string' || typeof pending.title !== 'string' || typeof pending.content !== 'string' || !['markdown', 'text'].includes(pending.format)
    || pending.conversionSource?.resourceId !== resource.id || pending.conversionSource?.revision !== resource.revision) throw new Error('DOCUMENT_CONVERSION_JOURNAL_INVALID');
  return pending;
}

/** A lost reply retains the exact request. Reopening this conversion resumes it instead of creating another copy. */
export async function saveDocumentAs(scope: string, source: ResourceDocument, format: SaveAsFormat, title: string) {
  const assertScope = () => { if (!isEditorRuntimeActive(scope)) throw new Error('DOCUMENT_SCOPE_CHANGED'); };
  assertScope();
  const key = journalKey(scope, source);
  let pending = pendingSaveAs(scope, source);
  if (pending && (pending.format !== format || pending.title !== title.trim())) throw new Error('DOCUMENT_CONVERSION_PENDING');
  if (!pending) {
    // Read the immutable version again: the dialog cannot grant access from stale cache data.
    const current = await loadResource(source.id, source.revision); assertScope();
    const converted = await convertDocumentCopy(current, format); assertScope();
    pending = { requestId: crypto.randomUUID(), title: title.trim(), format, ...converted, topicId: current.topicId ?? null, folderId: current.folderId ?? null, conversionSource: { resourceId: current.id, revision: current.revision } };
    localStorage.setItem(key, JSON.stringify(pending));
  }
  try {
    const result = await api<ResourceDocument>('/api/v1/library/resources', { method: 'POST', body: JSON.stringify(pending), signal: AbortSignal.timeout(15_000) });
    assertScope(); localStorage.removeItem(key); return result;
  } catch (error) {
    if (error instanceof ApiError && error.status && error.status >= 400 && error.status < 500) localStorage.removeItem(key);
    throw error;
  }
}
