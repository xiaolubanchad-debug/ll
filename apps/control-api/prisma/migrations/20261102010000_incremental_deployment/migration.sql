ALTER TABLE "Deployment" ADD COLUMN "mode" VARCHAR(8) NOT NULL DEFAULT 'AUTO';
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_mode_check" CHECK ("mode" IN ('AUTO', 'FULL'));
