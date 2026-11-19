ALTER TABLE "download_link" DROP CONSTRAINT "download_link_token_hash_unique";--> statement-breakpoint
ALTER TABLE "download_link" DROP COLUMN "token_hash";