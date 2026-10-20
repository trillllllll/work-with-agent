ALTER TABLE "app_settings" ADD COLUMN "html_blocks_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "app_settings" ADD COLUMN "html_cdn_allowlist" TEXT NOT NULL DEFAULT '["https://cdn.jsdelivr.net","https://cdnjs.cloudflare.com","https://unpkg.com"]';
