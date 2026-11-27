-- Aviso ao app: o alerta `app_webhook_falhou` entra nos tipos de `store_alert`, e cada aviso ganha a ordem dentro do
-- pedido (`sequence`) e, no estorno parcial, a soma devolvida fixada na criação (`refunded_cents`). A tabela nasceu
-- na 0038 e ainda não tem linhas (nenhum código gravava nela).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "store_alert" DROP CONSTRAINT "store_alert_kind_check";--> statement-breakpoint
ALTER TABLE "app_webhook_delivery" ADD COLUMN "sequence" integer;--> statement-breakpoint
ALTER TABLE "app_webhook_delivery" ADD COLUMN "refunded_cents" integer;--> statement-breakpoint
ALTER TABLE "app_webhook_delivery" ADD CONSTRAINT "app_webhook_delivery_order_sequence_unique" UNIQUE("order_id","sequence");--> statement-breakpoint
ALTER TABLE "store_alert" ADD CONSTRAINT "store_alert_kind_check" CHECK ("store_alert"."kind" in ('chave_asaas_invalida','evento_conta_asaas_anterior','estorno_cancelado','estorno_falhou','estorno_parcial','disjuntor_cartao','monitor_pagina_pagamento','telegram_falhou','app_webhook_falhou'));--> statement-breakpoint
ALTER TABLE "app_webhook_delivery" ADD CONSTRAINT "app_webhook_delivery_sequence_check" CHECK (("app_webhook_delivery"."order_id" is null) = ("app_webhook_delivery"."sequence" is null) and "app_webhook_delivery"."sequence" >= 1);--> statement-breakpoint
ALTER TABLE "app_webhook_delivery" ADD CONSTRAINT "app_webhook_delivery_refunded_check" CHECK (("app_webhook_delivery"."event_type" = 'pagamento.reembolso_parcial') = ("app_webhook_delivery"."refunded_cents" is not null) and "app_webhook_delivery"."refunded_cents" > 0);
