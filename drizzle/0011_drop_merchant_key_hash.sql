ALTER TABLE "merchants" DROP CONSTRAINT "merchants_api_key_hash_unique";--> statement-breakpoint
ALTER TABLE "merchants" DROP COLUMN "api_key_hash";