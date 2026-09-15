PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topic_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'todo',
    "result_summary" TEXT NOT NULL DEFAULT '',
    "deleted_at" TEXT,
    "created_at" TEXT NOT NULL DEFAULT '',
    "updated_at" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "new_tasks_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "topics" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_tasks" ("id", "topic_id", "title", "description", "status", "result_summary", "deleted_at", "created_at", "updated_at")
SELECT "id", "topic_id", "title", "description", "status", "result_summary", "deleted_at", "created_at", "updated_at" FROM "tasks";

DROP TABLE "tasks";
ALTER TABLE "new_tasks" RENAME TO "tasks";

CREATE INDEX "tasks_topic_id_idx" ON "tasks"("topic_id");
CREATE INDEX "tasks_topic_id_deleted_at_idx" ON "tasks"("topic_id", "deleted_at");
CREATE INDEX "tasks_deleted_at_idx" ON "tasks"("deleted_at");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
