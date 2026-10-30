CREATE TABLE "TestEnrollment" (
 "id" UUID NOT NULL, "taskId" UUID NOT NULL, "nodeId" UUID NOT NULL,
 "deliveryId" UUID NOT NULL, "fence" INTEGER NOT NULL, "tokenHash" CHAR(64) NOT NULL,
 "expectedUa" VARCHAR(512) NOT NULL, "model" VARCHAR(100) NOT NULL, "profileId" VARCHAR(64) NOT NULL,
 "expiresAt" TIMESTAMPTZ(3) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "TestEnrollment_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "TestEnrollment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TestEnrollment_taskId_key" ON "TestEnrollment"("taskId");
CREATE UNIQUE INDEX "TestEnrollment_tokenHash_key" ON "TestEnrollment"("tokenHash");
CREATE INDEX "TestEnrollment_nodeId_createdAt_idx" ON "TestEnrollment"("nodeId","createdAt");
CREATE TABLE "TestRecord" (
 "id" UUID NOT NULL, "enrollmentId" UUID NOT NULL, "installationId" UUID NOT NULL,
 "requestKey" UUID NOT NULL, "requestHash" CHAR(64) NOT NULL,
 "username" VARCHAR(10) NOT NULL, "sourceIp" VARCHAR(64) NOT NULL, "androidIdHash" CHAR(64) NOT NULL,
 "model" VARCHAR(100) NOT NULL, "manufacturer" VARCHAR(100) NOT NULL, "apiLevel" INTEGER NOT NULL,
 "userAgent" VARCHAR(512) NOT NULL, "defaultWebViewUa" VARCHAR(1024) NOT NULL,
 "uaMatched" BOOLEAN NOT NULL, "modelMatched" BOOLEAN NOT NULL, "encrypted" JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "TestRecord_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "TestRecord_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "TestEnrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TestRecord_enrollmentId_key" ON "TestRecord"("enrollmentId");
CREATE UNIQUE INDEX "TestRecord_username_key" ON "TestRecord"("username");
CREATE INDEX "TestRecord_createdAt_id_idx" ON "TestRecord"("createdAt","id");
