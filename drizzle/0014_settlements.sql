CREATE TABLE "recon_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"psp_id" text NOT NULL,
	"day" text NOT NULL,
	"status" text NOT NULL,
	"items" integer DEFAULT 0 NOT NULL,
	"matched" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"psp_id" text NOT NULL,
	"psp_event_id" text NOT NULL,
	"kind" text NOT NULL,
	"psp_payment_id" text,
	"order_ref" text,
	"amount_paise" bigint NOT NULL,
	"fee_paise" bigint NOT NULL,
	"tax_paise" bigint NOT NULL,
	"settled_amount_paise" bigint NOT NULL,
	"settlement_id" text,
	"utr" text,
	"settled_at" timestamp with time zone,
	"subject_type" text,
	"subject_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_tracking" ADD COLUMN "settlement_status" text DEFAULT 'UNSETTLED' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_tracking" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_tracking" ADD COLUMN "settlement_utr" text;--> statement-breakpoint
ALTER TABLE "payment_tracking" ADD COLUMN "settled_amount_paise" bigint;--> statement-breakpoint
ALTER TABLE "payment_tracking" ADD COLUMN "settlement_fee_paise" bigint;--> statement-breakpoint
ALTER TABLE "recon_runs" ADD CONSTRAINT "recon_runs_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recon_runs_psp_day" ON "recon_runs" USING btree ("psp_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_psp_event" ON "settlements" USING btree ("psp_id","psp_event_id");--> statement-breakpoint
CREATE INDEX "settlements_merchant_time" ON "settlements" USING btree ("merchant_id","settled_at");--> statement-breakpoint
CREATE INDEX "settlements_subject" ON "settlements" USING btree ("subject_type","subject_id");