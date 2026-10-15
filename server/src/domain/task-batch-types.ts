export const TASK_BATCH_FIELDS = [
  'title', 'topicId', 'parentId', 'status', 'priority', 'description', 'resultSummary',
  'dueDate', 'scheduledStart', 'scheduledEnd', 'estimatedMinutes', 'tagIds',
] as const;

export type TaskBatchField = (typeof TASK_BATCH_FIELDS)[number];
export type TaskSnapshot = {
  id: string;
  revision: number;
  title: string;
  topicId: string | null;
  parentId: string | null;
  sortOrder: number;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  priority: 'none' | 'low' | 'medium' | 'high';
  description: string;
  resultSummary: string;
  dueDate: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  estimatedMinutes: number | null;
  tagIds: string[];
};
export type TaskDelta = {
  taskId: string;
  before: TaskSnapshot | null;
  after: TaskSnapshot;
  fields: Array<{ field: TaskBatchField; before: unknown; after: unknown }>;
  origin: 'explicit' | 'related';
};
export type TaskBatchPreview = {
  schemaVersion: 1;
  summary: string;
  operationCount: number;
  beforeTasks: TaskSnapshot[];
  afterTasks: TaskSnapshot[];
  changes: TaskDelta[];
};
export type BatchSuccess = {
  success: true;
  data: { proposalId: string; changeId: string; operationCount: number; affectedTaskIds: string[]; tasks: TaskSnapshot[] };
};
export type BatchFailure = {
  success: false;
  error: string;
  code: string;
  data: { proposalId: string; atomic: true; appliedOperationCount: 0 };
};
export type BatchOutcome = BatchSuccess | BatchFailure;
export type BatchApprovalEnvelope = {
  schemaVersion: 1;
  kind: 'task_batch';
  proposalId: string;
  proposalRevision: number;
  toolCallId: string;
  assistantMessageId: string;
  sourceUserMessageId: string;
  summary: string;
  preview: TaskBatchPreview;
  outcome?: BatchOutcome;
  supersededByApprovalId?: string;
};

export type AppReviewField = { key: string; label: string; before: unknown; after: unknown; beforeText: string; afterText: string };
export type AppReviewEntity = {
  entityType: string;
  entityId: string;
  titleBefore: string | null;
  titleAfter: string | null;
  operation: string;
  origin: 'explicit' | 'related';
  revisionBefore: number | null;
  revisionAfter: number | null;
  fields: AppReviewField[];
};
export type AppReview = {
  schemaVersion: 1;
  title: string;
  intent: string;
  requestedOperationCount: number;
  commandCount: number;
  affectedEntityCount: number;
  relatedEntityCount: number;
  atomic: true;
  reversibility: 'supported' | 'unsupported';
  reversibilityReason: string | null;
  consequences: string[];
  entities: AppReviewEntity[];
  previewHash: string;
};
export type AppOutcome =
  | { status: 'executed'; appliedOperationCount: number; changeId: string | null; affected?: Array<{ type: string; id: string; title: string }>; completedAt: string }
  | { status: 'rejected' | 'failed'; appliedOperationCount: 0; code: string; message: string; completedAt: string };

export type StoredApprovalRead = {
  toolCallId?: string;
  preview?: TaskBatchPreview;
  outcome?: BatchOutcome;
  supersededByApprovalId?: string;
  summary?: string;
  proposalId?: string;
  proposalRevision?: number;
  assistantMessageId?: string;
  appReview?: AppReview;
  appOutcome?: AppOutcome;
  previewHash?: string;
  requestedOperations?: unknown[];
  reversesApprovalId?: string | null;
  legacyProposal?: { proposalId: string; proposalRevision?: number; toolCallId?: string };
  legacyResult?: { success?: boolean; data?: unknown; error?: string; code?: string };
  resultState?: 'batch' | 'proposal' | 'result' | 'app_changes' | 'unreadable';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readStoredApproval(result: unknown): StoredApprovalRead {
  let value = result;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return { resultState: 'unreadable' }; }
  }
  if (!isRecord(value)) return { resultState: 'unreadable' };
  if (value.schemaVersion === 1 && value.kind === 'task_batch' && isRecord(value.preview)) {
    return {
      resultState: 'batch',
      toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : undefined,
      preview: value.preview as TaskBatchPreview,
      outcome: isRecord(value.outcome) ? value.outcome as BatchOutcome : undefined,
      supersededByApprovalId: typeof value.supersededByApprovalId === 'string' ? value.supersededByApprovalId : undefined,
      summary: typeof value.summary === 'string' ? value.summary : undefined,
      proposalId: typeof value.proposalId === 'string' ? value.proposalId : undefined,
      proposalRevision: typeof value.proposalRevision === 'number' ? value.proposalRevision : undefined,
      assistantMessageId: typeof value.assistantMessageId === 'string' ? value.assistantMessageId : undefined,
    };
  }
  if (value.schemaVersion === 2 && value.kind === 'app_changes') {
    const review = isRecord(value.review) && typeof value.review.previewHash === 'string' && Array.isArray(value.review.entities) ? value.review as AppReview : undefined;
    const outcome = isRecord(value.outcome) && (value.outcome.status === 'executed' || value.outcome.status === 'rejected' || value.outcome.status === 'failed') ? value.outcome as AppOutcome : undefined;
    return {
      resultState: 'app_changes',
      toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : undefined,
      proposalId: typeof value.proposalId === 'string' ? value.proposalId : undefined,
      proposalRevision: typeof value.proposalRevision === 'number' ? value.proposalRevision : undefined,
      assistantMessageId: typeof value.assistantMessageId === 'string' ? value.assistantMessageId : undefined,
      summary: typeof review?.intent === 'string' ? review.intent : undefined,
      appReview: review,
      appOutcome: outcome,
      previewHash: review?.previewHash,
      requestedOperations: Array.isArray(value.requestedOperations) ? value.requestedOperations : undefined,
      reversesApprovalId: typeof value.reversesApprovalId === 'string' ? value.reversesApprovalId : value.reversesApprovalId === null ? null : undefined,
      supersededByApprovalId: typeof value.supersededByApprovalId === 'string' ? value.supersededByApprovalId : undefined,
    };
  }
  if (typeof value.proposalId === 'string' && typeof value.success !== 'boolean') {
    return {
      resultState: 'proposal',
      toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : undefined,
      legacyProposal: {
        proposalId: value.proposalId,
        proposalRevision: typeof value.proposalRevision === 'number' ? value.proposalRevision : undefined,
        toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : undefined,
      },
    };
  }
  if (typeof value.success === 'boolean') {
    return {
      resultState: 'result',
      toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : undefined,
      legacyResult: value as StoredApprovalRead['legacyResult'],
    };
  }
  return { resultState: 'unreadable', toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : undefined };
}
