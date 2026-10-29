/** Shared wire types. Keep this module dependency-free so the client can import types. */
export type PracticeQuestionType = 'single' | 'multiple' | 'boolean' | 'short';
export type PracticeDifficulty = 'easy' | 'medium' | 'hard';
export type PracticeMode = 'knowledge' | 'wrong' | 'review' | 'mixed';
export type PracticeAnswer = string | string[];
export type PracticeConfig = {
  mapId: string;
  nodeIds?: string[];
  mode?: PracticeMode;
  goal?: string;
  count?: number;
  types?: PracticeQuestionType[];
  difficulty?: PracticeDifficulty;
  language?: string;
};
export type PracticeQuestionView = {
  id: string;
  versionId: string;
  nodeId: string;
  type: PracticeQuestionType;
  prompt: string;
  options: Array<{
    id: string;
    text: string;
  }>;
  difficulty: PracticeDifficulty;
  objective: string;
  source: {
    kind: 'note' | 'model_example';
    label: string;
    nodeRevision?: number;
  };
  variantOfQuestionVersionId?: string;
  archived: boolean;
  /** Explicitly retired question, independent from an archived source map/node. */
  retired?: boolean;
};
export type PracticeDraftView = {
  id: string;
  itemId: string;
  activeAttemptId: string;
  attemptNo: number;
  answer: PracticeAnswer;
  revision: number;
  submitted: boolean;
  updatedAt: string;
};
export type PracticeGradeView = {
  id: string;
  attemptId: string;
  version: number;
  method: 'rule' | 'model';
  state: 'succeeded' | 'needs_review';
  result: 'correct' | 'partial' | 'incorrect' | 'unresolved';
  score: number | null;
  maxScore: number;
  explanation: string;
  strengths: string;
  mistakes: string[];
  model: string | null;
  promptVersion: string;
  createdAt: string;
};
export type PracticeAttemptView = {
  id: string;
  itemId: string;
  attemptNo: number;
  answer: PracticeAnswer;
  submittedAt: string;
  assisted: boolean;
  solutionViewed: boolean;
  assistanceUncertain: boolean;
  gradingVersion: number;
  gradingState: 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_review';
  grade: PracticeGradeView | null;
  grades: PracticeGradeView[];
  gradesNextCursor?: string | null;
  error: string | null;
};
export type PracticeItemView = {
  id: string;
  sessionId: string;
  position: number;
  question: PracticeQuestionView;
  draft: PracticeDraftView;
  attempts: PracticeAttemptView[];
  attemptsNextCursor?: string | null;
  skipped: boolean;
  hintCount: number;
  assistance: boolean;
  solutionViewed: boolean;
  selectionReason: string;
  hints: string[];
  solution?: {
    answer: PracticeAnswer;
    explanation: string;
    rubric: string;
  };
};
export type PracticeSummary = {
  total: number;
  invalid?: number;
  answered: number;
  skipped: number;
  pending: number;
  correct: number;
  independentCorrect: number;
  assistedCorrect: number;
  partial: number;
  incorrect: number;
  unresolved: number;
};
export type PracticeSessionView = {
  id: string;
  mapId: string;
  mapTitle: string;
  ownerId: string;
  mode: PracticeMode;
  state: 'active' | 'paused' | 'finished';
  currentPosition: number;
  revision: number;
  config: PracticeConfig;
  items: PracticeItemView[];
  summary: PracticeSummary;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  archived: boolean;
};
export type PracticeJobView = {
  id: string;
  kind: 'generate' | 'grade';
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  mapId: string;
  sessionId: string | null;
  attemptId: string | null;
  retries: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  candidateRevision: string | null;
  candidate: {
    title: string;
    config: PracticeConfig;
    questions: PracticeQuestionView[];
  } | null;
  adoptedSessionId: string | null;
};
export type PracticeReviewView = {
  id: string;
  mapId: string;
  nodeId: string;
  questionId: string | null;
  title: string;
  reasons: string[];
  dueAt: string | null;
  paused: boolean;
  revision: number;
  policy: 'manual' | 'spaced-v1';
  policyVersion: string;
  manualSchedule: boolean;
  lastAttemptId: string | null;
  lastGradeId: string | null;
  streak: number;
  updatedAt: string;
};
export type PracticeReviewEventView = {
  id: string;
  kind: string;
  createdAt: string;
  attemptId: string | null;
  gradeId: string | null;
  before: PracticeReviewView | null;
  after: PracticeReviewView;
};
export type PracticeResumeView = {
  nodeId: string | null;
  mapId: string | null;
  nodeTitle: string | null;
  updatedAt: string;
};
export type LearningOverviewView = {
  resume: PracticeResumeView | null;
  sessions: Array<{
    id: string;
    mapId: string;
    mapTitle: string;
    state: string;
    currentPosition: number;
    total: number;
    updatedAt: string;
  }>;
  counts: {
    todo: number;
    learning: number;
    review: number;
    done: number;
    due: number;
  };
  checkpoint: {
    id: string;
    content: string;
    createdAt: string;
    nodeId: string | null;
  } | null;
  pendingGenerationJobs: PracticeJobView[];
  updatedAt: string;
};
export type LearningSearchView = {
  items: Array<{
    id: string;
    mapId: string;
    title: string;
    status: string;
    revision: number;
    path: string[];
    excerpt: string;
  }>;
  nextCursor: string | null;
};
export type PracticeHistoryView = {
  items: Array<PracticeAttemptView & {
    sessionId: string;
    question: PracticeQuestionView;
    nodeTitle: string;
  }>;
  nextCursor: string | null;
};
export type PracticeMutation<T extends object> = {
  status: 'applied';
  requestId: string;
} & T;
export type DraftSaveInput = {
  requestId: string;
  activeAttemptId: string;
  expectedDraftRevision: number;
  answer: PracticeAnswer;
};
export type AttemptSubmitInput = DraftSaveInput & {
  questionVersionId: string;
  clientAttemptId: string;
};
export type SessionUpdateInput = {
  requestId: string;
  expectedRevision: number;
  currentPosition?: number;
  state?: 'active' | 'paused' | 'finished';
};
export type ReviewUpdateInput = {
  requestId: string;
  id?: string;
  expectedRevision?: number;
  mapId?: string;
  nodeId?: string;
  questionId?: string | null;
  dueAt?: string | null;
  paused?: boolean;
  policy?: 'manual' | 'spaced-v1';
};
