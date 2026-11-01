export type LearningBriefing = {
  map: { id: string; title: string };
  checkpoint: { id: string; content: string; createdAt: string } | null;
  attempts: Array<{ id: string; nodeTitle: string; submittedAt: string; gradingState: string; result: string | null; assisted: boolean; solutionViewed: boolean }>;
  moreAttempts: boolean;
  reviews: Array<{ id: string; nodeId: string; nodeTitle: string; dueAt: string | null }>;
  moreReviews: boolean;
  sessions: Array<{ id: string; state: string; updatedAt: string }>;
};
