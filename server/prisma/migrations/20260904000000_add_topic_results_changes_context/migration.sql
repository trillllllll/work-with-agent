ALTER TABLE "topics" ADD COLUMN "goal" TEXT NOT NULL DEFAULT '';
ALTER TABLE "topics" ADD COLUMN "draft_summary" TEXT NOT NULL DEFAULT '';
ALTER TABLE "topics" ADD COLUMN "final_summary" TEXT NOT NULL DEFAULT '';
ALTER TABLE "topics" ADD COLUMN "summary_status" TEXT NOT NULL DEFAULT 'empty';
ALTER TABLE "topics" ADD COLUMN "summary_updated_at" TEXT;
ALTER TABLE "conversations" ADD COLUMN "summary_version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "conversations" ADD COLUMN "last_compacted_at" TEXT;
ALTER TABLE "conversations" ADD COLUMN "token_estimate" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "messages" ADD COLUMN "compacted_at" TEXT;
CREATE TABLE "change_records" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "before_snapshot" TEXT,
  "after_snapshot" TEXT,
  "source" TEXT NOT NULL,
  "conversation_id" TEXT,
  "approval_id" TEXT,
  "undone_at" TEXT,
  "created_at" TEXT NOT NULL DEFAULT ''
);
CREATE INDEX "change_records_entity_type_entity_id_created_at_idx" ON "change_records"("entity_type", "entity_id", "created_at");
