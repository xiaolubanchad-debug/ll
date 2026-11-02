ALTER TABLE "Node" ADD COLUMN "dailyOpenLimitOverride" INTEGER;
ALTER TABLE "Node" ADD CONSTRAINT "Node_daily_open_limit_check" CHECK ("dailyOpenLimitOverride" IS NULL OR "dailyOpenLimitOverride" BETWEEN 1 AND 8640);
ALTER TABLE "Run" DROP CONSTRAINT "Run_v15_budget_check";
ALTER TABLE "Run" ADD CONSTRAINT "Run_v15_budget_check" CHECK (
 "purpose" IN ('LEGACY','DOWNLOAD','REGISTER','PROXY_CHECK') AND "attemptsStarted">=0 AND "successes">=0 AND
 ("purpose"<>'REGISTER' OR ("successTarget">=1 AND "attemptLimit">="successTarget" AND "attemptsStarted"<="attemptLimit" AND "successes"<="successTarget" AND
 ("attemptLimit"<=1000 OR ("attemptLimit"<=8640 AND COALESCE(("executionPlan" #>> '{openPolicy,capacityVersion}'='1' AND "executionPlan" #>> '{openPolicy,concurrency}'='1' AND ("executionPlan" #>> '{openPolicy,dailyLimit}')::numeric>="attemptLimit"),false)))))
);
