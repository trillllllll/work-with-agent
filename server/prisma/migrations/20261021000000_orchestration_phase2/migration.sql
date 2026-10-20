-- Orchestration phase 2: worktree inventory/cleanup, cross-machine rounds, optional PR.
-- Plain ADD COLUMN keeps the partial unique index Orchestration_one_open_per_task from phase 1.

-- AlterTable
ALTER TABLE "AgentNode" ADD COLUMN "inventoryJson" TEXT NOT NULL DEFAULT 'null';
ALTER TABLE "AgentNode" ADD COLUMN "inventoryAt" TEXT;

-- AlterTable
ALTER TABLE "Orchestration" ADD COLUMN "extraLocationsJson" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Orchestration" ADD COLUMN "publishedHead" TEXT;
ALTER TABLE "Orchestration" ADD COLUMN "pullRequestUrl" TEXT;

-- AlterTable
ALTER TABLE "OrchestrationStep" ADD COLUMN "locationId" TEXT;
ALTER TABLE "OrchestrationStep" ADD COLUMN "nodeId" TEXT;
ALTER TABLE "OrchestrationStep" ADD COLUMN "repoPath" TEXT;

-- CreateTable
CREATE TABLE "WorktreeCleanup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "itemsJson" TEXT NOT NULL,
    "deleteBranches" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source" TEXT NOT NULL DEFAULT 'user',
    "jobId" TEXT,
    "resultJson" TEXT,
    "expiresAt" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "WorktreeCleanup_nodeId_status_idx" ON "WorktreeCleanup"("nodeId", "status");
