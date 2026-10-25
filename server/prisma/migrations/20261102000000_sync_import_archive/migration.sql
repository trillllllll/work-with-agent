CREATE TABLE "sync_imports" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "fingerprint" TEXT NOT NULL,
 "source" TEXT NOT NULL,
 "created_at" TEXT NOT NULL
);
CREATE INDEX "sync_imports_fingerprint_idx" ON "sync_imports"("fingerprint");
CREATE TABLE "sync_import_archive" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "source" TEXT NOT NULL,
 "table_name" TEXT NOT NULL,
 "entity_key" TEXT NOT NULL,
 "payload" TEXT NOT NULL,
 "created_at" TEXT NOT NULL
);
