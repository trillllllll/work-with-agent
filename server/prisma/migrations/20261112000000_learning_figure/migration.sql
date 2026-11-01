-- 学习主图：每个主题一张，经确认保存
CREATE TABLE "learning_figures" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "map_id" TEXT NOT NULL,
    "svg" TEXT NOT NULL,
    "node_ids_json" TEXT NOT NULL DEFAULT '[]',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT NOT NULL DEFAULT '',
    "updated_at" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "learning_figures_map_id_fkey" FOREIGN KEY ("map_id") REFERENCES "learning_maps" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "learning_figures_map_id_key" ON "learning_figures"("map_id");
