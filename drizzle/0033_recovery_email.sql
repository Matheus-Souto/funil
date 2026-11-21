CREATE TABLE "email_optout" (
	"store_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_optout_store_id_email_hash_pk" PRIMARY KEY("store_id","email_hash"),
	CONSTRAINT "email_optout_reason_check" CHECK ("email_optout"."reason" in ('unsubscribe','complaint','bounce'))
);
--> statement-breakpoint
CREATE TABLE "recovery_email" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"lead_id" uuid,
	"order_id" uuid,
	"offer_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"skip_reason" text,
	"unsub_hash" text NOT NULL,
	"job_id" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recovery_email_kind_check" CHECK ("recovery_email"."kind" in ('lead','pix','card')),
	CONSTRAINT "recovery_email_status_check" CHECK ("recovery_email"."status" in ('queued','sending','sent','failed','skipped')),
	CONSTRAINT "recovery_email_kind_order_check" CHECK (("recovery_email"."kind" = 'lead') = ("recovery_email"."order_id" is null))
);
--> statement-breakpoint
ALTER TABLE "email_log" DROP CONSTRAINT "email_log_kind_check";--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "recovery_on" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "recovery_lead" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "recovery_pix" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "recovery_card" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "email_optout" ADD CONSTRAINT "email_optout_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_email" ADD CONSTRAINT "recovery_email_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_email" ADD CONSTRAINT "recovery_email_lead_id_checkout_lead_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."checkout_lead"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_email" ADD CONSTRAINT "recovery_email_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_email" ADD CONSTRAINT "recovery_email_offer_id_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_email_unsub_uniq" ON "recovery_email" USING btree ("unsub_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_email_lead_uniq" ON "recovery_email" USING btree ("lead_id") WHERE "recovery_email"."lead_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_email_order_kind_uniq" ON "recovery_email" USING btree ("order_id","kind") WHERE "recovery_email"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "recovery_email_store_email_idx" ON "recovery_email" USING btree ("store_id","email_hash","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recovery_email_store_created_idx" ON "recovery_email" USING btree ("store_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "recovery_email_expires_idx" ON "recovery_email" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_kind_check" CHECK ("email_log"."kind" in ('delivery','seller_notice','test','recovery'));--> statement-breakpoint
select enable_store_rls('recovery_email');--> statement-breakpoint
select enable_store_rls('email_optout');
