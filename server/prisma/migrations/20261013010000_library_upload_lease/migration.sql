-- Receive leases and commit idempotency for library uploads.
-- Already-applied library SQL is left untouched.

ALTER TABLE "LibraryUpload" ADD COLUMN "receiveLeaseUntil" TEXT;
ALTER TABLE "LibraryUpload" ADD COLUMN "contentKey" TEXT;
ALTER TABLE "LibraryUpload" ADD COLUMN "commitRequestHash" TEXT;
ALTER TABLE "LibraryUpload" ADD COLUMN "commitResultJson" TEXT;

UPDATE "LibraryUpload"
SET "contentKey" = "id"
WHERE "state" = 'ready' AND "contentKey" IS NULL;

UPDATE "LibraryUpload"
SET "state" = 'failed',
    "errorCode" = 'UPLOAD_INTERRUPTED',
    "leaseToken" = NULL,
    "receiveLeaseUntil" = NULL
WHERE "state" = 'receiving';

CREATE INDEX "LibraryUpload_receiveLease"
ON "LibraryUpload"("state", "receiveLeaseUntil");
