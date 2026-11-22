CREATE TABLE "team_invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"store_id" uuid NOT NULL,
	"email" text,
	"email_hash" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"send_status" text,
	"send_error" text,
	"send_count" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_invite_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "team_invite_role_check" CHECK ("team_invite"."role" in ('admin','support','traffic')),
	CONSTRAINT "team_invite_status_check" CHECK ("team_invite"."status" in ('pending','accepted','revoked','expired')),
	CONSTRAINT "team_invite_send_status_check" CHECK ("team_invite"."send_status" is null or "team_invite"."send_status" in ('sent','failed')),
	CONSTRAINT "team_invite_email_status_check" CHECK (("team_invite"."status" = 'pending') = ("team_invite"."email" is not null))
);
--> statement-breakpoint
ALTER TABLE "email_log" DROP CONSTRAINT "email_log_kind_check";--> statement-breakpoint
ALTER TABLE "team_invite" ADD CONSTRAINT "team_invite_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invite" ADD CONSTRAINT "team_invite_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invite" ADD CONSTRAINT "team_invite_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_invite_pending_email_uniq" ON "team_invite" USING btree ("store_id","email_hash") WHERE "team_invite"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "team_invite_store_status_idx" ON "team_invite" USING btree ("store_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "team_invite_ended_idx" ON "team_invite" USING btree ("ended_at");--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_kind_check" CHECK ("email_log"."kind" in ('delivery','seller_notice','test','recovery','team_invite'));
--> statement-breakpoint
select enable_store_rls('team_invite');
