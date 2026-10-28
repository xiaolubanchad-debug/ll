ALTER TABLE "Run"
  ADD COLUMN "purpose" VARCHAR(20) NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN "cacheDay" VARCHAR(10),
  ADD COLUMN "dailyKey" CHAR(64),
  ADD COLUMN "sourceDownloadId" UUID,
  ADD COLUMN "proxySecretVersionId" UUID,
  ADD COLUMN "successTarget" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attemptLimit" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attemptsStarted" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "successes" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "executionPlan" JSONB,
  ADD COLUMN "proxyObservation" JSONB;
CREATE UNIQUE INDEX "Run_dailyKey_key" ON "Run"("dailyKey");
ALTER TABLE "Run" ADD CONSTRAINT "Run_v15_budget_check" CHECK (
 "purpose" IN ('LEGACY','DOWNLOAD','REGISTER','PROXY_CHECK') AND
 "attemptsStarted" >= 0 AND "successes" >= 0 AND
 ("purpose" <> 'REGISTER' OR ("successTarget" BETWEEN 1 AND 1000 AND "attemptLimit" BETWEEN "successTarget" AND 1000 AND "attemptsStarted" <= "attemptLimit" AND "successes" <= "successTarget"))
);
ALTER TABLE "Task" ADD COLUMN "attemptStarted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Task" ADD COLUMN "entryId" VARCHAR(100);
CREATE TABLE "DailySchedule" (
 "id" UUID PRIMARY KEY,
 "nodeId" UUID NOT NULL UNIQUE REFERENCES "Node"("id") ON DELETE RESTRICT,
 "body" JSONB NOT NULL,
 "version" INTEGER NOT NULL DEFAULT 1,
 "enabled" BOOLEAN NOT NULL DEFAULT false,
 "createdBy" UUID NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "DailyOccurrence" (
 "id" UUID PRIMARY KEY,
 "scheduleId" UUID NOT NULL REFERENCES "DailySchedule"("id") ON DELETE RESTRICT,
 "day" VARCHAR(10) NOT NULL,
 "snapshot" JSONB NOT NULL,
 "downloadRunId" UUID,
 "registerRunId" UUID,
 "status" VARCHAR(32) NOT NULL DEFAULT 'WAITING_DOWNLOAD',
 "errorCode" VARCHAR(100),
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("scheduleId","day")
);
CREATE INDEX "DailyOccurrence_day_createdAt_idx" ON "DailyOccurrence"("day","createdAt");
