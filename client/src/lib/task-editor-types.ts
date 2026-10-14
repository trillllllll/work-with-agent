/** 轻量编辑器的数据契约：字段、含义和边界固定，见实施契约第三节。 */

export type TaskText = { title: string; description: string };

export type TextVersion = TaskText & { revision: number };

export type TextField = 'title' | 'description';

export type FieldConflict = {
  base: string;
  local: string;
  remote: string;
  remoteRevision: number;
};

export type PendingRequest = {
  requestId: string;
  kind: 'text' | 'reference';
  method: 'PATCH' | 'POST';
  path: string;
  bodyJson: string;

  base: TextVersion;
  sentText: TaskText;
  sentEditSeq: number;

  createdAt: number;
};

export type DraftBlockReason =
  | 'invalid-title'
  | 'conflict'
  | 'readonly'
  | 'not-found'
  | 'auth'
  | 'reference-conflict'
  | 'invalid-input'
  | 'server-reset'
  | null;

export type TaskTextDraftV1 = {
  schemaVersion: 1;
  scopeKey: string;
  taskId: string;
  branchId: string;

  recordVersion: number;
  editSeq: number;

  base: TextVersion;
  draft: TaskText;

  outbox: PendingRequest | null;
  conflicts: Partial<Record<TextField, FieldConflict>>;
  blockedReason: DraftBlockReason;

  retryCount: number;
  nextRetryAt: number | null;
  updatedAt: number;
};

export type SaveStatus =
  | 'clean'
  | 'local-pending'
  | 'saving'
  | 'local-only'
  | 'conflict'
  | 'blocked'
  | 'storage-error';

export type EditorSelectionBookmark = {
  taskId: string;
  anchor: number;
  head: number;
  kind: 'text' | 'node';
};

export type TaskDetailHandle = {
  prepareLeave: () => Promise<boolean>;
  ensureSaved: () => Promise<boolean>;
  requestTransition: (action: () => void) => void;
};
