ALTER TABLE "integration" DROP CONSTRAINT "integration_kind_check";--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "email_provider" text DEFAULT 'smtp' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "delivery_status" text;--> statement-breakpoint
ALTER TABLE "email_log" ADD COLUMN "delivery_status_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "email_log_provider_message_idx" ON "email_log" USING btree ("store_id","provider_message_id");--> statement-breakpoint
ALTER TABLE "store" ADD CONSTRAINT "store_email_provider_check" CHECK ("store"."email_provider" in ('smtp','resend'));--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_kind_check" CHECK ("integration"."kind" in ('pix_manual','asaas','smtp','meta','resend'));--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_provider_check" CHECK ("email_log"."provider" in ('smtp','resend'));--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_delivery_status_check" CHECK ("email_log"."delivery_status" in ('delivered','bounced','complained'));