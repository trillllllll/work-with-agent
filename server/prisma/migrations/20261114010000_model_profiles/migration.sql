ALTER TABLE "app_settings" ADD COLUMN "model_profiles_json" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "app_settings" ADD COLUMN "active_model_profile_id" TEXT NOT NULL DEFAULT '';
