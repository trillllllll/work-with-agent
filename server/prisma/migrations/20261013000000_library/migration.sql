-- Library folders, tags, task links, uploads, extraction and the character n-gram index.
-- CHECK constraints and expression/partial indexes stay in SQL because Prisma cannot express them.

CREATE TABLE "LibraryFolder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "parentId" TEXT,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  FOREIGN KEY ("parentId") REFERENCES "LibraryFolder"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LibraryFolder_sibling_name"
ON "LibraryFolder"(COALESCE("parentId", ''), "normalizedName");

CREATE INDEX "LibraryFolder_parent"
ON "LibraryFolder"("parentId");

ALTER TABLE "Material"
ADD COLUMN "folderId" TEXT
REFERENCES "LibraryFolder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Material"
ADD COLUMN "organizationRevision" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "Material_folder"
ON "Material"("folderId", "archivedAt", "updatedAt");

CREATE TABLE "LibraryTag" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "normalizedName" TEXT NOT NULL UNIQUE,
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL
);

CREATE TABLE "MaterialTag" (
  "materialId" TEXT NOT NULL,
  "tagId" TEXT NOT NULL,
  PRIMARY KEY ("materialId", "tagId"),
  FOREIGN KEY ("materialId") REFERENCES "Material"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("tagId") REFERENCES "LibraryTag"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "MaterialTag_tag"
ON "MaterialTag"("tagId", "materialId");

CREATE TABLE "MaterialTaskLink" (
  "materialId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "manual" INTEGER NOT NULL DEFAULT 0 CHECK ("manual" IN (0, 1)),
  "legacy" INTEGER NOT NULL DEFAULT 0 CHECK ("legacy" IN (0, 1)),
  "createdAt" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  PRIMARY KEY ("materialId", "taskId"),
  CHECK ("manual" + "legacy" >= 1),
  FOREIGN KEY ("materialId") REFERENCES "Material"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("taskId") REFERENCES "tasks"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MaterialTaskLink_task"
ON "MaterialTaskLink"("taskId", "materialId");

CREATE TABLE "LibraryUpload" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actorId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "declaredSize" INTEGER NOT NULL
    CHECK ("declaredSize" >= 0 AND "declaredSize" <= 104857600),
  "actualSize" INTEGER,
  "sha256" TEXT,
  "state" TEXT NOT NULL DEFAULT 'pending'
    CHECK ("state" IN (
      'pending', 'receiving', 'ready', 'committed', 'cancelled', 'failed'
    )),
  "leaseToken" TEXT,
  "materialId" TEXT,
  "resultRevision" INTEGER,
  "errorCode" TEXT,
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL,
  UNIQUE ("actorId", "requestKey")
);

CREATE INDEX "LibraryUpload_expiry"
ON "LibraryUpload"("state", "expiresAt");

CREATE TABLE "MaterialExtraction" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "materialId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "parserVersion" TEXT NOT NULL DEFAULT 'library-v1',
  "status" TEXT NOT NULL DEFAULT 'queued'
    CHECK ("status" IN (
      'queued', 'running', 'ready', 'partial',
      'blocked', 'failed', 'unsupported'
    )),
  "generation" INTEGER NOT NULL DEFAULT 0,
  "indexedGeneration" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT,
  "leaseUntil" TEXT,
  "nextAttemptAt" TEXT NOT NULL,
  "errorCode" TEXT,
  "errorsJson" TEXT NOT NULL DEFAULT '[]',
  "createdAt" TEXT NOT NULL,
  "updatedAt" TEXT NOT NULL,
  UNIQUE ("materialId", "revision"),
  FOREIGN KEY ("materialId", "revision")
    REFERENCES "MaterialVersion"("materialId", "revision")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "MaterialExtraction_queue"
ON "MaterialExtraction"("status", "nextAttemptAt", "leaseUntil");

CREATE TABLE "MaterialChunk" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "extractionId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "ordinal" INTEGER NOT NULL CHECK ("ordinal" >= 0),
  "text" TEXT NOT NULL,
  "textHash" TEXT NOT NULL,
  "locatorJson" TEXT NOT NULL,
  "method" TEXT NOT NULL CHECK ("method" IN ('native', 'ocr')),
  "createdAt" TEXT NOT NULL,
  UNIQUE ("extractionId", "generation", "ordinal"),
  FOREIGN KEY ("extractionId") REFERENCES "MaterialExtraction"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "LibrarySearchDocument" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "materialId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "chunkId" TEXT,
  "titleNorm" TEXT NOT NULL,
  "fileNameNorm" TEXT NOT NULL,
  "tagsNorm" TEXT NOT NULL,
  "bodyNorm" TEXT NOT NULL,
  "normalizationMapJson" TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY ("materialId", "revision")
    REFERENCES "MaterialVersion"("materialId", "revision")
    ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("chunkId") REFERENCES "MaterialChunk"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "LibrarySearchDocument_meta"
ON "LibrarySearchDocument"("materialId", "revision")
WHERE "chunkId" IS NULL;

CREATE UNIQUE INDEX "LibrarySearchDocument_chunk"
ON "LibrarySearchDocument"("chunkId")
WHERE "chunkId" IS NOT NULL;

CREATE INDEX "LibrarySearchDocument_material"
ON "LibrarySearchDocument"("materialId", "revision");

CREATE TABLE "LibrarySearchPosting" (
  "token" TEXT NOT NULL,
  "documentId" TEXT NOT NULL,
  PRIMARY KEY ("token", "documentId"),
  FOREIGN KEY ("documentId") REFERENCES "LibrarySearchDocument"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "LibrarySearchPosting_document"
ON "LibrarySearchPosting"("documentId");

CREATE TABLE "LibraryAnswer" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actorId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "filtersJson" TEXT NOT NULL,
  "status" TEXT NOT NULL
    CHECK ("status" IN ('answered', 'insufficient', 'model_unavailable')),
  "resultJson" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  UNIQUE ("actorId", "requestKey")
);
