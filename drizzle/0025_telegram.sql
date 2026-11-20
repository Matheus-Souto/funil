CREATE TABLE "telegram_notice" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"event" text NOT NULL,
	"message_id" bigint NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_notice_order_event_unique" UNIQUE("order_id","event"),
	CONSTRAINT "telegram_notice_event_check" CHECK ("telegram_notice"."event" in ('sale','pix_generated','card_declined','abandoned'))
);
--> statement-breakpoint
ALTER TABLE "integration" DROP CONSTRAINT "integration_kind_check";--> statement-breakpoint
ALTER TABLE "store_alert" DROP CONSTRAINT "store_alert_kind_check";--> statement-breakpoint
ALTER TABLE "telegram_notice" ADD CONSTRAINT "telegram_notice_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_notice" ADD CONSTRAINT "telegram_notice_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_kind_check" CHECK ("integration"."kind" in ('pix_manual','asaas','smtp','meta','resend','telegram'));--> statement-breakpoint
ALTER TABLE "store_alert" ADD CONSTRAINT "store_alert_kind_check" CHECK ("store_alert"."kind" in ('chave_asaas_invalida','evento_conta_asaas_anterior','estorno_cancelado','estorno_falhou','estorno_parcial','disjuntor_cartao','monitor_pagina_pagamento','telegram_falhou'));--> statement-breakpoint
select enable_store_rls('telegram_notice');
