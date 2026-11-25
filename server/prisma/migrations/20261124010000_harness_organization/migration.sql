ALTER TABLE "harness_sessions" ADD COLUMN "nativeOrganizationJson" TEXT;
ALTER TABLE "harness_sessions" ADD COLUMN "nativePinOrder" REAL;
ALTER TABLE "harness_sessions" ADD COLUMN "pinnedOverride" BOOLEAN;
ALTER TABLE "harness_sessions" ADD COLUMN "archivedOverride" BOOLEAN;
ALTER TABLE "AgentNode" ADD COLUMN "harnessProjectPinsJson" TEXT;

UPDATE "harness_sessions" SET "pinnedOverride" = 1 WHERE "pinnedAt" IS NOT NULL;
UPDATE "harness_sessions" SET "archivedOverride" = 1 WHERE "archivedAt" IS NOT NULL;
