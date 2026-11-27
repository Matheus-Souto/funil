-- Uma liberação por sessão de pagamento do app: `released_order_id` guarda o único pedido da sessão que avisa o app
-- (eleito sob trava da sessão); outro pedido pago da mesma sessão é duplicado e gera o alerta `pagamento_duplicado_app`
-- (pedir o reembolso). A coluna nasce nula; nenhuma sessão em produção ainda (a API de pagamentos é desta mesma leva).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "store_alert" DROP CONSTRAINT "store_alert_kind_check";--> statement-breakpoint
ALTER TABLE "app_checkout_session" ADD COLUMN "released_order_id" uuid;--> statement-breakpoint
ALTER TABLE "app_checkout_session" ADD CONSTRAINT "app_checkout_session_released_order_fk" FOREIGN KEY ("store_id","released_order_id") REFERENCES "public"."orders"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_alert" ADD CONSTRAINT "store_alert_kind_check" CHECK ("store_alert"."kind" in ('chave_asaas_invalida','evento_conta_asaas_anterior','estorno_cancelado','estorno_falhou','estorno_parcial','disjuntor_cartao','monitor_pagina_pagamento','telegram_falhou','app_webhook_falhou','pagamento_duplicado_app'));