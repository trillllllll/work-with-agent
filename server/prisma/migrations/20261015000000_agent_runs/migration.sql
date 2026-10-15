-- AlterTable
ALTER TABLE "conversations" ADD COLUMN "active_run_id" TEXT;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN "parts_json" TEXT NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "change_records" ADD COLUMN "approved_by_actor_id" TEXT;

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversation_id" TEXT NOT NULL,
    "source_user_message_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "pause_reason" TEXT,
    "context_json" TEXT NOT NULL,
    "model_messages_json" TEXT NOT NULL,
    "cursor_json" TEXT NOT NULL,
    "next_event_seq" INTEGER NOT NULL DEFAULT 0,
    "lease_token" TEXT,
    "lease_expires_at" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    "completed_at" TEXT,
    CONSTRAINT "agent_runs_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_source_user_message_id_key" ON "agent_runs"("source_user_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_runs_request_key_key" ON "agent_runs"("request_key");

-- CreateIndex
CREATE INDEX "agent_runs_state_updated_at_idx" ON "agent_runs"("state", "updated_at");

-- CreateIndex
CREATE INDEX "agent_runs_conversation_id_created_at_idx" ON "agent_runs"("conversation_id", "created_at");

-- One queued, running, or waiting request per conversation.
CREATE UNIQUE INDEX "agent_runs_one_active_per_conversation" ON "agent_runs"("conversation_id") WHERE "state" IN ('queued', 'running', 'waiting_approval');

-- CreateTable
CREATE TABLE "agent_run_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "run_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "data_json" TEXT NOT NULL,
    "created_at" TEXT NOT NULL,
    CONSTRAINT "agent_run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_events_run_id_seq_key" ON "agent_run_events"("run_id", "seq");

-- AlterTable
ALTER TABLE "approvals" ADD COLUMN "run_id" TEXT REFERENCES "agent_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "approvals" ADD COLUMN "decision_token" TEXT;

-- AlterTable
ALTER TABLE "approvals" ADD COLUMN "decision_expires_at" TEXT;

-- CreateIndex
CREATE INDEX "approvals_run_id_idx" ON "approvals"("run_id");
