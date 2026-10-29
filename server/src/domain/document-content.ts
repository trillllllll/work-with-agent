/** Persisted product contract. This module is deliberately browser safe and independent of any editor. */
export type ResourceFormat = 'richdoc-v1' | 'markdown' | 'text' | 'binary';
export type ResourceTarget = { resourceId: string; revision: number };
export type ResourceReference = ResourceTarget & { nodeId: string; mode: 'fixed' };
export type RichMark = { kind: 'bold' | 'italic' | 'strike' | 'code' | 'link'; href?: string };
export type RichText = { text: string; marks?: RichMark[]; break?: true };
export type RichBlockKind = 'paragraph' | 'heading' | 'bulletList' | 'orderedList' | 'listItem' | 'taskList' | 'taskItem' | 'blockquote' | 'codeBlock' | 'table' | 'tableRow' | 'tableCell' | 'tableHeader' | 'horizontalRule' | 'image' | 'file';
export type RichBlock = {
  id: string; kind: RichBlockKind; text?: RichText[]; children?: RichBlock[];
  level?: number; language?: string; start?: number; checked?: boolean;
  align?: 'left' | 'center' | 'right'; colspan?: number; rowspan?: number; colwidth?: number[];
  target?: ResourceTarget; alt?: string; caption?: string; width?: number; label?: string;
};
export type RichDocument = { schemaVersion: 1; blocks: RichBlock[] };
export type DocumentContent = string | RichDocument;

// A document budget is separate from chat/tool excerpt limits. Oversize documents remain readable/downloadable.
export const documentByteLimit = 8 * 1024 * 1024;
export const documentNodeLimit = 50_000;
export const documentDepthLimit = 64;
const blockKinds = new Set<string>(['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'blockquote', 'codeBlock', 'table', 'tableRow', 'tableCell', 'tableHeader', 'horizontalRule', 'image', 'file']);
const inlineKinds = new Set(['paragraph', 'heading', 'codeBlock']);
const containerKinds = new Set(['bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'blockquote', 'table', 'tableRow', 'tableCell', 'tableHeader']);
const markKinds = new Set(['bold', 'italic', 'strike', 'code', 'link']);
const fieldKeys: Record<string, string[]> = {
  paragraph: ['text', 'align'], heading: ['text', 'level', 'align'], codeBlock: ['text', 'language'],
  orderedList: ['children', 'start'], bulletList: ['children'], listItem: ['children'], taskList: ['children'], taskItem: ['children', 'checked'],
  blockquote: ['children'], table: ['children'], tableRow: ['children'], tableCell: ['children', 'colspan', 'rowspan', 'colwidth', 'align'], tableHeader: ['children', 'colspan', 'rowspan', 'colwidth', 'align'],
  horizontalRule: [], image: ['target', 'alt', 'caption', 'width'], file: ['target', 'label'],
};
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function onlyKeys(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).every((key) => allowed.includes(key)); }
export function safeDocumentLink(value: string) { return /^(https?:\/\/|mailto:|wwa-material:)/i.test(value) && !/[\u0000-\u0020]/.test(value); }

/** Inspection never normalizes unknown data: the caller must retain the original and show it read-only. */
export function inspectRichDocument(value: unknown): { supported: boolean; issues: string[]; references: ResourceReference[] } {
  const issues: string[] = []; const references: ResourceReference[] = []; const ids = new Set<string>();
  let count = 0;
  const issue = (message: string) => { if (issues.length < 30) issues.push(message); };
  if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.blocks) || !onlyKeys(value, ['schemaVersion', 'blocks'])) {
    return { supported: false, issues: ['Unsupported document schema'], references };
  }
  const visit = (entry: unknown, depth: number, parent = 'document') => {
    if (++count > documentNodeLimit || depth > documentDepthLimit) { issue('Document structure exceeds budget'); return; }
    if (!object(entry) || typeof entry.kind !== 'string' || !blockKinds.has(entry.kind)) { issue('Unsupported block'); return; }
    const kind = entry.kind;
    if (!onlyKeys(entry, ['id', 'kind', ...fieldKeys[kind]])) issue('Unsupported block attributes');
    if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.id) || ids.has(entry.id)) issue('Missing or duplicate block identity');
    else ids.add(entry.id);
    const allowedChildren: Record<string, string[]> = { bulletList: ['listItem'], orderedList: ['listItem'], taskList: ['taskItem'], table: ['tableRow'], tableRow: ['tableCell', 'tableHeader'] };
    if (allowedChildren[parent] && !allowedChildren[parent].includes(kind)) issue('Invalid nested block');
    if (!allowedChildren[parent] && ['listItem', 'taskItem', 'tableRow', 'tableCell', 'tableHeader'].includes(kind)) issue('Invalid block position');
    if (kind === 'heading' && (!Number.isInteger(entry.level) || Number(entry.level) < 1 || Number(entry.level) > 6)) issue('Invalid heading level');
    if (entry.start !== undefined && (!Number.isInteger(entry.start) || Number(entry.start) < 1)) issue('Invalid list start');
    if (kind === 'taskItem' && typeof entry.checked !== 'boolean') issue('Invalid task state');
    if (entry.align !== undefined && !['left', 'center', 'right'].includes(String(entry.align))) issue('Invalid text alignment');
    for (const name of ['alt', 'caption', 'language', 'label']) if (entry[name] !== undefined && typeof entry[name] !== 'string') issue('Invalid text attribute');
    if (entry.width !== undefined && (!Number.isFinite(entry.width) || Number(entry.width) < 64 || Number(entry.width) > 1600)) issue('Invalid image width');
    for (const name of ['colspan', 'rowspan']) if (entry[name] !== undefined && (!Number.isInteger(entry[name]) || Number(entry[name]) < 1 || Number(entry[name]) > 100)) issue('Invalid table span');
    if (entry.colwidth !== undefined && (!Array.isArray(entry.colwidth) || entry.colwidth.length > 100 || entry.colwidth.some((width) => !Number.isInteger(width) || width < 0 || width > 1600))) issue('Invalid column width');
    if (inlineKinds.has(kind)) {
      if (entry.text !== undefined && !Array.isArray(entry.text)) issue('Invalid inline content');
      for (const run of Array.isArray(entry.text) ? entry.text : []) {
        if (++count > documentNodeLimit) { issue('Document structure exceeds budget'); break; }
        if (!object(run) || typeof run.text !== 'string' || !onlyKeys(run, ['text', 'marks', 'break'])) { issue('Unsupported inline content'); continue; }
        if (run.break !== undefined && (run.break !== true || run.text !== '' || run.marks !== undefined)) issue('Invalid line break');
        if (run.marks !== undefined && !Array.isArray(run.marks)) issue('Invalid marks');
        if (kind === 'codeBlock' && (run.marks !== undefined || run.break !== undefined)) issue('Code blocks require plain text');
        for (const mark of Array.isArray(run.marks) ? run.marks : []) {
          if (!object(mark) || typeof mark.kind !== 'string' || !markKinds.has(mark.kind) || !onlyKeys(mark, mark.kind === 'link' ? ['kind', 'href'] : ['kind'])) { issue('Unsupported mark'); continue; }
          if (mark.kind === 'link' && (typeof mark.href !== 'string' || !safeDocumentLink(mark.href))) issue('Unsafe link');
        }
      }
    }
    if (containerKinds.has(kind)) {
      if (!Array.isArray(entry.children) || !entry.children.length) issue('Empty container');
      for (const child of Array.isArray(entry.children) ? entry.children : []) { if (count > documentNodeLimit) break; visit(child, depth + 1, kind); }
      if (['listItem', 'taskItem', 'tableCell', 'tableHeader'].includes(kind) && Array.isArray(entry.children) && (entry.children[0] as RichBlock)?.kind !== 'paragraph') issue('Container must start with a paragraph');
    }
    if (kind === 'image' || kind === 'file') {
      const target = entry.target;
      if (!object(target) || !onlyKeys(target, ['resourceId', 'revision']) || typeof target.resourceId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(target.resourceId) || !Number.isSafeInteger(target.revision) || Number(target.revision) < 1) issue('Invalid resource reference');
      else references.push({ resourceId: target.resourceId, revision: Number(target.revision), nodeId: String(entry.id), mode: 'fixed' });
    }
  };
  for (const block of value.blocks) { if (count > documentNodeLimit) break; visit(block, 1); }
  if (!value.blocks.length) issue('Document requires a paragraph');
  return { supported: !issues.length, issues, references };
}

