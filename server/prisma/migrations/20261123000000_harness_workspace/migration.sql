ALTER TABLE "harness_sessions" ADD COLUMN "harness" TEXT NOT NULL DEFAULT 'codex';
ALTER TABLE "harness_sessions" ADD COLUMN "title" TEXT;
ALTER TABLE "harness_sessions" ADD COLUMN "pinnedAt" TEXT;
ALTER TABLE "harness_sessions" ADD COLUMN "archivedAt" TEXT;
ALTER TABLE "harness_sessions" ADD COLUMN "readAt" TEXT;
ALTER TABLE "harness_sessions" ADD COLUMN "hasQueuedInput" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "harness_sessions" ADD COLUMN "sourceSessionId" TEXT;
ALTER TABLE "harness_sessions" ADD COLUMN "sourceTurnId" TEXT;
ALTER TABLE "harness_commands" ADD COLUMN "resultSessionId" TEXT;

CREATE UNIQUE INDEX "harness_sessions_nodeId_harness_threadId_key" ON "harness_sessions"("nodeId", "harness", "threadId");
DROP INDEX "harness_sessions_nodeId_threadId_key";
CREATE INDEX "harness_sessions_harness_archivedAt_updatedAt_id_idx" ON "harness_sessions"("harness", "archivedAt", "updatedAt", "id");
