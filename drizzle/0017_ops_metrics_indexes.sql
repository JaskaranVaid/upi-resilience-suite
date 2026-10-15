CREATE INDEX "debits_error_time" ON "debits" USING btree ("last_error_code","updated_at");--> statement-breakpoint
CREATE INDEX "attempts_execute_time" ON "payment_attempts" USING btree ("created_at") WHERE "payment_attempts"."op" = 'execute';--> statement-breakpoint
CREATE INDEX "outbox_dead_at" ON "webhook_outbox" USING btree ("dead_at") WHERE "webhook_outbox"."dead_at" is not null;