-- Built-in assistant usage. ADD COLUMN only: agent_runs rows are appended per
-- request, so old rows stay NULL and read as "no usage recorded".

-- AlterTable
ALTER TABLE "agent_runs" ADD COLUMN "input_tokens" INTEGER;
ALTER TABLE "agent_runs" ADD COLUMN "cached_input_tokens" INTEGER;
ALTER TABLE "agent_runs" ADD COLUMN "output_tokens" INTEGER;
ALTER TABLE "agent_runs" ADD COLUMN "model" TEXT;
