-- Reject and acceptance notes (phase 3). Plain ADD COLUMN keeps the partial unique index
-- Orchestration_one_open_per_task from the orchestration migration (draft, running, paused,
-- awaiting_acceptance). `rejected` is terminal and must stay out of that index.
-- Rebuilding the Orchestration table would drop the index.

-- AlterTable
ALTER TABLE "Orchestration" ADD COLUMN "acceptanceNote" TEXT;
ALTER TABLE "Orchestration" ADD COLUMN "rejectionReason" TEXT;
ALTER TABLE "Orchestration" ADD COLUMN "rejectedAt" TEXT;
