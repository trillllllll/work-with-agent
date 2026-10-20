-- Dispatch usage (phase 1): CLI tokens, cost, exit code and numstat reported by wwa-node.
-- Plain ADD COLUMN keeps the partial unique index Orchestration_one_open_per_task from phase 1.
-- Rebuilding the Orchestration table would drop that index.

-- AlterTable
ALTER TABLE "NodeJob" ADD COLUMN "exitCode" INTEGER;
ALTER TABLE "NodeJob" ADD COLUMN "provider" TEXT;
ALTER TABLE "NodeJob" ADD COLUMN "cliVersion" TEXT;
ALTER TABLE "NodeJob" ADD COLUMN "model" TEXT;
ALTER TABLE "NodeJob" ADD COLUMN "inputTokens" INTEGER;
ALTER TABLE "NodeJob" ADD COLUMN "cachedInputTokens" INTEGER;
ALTER TABLE "NodeJob" ADD COLUMN "outputTokens" INTEGER;
ALTER TABLE "NodeJob" ADD COLUMN "costMicroUsd" INTEGER;
ALTER TABLE "NodeJob" ADD COLUMN "numTurns" INTEGER;
ALTER TABLE "NodeJob" ADD COLUMN "cliDurationMs" INTEGER;
ALTER TABLE "NodeJob" ADD COLUMN "runDurationMs" INTEGER;
ALTER TABLE "NodeJob" ADD COLUMN "usageJson" TEXT;
ALTER TABLE "NodeJob" ADD COLUMN "filesChanged" INTEGER;
ALTER TABLE "NodeJob" ADD COLUMN "linesAdded" INTEGER;
ALTER TABLE "NodeJob" ADD COLUMN "linesDeleted" INTEGER;
ALTER TABLE "NodeJob" ADD COLUMN "diffStatJson" TEXT;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN "exitCode" INTEGER;
ALTER TABLE "Run" ADD COLUMN "cliVersion" TEXT;
ALTER TABLE "Run" ADD COLUMN "model" TEXT;
ALTER TABLE "Run" ADD COLUMN "inputTokens" INTEGER;
ALTER TABLE "Run" ADD COLUMN "cachedInputTokens" INTEGER;
ALTER TABLE "Run" ADD COLUMN "outputTokens" INTEGER;
ALTER TABLE "Run" ADD COLUMN "costMicroUsd" INTEGER;
ALTER TABLE "Run" ADD COLUMN "numTurns" INTEGER;
ALTER TABLE "Run" ADD COLUMN "cliDurationMs" INTEGER;
ALTER TABLE "Run" ADD COLUMN "runDurationMs" INTEGER;
ALTER TABLE "Run" ADD COLUMN "usageJson" TEXT;
