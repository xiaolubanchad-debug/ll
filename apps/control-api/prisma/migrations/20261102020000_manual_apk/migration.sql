-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "manualApkId" UUID;

-- CreateTable
CREATE TABLE "ManualApkUpload" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "nodeVersion" INTEGER NOT NULL,
    "cacheDay" VARCHAR(10) NOT NULL,
    "targetKey" CHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'UPLOADING',
    "maxBytes" INTEGER NOT NULL,
    "apk" JSONB,
    "storageSha" CHAR(64),
    "errorCode" VARCHAR(100),
    "receiveOwner" UUID,
    "receiveUntil" TIMESTAMPTZ(3),
    "operationId" UUID,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ManualApkUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManualApkUpload_taskId_key" ON "ManualApkUpload"("taskId");

-- CreateIndex
CREATE INDEX "ManualApkUpload_status_createdAt_idx" ON "ManualApkUpload"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_manualApkId_fkey" FOREIGN KEY ("manualApkId") REFERENCES "ManualApkUpload"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualApkUpload" ADD CONSTRAINT "ManualApkUpload_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualApkUpload" ADD CONSTRAINT "ManualApkUpload_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "ManualApkUpload" ADD CONSTRAINT "ManualApkUpload_status_check" CHECK ("status" IN ('UPLOADING','RECEIVING','QUEUED','IMPORTING','APPLIED','FAILED','CANCELLED','EXPIRED','NEEDS_REVIEW'));
ALTER TABLE "ManualApkUpload" ADD CONSTRAINT "ManualApkUpload_size_check" CHECK ("maxBytes" > 0 AND "maxBytes" <= 536870912);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'apk_worker') THEN
    GRANT SELECT ON "ManualApkUpload" TO apk_worker;
    GRANT UPDATE ("status","errorCode","updatedAt") ON "ManualApkUpload" TO apk_worker;
  END IF;
END $$;
