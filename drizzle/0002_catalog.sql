CREATE TABLE "offer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"product_id" uuid NOT NULL,
	"price_cents" integer NOT NULL,
	"methods" text[] NOT NULL,
	"pix_mode" text NOT NULL,
	"max_installments" integer DEFAULT 1 NOT NULL,
	"bump_product_id" uuid,
	"bump_price_cents" integer,
	"bump_label" text,
	"thank_you_text" text,
	"pixel_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_store_slug_unique" UNIQUE("store_id","slug"),
	CONSTRAINT "offer_price_check" CHECK ("offer"."price_cents" > 0),
	CONSTRAINT "offer_methods_check" CHECK (cardinality("offer"."methods") > 0 and "offer"."methods" <@ array['pix','card']::text[]),
	CONSTRAINT "offer_pix_mode_check" CHECK ("offer"."pix_mode" in ('manual','asaas')),
	CONSTRAINT "offer_installments_check" CHECK ("offer"."max_installments" between 1 and 12),
	CONSTRAINT "offer_bump_check" CHECK (("offer"."bump_product_id" is null and "offer"."bump_price_cents" is null) or ("offer"."bump_product_id" is not null and "offer"."bump_price_cents" > 0 and "offer"."bump_product_id" <> "offer"."product_id"))
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"file_key" text NOT NULL,
	"file_name" text NOT NULL,
	"file_size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_bump_product_id_product_id_fk" FOREIGN KEY ("bump_product_id") REFERENCES "public"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
select enable_store_rls('product');--> statement-breakpoint
select enable_store_rls('offer');
