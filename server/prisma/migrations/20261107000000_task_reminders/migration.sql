ALTER TABLE "tasks" ADD COLUMN "reminder_minutes_before" INTEGER;
ALTER TABLE "app_settings" ADD COLUMN "reminder_lead_minutes" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "app_settings" ADD COLUMN "reminder_all_day_time" TEXT NOT NULL DEFAULT '09:00';
ALTER TABLE "app_settings" ADD COLUMN "reminder_time_zone" TEXT NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE "app_settings" ADD COLUMN "vapid_public_key" TEXT NOT NULL DEFAULT '';
ALTER TABLE "app_settings" ADD COLUMN "vapid_private_key" TEXT NOT NULL DEFAULT '';
ALTER TABLE "app_settings" ADD COLUMN "vapid_subject" TEXT NOT NULL DEFAULT '';
-- CreateTable
CREATE TABLE "reminder_fires" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "task_id" TEXT NOT NULL,
    "fire_key" TEXT NOT NULL,
    "fired_at" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "time_zone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "created_at" TEXT NOT NULL DEFAULT '',
    "last_used_at" TEXT NOT NULL DEFAULT ''
);

-- CreateIndex
CREATE UNIQUE INDEX "reminder_fires_task_id_fire_key_key" ON "reminder_fires"("task_id", "fire_key");

-- CreateIndex
CREATE INDEX "reminder_fires_fired_at_idx" ON "reminder_fires"("fired_at");

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
