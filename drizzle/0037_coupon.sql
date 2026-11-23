CREATE TABLE "coupon" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"code" text NOT NULL,
	"kind" text NOT NULL,
	"percent_bp" integer,
	"amount_cents" integer,
	"applies_to" text DEFAULT 'main' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"max_uses" integer,
	"max_per_email" integer DEFAULT 1,
	"active" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_store_code_unique" UNIQUE("store_id","code"),
	CONSTRAINT "coupon_store_id_id_unique" UNIQUE("store_id","id"),
	CONSTRAINT "coupon_code_check" CHECK ("coupon"."code" ~ '^[A-Z0-9_-]{3,32}$'),
	CONSTRAINT "coupon_kind_check" CHECK ("coupon"."kind" in ('percent','fixed')),
	CONSTRAINT "coupon_percent_check" CHECK ("coupon"."percent_bp" is null or "coupon"."percent_bp" between 1 and 9000),
	CONSTRAINT "coupon_amount_check" CHECK ("coupon"."amount_cents" is null or "coupon"."amount_cents" > 0),
	CONSTRAINT "coupon_value_check" CHECK (("coupon"."kind" = 'percent') = ("coupon"."percent_bp" is not null) and ("coupon"."kind" = 'fixed') = ("coupon"."amount_cents" is not null)),
	CONSTRAINT "coupon_applies_to_check" CHECK ("coupon"."applies_to" in ('main','all')),
	CONSTRAINT "coupon_window_check" CHECK ("coupon"."ends_at" is null or "coupon"."starts_at" is null or "coupon"."ends_at" > "coupon"."starts_at"),
	CONSTRAINT "coupon_max_uses_check" CHECK ("coupon"."max_uses" is null or "coupon"."max_uses" > 0),
	CONSTRAINT "coupon_max_per_email_check" CHECK ("coupon"."max_per_email" is null or "coupon"."max_per_email" > 0)
);
--> statement-breakpoint
CREATE TABLE "coupon_offer" (
	"store_id" uuid NOT NULL,
	"coupon_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	CONSTRAINT "coupon_offer_coupon_id_offer_id_pk" PRIMARY KEY("coupon_id","offer_id")
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "coupon_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "coupon" ADD CONSTRAINT "coupon_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_offer" ADD CONSTRAINT "coupon_offer_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_offer" ADD CONSTRAINT "coupon_offer_coupon_fk" FOREIGN KEY ("store_id","coupon_id") REFERENCES "public"."coupon"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_offer" ADD CONSTRAINT "coupon_offer_offer_fk" FOREIGN KEY ("store_id","offer_id") REFERENCES "public"."offer"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_coupon_fk" FOREIGN KEY ("store_id","coupon_id") REFERENCES "public"."coupon"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_coupon_idx" ON "orders" USING btree ("coupon_id") WHERE "orders"."coupon_id" is not null;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_nonneg_check" CHECK ("orders"."discount_cents" >= 0);--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_discount_check" CHECK ("orders"."total_cents" = "orders"."subtotal_cents" - "orders"."discount_cents" and ("orders"."coupon_id" is null) = ("orders"."discount_cents" = 0));
--> statement-breakpoint
select enable_store_rls('coupon');--> statement-breakpoint
select enable_store_rls('coupon_offer');
