-- CreateTable
CREATE TABLE "AgentNode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "platform" TEXT NOT NULL DEFAULT '',
    "version" TEXT NOT NULL DEFAULT '',
    "capabilitiesJson" TEXT NOT NULL DEFAULT '{}',
    "lastSeenAt" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "defaultProvider" TEXT NOT NULL DEFAULT 'codex',
    "archivedAt" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "ProjectLocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fingerprintJson" TEXT NOT NULL DEFAULT '{}',
    "error" TEXT,
    "verifiedAt" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    CONSTRAINT "ProjectLocation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ProjectLocation_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "AgentNode" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectBinding" (
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,

    PRIMARY KEY ("scopeType", "scopeId"),
    CONSTRAINT "ProjectBinding_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Orchestration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "projectId" TEXT NOT NULL,
    "locationId" TEXT,
    "nodeId" TEXT,
    "repoPath" TEXT NOT NULL DEFAULT '',
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "integrationBranch" TEXT NOT NULL,
    "integrationPath" TEXT,
    "baseCommit" TEXT,
    "integrationHead" TEXT,
    "grantJson" TEXT NOT NULL DEFAULT '{}',
    "planJson" TEXT NOT NULL DEFAULT '{}',
    "taskSnapshotJson" TEXT NOT NULL DEFAULT '{}',
    "pauseReason" TEXT,
    "finalComment" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    "startedAt" TEXT,
    "endedAt" TEXT,
    "acceptedAt" TEXT,
    "pushedAt" TEXT
);

-- CreateTable
CREATE TABLE "OrchestrationStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orchestrationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subtaskId" TEXT,
    "sourceStepId" TEXT,
    "dependsOnJson" TEXT NOT NULL DEFAULT '[]',
    "position" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "continueCount" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TEXT,
    "branch" TEXT,
    "workPath" TEXT,
    "baseCommit" TEXT,
    "resultCommit" TEXT,
    "preMergeHead" TEXT,
    "mergeCommit" TEXT,
    "acceptanceCriteria" TEXT NOT NULL DEFAULT '',
    "lastTaskRevision" INTEGER,
    "feedback" TEXT,
    "lastJobId" TEXT,
    "error" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    CONSTRAINT "OrchestrationStep_orchestrationId_fkey" FOREIGN KEY ("orchestrationId") REFERENCES "Orchestration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NodeJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "orchestrationId" TEXT,
    "stepId" TEXT,
    "kind" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'work',
    "dispatchKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "payloadJson" TEXT NOT NULL,
    "leaseToken" TEXT,
    "leaseExpiresAt" TEXT,
    "resultJson" TEXT,
    "error" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    "startedAt" TEXT,
    "endedAt" TEXT,
    CONSTRAINT "NodeJob_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "AgentNode" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OrchestrationEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orchestrationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "stepId" TEXT,
    "payload" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    CONSTRAINT "OrchestrationEvent_orchestrationId_fkey" FOREIGN KEY ("orchestrationId") REFERENCES "Orchestration" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentNode_tokenHash_key" ON "AgentNode"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectLocation_projectId_nodeId_key" ON "ProjectLocation"("projectId", "nodeId");

-- CreateIndex
CREATE INDEX "Orchestration_status_idx" ON "Orchestration"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Orchestration_taskId_round_key" ON "Orchestration"("taskId", "round");

-- CreateIndex
CREATE INDEX "OrchestrationStep_orchestrationId_status_idx" ON "OrchestrationStep"("orchestrationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "NodeJob_dispatchKey_key" ON "NodeJob"("dispatchKey");

-- CreateIndex
CREATE INDEX "NodeJob_nodeId_status_idx" ON "NodeJob"("nodeId", "status");

-- CreateIndex
CREATE INDEX "NodeJob_orchestrationId_idx" ON "NodeJob"("orchestrationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrchestrationEvent_orchestrationId_seq_key" ON "OrchestrationEvent"("orchestrationId", "seq");


-- One open orchestration per main task.
CREATE UNIQUE INDEX "Orchestration_one_open_per_task" ON "Orchestration"("taskId") WHERE "status" IN ('draft', 'running', 'paused', 'awaiting_acceptance');
