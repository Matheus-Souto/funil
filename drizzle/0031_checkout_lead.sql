CREATE TABLE "checkout_lead" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"email" text,
	"email_hash" text NOT NULL,
	"phone" text,
	"status" text DEFAULT 'open' NOT NULL,
	"order_id" uuid,
	"notified_at" timestamp with time zone,
	"telegram_message_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "checkout_lead_status_check" CHECK ("checkout_lead"."status" in ('open','contacted','converted')),
	CONSTRAINT "checkout_lead_email_check" CHECK ("checkout_lead"."status" = 'converted' or "checkout_lead"."email" is not null)
);
--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "lead_capture" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "privacy_email" text;--> statement-breakpoint
ALTER TABLE "checkout_lead" ADD CONSTRAINT "checkout_lead_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_lead" ADD CONSTRAINT "checkout_lead_offer_id_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_lead" ADD CONSTRAINT "checkout_lead_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_lead_store_key_uniq" ON "checkout_lead" USING btree ("store_id","key_hash");--> statement-breakpoint
CREATE INDEX "checkout_lead_store_created_idx" ON "checkout_lead" USING btree ("store_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checkout_lead_store_email_idx" ON "checkout_lead" USING btree ("store_id","email_hash");--> statement-breakpoint
CREATE INDEX "checkout_lead_expires_idx" ON "checkout_lead" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "store_lead_capture_check" CHECK (not "store"."lead_capture" or "store"."privacy_email" is not null);--> statement-breakpoint
select enable_store_rls('checkout_lead');