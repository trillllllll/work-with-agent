import type { Approval } from '@/chat.js';
import type { ProposalCommand } from '@/lib/proposal-group.js';
import type { AppOutcome, AppReview } from '../../../../../server/src/domain/task-batch-types.js';

export type BatchCard = {
  approvalId: string;
  status: string;
  preview?: Approval['preview'];
  outcome?: Approval['outcome'];
  supersededByApprovalId?: string;
};

export type AppChangeCard = {
  approvalId: string;
  status: string;
  review?: AppReview;
  proposalRevision: number;
  outcome?: AppOutcome;
  previewHash?: string;
  conversationId?: string | null;
};

export type ProposalResult = { status?: string; reason?: string | null; rejectedAt?: string };

export type Proposal = {
  id: string;
  status: string;
  revision: number;
  actorId: string;
  connectionId?: string | null;
  commands: ProposalCommand[] | string;
  preview: unknown;
  result?: ProposalResult | string | null;
  createdAt: string;
  batchCard?: BatchCard;
  appChangeCard?: AppChangeCard;
};
