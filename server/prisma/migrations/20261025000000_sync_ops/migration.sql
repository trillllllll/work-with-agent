-- Hub log for aligning tasks, topics, and tags across devices.
-- Settings, sessions, and credentials stay out of these tables.

CREATE TABLE "sync_ops" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "op_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL DEFAULT 'server',
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "before_json" TEXT,
    "after_json" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX "sync_ops_op_id_key" ON "sync_ops"("op_id");
CREATE INDEX "sync_ops_entity_type_entity_id_idx" ON "sync_ops"("entity_type", "entity_id");

CREATE TABLE "sync_devices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL DEFAULT '',
    "token_hash" TEXT NOT NULL,
    "last_seen_at" TEXT NOT NULL DEFAULT '',
    "created_at" TEXT NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX "sync_devices_token_hash_key" ON "sync_devices"("token_hash");

CREATE TABLE "sync_conflicts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "op_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "base_json" TEXT NOT NULL,
    "live_json" TEXT NOT NULL,
    "incoming_json" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TEXT NOT NULL DEFAULT '',
    "resolved_at" TEXT
);

CREATE INDEX "sync_conflicts_state_created_at_idx" ON "sync_conflicts"("state", "created_at");
