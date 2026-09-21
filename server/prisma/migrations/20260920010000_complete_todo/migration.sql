ALTER TABLE "topics" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "tasks" ADD COLUMN "parent_id" TEXT REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tasks" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "tasks" ADD COLUMN "delete_batch_id" TEXT;

-- Preserve the previous updated-at ordering, using IDs to resolve ties.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "topic_id", "deleted_at" IS NULL ORDER BY "updated_at" DESC, "id" ASC) - 1 AS position
  FROM "tasks"
)
UPDATE "tasks" SET "sort_order" = (SELECT position FROM ranked WHERE ranked.id = tasks.id);

CREATE INDEX "tasks_topic_id_parent_id_deleted_at_sort_order_idx" ON "tasks"("topic_id", "parent_id", "deleted_at", "sort_order");
CREATE INDEX "tasks_parent_id_idx" ON "tasks"("parent_id");
CREATE INDEX "tasks_delete_batch_id_idx" ON "tasks"("delete_batch_id");

CREATE TABLE "tags" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_at" TEXT NOT NULL DEFAULT '',
  "updated_at" TEXT NOT NULL DEFAULT ''
);
CREATE TABLE "task_tags" (
  "task_id" TEXT NOT NULL,
  "tag_id" TEXT NOT NULL,
  PRIMARY KEY ("task_id", "tag_id"),
  FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "task_tags_tag_id_idx" ON "task_tags"("tag_id");
