CREATE TABLE "duplicate_suspects" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"mandate_ref" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"first_kind" text NOT NULL,
	"first_id" text NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"second_kind" text NOT NULL,
	"second_id" text NOT NULL,
	"second_at" timestamp with time zone NOT NULL,
	"same_order" boolean NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text
);
--> statement-breakpoint
CREATE TABLE "rollout_changes" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"from_stage" text NOT NULL,
	"from_percent" integer,
	"to_stage" text NOT NULL,
	"to_percent" integer,
	"reason" text NOT NULL,
	"operator_id" text,
	"override" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shadow_debits" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"mandate_id" text,
	"mandate_ref" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"order_id" text,
	"amount_paise" bigint NOT NULL,
	"source" text NOT NULL,
	"rollout_stage" text,
	"requested_at" timestamp with time zone NOT NULL,
	"requested_in_peak" boolean NOT NULL,
	"due_date" text,
	"planned_at" timestamp with time zone NOT NULL,
	"planned_notice_date" text NOT NULL,
	"would_refuse" text,
	"live_debit_id" text,
	"executed_at" timestamp with time zone,
	"outcome" text,
	"failure_kind" text,
	"failure_code" text,
	"psp_txn_id" text,
	"legacy_attempts" integer,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "debits" ADD COLUMN "rollout_stage" text;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "rollout_stage" text DEFAULT 'FULL' NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "canary_percent" integer;--> statement-breakpoint
ALTER TABLE "duplicate_suspects" ADD CONSTRAINT "duplicate_suspects_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollout_changes" ADD CONSTRAINT "rollout_changes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_debits" ADD CONSTRAINT "shadow_debits_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_debits" ADD CONSTRAINT "shadow_debits_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "duplicate_suspects_pair" ON "duplicate_suspects" USING btree ("first_id","second_id");--> statement-breakpoint
CREATE INDEX "duplicate_suspects_merchant" ON "duplicate_suspects" USING btree ("merchant_id","detected_at");--> statement-breakpoint
CREATE INDEX "duplicate_suspects_status" ON "duplicate_suspects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "rollout_changes_merchant" ON "rollout_changes" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shadow_debits_merchant_idem" ON "shadow_debits" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "shadow_debits_merchant_executed" ON "shadow_debits" USING btree ("merchant_id","executed_at");--> statement-breakpoint
CREATE INDEX "shadow_debits_mandate_executed" ON "shadow_debits" USING btree ("merchant_id","mandate_ref","executed_at");--> statement-breakpoint
CREATE INDEX "shadow_debits_merchant_created" ON "shadow_debits" USING btree ("merchant_id","created_at");