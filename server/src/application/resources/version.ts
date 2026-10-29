import type { MaterialVersion } from '@prisma/client';
import { canonicalContent, contentText, inspectRichDocument, type DocumentContent, type ResourceFormat } from '../../domain/document-content.js';

/** The legacy hash and bytes stay untouched. An explicit version format wins over current material kind. */
export function versionFormat(kind: string, version: Pick<MaterialVersion, 'format' | 'attachmentPath'>): ResourceFormat {
  if (version.format) return version.format as ResourceFormat;
  if (kind === 'markdown') return 'markdown';
  if (kind === 'text' || kind === 'thread' || kind === 'link') return 'text';
  return version.attachmentPath ? 'binary' : 'text';
}

export function versionContent(kind: string, version: Pick<MaterialVersion, 'format' | 'content' | 'attachmentPath'> & { authoritativeContent?: string | null }): DocumentContent {
  if (versionFormat(kind, version) !== 'richdoc-v1') return version.authoritativeContent ?? version.content;
  try { return JSON.parse(version.content) as DocumentContent; }
  catch { return version.content; }
}

export function versionProjection(kind: string, version: Pick<MaterialVersion, 'format' | 'content' | 'attachmentPath'> & { authoritativeContent?: string | null }) {
  const format = versionFormat(kind, version);
  const content = versionContent(kind, version);
  return format === 'richdoc-v1' ? contentText(format, content) : String(content);
}

export function versionSupported(kind: string, version: Pick<MaterialVersion, 'format' | 'schemaVersion' | 'content' | 'attachmentPath'>) {
  const format = versionFormat(kind, version);
  if (!['richdoc-v1', 'markdown', 'text', 'binary'].includes(format)) return false;
  return format !== 'richdoc-v1' || (version.schemaVersion === 1 && inspectRichDocument(versionContent(kind, version)).supported);
}

export function serializeContent(format: ResourceFormat, content: DocumentContent) {
  return format === 'richdoc-v1' ? canonicalContent(content) : String(content);
}
