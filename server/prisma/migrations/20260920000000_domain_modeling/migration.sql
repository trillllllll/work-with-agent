ALTER TABLE "topics" ADD COLUMN "archived_at" TEXT;

CREATE TABLE "task_topic_assignments" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "task_id" TEXT NOT NULL,
  "from_topic_id" TEXT,
  "to_topic_id" TEXT,
  "reason" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "conversation_id" TEXT,
  "approval_id" TEXT,
  "changed_at" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "task_topic_assignments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "task_topic_assignments_from_topic_id_fkey" FOREIGN KEY ("from_topic_id") REFERENCES "topics" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "task_topic_assignments_to_topic_id_fkey" FOREIGN KEY ("to_topic_id") REFERENCES "topics" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "task_topic_assignments_task_id_changed_at_idx" ON "task_topic_assignments"("task_id", "changed_at");
CREATE INDEX "task_topic_assignments_from_topic_id_idx" ON "task_topic_assignments"("from_topic_id");
CREATE INDEX "task_topic_assignments_to_topic_id_idx" ON "task_topic_assignments"("to_topic_id");

INSERT INTO "task_topic_assignments" (
  "id", "task_id", "from_topic_id", "to_topic_id", "reason", "source", "changed_at"
)
SELECT
  'migration-' || "id", "id", NULL, "topic_id", 'migration', 'system', "created_at"
FROM "tasks"
WHERE "topic_id" IS NOT NULL;
