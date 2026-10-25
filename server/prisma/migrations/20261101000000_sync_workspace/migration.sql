CREATE TABLE "sync_workspace" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspace_id" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
CREATE UNIQUE INDEX "sync_workspace_workspace_id_key" ON "sync_workspace"("workspace_id");
