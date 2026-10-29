import JSZip from 'jszip';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkStringify from 'remark-stringify';
import { assertWritableContent, canonicalContent, inspectRichDocument, safeDocumentLink, type DocumentContent, type RichBlock, type RichDocument } from '../../../../server/src/domain/document-content.js';
import { ApiError, api, authHeaders } from '../api.js';
import { EditorRuntime, isEditorRuntimeActive } from '../task-editor-runtime.js';
import { documentTransport, loadResource } from './api.js';
import type { DocumentFormat, DocumentReceipt, DocumentUpload, ResourceDocument } from './types.js';
import { relativeAssetPath, type RelativeReference } from './markdown-assets.js';

export const BUNDLE_BYTES = 128 * 1024 * 1024;
export const BUNDLE_RESOURCES = 100;
type BundleFile = { sha256: string; size: number };
type BundleResource = {
  key: string; sourceId: string; sourceRevision: number; title: string; format: DocumentFormat;
  schemaVersion: number | null; bodyPath: string; originalPath?: string; sourceOriginalPath?: string;
  fileName?: string; mimeType?: string; supported: boolean; supplementalContent?: string | null;
  relativeReferences?: RelativeReference[];
};
export type BundleManifest = { format: 'dovun-resource-bundle'; version: 1; root: string; resources: BundleResource[]; files: Record<string, BundleFile> };
type BundleData = { manifest: BundleManifest; files: Map<string, Uint8Array> };
const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(value);
async function sha256(value: Uint8Array) { const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(value).buffer); return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }
const safePath = (value: string) => /^[a-zA-Z0-9._/-]+$/.test(value) && !value.startsWith('/') && value.split('/').every((part) => part && part !== '.' && part !== '..');
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const markdownText = (value: string) => value.replace(/[\\`*_{}\[\]<>|]/g, '\\$&');
const sourceKey = (id: string, revision: number) => `${id}:${revision}`;

function readableMarkdown(source: string, references: RelativeReference[], pathFor: (reference: RelativeReference) => string) {
  const processor = unified().use(remarkParse).use(remarkStringify);
  const tree = processor.parse(source);
  const byPath = new Map(references.map((reference) => [reference.path, reference]));
  const queue: Array<{ type?: string; url?: string; children?: unknown[] }> = [tree];
  for (let index = 0; index < queue.length; index += 1) {
    if (index > 100_000) throw new Error('BUNDLE_MARKDOWN_TOO_COMPLEX');
    const node = queue[index];
    if (['image', 'link', 'definition'].includes(node.type ?? '') && typeof node.url === 'string') {
      const path = relativeAssetPath(node.url), reference = path ? byPath.get(path) : undefined;
      if (reference) node.url = pathFor(reference);
    }
    if (node.children) queue.push(...node.children as typeof queue);
  }
  return processor.stringify(tree);
}

/** Streaming reader rejects budget overruns before retaining all returned bytes. */
async function fetchBytes(url: string, limit: number, signal?: AbortSignal) {
  const response = await fetch(url, { credentials: 'include', headers: authHeaders(), signal: signal ?? AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`BUNDLE_RESOURCE_UNAVAILABLE (${response.status})`);
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('BUNDLE_BUDGET_EXCEEDED'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('BUNDLE_STREAM_UNAVAILABLE');
  let size = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength; if (size > limit) { await reader.cancel(); throw new Error('BUNDLE_BUDGET_EXCEEDED'); } chunks.push(result.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } return bytes;
}

/** The readable copies are explicit conversions. The schema bodies in resources/ remain authoritative. */
export function readableCopies(document: RichDocument, pathFor: (id: string, revision: number) => string) {
  const inline = (block: RichBlock, html: boolean) => (block.text ?? []).map((run) => {
    if (run.break) return html ? '<br>' : '  \n';
    let text = html ? escapeHtml(run.text) : markdownText(run.text);
    for (const mark of run.marks ?? []) {
      if (mark.kind === 'link' && mark.href && safeDocumentLink(mark.href)) text = html ? `<a href="${escapeHtml(mark.href)}">${text}</a>` : `[${text}](${mark.href.replace(/\)/g, '%29')})`;
      else if (mark.kind === 'bold') text = html ? `<strong>${text}</strong>` : `**${text}**`;
      else if (mark.kind === 'italic') text = html ? `<em>${text}</em>` : `*${text}*`;
      else if (mark.kind === 'strike') text = html ? `<s>${text}</s>` : `~~${text}~~`;
      else if (mark.kind === 'code') text = html ? `<code>${text}</code>` : `\`${text.replace(/`/g, '\\`')}\``;
    }
    return text;
  }).join('');
  const html = (block: RichBlock): string => {
    const children = (block.children ?? []).map(html).join('');
    const text = inline(block, true);
    if (block.kind === 'image') return `<figure><img src="${escapeHtml(pathFor(block.target!.resourceId, block.target!.revision))}" alt="${escapeHtml(block.alt ?? '')}"${block.width ? ` width="${block.width}"` : ''}>${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ''}</figure>`;
    if (block.kind === 'file') return `<p><a href="${escapeHtml(pathFor(block.target!.resourceId, block.target!.revision))}">${escapeHtml(block.label ?? 'File')}</a></p>`;
    if (block.kind === 'heading') return `<h${block.level}>${text}</h${block.level}>`;
    if (block.kind === 'codeBlock') return `<pre><code data-language="${escapeHtml(block.language ?? '')}">${escapeHtml((block.text ?? []).map((run) => run.text).join(''))}</code></pre>`;
    if (block.kind === 'horizontalRule') return '<hr>';
    const tag = ({ paragraph: 'p', bulletList: 'ul', orderedList: 'ol', listItem: 'li', taskList: 'ul', taskItem: 'li', blockquote: 'blockquote', table: 'table', tableRow: 'tr', tableCell: 'td', tableHeader: 'th' } as Record<string, string>)[block.kind] ?? 'div';
    const attrs = block.kind === 'tableCell' || block.kind === 'tableHeader' ? ` colspan="${block.colspan ?? 1}" rowspan="${block.rowspan ?? 1}"` : block.kind === 'orderedList' ? ` start="${block.start ?? 1}"` : '';
    return `<${tag}${attrs}>${block.kind === 'taskItem' ? block.checked ? '☑ ' : '☐ ' : ''}${text}${children}</${tag}>`;
  };
  const markdown = (block: RichBlock): string => {
    const text = inline(block, false), children = (block.children ?? []).map(markdown);
    if (block.kind === 'heading') return `${'#'.repeat(block.level ?? 1)} ${text}`;
    if (block.kind === 'image') return `![${markdownText(block.alt ?? '')}](${pathFor(block.target!.resourceId, block.target!.revision)})${block.caption ? `\n\n${markdownText(block.caption)}` : ''}`;
    if (block.kind === 'file') return `[${markdownText(block.label ?? 'File')}](${pathFor(block.target!.resourceId, block.target!.revision)})`;
    if (block.kind === 'codeBlock') {
      const code = (block.text ?? []).map((run) => run.text).join('');
      const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map((match) => match[0].length + 1)));
      return `${fence}${(block.language ?? '').replace(/[\r\n`]/g, '')}\n${code}\n${fence}`;
    }
    if (block.kind === 'horizontalRule') return '---';
    if (block.kind === 'blockquote') return children.join('\n\n').split('\n').map((line) => `> ${line}`).join('\n');
    if (block.kind === 'bulletList' || block.kind === 'orderedList' || block.kind === 'taskList') return children.map((child, index) => `${block.kind === 'orderedList' ? `${(block.start ?? 1) + index}.` : '-'} ${child.replace(/\n/g, '\n  ')}`).join('\n');
    if (block.kind === 'taskItem') return `[${block.checked ? 'x' : ' '}] ${children.join('\n\n')}`;
    // HTML tables preserve spans that Markdown pipe tables cannot express.
    if (block.kind === 'table') return html(block);
    return [text, ...children].filter(Boolean).join('\n\n');
  };
  return { markdown: document.blocks.map(markdown).join('\n\n'), html: document.blocks.map(html).join('\n') };
}

export async function exportResourceBundle(id: string, revision: number, signal?: AbortSignal): Promise<Blob> {
  const scopeKey = EditorRuntime.current()?.scopeKey;
  const assertScope = () => { signal?.throwIfAborted(); if (!scopeKey || !isEditorRuntimeActive(scopeKey)) throw new Error('DOCUMENT_SCOPE_CHANGED'); };
  assertScope();
  const zip = new JSZip(); const files = new Map<string, Uint8Array>();
  const resources: BundleResource[] = []; const sources = new Map<string, string>(); const documents = new Map<string, ResourceDocument>();
  let totalBytes = 0;
  const add = (path: string, bytes: Uint8Array) => { totalBytes += bytes.byteLength; if (totalBytes > BUNDLE_BYTES - 1024 * 1024) throw new Error('BUNDLE_BUDGET_EXCEEDED'); files.set(path, bytes); };
  const collect = async (resourceId: string, targetRevision: number): Promise<string> => {
    assertScope(); const identity = sourceKey(resourceId, targetRevision);
    const existing = sources.get(identity); if (existing) return existing;
    if (resources.length >= BUNDLE_RESOURCES) throw new Error('BUNDLE_RESOURCE_LIMIT');
    const key = `r${resources.length}`; sources.set(identity, key);
    const resource = await loadResource(resourceId, targetRevision);
    assertScope();
    const record: BundleResource = { key, sourceId: resourceId, sourceRevision: targetRevision, title: resource.title, format: resource.format, schemaVersion: resource.schemaVersion, supported: resource.supported !== false, bodyPath: `resources/${key}/body.json`, supplementalContent: resource.supplementalContent, ...(resource.format === 'markdown' ? { relativeReferences: structuredClone(resource.relativeReferences ?? []) } : {}) };
    resources.push(record); documents.set(key, resource);
    add(record.bodyPath, encode(JSON.stringify(resource.content)));
    if (resource.attachment || resource.format === 'binary') {
      const extension = (resource.attachment?.fileName ?? '').match(/\.([a-zA-Z0-9]{1,12})$/)?.[1] ?? 'bin';
      record.originalPath = `resources/${key}/original.${extension}`; record.fileName = resource.attachment?.fileName ?? resource.title; record.mimeType = resource.attachment?.mimeType ?? 'application/octet-stream';
      add(record.originalPath, await fetchBytes(`/api/v1/library/resources/${encodeURIComponent(resourceId)}/versions/${targetRevision}/original`, BUNDLE_BYTES - totalBytes, signal));
    }
    if (resource.hasSourceOriginal) {
      record.sourceOriginalPath = `resources/${key}/source-original.bin`;
      add(record.sourceOriginalPath, await fetchBytes(`/api/v1/library/resources/${encodeURIComponent(resourceId)}/versions/${targetRevision}/source-original`, BUNDLE_BYTES - totalBytes, signal));
    }
    if (resource.format === 'richdoc-v1') {
      const inspected = inspectRichDocument(resource.content); record.supported = inspected.supported;
      for (const reference of inspected.references) await collect(reference.resourceId, reference.revision);
    }
    for (const reference of record.relativeReferences ?? []) await collect(reference.resourceId, reference.revision);
    return key;
  };
  const root = await collect(id, revision);
  for (const record of resources) {
    const resource = documents.get(record.key)!;
    const relativePath = (target: string, version: number) => {
      const entry = resources.find((item) => item.key === sources.get(sourceKey(target, version)));
      if (!entry) throw new Error('BUNDLE_REFERENCE_MISSING');
      return entry.originalPath ? `../${entry.originalPath}` : `../readable/${entry.key}.html`;
    };
    let html: string, markdown: string;
    if (record.format === 'richdoc-v1' && record.supported) {
      const rendered = readableCopies(resource.content as RichDocument, relativePath); html = rendered.html; markdown = rendered.markdown;
    } else if (typeof resource.content === 'string') {
      const original = record.originalPath ? `../${record.originalPath}` : null;
      html = `${original ? `<p><a href="${original}">${escapeHtml(record.fileName ?? record.title)}</a></p>` : ''}<pre>${escapeHtml(resource.content)}</pre>`;
      markdown = `${original ? `[${markdownText(record.fileName ?? record.title)}](${original})\n\n` : ''}${record.format === 'markdown' ? readableMarkdown(resource.content, record.relativeReferences ?? [], (reference) => relativePath(reference.resourceId, reference.revision)) : resource.content}`;
    }
    else { html = `<pre>${escapeHtml(JSON.stringify(resource.content, null, 2))}</pre>`; markdown = JSON.stringify(resource.content, null, 2); }
    add(`readable/${record.key}.md`, encode(markdown));
    add(`readable/${record.key}.html`, encode(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'"><title>${escapeHtml(record.title)}</title><style>body{max-width:80ch;margin:3rem auto;padding:1rem;font:16px/1.6 system-ui;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:.5rem}pre{overflow:auto}</style></head><body><h1>${escapeHtml(record.title)}</h1>${html}</body></html>`));
  }
  add('index.html', encode(`<!doctype html><meta charset="utf-8"><title>Dovun document export</title><p><a href="readable/${root}.html">Open readable copy</a></p><p>Product schema and exact file versions are preserved in resources/ and verified by manifest.json. Markdown and HTML files are converted reading copies.</p>`));
  const manifest: BundleManifest = { format: 'dovun-resource-bundle', version: 1, root, resources, files: {} };
  for (const [path, bytes] of files) { assertScope(); manifest.files[path] = { size: bytes.byteLength, sha256: await sha256(bytes) }; zip.file(path, bytes); }
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }); assertScope(); return blob;
}

