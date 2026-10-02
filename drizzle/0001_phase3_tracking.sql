CREATE TABLE "case_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dashboard_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "dashboard_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "dashboard_users" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "payment_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"tracking_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"resolution" text,
	"closed_by_merchant" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"case_id" text,
	"type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"data" jsonb,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_tracking" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"psp_id" text,
	"txn_ref" text,
	"upi_rrn" text,
	"npci_txn_id" text,
	"customer_debit" text DEFAULT 'UNKNOWN' NOT NULL,
	"capture" text DEFAULT 'UNKNOWN' NOT NULL,
	"reversal_status" text DEFAULT 'NONE' NOT NULL,
	"reversal_initiated_at" timestamp with time zone,
	"reversal_completed_at" timestamp with time zone,
	"verification_status" text NOT NULL,
	"verification_started_at" timestamp with time zone,
	"next_check_at" timestamp with time zone,
	"check_count" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_manual_check_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "udir_complaints" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"merchant_id" text NOT NULL,
	"psp_id" text NOT NULL,
	"mode" text NOT NULL,
	"psp_complaint_ref" text NOT NULL,
	"reason_code" text NOT NULL,
	"status" text NOT NULL,
	"raised_by_user_id" text,
	"raised_at" timestamp with time zone NOT NULL,
	"last_status_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "debits" ADD COLUMN "order_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "order_id" text;--> statement-breakpoint
ALTER TABLE "case_notes" ADD CONSTRAINT "case_notes_case_id_payment_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."payment_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_notes" ADD CONSTRAINT "case_notes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_sessions" ADD CONSTRAINT "dashboard_sessions_user_id_dashboard_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."dashboard_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_users" ADD CONSTRAINT "dashboard_users_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_cases" ADD CONSTRAINT "payment_cases_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_cases" ADD CONSTRAINT "payment_cases_tracking_id_payment_tracking_id_fk" FOREIGN KEY ("tracking_id") REFERENCES "public"."payment_tracking"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_tracking" ADD CONSTRAINT "payment_tracking_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "udir_complaints" ADD CONSTRAINT "udir_complaints_case_id_payment_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."payment_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "udir_complaints" ADD CONSTRAINT "udir_complaints_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_case" ON "case_notes" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "dashboard_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "cases_merchant_status" ON "payment_cases" USING btree ("merchant_id","status","opened_at");--> statement-breakpoint
CREATE INDEX "cases_subject" ON "payment_cases" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "events_subject" ON "payment_events" USING btree ("subject_type","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "events_merchant" ON "payment_events" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tracking_subject" ON "payment_tracking" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "tracking_merchant_rrn" ON "payment_tracking" USING btree ("merchant_id","upi_rrn");--> statement-breakpoint
CREATE INDEX "tracking_due" ON "payment_tracking" USING btree ("verification_status","next_check_at");--> statement-breakpoint
CREATE INDEX "complaints_case" ON "udir_complaints" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "debits_merchant_order" ON "debits" USING btree ("merchant_id","order_id");--> statement-breakpoint
CREATE INDEX "payments_merchant_order" ON "payments" USING btree ("merchant_id","order_id");