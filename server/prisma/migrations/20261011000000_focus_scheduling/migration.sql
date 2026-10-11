-- AlterTable
ALTER TABLE "tasks" ADD COLUMN "estimated_minutes" INTEGER;
ALTER TABLE "tasks" ADD COLUMN "scheduled_start" TEXT;
ALTER TABLE "tasks" ADD COLUMN "scheduled_end" TEXT;

-- CreateTable
CREATE TABLE "focus_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'focus',
    "started_at" TEXT NOT NULL,
    "ended_at" TEXT NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "planned_minutes" INTEGER NOT NULL DEFAULT 25,
    "completed" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "focus_sessions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "focus_sessions_task_id_idx" ON "focus_sessions"("task_id");
CREATE INDEX "focus_sessions_started_at_idx" ON "focus_sessions"("started_at");
