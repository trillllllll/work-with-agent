CREATE TABLE "task_images" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "byte_size" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "created_at" TEXT NOT NULL DEFAULT ''
);

CREATE INDEX "task_images_task_id_idx" ON "task_images"("task_id");
