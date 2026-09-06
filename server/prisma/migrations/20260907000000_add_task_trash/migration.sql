ALTER TABLE "tasks" ADD COLUMN "deleted_at" TEXT;
CREATE INDEX "tasks_topic_id_deleted_at_idx" ON "tasks"("topic_id", "deleted_at");
CREATE INDEX "tasks_deleted_at_idx" ON "tasks"("deleted_at");
