import { DomainError } from '../../domain/task.js';

/** Compatibility rollback retains this server's readers and pauses resource publication. */
export function documentWritesPaused() { return process.env.DOVUN_DOCUMENT_READ_ONLY === '1'; }

export function assertDocumentWritable() {
  if (documentWritesPaused()) throw new DomainError('DOCUMENT_READ_ONLY', 'Document writes are paused for compatibility rollback; keep or export your local draft.', 503);
}

export function assertDocumentCommandWritable(kind: string) {
  if (/^(material\.|resource\.|libraryFolder\.|libraryTag\.)/.test(kind) || kind === 'task.reference_materials') assertDocumentWritable();
}
