-- AlterTable
ALTER TABLE "Memory" ADD COLUMN "importance" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "Memory" ADD COLUMN "labels" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Memory" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "MemoryVersion" ADD COLUMN "importance" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "MemoryVersion" ADD COLUMN "labels" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "MemoryVersion" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'manual';

-- CreateIndex
DROP INDEX "Memory_topicId_status_updatedAt_idx";
CREATE INDEX "Memory_topicId_status_importance_updatedAt_idx" ON "Memory"("topicId", "status", "importance", "updatedAt");

-- CreateTable
CREATE TABLE "Entity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topicKey" TEXT NOT NULL,
    "topicId" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'concept',
    "description" TEXT NOT NULL DEFAULT '',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "GraphLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topicId" TEXT,
    "fromType" TEXT NOT NULL,
    "fromId" TEXT NOT NULL,
    "toType" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Entity_topicKey_name_key" ON "Entity"("topicKey", "name");
CREATE INDEX "Entity_topicId_kind_idx" ON "Entity"("topicId", "kind");
CREATE UNIQUE INDEX "GraphLink_fromType_fromId_toType_toId_relation_key" ON "GraphLink"("fromType", "fromId", "toType", "toId", "relation");
CREATE INDEX "GraphLink_fromId_fromType_idx" ON "GraphLink"("fromId", "fromType");
CREATE INDEX "GraphLink_toId_toType_idx" ON "GraphLink"("toId", "toType");
