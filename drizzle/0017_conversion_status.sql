ALTER TABLE "conversion" ADD COLUMN "status" text DEFAULT 'sent' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversion" ADD COLUMN "error_code" integer;--> statement-breakpoint
ALTER TABLE "conversion" ADD CONSTRAINT "conversion_status_check" CHECK ("conversion"."status" in ('sent','failed'));