-- Stats overview columns. ADD COLUMN / CREATE INDEX only: recreating "tasks"
-- would rebuild every foreign key that points at it. Types match
-- `prisma migrate diff` (completed_at TEXT, completed_at_estimated BOOLEAN NOT NULL DEFAULT false).

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "completed_at" TEXT;
ALTER TABLE "tasks" ADD COLUMN "completed_at_estimated" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "tasks_completed_at_idx" ON "tasks"("completed_at");

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN "last_used_at" TEXT;

-- CreateIndex
CREATE INDEX "change_records_connection_id_created_at_idx" ON "change_records"("connection_id", "created_at");

-- Range aggregates for the stats overview. (created_at, connection_id) covers the
-- connection write GROUP BY so SQLite does not read snapshot blobs.
CREATE INDEX "tasks_created_at_idx" ON "tasks"("created_at");
CREATE INDEX "change_records_created_at_connection_id_idx" ON "change_records"("created_at", "connection_id");
