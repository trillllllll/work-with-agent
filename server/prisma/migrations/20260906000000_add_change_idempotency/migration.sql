ALTER TABLE "change_records" ADD COLUMN "request_id" TEXT;
ALTER TABLE "change_records" ADD COLUMN "reversal_of" TEXT;
CREATE UNIQUE INDEX "change_records_request_id_key" ON "change_records"("request_id") WHERE "request_id" IS NOT NULL;
