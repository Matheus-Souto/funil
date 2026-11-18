CREATE TABLE "login_attempt" (
	"email_hash" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "login_attempt_email_at_idx" ON "login_attempt" USING btree ("email_hash","at");