ALTER TABLE "Material" ADD COLUMN "sourceTaskId" TEXT;
CREATE INDEX "Material_sourceTaskId_idx" ON "Material"("sourceTaskId");
ALTER TABLE "MaterialVersion" ADD COLUMN "authoritativeContent" TEXT;
ALTER TABLE "MaterialVersion" ADD COLUMN "supplementalContent" TEXT;

-- A managed legacy image retains its original task's permission scope even when
-- that task moves via replication or an older command adapter.
CREATE TRIGGER "resource_task_image_scope_update" AFTER UPDATE OF topic_id, deleted_at ON tasks
BEGIN
  UPDATE "Material" SET "topicId" = NEW.topic_id,
    "archivedAt" = CASE WHEN NEW.deleted_at IS NOT NULL THEN NEW.deleted_at WHEN OLD.deleted_at IS NOT NULL THEN NULL ELSE "archivedAt" END
    WHERE "sourceTaskId" = NEW.id;
END;
CREATE TRIGGER "resource_task_image_scope_delete" AFTER DELETE ON tasks
BEGIN
  UPDATE "Material" SET "archivedAt" = COALESCE("archivedAt", strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE "sourceTaskId" = OLD.id;
END;
