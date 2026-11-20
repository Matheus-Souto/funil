CREATE TABLE "offer_product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "offer_product_offer_product_unique" UNIQUE("offer_id","product_id"),
	CONSTRAINT "offer_product_offer_kind_position_unique" UNIQUE("offer_id","kind","position"),
	CONSTRAINT "offer_product_kind_check" CHECK ("offer_product"."kind" in ('main','bump')),
	CONSTRAINT "offer_product_position_check" CHECK ("offer_product"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "order_item" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_store_id_id_unique" UNIQUE("store_id","id");--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_store_id_id_unique" UNIQUE("store_id","id");--> statement-breakpoint
ALTER TABLE "offer_product" ADD CONSTRAINT "offer_product_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_product" ADD CONSTRAINT "offer_product_offer_fk" FOREIGN KEY ("store_id","offer_id") REFERENCES "public"."offer"("store_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_product" ADD CONSTRAINT "offer_product_product_fk" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."product"("store_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Backfill (escrito à mão): cada oferta vende o produto principal e, se tiver, o do bump (posição 0 nos dois grupos).
-- Roda antes do enable_store_rls para não depender de o papel dono ignorar o RLS. As colunas offer.product_id e
-- offer.bump_product_id continuam existindo (saem numa migration posterior).
INSERT INTO "offer_product" ("store_id", "offer_id", "product_id", "kind", "position")
SELECT "store_id", "id", "product_id", 'main', 0 FROM "offer";--> statement-breakpoint
INSERT INTO "offer_product" ("store_id", "offer_id", "product_id", "kind", "position")
SELECT "store_id", "id", "bump_product_id", 'bump', 0 FROM "offer" WHERE "bump_product_id" IS NOT NULL;--> statement-breakpoint
select enable_store_rls('offer_product');