/** Validate central directory allocation before JSZip; reject ZIP64 and split archives. */
function archiveBudget(bytes: ArrayBuffer) {
  if (bytes.byteLength > BUNDLE_BYTES) throw new Error('BUNDLE_BUDGET_EXCEEDED');
  const view = new DataView(bytes); let end = -1;
  for (let cursor = bytes.byteLength - 22; cursor >= Math.max(0, bytes.byteLength - 65_557); cursor--) if (view.getUint32(cursor, true) === 0x06054b50) { end = cursor; break; }
  if (end < 0) throw new Error('INVALID_BUNDLE_ARCHIVE');
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true); let cursor = view.getUint32(end + 16, true), size = 0;
  if (count > 1000 || cursor + directorySize > end || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('BUNDLE_BUDGET_EXCEEDED');
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error('INVALID_BUNDLE_ARCHIVE');
    size += view.getUint32(cursor + 24, true); if (size > BUNDLE_BYTES) throw new Error('BUNDLE_BUDGET_EXCEEDED');
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  if (cursor > end) throw new Error('INVALID_BUNDLE_ARCHIVE');
}
function inflate(entry: JSZip.JSZipObject, limit: number) {
  return new Promise<Uint8Array>((resolve, reject) => {
    let size = 0; const chunks: Uint8Array[] = [];
    // JSZip 3.10.2 implements this bounded streaming API in zipObject.js; its declarations omit it.
    type InflateStream = { on(event: 'data', listener: (value: Uint8Array) => void): InflateStream; on(event: 'error', listener: (error: Error) => void): InflateStream; on(event: 'end', listener: () => void): InflateStream; pause(): void; resume(): void };
    const stream = (entry as JSZip.JSZipObject & { internalStream(type: 'uint8array'): InflateStream }).internalStream('uint8array');
    stream.on('data', (chunk: Uint8Array) => { size += chunk.byteLength; if (size > limit) { stream.pause(); reject(new Error('BUNDLE_BUDGET_EXCEEDED')); } else chunks.push(chunk); });
    stream.on('error', reject); stream.on('end', () => { const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; } resolve(bytes); }); stream.resume();
  });
}

