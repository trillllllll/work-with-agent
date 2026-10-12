CREATE TABLE "plan_time_bands" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "start_minute" INTEGER NOT NULL,
  "end_minute" INTEGER NOT NULL,
  "weekdays_json" TEXT NOT NULL,
  "color" TEXT NOT NULL,
  "position" INTEGER NOT NULL
);
