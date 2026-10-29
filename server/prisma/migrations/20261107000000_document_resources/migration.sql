ALTER TABLE "MaterialVersion" ADD COLUMN "format" TEXT;
ALTER TABLE "MaterialVersion" ADD COLUMN "schemaVersion" INTEGER;
ALTER TABLE "MaterialVersion" ADD COLUMN "sourceOriginalPath" TEXT;

CREATE TABLE "ResourceReference" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sourceResourceId" TEXT NOT NULL,
  "sourceRevision" INTEGER NOT NULL,
  "nodeId" TEXT NOT NULL,
  "targetResourceId" TEXT NOT NULL,
  "targetRevision" INTEGER NOT NULL,
  CONSTRAINT "ResourceReference_source_fkey" FOREIGN KEY ("sourceResourceId", "sourceRevision") REFERENCES "MaterialVersion" ("materialId", "revision") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ResourceReference_target_fkey" FOREIGN KEY ("targetResourceId", "targetRevision") REFERENCES "MaterialVersion" ("materialId", "revision") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ResourceReference_sourceResourceId_sourceRevision_nodeId_key" ON "ResourceReference"("sourceResourceId", "sourceRevision", "nodeId");
CREATE INDEX "ResourceReference_targetResourceId_targetRevision_idx" ON "ResourceReference"("targetResourceId", "targetRevision");
CREATE TABLE "ResourceWriteReceipt" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "actorId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "resultJson" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL
);
CREATE UNIQUE INDEX "ResourceWriteReceipt_actorId_requestId_key" ON "ResourceWriteReceipt"("actorId", "requestId");
CREATE TABLE "ResourceLegacyAlias" (
  "sourceKind" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  PRIMARY KEY ("sourceKind", "sourceId")
);
CREATE INDEX "ResourceLegacyAlias_resourceId_idx" ON "ResourceLegacyAlias"("resourceId");
