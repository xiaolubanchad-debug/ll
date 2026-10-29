ALTER TABLE "Configuration" ADD COLUMN "archivedAt" TIMESTAMPTZ(3), ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "ConfigVersion" ADD COLUMN "archivedAt" TIMESTAMPTZ(3), ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Release" ADD COLUMN "archivedAt" TIMESTAMPTZ(3), ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
CREATE TABLE "ManagedTask" (
 "id" UUID PRIMARY KEY, "name" VARCHAR(100) NOT NULL, "nodeId" UUID NOT NULL REFERENCES "Node"("id") ON DELETE RESTRICT,
 "configId" UUID NOT NULL UNIQUE REFERENCES "Configuration"("id") ON DELETE RESTRICT,
 "currentVersionId" UUID NOT NULL REFERENCES "ConfigVersion"("id") ON DELETE RESTRICT,
 "version" INTEGER NOT NULL DEFAULT 1,"automatic" BOOLEAN NOT NULL DEFAULT false,"enabled" BOOLEAN NOT NULL DEFAULT false,
 "time" VARCHAR(5) NOT NULL DEFAULT '00:05',"successTarget" INTEGER NOT NULL,"attemptLimit" INTEGER NOT NULL,
 "createdBy" UUID NOT NULL,"archivedAt" TIMESTAMPTZ(3),"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "ManagedCycle" (
 "id" UUID PRIMARY KEY,"taskId" UUID NOT NULL REFERENCES "ManagedTask"("id") ON DELETE RESTRICT,
 "nodeId" UUID NOT NULL,"configVersionId" UUID NOT NULL REFERENCES "ConfigVersion"("id") ON DELETE RESTRICT,
 "releaseId" UUID NOT NULL,"day" VARCHAR(10) NOT NULL,"round" INTEGER NOT NULL DEFAULT 1,"generation" INTEGER NOT NULL DEFAULT 1,
 "status" VARCHAR(32) NOT NULL DEFAULT 'QUEUED',"stopRequested" BOOLEAN NOT NULL DEFAULT false,
 "successTarget" INTEGER NOT NULL,"attemptLimit" INTEGER NOT NULL,"downloadRunId" UUID,"proxyRunId" UUID,
 "deferredDownloadRules" BOOLEAN NOT NULL DEFAULT false,"errorCode" VARCHAR(100),"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ManagedCycle_taskId_day_round_key" ON "ManagedCycle"("taskId","day","round");
CREATE INDEX "ManagedCycle_status_createdAt_idx" ON "ManagedCycle"("status","createdAt");
ALTER TABLE "Run" ADD COLUMN "taskCycleId" UUID REFERENCES "ManagedCycle"("id") ON DELETE RESTRICT;
CREATE INDEX "Run_taskCycleId_createdAt_idx" ON "Run"("taskCycleId","createdAt");
CREATE INDEX "ManagedTask_nodeId_enabled_idx" ON "ManagedTask"("nodeId","enabled");
