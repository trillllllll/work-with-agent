import { canonicalContent } from '../../domain/document-content.js';
import { libraryError } from '../library/access.js';
import { type Actor } from '../security.js';
import { ResourceService } from './service.js';

/** Lossless, bounded source slices. Callers concatenate slices before parsing product JSON. */
export async function readResourceDocument(actor: Actor, args: Record<string, unknown>) {
  const revision = Number(args.revision);
  const cursor = args.cursor === undefined ? 0 : Number(args.cursor);
  const limit = args.limit === undefined ? 16000 : Number(args.limit);
  if (!Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20000) throw libraryError('INVALID_TOOL_ARGUMENTS', 'Document source requires revision and valid cursor/limit (1–20000)', 400);
  const document = await new ResourceService().read(actor, String(args.materialId ?? ''), revision);
  const source = typeof document.content === 'string' ? document.content : canonicalContent(document.content);
  const end = Math.min(source.length, cursor + limit);
  if (cursor > source.length) throw libraryError('CURSOR_STALE', '分页已失效，请从第一页重新读取', 409);
  return {
    id: document.id, revision, contentHash: document.contentHash, format: document.format, schemaVersion: document.schemaVersion,
    supported: document.supported, readOnly: document.readOnly, capabilities: document.capabilities,
    contentEncoding: typeof document.content === 'string' ? 'text' : 'product-json', content: source.slice(cursor, end),
    offset: cursor, total: source.length, nextCursor: end < source.length ? String(end) : null,
    complete: cursor === 0 && end === source.length, relativeReferences: document.relativeReferences,
    note: 'Concatenate every content slice in offset order before editing. Slices use UTF-16 offsets. Parse product-json as the complete richdoc-v1 document; preserve all unrelated blocks and exact file revisions.',
  };
}