export async function validateResourceBundle(input: Blob | ArrayBuffer): Promise<BundleData> {
  const bytes = input instanceof ArrayBuffer ? input : await input.arrayBuffer(); archiveBudget(bytes);
  const zip = await JSZip.loadAsync(bytes);
  for (const entry of Object.values(zip.files)) {
    const raw = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    if (!safePath(raw.replace(/\/$/, '')) || raw !== entry.name) throw new Error('UNSAFE_BUNDLE_PATH');
  }
  const manifestEntry = zip.file('manifest.json'); if (!manifestEntry) throw new Error('BUNDLE_MANIFEST_MISSING');
  const manifest = JSON.parse(decode(await inflate(manifestEntry, 1024 * 1024))) as BundleManifest;
  if (manifest.format !== 'dovun-resource-bundle' || manifest.version !== 1 || !Array.isArray(manifest.resources) || !manifest.resources.length || manifest.resources.length > BUNDLE_RESOURCES || !manifest.files || typeof manifest.files !== 'object') throw new Error('UNSUPPORTED_BUNDLE_MANIFEST');
  const keys = new Set<string>(), paths = new Set<string>(), identities = new Set<string>();
  for (const entry of manifest.resources) {
    if (!/^r\d+$/.test(entry.key) || keys.has(entry.key) || typeof entry.sourceId !== 'string' || !Number.isSafeInteger(entry.sourceRevision) || entry.sourceRevision < 1 || typeof entry.title !== 'string' || entry.title.length > 300 || !['richdoc-v1', 'markdown', 'text', 'binary'].includes(entry.format)) throw new Error('INVALID_BUNDLE_RESOURCE');
    if (identities.has(sourceKey(entry.sourceId, entry.sourceRevision))) throw new Error('DUPLICATE_BUNDLE_RESOURCE');
    keys.add(entry.key); identities.add(sourceKey(entry.sourceId, entry.sourceRevision));
    if (entry.relativeReferences !== undefined) {
      if (entry.format !== 'markdown' || !Array.isArray(entry.relativeReferences) || entry.relativeReferences.length > 1000) throw new Error('INVALID_BUNDLE_RELATIVE_REFERENCE');
      const aliases = new Set<string>();
      for (const reference of entry.relativeReferences) {
        if (!reference || typeof reference.path !== 'string' || relativeAssetPath(reference.path) !== reference.path || aliases.has(reference.path) || typeof reference.resourceId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(reference.resourceId) || !Number.isSafeInteger(reference.revision) || reference.revision < 1) throw new Error('INVALID_BUNDLE_RELATIVE_REFERENCE');
        aliases.add(reference.path);
      }
    }
    for (const path of [entry.bodyPath, entry.originalPath, entry.sourceOriginalPath].filter((item): item is string => Boolean(item))) { if (!safePath(path) || paths.has(path)) throw new Error('INVALID_BUNDLE_RESOURCE_PATH'); paths.add(path); }
  }
  if (!keys.has(manifest.root)) throw new Error('BUNDLE_ROOT_MISSING');
  const files = new Map<string, Uint8Array>(); let total = 0;
  for (const [path, metadata] of Object.entries(manifest.files)) {
    if (!safePath(path) || !metadata || !Number.isSafeInteger(metadata.size) || metadata.size < 0 || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new Error('INVALID_BUNDLE_FILE');
    total += metadata.size; if (total > BUNDLE_BYTES) throw new Error('BUNDLE_BUDGET_EXCEEDED');
    const entry = zip.file(path); if (!entry) throw new Error('BUNDLE_FILE_MISSING');
    const data = await inflate(entry, metadata.size);
    if (data.byteLength !== metadata.size || await sha256(data) !== metadata.sha256) throw new Error('BUNDLE_CHECKSUM_MISMATCH');
    files.set(path, data);
  }
  if (Object.keys(zip.files).some((path) => !zip.files[path].dir && path !== 'manifest.json' && !files.has(path))) throw new Error('BUNDLE_UNDECLARED_FILE');
  for (const entry of manifest.resources) {
    if (!files.has(entry.bodyPath) || entry.originalPath && !files.has(entry.originalPath) || entry.sourceOriginalPath && !files.has(entry.sourceOriginalPath)) throw new Error('BUNDLE_FILE_MISSING');
    const content = JSON.parse(decode(files.get(entry.bodyPath)!));
    if (entry.format !== 'binary') assertWritableContent(entry.format, content, entry.schemaVersion);
    else if (!entry.originalPath) throw new Error('BUNDLE_ORIGINAL_MISSING');
  }
  // Validate the entire dependency graph before creating any resources.
  const bySource = new Map(manifest.resources.map((entry) => [sourceKey(entry.sourceId, entry.sourceRevision), entry]));
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (entry: BundleResource) => {
    if (visited.has(entry.key)) return;
    if (visiting.has(entry.key)) throw new Error('BUNDLE_REFERENCE_CYCLE');
    visiting.add(entry.key);
    const references = [...(entry.format === 'richdoc-v1' ? inspectRichDocument(JSON.parse(decode(files.get(entry.bodyPath)!))).references : []), ...(entry.relativeReferences ?? [])];
    for (const ref of references) {
      const target = bySource.get(sourceKey(ref.resourceId, ref.revision)); if (!target) throw new Error('BUNDLE_REFERENCE_MISSING'); visit(target);
    }
    visiting.delete(entry.key); visited.add(entry.key);
  };
  manifest.resources.forEach(visit);
  return { manifest, files };
}

type ImportStep = { requestId: string; bodyJson?: string; uploadId?: string; result?: { resourceId: string; revision: number } };
type ImportJournal = { key: string; scopeKey: string; jobId: string; steps: Record<string, ImportStep> };
class ImportJournalStore {
  private database: Promise<IDBDatabase>;
  constructor() { this.database = new Promise((resolve, reject) => { const request = indexedDB.open('dovun-document-imports', 1); request.onupgradeneeded = () => request.result.createObjectStore('jobs', { keyPath: 'key' }); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('IMPORT_STORAGE_BLOCKED')); }); }
  async read(key: string) { const db = await this.database; return new Promise<ImportJournal | undefined>((resolve, reject) => { const tx = db.transaction('jobs'); const read = tx.objectStore('jobs').get(key); tx.oncomplete = () => resolve(read.result); tx.onerror = tx.onabort = () => reject(tx.error); }); }
  async write(journal: ImportJournal) { const db = await this.database; return new Promise<void>((resolve, reject) => { const tx = db.transaction('jobs', 'readwrite'); tx.objectStore('jobs').put(structuredClone(journal)); tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error); }); }
}

