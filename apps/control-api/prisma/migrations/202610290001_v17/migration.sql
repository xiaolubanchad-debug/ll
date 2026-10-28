ALTER TABLE "SecretVersion" ADD COLUMN "name" VARCHAR(100);
ALTER TABLE "Task" ADD COLUMN "startedAt" TIMESTAMPTZ(3), ADD COLUMN "registrationStartedAt" TIMESTAMPTZ(3), ADD COLUMN "finishedAt" TIMESTAMPTZ(3), ADD COLUMN "lastStage" VARCHAR(32) NOT NULL DEFAULT 'QUEUED';
CREATE INDEX "Task_registrationStartedAt_id_idx" ON "Task"("registrationStartedAt", "id");
WITH valid_events AS (
  SELECT t.id, e.sequence, e."createdAt", e.body->>'type' AS type, e.body->'payload'->>'stage' AS stage
  FROM "Task" t JOIN "Delivery" d ON d."runId"=t."runId"
  JOIN "RunEvent" e ON e."deliveryId"=d.id AND e.body->>'taskId'=t.id::text
  WHERE NOT e."recordedForReview" AND e.sequence<=d."appliedThroughSequence"
), times AS (
  SELECT id, min("createdAt") FILTER (WHERE type='TASK_STAGE') AS started,
  min("createdAt") FILTER (WHERE type='TASK_STAGE' AND stage='PREPARING') AS registration,
  max("createdAt") FILTER (WHERE type='TASK_FINISHED') AS finished
  FROM valid_events GROUP BY id
), stages AS (
  SELECT DISTINCT ON(id) id, stage FROM valid_events WHERE type='TASK_STAGE'
  AND stage IN ('DOWNLOADING','DOWNLOADED','PREPARING','INSTALLING','LAUNCHING','DISCOVERING','REGISTERING','VERIFYING') ORDER BY id,sequence DESC
)
UPDATE "Task" t SET "startedAt"=times.started,
"registrationStartedAt"=CASE WHEN r.purpose='REGISTER' AND t."attemptStarted" THEN times.started ELSE times.registration END,
"finishedAt"=times.finished, "lastStage"=COALESCE(stages.stage,'QUEUED')
FROM times LEFT JOIN stages ON stages.id=times.id, "Run" r WHERE t.id=times.id AND r.id=t."runId";
UPDATE "Task" t SET "registrationStartedAt"=t."finishedAt" FROM "Run" r JOIN "ConfigVersion" c ON c.id=r."configVersionId"
WHERE t."runId"=r.id AND r.purpose='LEGACY' AND c.body->'execution'->>'mode'='FULL'
AND t.status='SKIPPED' AND t."finishedAt" IS NOT NULL AND t."registrationStartedAt" IS NULL;
