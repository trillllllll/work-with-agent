-- AlterTable
ALTER TABLE "change_records" ADD COLUMN "actor_id" TEXT;
ALTER TABLE "change_records" ADD COLUMN "connection_id" TEXT;
ALTER TABLE "change_records" ADD COLUMN "proposal_id" TEXT;

-- CreateTable
CREATE TABLE "LocalSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "csrfHash" TEXT NOT NULL,
    "expiresAt" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Connection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "topicIds" TEXT NOT NULL DEFAULT '[]',
    "includeInbox" BOOLEAN NOT NULL DEFAULT false,
    "autoActions" TEXT NOT NULL DEFAULT '[]',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorId" TEXT NOT NULL,
    "connectionId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "commands" TEXT NOT NULL,
    "preconditions" TEXT NOT NULL,
    "preview" TEXT NOT NULL,
    "result" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "RequestReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actorId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "LocalSession_tokenHash_key" ON "LocalSession"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_tokenHash_key" ON "Connection"("tokenHash");

-- CreateIndex
CREATE INDEX "Connection_status_createdAt_idx" ON "Connection"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Proposal_status_createdAt_idx" ON "Proposal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Proposal_actorId_createdAt_idx" ON "Proposal"("actorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RequestReceipt_actorId_requestId_key" ON "RequestReceipt"("actorId", "requestId");


-- Idempotency is scoped to the authenticated actor in RequestReceipt.
DROP INDEX IF EXISTS "change_records_request_id_key";
