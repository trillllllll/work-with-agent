ALTER TABLE "messages" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE "approvals" ADD COLUMN "conversation_id" TEXT;

CREATE INDEX "approvals_conversation_id_idx" ON "approvals"("conversation_id");
