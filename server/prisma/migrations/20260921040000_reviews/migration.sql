-- CreateTable
CREATE TABLE "ReviewRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "frequency" TEXT NOT NULL,
    "timeOfDay" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "weekDay" INTEGER NOT NULL DEFAULT 0,
    "topicIds" TEXT NOT NULL DEFAULT '[]',
    "includeInbox" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL DEFAULT 'none',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "coverageThrough" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "ReviewBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleId" TEXT NOT NULL,
    "occurrenceKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'generating',
    "snapshot" TEXT NOT NULL DEFAULT '{}',
    "content" TEXT NOT NULL DEFAULT '',
    "organizationIds" TEXT NOT NULL DEFAULT '[]',
    "error" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    CONSTRAINT "ReviewBatch_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "ReviewRule" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewBatch_ruleId_occurrenceKey_key" ON "ReviewBatch"("ruleId", "occurrenceKey");
