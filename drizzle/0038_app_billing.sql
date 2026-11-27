SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE "app_checkout_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"account" text NOT NULL,
	"buyer_name" text NOT NULL,
	"buyer_email" text NOT NULL,
	"buyer_phone" text,
	"touch" jsonb,
	"ref" text,
	"fbc" text,
	"fbp" text,
	"return_url" text,
	"expires_at" timestamp with time zone NOT NULL,
	"order_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_checkout_session_store_id_id_unique" UNIQUE("store_id","id"),
	CONSTRAINT "app_checkout_session_account_check" CHECK (char_length("app_checkout_session"."account") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "app_trial" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"account" text NOT NULL,
	"email_hash" text NOT NULL,
	"mailbox_hash" text NOT NULL,
	"first_touch" jsonb,
	"ref" text,
	"fbc" text,
	"fbp" text,
	"client_ip" text,
	"user_agent" text,
	"event_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_trial_store_account_unique" UNIQUE("store_id","account"),
	CONSTRAINT "app_trial_store_id_id_unique" UNIQUE("store_id","id"),
	CONSTRAINT "app_trial_account_check" CHECK (char_length("app_trial"."account") between 1 and 64)
);
--> statement-breakpoint
CREATE TABLE "app_webhook_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"order_id" uuid,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_http_status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "app_webhook_delivery_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "app_webhook_delivery_event_type_check" CHECK ("app_webhook_delivery"."event_type" in ('pagamento.confirmado','pagamento.reembolsado','pagamento.reembolso_parcial','pagamento.contestado','pagamento.restabelecido','ping')),
	CONSTRAINT "app_webhook_delivery_status_check" CHECK ("app_webhook_delivery"."status" in ('pending','delivered','failed')),
	CONSTRAINT "app_webhook_delivery_event_order_check" CHECK (("app_webhook_delivery"."event_type" = 'ping') = ("app_webhook_delivery"."order_id" is null))
);
--> statement-breakpoint
ALTER TABLE "integration" DROP CONSTRAINT "integration_kind_check";--> statement-breakpoint
ALTER TABLE "conversion" DROP CONSTRAINT "conversion_event_check";--> statement-breakpoint
ALTER TABLE "mcp_token" DROP CONSTRAINT "mcp_token_role_check";--> statement-breakpoint
ALTER TABLE "conversion" ALTER COLUMN "order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "store" ADD COLUMN "accept_cnpj" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "offer" ADD COLUMN "delivery" text DEFAULT 'download' NOT NULL;--> statement-breakpoint
ALTER TABLE "offer" ADD COLUMN "app_code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "app_account" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "app_session_id" uuid;--> statement-breakpoint
ALTER TABLE "conversion" ADD COLUMN "trial_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_store_id_id_unique" UNIQUE("store_id","id");--> statement-breakpoint
ALTER TABLE "app_checkout_session" ADD CONSTRAINT "app_checkout_session_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_checkout_session" ADD CONSTRAINT "app_checkout_session_offer_fk" FOREIGN KEY ("store_id","offer_id") REFERENCES "public"."offer"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_checkout_session" ADD CONSTRAINT "app_checkout_session_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."orders"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_trial" ADD CONSTRAINT "app_trial_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_webhook_delivery" ADD CONSTRAINT "app_webhook_delivery_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_webhook_delivery" ADD CONSTRAINT "app_webhook_delivery_order_fk" FOREIGN KEY ("store_id","order_id") REFERENCES "public"."orders"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_app_session_fk" FOREIGN KEY ("store_id","app_session_id") REFERENCES "public"."app_checkout_session"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion" ADD CONSTRAINT "conversion_trial_fk" FOREIGN KEY ("store_id","trial_id") REFERENCES "public"."app_trial"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_store_app_code_unique" UNIQUE("store_id","app_code");--> statement-breakpoint
ALTER TABLE "conversion" ADD CONSTRAINT "conversion_trial_event_unique" UNIQUE("trial_id","event");--> statement-breakpoint
CREATE INDEX "app_checkout_session_order_idx" ON "app_checkout_session" USING btree ("order_id") WHERE "app_checkout_session"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "app_webhook_delivery_order_idx" ON "app_webhook_delivery" USING btree ("order_id") WHERE "app_webhook_delivery"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "orders_app_session_idx" ON "orders" USING btree ("app_session_id") WHERE "orders"."app_session_id" is not null;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_app_account_session_check" CHECK (("orders"."app_account" is null) = ("orders"."app_session_id" is null));--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_app_account_check" CHECK (char_length("orders"."app_account") between 1 and 64);--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_delivery_check" CHECK ("offer"."delivery" in ('download','app'));--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_app_code_check" CHECK ("offer"."app_code" ~ '^[a-z0-9_]{1,40}$');--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_app_code_required_check" CHECK (("offer"."delivery" = 'app') = ("offer"."app_code" is not null));--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_app_checkout_check" CHECK ("offer"."delivery" <> 'app' or ("offer"."max_installments" = 1 and "offer"."pix_mode" = 'asaas' and "offer"."bump_price_cents" is null));--> statement-breakpoint
ALTER TABLE "integration" ADD CONSTRAINT "integration_kind_check" CHECK ("integration"."kind" in ('pix_manual','asaas','smtp','meta','resend','telegram','app_webhook'));--> statement-breakpoint
ALTER TABLE "conversion" ADD CONSTRAINT "conversion_subject_check" CHECK (("conversion"."order_id" is null) <> ("conversion"."trial_id" is null));--> statement-breakpoint
ALTER TABLE "conversion" ADD CONSTRAINT "conversion_event_check" CHECK ("conversion"."event" in ('Purchase','InitiateCheckout','StartTrial'));--> statement-breakpoint
ALTER TABLE "mcp_token" ADD CONSTRAINT "mcp_token_role_check" CHECK ("mcp_token"."role" in ('owner','admin','support','traffic','reader','integration'));
--> statement-breakpoint
select enable_store_rls('app_checkout_session');--> statement-breakpoint
select enable_store_rls('app_trial');--> statement-breakpoint
select enable_store_rls('app_webhook_delivery');
