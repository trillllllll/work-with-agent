-- CreateTable
CREATE TABLE "AutoMemoryScope" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topicId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "initializedAt" TEXT,
    "dirtySince" TEXT,
    "dueAt" TEXT,
    "lastStartedAt" TEXT,
    "lastCompletedAt" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "AutoMemorySource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeKey" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "part" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "observedHash" TEXT NOT NULL,
    "processedHash" TEXT,
    "failedHash" TEXT,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "firstObservedAt" TEXT NOT NULL,
    "changedAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AutoMemorySource_scopeKey_sourceType_sourceId_part_key" ON "AutoMemorySource"("scopeKey", "sourceType", "sourceId", "part");

-- CreateIndex
CREATE INDEX "AutoMemorySource_scopeKey_available_changedAt_idx" ON "AutoMemorySource"("scopeKey", "available", "changedAt");

-- CreateTable
CREATE TABLE "AutoMemoryJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeKey" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "snapshot" TEXT NOT NULL,
    "modelOutput" TEXT,
    "proposalIds" TEXT NOT NULL DEFAULT '[]',
    "leaseToken" TEXT,
    "leaseExpiresAt" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TEXT NOT NULL,
    "startedAt" TEXT,
    "completedAt" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "AutoMemoryJob_scopeKey_inputHash_attempt_key" ON "AutoMemoryJob"("scopeKey", "inputHash", "attempt");

-- CreateIndex
CREATE INDEX "AutoMemoryJob_status_createdAt_idx" ON "AutoMemoryJob"("status", "createdAt");

-- CreateTable
CREATE TABLE "AutoMemoryTurn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "topicId" TEXT,
    "userMessageId" TEXT NOT NULL,
    "assistantMessageIds" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'collecting',
    "materialIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TEXT NOT NULL,
    "completedAt" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "AutoMemoryTurn_userMessageId_key" ON "AutoMemoryTurn"("userMessageId");

-- CreateIndex
CREATE INDEX "AutoMemoryTurn_status_createdAt_idx" ON "AutoMemoryTurn"("status", "createdAt");

-- CreateTable
CREATE TABLE "MemorySuggestionKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeKey" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "MemorySuggestionKey_scopeKey_proposalId_idx" ON "MemorySuggestionKey"("scopeKey", "proposalId");
