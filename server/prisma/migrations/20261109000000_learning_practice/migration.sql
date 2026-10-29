-- CreateTable
CREATE TABLE "learning_questions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mapId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "currentVersionId" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "learning_question_versions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "questionId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "nodeTitle" TEXT NOT NULL,
    "contentJson" TEXT NOT NULL,
    "model" TEXT,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "learning_practice_sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "mapTitle" TEXT NOT NULL,
    "generationJobId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "configJson" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'active',
    "currentPosition" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    "finishedAt" TEXT
);

-- CreateTable
CREATE TABLE "learning_practice_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "questionVersionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "selectionReason" TEXT NOT NULL,
    "skipped" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "learning_answer_drafts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "activeAttemptId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL DEFAULT 1,
    "answerJson" TEXT NOT NULL DEFAULT '""',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "submitted" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "learning_attempts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "questionVersionId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "clientAttemptId" TEXT NOT NULL,
    "answerJson" TEXT NOT NULL,
    "submittedAt" TEXT NOT NULL,
    "assisted" BOOLEAN NOT NULL DEFAULT false,
    "solutionViewed" BOOLEAN NOT NULL DEFAULT false,
    "assistanceUncertain" BOOLEAN NOT NULL DEFAULT false,
    "gradingVersion" INTEGER NOT NULL DEFAULT 1,
    "gradingState" TEXT NOT NULL DEFAULT 'queued',
    "currentGradeId" TEXT,
    "error" TEXT
);

-- CreateTable
CREATE TABLE "learning_grades" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attemptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "score" REAL,
    "maxScore" REAL NOT NULL,
    "explanation" TEXT NOT NULL,
    "strengths" TEXT NOT NULL,
    "mistakesJson" TEXT NOT NULL,
    "model" TEXT,
    "promptVersion" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "learning_practice_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "activeAttemptId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "sourceMessageId" TEXT,
    "payloadJson" TEXT NOT NULL DEFAULT '{}',
    "eventKey" TEXT NOT NULL,
    "createdAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "learning_jobs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "sessionId" TEXT,
    "attemptId" TEXT,
    "gradingVersion" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "inputJson" TEXT NOT NULL,
    "outputJson" TEXT,
    "candidateRevision" TEXT,
    "adoptedSessionId" TEXT,
    "leaseToken" TEXT,
    "leaseExpiresAt" TEXT,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "model" TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "learning_review_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "questionId" TEXT,
    "title" TEXT NOT NULL,
    "reasonsJson" TEXT NOT NULL DEFAULT '[]',
    "dueAt" TEXT,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "policy" TEXT NOT NULL DEFAULT 'manual',
    "policyVersion" TEXT NOT NULL DEFAULT 'manual-v1',
    "manualSchedule" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "streak" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptId" TEXT,
    "lastGradeId" TEXT,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "learning_review_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reviewId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "beforeJson" TEXT NOT NULL,
    "afterJson" TEXT NOT NULL,
    "attemptId" TEXT,
    "gradeId" TEXT,
    "createdAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "learning_resume_state" (
    "ownerId" TEXT NOT NULL PRIMARY KEY,
    "nodeId" TEXT,
    "mapId" TEXT,
    "nodeTitle" TEXT,
    "updatedAt" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "learning_questions_mapId_nodeId_archived_idx" ON "learning_questions"("mapId", "nodeId", "archived");

-- CreateIndex
CREATE INDEX "learning_question_versions_questionId_createdAt_idx" ON "learning_question_versions"("questionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "learning_practice_sessions_generationJobId_key" ON "learning_practice_sessions"("generationJobId");

-- CreateIndex
CREATE INDEX "learning_practice_sessions_ownerId_state_updatedAt_idx" ON "learning_practice_sessions"("ownerId", "state", "updatedAt");

-- CreateIndex
CREATE INDEX "learning_practice_sessions_mapId_updatedAt_idx" ON "learning_practice_sessions"("mapId", "updatedAt");

-- CreateIndex
CREATE INDEX "learning_practice_items_questionVersionId_idx" ON "learning_practice_items"("questionVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "learning_practice_items_sessionId_position_key" ON "learning_practice_items"("sessionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "learning_answer_drafts_itemId_key" ON "learning_answer_drafts"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "learning_answer_drafts_activeAttemptId_key" ON "learning_answer_drafts"("activeAttemptId");

-- CreateIndex
CREATE INDEX "learning_attempts_ownerId_submittedAt_id_idx" ON "learning_attempts"("ownerId", "submittedAt", "id");

CREATE INDEX "learning_attempts_ownerId_questionVersionId_submittedAt_id_idx" ON "learning_attempts"("ownerId", "questionVersionId", "submittedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "learning_attempts_itemId_attemptNo_key" ON "learning_attempts"("itemId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "learning_attempts_ownerId_clientAttemptId_key" ON "learning_attempts"("ownerId", "clientAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "learning_grades_attemptId_version_key" ON "learning_grades"("attemptId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "learning_practice_events_eventKey_key" ON "learning_practice_events"("eventKey");

-- CreateIndex
CREATE INDEX "learning_practice_events_itemId_activeAttemptId_createdAt_idx" ON "learning_practice_events"("itemId", "activeAttemptId", "createdAt");

-- CreateIndex
CREATE INDEX "learning_jobs_state_leaseExpiresAt_createdAt_idx" ON "learning_jobs"("state", "leaseExpiresAt", "createdAt");

-- CreateIndex
CREATE INDEX "learning_jobs_ownerId_kind_updatedAt_idx" ON "learning_jobs"("ownerId", "kind", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "learning_jobs_attemptId_gradingVersion_key" ON "learning_jobs"("attemptId", "gradingVersion");

-- CreateIndex
CREATE INDEX "learning_review_items_ownerId_paused_dueAt_idx" ON "learning_review_items"("ownerId", "paused", "dueAt");

-- CreateIndex
CREATE INDEX "learning_review_items_mapId_nodeId_idx" ON "learning_review_items"("mapId", "nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "learning_review_items_ownerId_scopeKey_key" ON "learning_review_items"("ownerId", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "learning_review_events_eventKey_key" ON "learning_review_events"("eventKey");

-- CreateIndex
CREATE INDEX "learning_review_events_reviewId_createdAt_idx" ON "learning_review_events"("reviewId", "createdAt");
