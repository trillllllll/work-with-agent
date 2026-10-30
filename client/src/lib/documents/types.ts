import type { DocumentContent, RichBlock, RichDocument } from '../../../../server/src/domain/document-content.js';
import type { RelativeReference } from './markdown-assets.js';

export type DocumentFormat = 'richdoc-v1' | 'markdown' | 'text' | 'binary';
/** Upload nodes belong to durable device drafts and are never sent as a document version. */
export type UploadBlock = { id: string; kind: 'upload'; uploadId: string; label: string };
export type DraftBlock = Omit<RichBlock, 'children'> & { children?: DraftBlock[] } | UploadBlock;
export type DraftContent = string | Omit<RichDocument, 'blocks'> & { blocks: DraftBlock[] };

export type ResourceDocument = {
  id: string;
  title: string;
  kind: string;
  format: DocumentFormat;
  schemaVersion: number | null;
  content: DocumentContent;
  revision: number;
  currentRevision: number;
  organizationRevision: number;
  contentHash: string;
  readOnly: boolean;
  topicId?: string | null;
  folderId?: string | null;
  capabilities?: Record<string, unknown>;
  attachment?: { fileName?: string | null; mimeType?: string | null; [key: string]: unknown } | null;
  references?: unknown[];
  relativeReferences?: Array<{ path: string; resourceId: string; revision: number }>;
  supported?: boolean;
  hasSourceOriginal?: boolean;
  supplementalContent?: string | null;
  conversionSource?: { resourceId: string; revision: number; format: DocumentFormat; contentHash: string } | null;
  versions?: Array<{ revision: number; contentHash: string; createdAt: string; format: string | null }>;
};

export type DocumentBase = Pick<ResourceDocument, 'revision' | 'content' | 'contentHash' | 'relativeReferences'>;
export type DocumentReceipt = { requestId: string; resourceId: string; revision: number; contentHash: string; organizationRevision?: number };
export type OrganizationWrite = { requestId: string; resourceId: string; expectedOrganizationRevision: number; title: string; bodyJson: string; state: 'prepared' | 'unknown' };
export type DocumentWrite = {
  requestId: string;
  resourceId: string | null;
  expectedRevision: number;
  /** Exact bytes of the request are retained across retries and refreshes. */
  bodyJson: string;
  content: DocumentContent;
  editSeq: number;
  state: 'prepared' | 'unknown';
};
export type DocumentFailure = { code: string; message: string; status?: number };
export type DocumentConflict = { base: DocumentBase; local: DraftContent; localRelativeReferences?: RelativeReference[]; remote: ResourceDocument };
export type DocumentUpload = {
  id: string;
  nodeId: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'file';
  requestId: string;
  uploadId?: string;
  state: 'queued' | 'uploading' | 'failed' | 'ready' | 'removed';
  durable: boolean;
  error?: string;
  errorCode?: string;
  result?: { resourceId: string; revision: number };
};
export type DocumentDraft = {
  schemaVersion: 1;
  scopeKey: string;
  localId: string;
  resourceId: string | null;
  deviceId: string;
  sessionId: string;
  recordVersion: number;
  editSeq: number;
  confirmedSeq: number;
  updatedAt: number;
  title: string;
  confirmedTitle: string;
  organizationRevision: number;
  organizationPending: OrganizationWrite | null;
  format: DocumentFormat;
  contentSchemaVersion: number | null;
  topicId: string | null;
  folderId: string | null;
  content: DraftContent;
  relativeReferences?: RelativeReference[];
  base: DocumentBase;
  readOnly: boolean;
  pending: DocumentWrite | null;
  conflict: DocumentConflict | null;
  blocked: DocumentFailure | null;
  uploads: DocumentUpload[];
  /** Exact editor state retained locally when conversion to the product schema fails. Never publish automatically. */
  editorRecovery?: Array<{ viewKey: string; capturedAt: number; message: string; editorJson: unknown }>;
  /** Opened from "new document": nothing is created in Dovun until the title or body is changed. */
  blank?: boolean;
};
export type DocumentSaveStatus = 'new' | 'saved' | 'local-pending' | 'saving' | 'local-only' | 'uploading' | 'conflict' | 'error' | 'storage-error' | 'read-only' | 'recovery';
export type DocumentSnapshot = {
  localId: string;
  resourceId: string | null;
  title: string;
  format: DocumentFormat;
  schemaVersion: number | null;
  content: DraftContent;
  relativeReferences?: RelativeReference[];
  revision: number;
  status: DocumentSaveStatus;
  error: DocumentFailure | null;
  conflict: DocumentConflict | null;
  uploads: DocumentUpload[];
  staleBranches: DocumentDraft[];
  readOnly: boolean;
};
export type NewDocument = { title: string; format: Exclude<DocumentFormat, 'binary'>; content: DocumentContent; schemaVersion?: number | null; topicId?: string | null; folderId?: string | null; relativeReferences?: RelativeReference[]; blank?: boolean };

export type WriteOutcome =
  | { kind: 'success'; receipt: DocumentReceipt }
  | { kind: 'unknown' }
  | { kind: 'rejected'; error: DocumentFailure };
export type ReceiptOutcome = { kind: 'found'; receipt: DocumentReceipt } | { kind: 'missing' } | { kind: 'unknown' } | { kind: 'rejected'; error: DocumentFailure };
export interface DocumentTransport {
  send(write: DocumentWrite): Promise<WriteOutcome>;
  organize?(write: OrganizationWrite): Promise<WriteOutcome>;
  receipt(requestId: string): Promise<ReceiptOutcome>;
  read(resourceId: string): Promise<ResourceDocument>;
  upload?(upload: DocumentUpload, file: Blob, context: { topicId: string | null; folderId?: string | null; managed?: boolean }, checkpoint: (uploadId: string) => Promise<void>): Promise<{ resourceId: string; revision: number }>;
}

export interface DocumentDraftStorage {
  load(scopeKey: string, resourceId: string): Promise<DocumentDraft[]>;
  listScope(scopeKey: string): Promise<DocumentDraft[]>;
  put(record: DocumentDraft): Promise<void>;
  putWithFile(record: DocumentDraft, uploadId: string, file: Blob): Promise<void>;
  readFile(record: Pick<DocumentDraft, 'scopeKey' | 'localId' | 'sessionId'>, uploadId: string): Promise<Blob | undefined>;
  adopt(record: DocumentDraft, source: DocumentDraft, retireSource?: boolean): Promise<void>;
  /** Delete one draft branch and its attachment bytes in a single transaction. */
  discard(record: DocumentDraft): Promise<void>;
}
