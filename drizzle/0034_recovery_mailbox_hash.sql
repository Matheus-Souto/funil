-- Chave da caixa de entrada do lembrete (sha256 de `mailboxKey`, src/lib/recovery/rules.ts): o limite por endereço e o
-- descadastro passam a valer para a caixa. Linhas já existentes (só no dev; a produção ainda não tem a 0033) ficam com
-- o próprio `email_hash`. O UPDATE roda sem o FORCE do RLS (o dono enxerga todas as lojas) e o `enable_store_rls`
-- religa o FORCE e a política na mesma transação.
ALTER TABLE "recovery_email" ADD COLUMN "mailbox_hash" text;--> statement-breakpoint
ALTER TABLE "recovery_email" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "recovery_email" SET "mailbox_hash" = "email_hash" WHERE "mailbox_hash" IS NULL;--> statement-breakpoint
select enable_store_rls('recovery_email');--> statement-breakpoint
ALTER TABLE "recovery_email" ALTER COLUMN "mailbox_hash" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "recovery_email_store_mailbox_idx" ON "recovery_email" USING btree ("store_id","mailbox_hash","created_at" DESC NULLS LAST);
