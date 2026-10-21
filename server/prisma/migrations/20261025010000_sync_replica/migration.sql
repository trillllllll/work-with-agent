-- Replica bookkeeping. The hub log stays in sync_ops.
-- The device token is not stored here.

CREATE TABLE "sync_outbox" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "op_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before_json" TEXT,
    "after_json" TEXT,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX "sync_outbox_op_id_key" ON "sync_outbox"("op_id");
CREATE INDEX "sync_outbox_state_seq_idx" ON "sync_outbox"("state", "seq");

CREATE TABLE "sync_state" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applied_hub_seq" INTEGER NOT NULL DEFAULT 0,
    "baseline_ready" BOOLEAN NOT NULL DEFAULT 0,
    "updated_at" TEXT NOT NULL DEFAULT ''
);
