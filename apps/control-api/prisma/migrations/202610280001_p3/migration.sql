ALTER TABLE "Node" ADD COLUMN "registrationProtocol" VARCHAR(16);
ALTER TABLE "AuditEvent" ADD COLUMN "details" JSONB;
ALTER TABLE "Task" ADD COLUMN "observation" JSONB, ADD COLUMN "accountRef" UUID, ADD COLUMN "submissionId" UUID, ADD COLUMN "submittedAt" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "Task_submissionId_key" ON "Task"("submissionId");
CREATE TABLE "AccountResult" (
 "accountRef" UUID PRIMARY KEY, "taskId" UUID NOT NULL UNIQUE REFERENCES "Task"("id") ON DELETE RESTRICT,
 "deliveryId" UUID NOT NULL REFERENCES "Delivery"("id") ON DELETE RESTRICT, "fence" INTEGER NOT NULL CHECK ("fence">0),
 "encrypted" JSONB NOT NULL, "contentHash" CHAR(64) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Artifact" (
 "id" UUID PRIMARY KEY, "taskId" UUID NOT NULL REFERENCES "Task"("id") ON DELETE RESTRICT,
 "deliveryId" UUID NOT NULL REFERENCES "Delivery"("id") ON DELETE RESTRICT, "fence" INTEGER NOT NULL CHECK ("fence">0),
 "kind" VARCHAR(32) NOT NULL, "sha256" CHAR(64) NOT NULL, "bytes" INTEGER NOT NULL CHECK ("bytes">0 AND "bytes"<=10485760),
 "storageKey" VARCHAR(100) NOT NULL UNIQUE, "recordedForReview" BOOLEAN NOT NULL DEFAULT FALSE, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Artifact_taskId_createdAt_idx" ON "Artifact"("taskId","createdAt");
CREATE TABLE "TaskReview" (
 "id" UUID PRIMARY KEY, "taskId" UUID NOT NULL REFERENCES "Task"("id") ON DELETE RESTRICT,
 "outcome" VARCHAR(32) NOT NULL CHECK ("outcome" IN ('SUCCEEDED','FAILED')), "reason" VARCHAR(1000) NOT NULL,
 "evidenceIds" UUID[] NOT NULL, "createdBy" UUID NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "TaskReview_taskId_createdAt_idx" ON "TaskReview"("taskId","createdAt");
