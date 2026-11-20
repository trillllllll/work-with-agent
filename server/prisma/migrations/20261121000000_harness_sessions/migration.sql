CREATE TABLE "harness_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "activeNodeId" TEXT,
    "locationId" TEXT NOT NULL,
    "projectName" TEXT NOT NULL,
    "startCommandId" TEXT NOT NULL,
    "threadId" TEXT,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "error" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

CREATE UNIQUE INDEX "harness_sessions_activeNodeId_key" ON "harness_sessions"("activeNodeId");
CREATE UNIQUE INDEX "harness_sessions_startCommandId_key" ON "harness_sessions"("startCommandId");

CREATE TABLE "harness_commands" (
    "sessionId" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "createdAt" TEXT NOT NULL,
    "expiresAt" TEXT NOT NULL,
    "dispatchedAt" TEXT,
    CONSTRAINT "harness_commands_pkey" PRIMARY KEY ("sessionId", "commandId"),
    CONSTRAINT "harness_commands_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "harness_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "harness_commands_sessionId_status_createdAt_idx" ON "harness_commands"("sessionId", "status", "createdAt");
