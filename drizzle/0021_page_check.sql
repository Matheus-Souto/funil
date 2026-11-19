CREATE TABLE "page_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"page" text NOT NULL,
	"hash" text NOT NULL,
	"ok" boolean NOT NULL,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inventory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_check_store_page_unique" UNIQUE("store_id","page")
);
--> statement-breakpoint
ALTER TABLE "page_check" ADD CONSTRAINT "page_check_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
select enable_store_rls('page_check');
