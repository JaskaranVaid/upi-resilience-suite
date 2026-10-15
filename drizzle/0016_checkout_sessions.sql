CREATE TABLE "checkout_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"quote_id" text NOT NULL,
	"idempotency_key" text,
	"amount_paise" bigint NOT NULL,
	"order_id" text,
	"customer_phone" text,
	"customer_vpa" text,
	"return_url" text,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"payment_id" text,
	"payment_count" integer DEFAULT 0 NOT NULL,
	"pay_lock_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_quote_id_checkout_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."checkout_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_sessions_merchant_idem" ON "checkout_sessions" USING btree ("merchant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "checkout_sessions_payment" ON "checkout_sessions" USING btree ("payment_id");