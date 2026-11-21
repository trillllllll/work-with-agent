CREATE TABLE "harness_directories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL
);
CREATE UNIQUE INDEX "harness_directories_nodeId_path_key" ON "harness_directories"("nodeId", "path");
