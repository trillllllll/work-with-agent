-- 学习域与助手身份归属
CREATE TABLE "learning_maps" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TEXT,
    "created_at" TEXT NOT NULL DEFAULT '',
    "updated_at" TEXT NOT NULL DEFAULT ''
);

CREATE INDEX "learning_maps_deleted_at_status_sort_order_idx" ON "learning_maps"("deleted_at", "status", "sort_order");

CREATE TABLE "learning_nodes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "map_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'topic',
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'todo',
    "mastery" INTEGER NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TEXT,
    "created_at" TEXT NOT NULL DEFAULT '',
    "updated_at" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "learning_nodes_map_id_fkey" FOREIGN KEY ("map_id") REFERENCES "learning_maps" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "learning_nodes_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "learning_nodes" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "learning_nodes_map_id_idx" ON "learning_nodes"("map_id");
CREATE INDEX "learning_nodes_map_id_deleted_at_sort_order_idx" ON "learning_nodes"("map_id", "deleted_at", "sort_order");
CREATE INDEX "learning_nodes_parent_id_idx" ON "learning_nodes"("parent_id");
CREATE INDEX "learning_nodes_deleted_at_idx" ON "learning_nodes"("deleted_at");

CREATE TABLE "learning_activity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "map_id" TEXT NOT NULL,
    "node_id" TEXT,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "meta_json" TEXT NOT NULL DEFAULT '{}',
    "created_at" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "learning_activity_map_id_fkey" FOREIGN KEY ("map_id") REFERENCES "learning_maps" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "learning_activity_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "learning_nodes" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "learning_activity_node_id_created_at_idx" ON "learning_activity"("node_id", "created_at");
CREATE INDEX "learning_activity_map_id_created_at_idx" ON "learning_activity"("map_id", "created_at");

ALTER TABLE "conversations" ADD COLUMN "identity_id" TEXT NOT NULL DEFAULT 'work';
CREATE INDEX "conversations_identity_id_idx" ON "conversations"("identity_id");
ALTER TABLE "Skill" ADD COLUMN "identity_id" TEXT NOT NULL DEFAULT 'work';
CREATE INDEX "Skill_identity_id_idx" ON "Skill"("identity_id");
ALTER TABLE "Memory" ADD COLUMN "identity_id" TEXT NOT NULL DEFAULT 'work';
CREATE INDEX "Memory_identity_id_idx" ON "Memory"("identity_id");
ALTER TABLE "app_settings" ADD COLUMN "assistant_identity_json" TEXT NOT NULL DEFAULT '{}';
