ALTER TABLE "harness_sessions" ADD COLUMN "library" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "harness_sessions" ADD COLUMN "cwd" TEXT;
ALTER TABLE "harness_sessions" ADD COLUMN "nativeTitle" TEXT;

DROP INDEX "harness_sessions_activeNodeId_key";
CREATE INDEX "harness_sessions_activeNodeId_library_idx" ON "harness_sessions"("activeNodeId", "library");
CREATE UNIQUE INDEX "harness_sessions_nodeId_threadId_key" ON "harness_sessions"("nodeId", "threadId");
