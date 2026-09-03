CREATE TABLE "app_settings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "openai_base_url" TEXT NOT NULL DEFAULT '',
    "openai_api_key" TEXT NOT NULL DEFAULT '',
    "openai_model" TEXT NOT NULL DEFAULT '',
    "created_at" TEXT NOT NULL DEFAULT '',
    "updated_at" TEXT NOT NULL DEFAULT ''
);
