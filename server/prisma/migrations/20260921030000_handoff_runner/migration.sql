-- CreateTable
CREATE TABLE "Handoff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "provider" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'manual',
    "instruction" TEXT NOT NULL,
    "inputSnapshot" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "permissions" TEXT NOT NULL DEFAULT '{}',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL DEFAULT 'user',
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "handoffId" TEXT NOT NULL,
    "continuationOf" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "provider" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "externalSessionId" TEXT,
    "claimTokenHash" TEXT,
    "claimOwner" TEXT,
    "configJson" TEXT NOT NULL DEFAULT '{}',
    "workspaceJson" TEXT NOT NULL DEFAULT '{}',
    "resultJson" TEXT,
    "error" TEXT,
    "lastSequence" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TEXT,
    "endedAt" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    CONSTRAINT "Run_handoffId_fkey" FOREIGN KEY ("handoffId") REFERENCES "Handoff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "eventId" TEXT,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    CONSTRAINT "RunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT,
    "path" TEXT,
    "hash" TEXT NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TEXT NOT NULL,
    CONSTRAINT "Artifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HandoffReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "handoffId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "comment" TEXT NOT NULL DEFAULT '',
    "taskRevision" INTEGER NOT NULL,
    "createdAt" TEXT NOT NULL,
    CONSTRAINT "HandoffReview_handoffId_fkey" FOREIGN KEY ("handoffId") REFERENCES "Handoff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CodeApplication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "artifactId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'prepared',
    "targetPath" TEXT NOT NULL,
    "expectedHead" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "Handoff_taskId_createdAt_idx" ON "Handoff"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "Run_status_createdAt_idx" ON "Run"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RunEvent_runId_sequence_key" ON "RunEvent"("runId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "RunEvent_runId_eventId_key" ON "RunEvent"("runId", "eventId");

-- CreateIndex
CREATE INDEX "Artifact_runId_idx" ON "Artifact"("runId");

-- CreateIndex
CREATE INDEX "HandoffReview_handoffId_idx" ON "HandoffReview"("handoffId");

-- CreateIndex
CREATE INDEX "CodeApplication_runId_idx" ON "CodeApplication"("runId");
