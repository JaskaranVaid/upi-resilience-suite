ALTER TABLE "dashboard_users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "dashboard_users" ADD COLUMN "totp_pending_secret" text;--> statement-breakpoint
ALTER TABLE "dashboard_users" ADD COLUMN "totp_last_step" integer;