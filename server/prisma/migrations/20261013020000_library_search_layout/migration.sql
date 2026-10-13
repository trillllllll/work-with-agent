ALTER TABLE "LibrarySearchPosting" ADD COLUMN "materialId" TEXT NOT NULL DEFAULT '';

UPDATE "LibrarySearchPosting"
SET "materialId" = (
  SELECT "materialId" FROM "LibrarySearchDocument" WHERE "id" = "LibrarySearchPosting"."documentId"
)
WHERE "materialId" = '';

CREATE TABLE "LibrarySearchNormMap" (
  "documentId" TEXT NOT NULL PRIMARY KEY,
  "normalizationMapJson" TEXT NOT NULL,
  CONSTRAINT "LibrarySearchNormMap_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "LibrarySearchDocument"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "LibrarySearchNormMap" ("documentId", "normalizationMapJson")
SELECT "id", "normalizationMapJson"
FROM "LibrarySearchDocument"
WHERE "normalizationMapJson" <> '[]';

UPDATE "LibrarySearchDocument"
SET "normalizationMapJson" = '[]'
WHERE "normalizationMapJson" <> '[]';
