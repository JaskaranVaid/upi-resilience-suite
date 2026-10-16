CREATE TABLE "execution_pauses" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"target" text,
	"reason" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" text
);
--> statement-breakpoint
CREATE INDEX "execution_pauses_active" ON "execution_pauses" USING btree ("lifted_at");