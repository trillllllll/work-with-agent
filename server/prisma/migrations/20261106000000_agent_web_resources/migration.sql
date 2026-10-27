CREATE TABLE "agent_web_requests" (
 "id" TEXT NOT NULL PRIMARY KEY, "run_id" TEXT NOT NULL, "call_key" TEXT NOT NULL,
 "kind" TEXT NOT NULL, "target_hash" TEXT NOT NULL, "state" TEXT NOT NULL DEFAULT 'reserved',
 "category" TEXT, "retryable" BOOLEAN NOT NULL DEFAULT false, "result_json" TEXT,
 "charged_ms" INTEGER NOT NULL, "created_at" TEXT NOT NULL,
 CONSTRAINT "agent_web_requests_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "agent_web_requests_run_id_call_key_key" ON "agent_web_requests"("run_id", "call_key");
CREATE INDEX "agent_web_requests_run_id_kind_target_hash_idx" ON "agent_web_requests"("run_id", "kind", "target_hash");
CREATE TABLE "agent_web_pages" (
 "id" TEXT NOT NULL PRIMARY KEY, "run_id" TEXT NOT NULL, "url" TEXT NOT NULL, "url_hash" TEXT NOT NULL,
 "version" TEXT NOT NULL, "title" TEXT, "content" TEXT NOT NULL, "bytes" INTEGER NOT NULL, "fetched_at" TEXT NOT NULL,
 CONSTRAINT "agent_web_pages_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "agent_runs" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "agent_web_pages_run_id_url_hash_key" ON "agent_web_pages"("run_id", "url_hash");
