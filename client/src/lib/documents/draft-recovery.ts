import JSZip from 'jszip';
import type { DocumentSession } from './session.js';

export const DRAFT_RECOVERY_BYTES = 256 * 1024 * 1024;
type RecoveryFile = { path: string; sha256: string; size: number; uploadId?: string; fileName?: string; mimeType?: string };
export type DraftRecoveryManifest = {
  format: 'dovun-local-draft-recovery'; version: 1; createdAt: string;
  complete: boolean; automaticReplayAllowed: false; draftPath: 'draft.json';
  files: RecoveryFile[]; missing: Array<{ uploadId: string; reason: string }>;
};
const encode = (value: string) => new TextEncoder().encode(value);
async function digest(value: Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(value).buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** An offline rescue artifact, separate from a published-resource import bundle. */
export async function exportDraftRecovery(session: DocumentSession) {
  const snapshot = await session.recoverySnapshot();
  const zip = new JSZip();
  const manifest: DraftRecoveryManifest = {
    format: 'dovun-local-draft-recovery', version: 1, createdAt: new Date().toISOString(),
    complete: true, automaticReplayAllowed: false, draftPath: 'draft.json', files: [], missing: [...snapshot.missing],
  };
  let total = 0;
  const add = async (path: string, bytes: Uint8Array, metadata: Partial<RecoveryFile> = {}) => {
    if (total + bytes.byteLength > DRAFT_RECOVERY_BYTES - 1024 * 1024) throw new Error('DRAFT_RECOVERY_BUDGET_EXCEEDED');
    total += bytes.byteLength;
    manifest.files.push({ ...metadata, path, size: bytes.byteLength, sha256: await digest(bytes) });
    zip.file(path, bytes);
  };
  // No auth headers, cookies or localStorage credentials are read. Only the captured draft is exported.
  await add('draft.json', encode(JSON.stringify(snapshot.draft, null, 2)));
  await add('content.json', encode(JSON.stringify(snapshot.draft.content, null, 2)));
  for (const [index, recovery] of (snapshot.draft.editorRecovery ?? []).entries()) await add(`editor-recovery/${index}.json`, encode(JSON.stringify(recovery, null, 2)));
  if (typeof snapshot.draft.content === 'string') await add(snapshot.draft.format === 'markdown' ? 'content.md' : 'content.txt', encode(snapshot.draft.content));
  const byId = new Map(snapshot.files.map((entry) => [entry.uploadId, entry.file]));
  for (const [index, upload] of snapshot.draft.uploads.entries()) {
    const file = byId.get(upload.id);
    if (!file) continue;
    if (total + file.size > DRAFT_RECOVERY_BYTES - 1024 * 1024) {
      manifest.missing.push({ uploadId: upload.id, reason: 'The 256 MiB recovery package budget was exceeded. Export this attachment separately.' });
      continue;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength !== upload.size) { manifest.missing.push({ uploadId: upload.id, reason: 'Local attachment size does not match the draft.' }); continue; }
      await add(`uploads/${index}.bin`, bytes, { uploadId: upload.id, fileName: upload.fileName, mimeType: upload.mimeType });
    } catch { manifest.missing.push({ uploadId: upload.id, reason: 'Local attachment bytes could not be exported.' }); }
  }
  manifest.complete = manifest.missing.length === 0;
  await add('README.txt', encode([
    'Dovun local draft recovery package',
    'draft.json preserves the captured local branch, its confirmed base, conflict alternatives, organization request, and exact pending request bytes.',
    'content.json is the captured local body; content.md or content.txt is included for text formats. uploads/ contains local attachment bytes mapped by manifest.json.',
    'If editor-recovery/ is present, those files preserve newer raw editor state that could not be converted to the product document schema. content.json remains the last successfully converted body. Review and recover the raw editor state before discarding this branch; never publish it automatically.',
    'This package does not contain server-only files. Existing exact resource references remain in the document and may require the original workspace to read.',
    'Verify each manifest SHA-256 and byte size before using a file. complete=false means the listed attachment bytes are missing; the draft body remains preserved.',
    'No operation is applied by opening this package. Do not automatically replay pending requests. First verify the original workspace, request receipts, access and current revisions; then explicitly choose a new import or recovery.',
  ].join('\n\n')));
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  return { blob, complete: manifest.complete, missingUploadIds: manifest.missing.map((entry) => entry.uploadId) };
}
