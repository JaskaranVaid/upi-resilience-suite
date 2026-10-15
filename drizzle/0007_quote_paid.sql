ALTER TABLE "checkout_quotes" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checkout_quotes" ADD COLUMN "payment_reference" text;