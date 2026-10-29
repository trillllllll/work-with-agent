ALTER TABLE "Material" ADD COLUMN "managed" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Material" SET "managed" = true WHERE "sourceTaskId" IS NOT NULL;
