CREATE TABLE "conversion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"event" text NOT NULL,
	"event_id" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversion_order_event_unique" UNIQUE("order_id","event"),
	CONSTRAINT "conversion_event_check" CHECK ("conversion"."event" in ('Purchase','InitiateCheckout'))
);
--> statement-breakpoint
ALTER TABLE "conversion" ADD CONSTRAINT "conversion_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion" ADD CONSTRAINT "conversion_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
select enable_store_rls('conversion');
