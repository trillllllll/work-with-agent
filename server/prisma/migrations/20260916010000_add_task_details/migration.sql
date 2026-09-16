-- Add task scheduling and priority details while preserving existing tasks.
ALTER TABLE "tasks" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "tasks" ADD COLUMN "due_date" TEXT;
