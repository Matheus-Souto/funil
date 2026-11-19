CREATE TABLE "download_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"max_downloads" integer DEFAULT 5 NOT NULL,
	"downloads" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "download_link_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "download_link_downloads_check" CHECK ("download_link"."downloads" >= 0 and "download_link"."downloads" <= "download_link"."max_downloads"),
	CONSTRAINT "download_link_revoked_check" CHECK (("download_link"."revoked_at" is null and "download_link"."revoked_reason" is null) or ("download_link"."revoked_at" is not null and "download_link"."revoked_reason" in ('order_status','renewed')))
);
--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid,
	"job_id" uuid,
	"to_hash" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_log_status_check" CHECK ("email_log"."status" in ('sent','failed')),
	CONSTRAINT "email_log_kind_check" CHECK ("email_log"."kind" in ('delivery','seller_notice','test'))
);
--> statement-breakpoint
ALTER TABLE "download_link" ADD CONSTRAINT "download_link_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_link" ADD CONSTRAINT "download_link_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "download_link" ADD CONSTRAINT "download_link_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "download_link_order_idx" ON "download_link" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "email_log_order_idx" ON "email_log" USING btree ("order_id","kind");--> statement-breakpoint
CREATE INDEX "email_log_job_idx" ON "email_log" USING btree ("job_id");--> statement-breakpoint
select enable_store_rls('download_link');--> statement-breakpoint
select enable_store_rls('email_log');
