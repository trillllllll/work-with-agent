-- Dispatch stats (phase 4): failure kind on the step and the job that caused it,
-- plus the indexes the stats query filters on. Plain ADD COLUMN and CREATE INDEX
-- keep the partial unique index Orchestration_one_open_per_task. Rebuilding the
-- Orchestration table would drop that index.

-- AlterTable
ALTER TABLE "NodeJob" ADD COLUMN "failureKind" TEXT;
ALTER TABLE "OrchestrationStep" ADD COLUMN "failureKind" TEXT;

-- CreateIndex
CREATE INDEX "NodeJob_endedAt_idx" ON "NodeJob"("endedAt");
CREATE INDEX "Orchestration_projectId_startedAt_idx" ON "Orchestration"("projectId", "startedAt");
