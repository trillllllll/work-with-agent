-- CreateTable
CREATE TABLE "Material" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topicId" TEXT,
    "taskId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "uri" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "MaterialVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "materialId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "contentHash" TEXT NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "attachmentPath" TEXT,
    "mimeType" TEXT,
    "fileName" TEXT,
    "createdAt" TEXT NOT NULL,
    CONSTRAINT "MaterialVersion_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topicId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "health" TEXT NOT NULL DEFAULT 'current',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "evidence" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "MemoryVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memoryId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "health" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL,
    CONSTRAINT "MemoryVersion_memoryId_fkey" FOREIGN KEY ("memoryId") REFERENCES "Memory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkingBrief" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topicId" TEXT,
    "content" TEXT NOT NULL DEFAULT '',
    "manualNotes" TEXT NOT NULL DEFAULT '',
    "manifest" TEXT NOT NULL DEFAULT '[]',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "generatedAt" TEXT,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "OrganizationRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topicId" TEXT,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "snapshot" TEXT NOT NULL,
    "proposalIds" TEXT NOT NULL DEFAULT '[]',
    "result" TEXT,
    "error" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "Material_topicId_archivedAt_updatedAt_idx" ON "Material"("topicId", "archivedAt", "updatedAt");

-- CreateIndex
CREATE INDEX "Material_taskId_idx" ON "Material"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialVersion_materialId_revision_key" ON "MaterialVersion"("materialId", "revision");

-- CreateIndex
CREATE INDEX "Memory_topicId_status_updatedAt_idx" ON "Memory"("topicId", "status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryVersion_memoryId_revision_key" ON "MemoryVersion"("memoryId", "revision");

-- CreateIndex
CREATE INDEX "WorkingBrief_topicId_idx" ON "WorkingBrief"("topicId");

-- CreateIndex
CREATE INDEX "OrganizationRequest_topicId_status_createdAt_idx" ON "OrganizationRequest"("topicId", "status", "createdAt");
