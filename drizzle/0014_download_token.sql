CREATE TABLE "download_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "download_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "product" ADD COLUMN "file_sha256" text;--> statement-breakpoint
ALTER TABLE "download_link" ADD COLUMN "last_download_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "download_token" ADD CONSTRAINT "download_token_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_token" ADD CONSTRAINT "download_token_link_id_download_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."download_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "download_token_link_idx" ON "download_token" USING btree ("link_id");--> statement-breakpoint
select enable_store_rls('download_token');--> statement-breakpoint
-- Tokens já emitidos passam para a tabela nova (a coluna antiga sai na 0015).
insert into "download_token" ("store_id", "link_id", "token_hash", "created_at") select "store_id", "id", "token_hash", "created_at" from "download_link";
