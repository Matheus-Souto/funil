CREATE TABLE "card_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"asaas_payment_id" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "card_attempt_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "card_attempt_status_check" CHECK ("card_attempt"."status" in ('processing','approved','declined','error'))
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "rate_limit_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
ALTER TABLE "card_attempt" ADD CONSTRAINT "card_attempt_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_attempt" ADD CONSTRAINT "card_attempt_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_attempt_order_idx" ON "card_attempt" USING btree ("order_id","created_at");--> statement-breakpoint
select enable_store_rls('card_attempt');
