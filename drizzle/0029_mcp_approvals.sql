CREATE TABLE "approval_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"action" text NOT NULL,
	"input_sealed" text,
	"input_sha256" text NOT NULL,
	"summary" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"result_id" uuid,
	"error" text,
	CONSTRAINT "approval_request_status_check" CHECK ("approval_request"."status" in ('pending','approved','rejected','expired','failed','canceled')),
	CONSTRAINT "approval_request_error_check" CHECK (char_length("approval_request"."error") <= 500)
);
--> statement-breakpoint
CREATE TABLE "upload_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"name" text NOT NULL,
	"file_name" text NOT NULL,
	"key_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone,
	"product_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_link_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "upload_link_name_check" CHECK (char_length("upload_link"."name") between 1 and 200),
	CONSTRAINT "upload_link_file_name_check" CHECK (char_length("upload_link"."file_name") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_token_id_mcp_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."mcp_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_link" ADD CONSTRAINT "upload_link_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_link" ADD CONSTRAINT "upload_link_token_id_mcp_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."mcp_token"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_link" ADD CONSTRAINT "upload_link_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_request_store_status_idx" ON "approval_request" USING btree ("store_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "approval_request_token_idx" ON "approval_request" USING btree ("token_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "approval_request_pending_uniq" ON "approval_request" USING btree ("token_id","action","input_sha256") WHERE "approval_request"."status" = 'pending';--> statement-breakpoint
select enable_store_rls('approval_request');--> statement-breakpoint
select enable_store_rls('upload_link');
