ALTER TABLE "Task" ADD COLUMN "sourceLocator" VARCHAR(640);

CREATE TABLE "ApkWorkbenchEntry" (
    "nodeId" UUID NOT NULL,
    "configId" UUID NOT NULL,
    "sourceKey" CHAR(64) NOT NULL,
    "targetKey" CHAR(64) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "sourceLocator" VARCHAR(640) NOT NULL,
    "present" BOOLEAN NOT NULL,
    "url" VARCHAR(4096),
    "latestRunId" UUID,
    "readyAsset" JSONB,
    "downloadedAt" TIMESTAMPTZ(3),
    "receivedBytes" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" INTEGER,
    CONSTRAINT "ApkWorkbenchEntry_pkey" PRIMARY KEY ("nodeId", "configId", "sourceKey", "targetKey"),
    CONSTRAINT "ApkWorkbenchEntry_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ApkWorkbenchEntry_configId_fkey" FOREIGN KEY ("configId") REFERENCES "Configuration"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ApkWorkbenchEntry_latestRunId_idx" ON "ApkWorkbenchEntry"("latestRunId");
