CREATE TABLE "store_alert" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"order_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	CONSTRAINT "store_alert_kind_check" CHECK ("store_alert"."kind" in ('chave_asaas_invalida','evento_conta_asaas_anterior','estorno_cancelado','disjuntor_cartao'))
);
--> statement-breakpoint
ALTER TABLE "store_alert" ADD CONSTRAINT "store_alert_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_alert" ADD CONSTRAINT "store_alert_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_alert_open_idx" ON "store_alert" USING btree ("store_id","created_at") WHERE "store_alert"."acknowledged_at" is null;--> statement-breakpoint
select enable_store_rls('store_alert');
