ALTER TABLE "app_settings"
ADD COLUMN "mobile_navigation_json" TEXT NOT NULL
DEFAULT '["inbox","today","quadrant","topics"]';
