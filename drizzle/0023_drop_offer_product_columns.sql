ALTER TABLE "offer" DROP CONSTRAINT "offer_bump_check";--> statement-breakpoint
ALTER TABLE "offer" DROP CONSTRAINT "offer_product_id_product_id_fk";
--> statement-breakpoint
ALTER TABLE "offer" DROP CONSTRAINT "offer_bump_product_id_product_id_fk";
--> statement-breakpoint
ALTER TABLE "offer" DROP COLUMN "product_id";--> statement-breakpoint
ALTER TABLE "offer" DROP COLUMN "bump_product_id";--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_bump_check" CHECK ("offer"."bump_price_cents" is null or "offer"."bump_price_cents" > 0);