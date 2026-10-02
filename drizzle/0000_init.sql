CREATE TABLE "checkout_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"rule_set_id" text NOT NULL,
	"quote" jsonb NOT NULL,
	"accepted_method" text,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "debits" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"mandate_id" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"requested_in_peak" boolean NOT NULL,
	"due_date" text,
	"scheduled_at" timestamp with time zone NOT NULL,
	"notice_date" text NOT NULL,
	"notice_sent_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"last_txn_ref" text,
	"last_psp_id" text,
	"last_error_code" text,
	"psp_txn_id" text,
	"executing_since" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mandates" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"mandate_ref" text NOT NULL,
	"customer_vpa" text NOT NULL,
	"max_amount_paise" bigint NOT NULL,
	"eligible_psps" jsonb NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"webhook_url" text,
	"webhook_secret" text NOT NULL,
	"category" text NOT NULL,
	"small_merchant" boolean DEFAULT false NOT NULL,
	"method_costs" jsonb NOT NULL,
	"steering" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "merchants_api_key_hash_unique" UNIQUE("api_key_hash")
);
--> statement-breakpoint
CREATE TABLE "payment_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"debit_id" text,
	"payment_id" text,
	"psp_id" text NOT NULL,
	"txn_ref" text NOT NULL,
	"op" text NOT NULL,
	"outcome" text NOT NULL,
	"code" text,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"payer_vpa" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"quote_id" text,
	"state" text NOT NULL,
	"psp_id" text,
	"psp_txn_id" text,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "savings_events" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"type" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"ref_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"small_merchant" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"dead_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkout_quotes" ADD CONSTRAINT "checkout_quotes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debits" ADD CONSTRAINT "debits_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "debits" ADD CONSTRAINT "debits_mandate_id_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."mandates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "savings_events" ADD CONSTRAINT "savings_events_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_outbox" ADD CONSTRAINT "webhook_outbox_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "debits_merchant_idem" ON "debits" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "debits_due" ON "debits" USING btree ("state","scheduled_at");--> statement-breakpoint
CREATE INDEX "attempts_debit" ON "payment_attempts" USING btree ("debit_id");--> statement-breakpoint
CREATE INDEX "attempts_payment" ON "payment_attempts" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_merchant_idem" ON "payments" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "savings_merchant_time" ON "savings_events" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "savings_type_ref" ON "savings_events" USING btree ("type","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_merchant_external" ON "vendors" USING btree ("merchant_id","external_id");--> statement-breakpoint
CREATE INDEX "outbox_due" ON "webhook_outbox" USING btree ("delivered_at","next_attempt_at");