export async function importResourceBundle(file: Blob, scopeKey: string, options: { topicId?: string | null; folderId?: string | null; signal?: AbortSignal; newCopy?: boolean } = {}) {
  const assertScope = () => { options.signal?.throwIfAborted(); if (!isEditorRuntimeActive(scopeKey)) throw new Error('DOCUMENT_SCOPE_CHANGED'); };
  assertScope(); if (file.size > BUNDLE_BYTES) throw new Error('BUNDLE_BUDGET_EXCEEDED');
  const bytes = await file.arrayBuffer(), bundle = await validateResourceBundle(bytes);
  const digest = await sha256(new Uint8Array(bytes));
  const key = JSON.stringify([scopeKey, digest, options.topicId ?? null, options.folderId ?? null, ...(options.newCopy ? [crypto.randomUUID()] : [])]);
  const store = new ImportJournalStore();
  const journal = await store.read(key) ?? { key, scopeKey, jobId: crypto.randomUUID(), steps: {} };
  await store.write(journal);
  const transport = documentTransport(() => isEditorRuntimeActive(scopeKey));
  const bySource = new Map(bundle.manifest.resources.map((entry) => [sourceKey(entry.sourceId, entry.sourceRevision), entry]));
  const active = new Set<string>();
  // Deterministic request identities also protect concurrent tabs opening the same import journal.
  const stepFor = async (id: string) => { if (!journal.steps[id]) { journal.steps[id] = { requestId: `bundle-${await sha256(encode(JSON.stringify([key, id])))}` }; await store.write(journal); } return journal.steps[id]; };
  const upload = async (stepKey: string, entry: BundleResource, path: string, name = entry.fileName ?? entry.title) => {
    const step = await stepFor(stepKey); if (step.result) return step.result;
    const uploadRecord: DocumentUpload = { id: stepKey, nodeId: stepKey, fileName: name, mimeType: entry.mimeType ?? 'application/octet-stream', size: bundle.files.get(path)!.byteLength, kind: 'file', requestId: step.requestId, uploadId: step.uploadId, state: 'queued', durable: true };
    assertScope(); const result = await transport.upload!(uploadRecord, new Blob([new Uint8Array(bundle.files.get(path)!)]), { topicId: options.topicId ?? null, folderId: null, managed: true }, async (uploadId) => { step.uploadId = uploadId; await store.write(journal); assertScope(); });
    step.result = result; await store.write(journal); return result;
  };
  const create = async (entry: BundleResource): Promise<{ resourceId: string; revision: number }> => {
    assertScope(); const step = await stepFor(entry.key); if (step.result) return step.result;
    if (active.has(entry.key)) throw new Error('BUNDLE_REFERENCE_CYCLE'); active.add(entry.key);
    const sourceOriginal = entry.sourceOriginalPath ? await upload(`${entry.key}-source`, entry, entry.sourceOriginalPath) : undefined;
    const original = entry.originalPath ? await upload(`${entry.key}-original`, entry, entry.originalPath) : undefined;
    let content = JSON.parse(decode(bundle.files.get(entry.bodyPath)!)) as DocumentContent;
    const relativeReferences: RelativeReference[] = [];
    for (const reference of entry.relativeReferences ?? []) {
      const dependency = bySource.get(sourceKey(reference.resourceId, reference.revision)); if (!dependency) throw new Error('BUNDLE_REFERENCE_MISSING');
      relativeReferences.push({ path: reference.path, ...await create(dependency) });
    }
    if (entry.format === 'richdoc-v1') {
      const mappings = new Map<string, { resourceId: string; revision: number }>();
      for (const ref of inspectRichDocument(content).references) {
        const dependency = bySource.get(sourceKey(ref.resourceId, ref.revision)); if (!dependency) throw new Error('BUNDLE_REFERENCE_MISSING');
        mappings.set(sourceKey(ref.resourceId, ref.revision), await create(dependency));
      }
      const replace = (blocks: RichBlock[]): RichBlock[] => blocks.map((block) => ({ ...block, ...(block.target ? { target: mappings.get(sourceKey(block.target.resourceId, block.target.revision))! } : {}), ...(block.children ? { children: replace(block.children) } : {}) }));
      content = { schemaVersion: 1, blocks: replace((content as RichDocument).blocks) };
    }
    {
      const importSource = original || sourceOriginal || entry.supplementalContent !== undefined ? {
        ...(original && entry.format !== 'richdoc-v1' ? { original } : {}),
        ...(sourceOriginal || entry.format === 'richdoc-v1' && original ? { sourceOriginal: sourceOriginal ?? original } : {}),
        ...(typeof entry.supplementalContent === 'string' ? { supplementalContent: entry.supplementalContent } : {}),
      } : undefined;
      step.bodyJson ??= JSON.stringify({ requestId: step.requestId, title: entry.title, format: entry.format, schemaVersion: entry.schemaVersion, content, contentHash: await sha256(encode(canonicalContent(content))), topicId: options.topicId ?? null, folderId: options.folderId ?? null, managed: entry.key !== bundle.manifest.root, ...(entry.format === 'markdown' ? { relativeReferences } : {}), ...(importSource ? { importSource } : {}) });
      await store.write(journal); assertScope();
      let receipt: DocumentReceipt | null = null;
      try { receipt = await api<DocumentReceipt>(`/api/v1/library/resources/receipts/${encodeURIComponent(step.requestId)}`, { cache: 'no-store' }); } catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
      if (receipt) step.result = { resourceId: receipt.resourceId, revision: receipt.revision };
      else { assertScope(); const result = await api<ResourceDocument>('/api/v1/library/resources', { method: 'POST', body: step.bodyJson }); step.result = { resourceId: result.id, revision: result.revision }; }
      await store.write(journal);
    }
    active.delete(entry.key); return step.result;
  };
  const result = await create(bundle.manifest.resources.find((entry) => entry.key === bundle.manifest.root)!); assertScope(); return result;
}
