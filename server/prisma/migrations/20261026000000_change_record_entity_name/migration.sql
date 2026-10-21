-- Change history names are stored on the row so search does not read snapshots.
-- Plain ADD COLUMN and CREATE INDEX; do not rebuild change_records.

-- AlterTable
ALTER TABLE "change_records" ADD COLUMN "entity_name" TEXT;

-- CreateIndex
CREATE INDEX "change_records_created_at_id_idx" ON "change_records"("created_at", "id");

-- CreateIndex
CREATE INDEX "change_records_entity_id_idx" ON "change_records"("entity_id");
