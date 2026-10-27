-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "currentDeliveryId" UUID,
ADD COLUMN     "downloadProtocol" VARCHAR(16);

-- AlterTable
ALTER TABLE "NodeSlot" ADD COLUMN     "runId" UUID;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "cleanupBootId" UUID,
ADD COLUMN     "cleanupConfirmedAt" TIMESTAMPTZ(3),
ADD COLUMN     "configHash" CHAR(64),
ADD COLUMN     "configVersionId" UUID,
ADD COLUMN     "createdBy" UUID,
ADD COLUMN     "discovered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "errorCode" VARCHAR(100),
ADD COLUMN     "finishedAt" TIMESTAMPTZ(3),
ADD COLUMN     "releaseId" UUID,
ADD COLUMN     "reviewResolvedAt" TIMESTAMPTZ(3),
ADD COLUMN     "stopRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "supersedesRunId" UUID;

-- CreateTable
CREATE TABLE "Configuration" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Configuration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigVersion" (
    "id" UUID NOT NULL,
    "configId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "body" JSONB NOT NULL,
    "configHash" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID NOT NULL,

    CONSTRAINT "ConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "bootId" UUID NOT NULL,
    "fence" INTEGER NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackDeadline" TIMESTAMPTZ(3) NOT NULL,
    "leaseExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "appliedThroughSequence" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "targetKey" CHAR(64) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "sourceUrl" VARCHAR(4096) NOT NULL,
    "position" INTEGER NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
    "apk" JSONB,
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    "proof" VARCHAR(32) NOT NULL DEFAULT 'NONE',
    "errorCode" VARCHAR(100),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "id" UUID NOT NULL,
    "deliveryId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "contentHash" CHAR(64) NOT NULL,
    "body" JSONB NOT NULL,
    "recordedForReview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConfigVersion_configId_version_key" ON "ConfigVersion"("configId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_runId_key" ON "Delivery"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_runId_targetKey_key" ON "Task"("runId", "targetKey");

-- CreateIndex
CREATE UNIQUE INDEX "Task_runId_position_key" ON "Task"("runId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "RunEvent_deliveryId_sequence_key" ON "RunEvent"("deliveryId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "NodeSlot_runId_key" ON "NodeSlot"("runId");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_configVersionId_fkey" FOREIGN KEY ("configVersionId") REFERENCES "ConfigVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigVersion" ADD CONSTRAINT "ConfigVersion_configId_fkey" FOREIGN KEY ("configId") REFERENCES "Configuration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NodeSlot" ADD CONSTRAINT "NodeSlot_one_operation" CHECK ("operationId" IS NULL OR "runId" IS NULL);
ALTER TABLE "Run" ADD COLUMN "reconciliationReason" VARCHAR(300), ADD COLUMN "reconciledBy" UUID;
