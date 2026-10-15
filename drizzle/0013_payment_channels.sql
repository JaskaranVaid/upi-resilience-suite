ALTER TABLE "payments" ALTER COLUMN "payer_vpa" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "channel" text DEFAULT 'UPI_COLLECT' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "customer_action" jsonb;