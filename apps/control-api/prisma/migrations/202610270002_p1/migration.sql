-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "agentReleaseId" UUID,
ADD COLUMN     "agentVersion" VARCHAR(32),
ADD COLUMN     "archivedAt" TIMESTAMPTZ(3),
ADD COLUMN     "credentialVersionId" UUID,
ADD COLUMN     "deploymentStatus" VARCHAR(32) NOT NULL DEFAULT 'NOT_INSTALLED',
ADD COLUMN     "expectedFingerprint" VARCHAR(100),
ADD COLUMN     "health" JSONB,
ADD COLUMN     "hostKey" TEXT,
ADD COLUMN     "lastSeenAt" TIMESTAMPTZ(3),
ADD COLUMN     "port" INTEGER NOT NULL DEFAULT 22,
ADD COLUMN     "sudoCredentialVersionId" UUID,
ADD COLUMN     "username" VARCHAR(64) NOT NULL DEFAULT 'ubuntu',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "SecretVersion" (
    "id" UUID NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "keyId" VARCHAR(64) NOT NULL,
    "encrypted" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "createdBy" UUID NOT NULL,

    CONSTRAINT "SecretVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Release" (
    "id" UUID NOT NULL,
    "manifest" JSONB NOT NULL,
    "artifactName" VARCHAR(160) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NodeSlot" (
    "nodeId" UUID NOT NULL,
    "operationId" UUID,
    "quarantined" BOOLEAN NOT NULL DEFAULT false,
    "fence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "NodeSlot_pkey" PRIMARY KEY ("nodeId")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "nodeVersion" INTEGER NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
    "releaseId" UUID,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "stopRequested" BOOLEAN NOT NULL DEFAULT false,
    "workerId" UUID,
    "fence" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "result" JSONB,
    "errorCode" VARCHAR(64),

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeploymentEvent" (
    "id" UUID NOT NULL,
    "deploymentId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "status" VARCHAR(32) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeploymentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "deploymentId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "bootId" UUID,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentCredential" (
    "nodeId" UUID NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "releaseId" UUID NOT NULL,
    "bootId" UUID NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCredential_pkey" PRIMARY KEY ("nodeId")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "scope" VARCHAR(200) NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "actorId" UUID NOT NULL,
    "requestHash" CHAR(64) NOT NULL,
    "response" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("actorId","scope","key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Release_artifactName_key" ON "Release"("artifactName");

-- CreateIndex
CREATE UNIQUE INDEX "Release_sha256_key" ON "Release"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "NodeSlot_operationId_key" ON "NodeSlot"("operationId");

-- CreateIndex
CREATE INDEX "Deployment_status_createdAt_idx" ON "Deployment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeploymentEvent_deploymentId_sequence_key" ON "DeploymentEvent"("deploymentId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_deploymentId_key" ON "Enrollment"("deploymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_tokenHash_key" ON "Enrollment"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCredential_tokenHash_key" ON "AgentCredential"("tokenHash");

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_credentialVersionId_fkey" FOREIGN KEY ("credentialVersionId") REFERENCES "SecretVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_sudoCredentialVersionId_fkey" FOREIGN KEY ("sudoCredentialVersionId") REFERENCES "SecretVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeSlot" ADD CONSTRAINT "NodeSlot_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_releaseId_fkey" FOREIGN KEY ("releaseId") REFERENCES "Release"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeploymentEvent" ADD CONSTRAINT "DeploymentEvent_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCredential" ADD CONSTRAINT "AgentCredential_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Existing P0 inventory is retained and receives an execution slot.
INSERT INTO "NodeSlot" ("nodeId", "quarantined", "fence") SELECT "id", false, 0 FROM "Node" ON CONFLICT DO NOTHING;
ALTER TABLE "Deployment" ADD COLUMN "licenseAcceptedAt" TIMESTAMPTZ(3);
CREATE UNIQUE INDEX "Node_active_endpoint" ON "Node" (lower("host"), "port") WHERE "archivedAt" IS NULL;
