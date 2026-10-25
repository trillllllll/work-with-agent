CREATE TABLE "sync_receipts" (
  "op_id" TEXT NOT NULL PRIMARY KEY,
  "request_hash" TEXT NOT NULL,
  "result_json" TEXT NOT NULL,
  "created_at" TEXT NOT NULL
);