/** Stable property ordering makes hashes and request identity independent of JSON object insertion order. */
export function canonicalContent(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (object(item)) return Object.fromEntries(Object.keys(item).sort().filter((key) => item[key] !== undefined).map((key) => [key, normalize(item[key])]));
    return item;
  };
  return typeof value === 'string' ? value : JSON.stringify(normalize(value));
}
export function assertWritableContent(format: ResourceFormat, content: unknown, schemaVersion?: number | null): asserts content is DocumentContent {
  if (new TextEncoder().encode(canonicalContent(content) ?? '').byteLength > documentByteLimit) throw new Error('DOCUMENT_TOO_LARGE');
  if (format === 'richdoc-v1') {
    const inspection = inspectRichDocument(content);
    if (schemaVersion !== undefined && schemaVersion !== null && schemaVersion !== 1 || !inspection.supported) throw new Error(`UNSUPPORTED_DOCUMENT_SCHEMA: ${inspection.issues.join('; ')}`);
  } else if ((format !== 'markdown' && format !== 'text') || typeof content !== 'string') throw new Error('UNSUPPORTED_CONTENT_FORMAT');
}
export function contentCapabilities(format: ResourceFormat | string, supported = true) {
  const editable = supported && ['richdoc-v1', 'markdown', 'text'].includes(format);
  return { read: true, edit: editable, source: editable && format !== 'richdoc-v1', split: editable && format === 'markdown', richText: editable && format === 'richdoc-v1', download: true };
}
export function contentText(format: ResourceFormat | string, content: unknown): string {
  if (typeof content === 'string') return content;
  if (format !== 'richdoc-v1' || !object(content) || !Array.isArray(content.blocks)) return '';
  const lines: string[] = []; let count = 0;
  const walk = (blocks: unknown[], depth: number) => {
    if (depth > documentDepthLimit) return;
    for (const block of blocks) {
      if (++count > documentNodeLimit) return;
      if (!object(block)) continue;
      if (Array.isArray(block.text)) lines.push(block.text.map((run) => object(run) ? run.break ? '\n' : typeof run.text === 'string' ? run.text : '' : '').join(''));
      // Resource titles/alt text are resolved separately under the referenced resource's permission.
      if (Array.isArray(block.children)) walk(block.children, depth + 1);
    }
  };
  walk(content.blocks, 1); return lines.join('\n');
}
export function emptyRichDocument(id = 'initial'): RichDocument { return { schemaVersion: 1, blocks: [{ id, kind: 'paragraph', text: [] }] }; }
