-- Aplicado pelo migrate.ts ANTES das migrations do drizzle (elas chamam enable_store_rls).
-- Idempotente. Os papéis `app` e `card` são criados pelo migrate.ts (senhas vêm do ambiente).

-- DML em todas as tabelas atuais e futuras do schema public (as futuras: tabelas criadas pelo dono).
grant usage on schema public to app;
grant select, insert, update, delete on all tables in schema public to app;
grant usage, select on all sequences in schema public to app;
alter default privileges in schema public grant select, insert, update, delete on tables to app;
alter default privileges in schema public grant usage, select on sequences to app;

-- Liga RLS + FORCE + política de isolamento por loja. Toda migration que cria tabela
-- de negócio (com coluna store_id) chama: select enable_store_rls('nome_da_tabela');
-- nullif: após um set_config local o GUC volta a '' (não a null) na mesma conexão.
create or replace function enable_store_rls(tbl regclass) returns void
language plpgsql as $$
begin
  execute format('alter table %s enable row level security', tbl);
  execute format('alter table %s force row level security', tbl);
  execute format('drop policy if exists store_isolation on %s', tbl);
  execute format(
    'create policy store_isolation on %s using (store_id = nullif(current_setting(''app.store_id'', true), '''')::uuid) with check (store_id = nullif(current_setting(''app.store_id'', true), '''')::uuid)',
    tbl
  );
end;
$$;

-- ---------------------------------------------------------------------------------------------------------------------
-- Papel `card` (serviço de cartão isolado: roda `payWithCard` e o formulário do iframe). Criado pelo migrate.ts (com
-- login só quando CARD_DB_PASSWORD existe). Sem BYPASSRLS: o `store_isolation` vale para ele como para o `app`.
--
-- Só GRANT explícito, por tabela ou coluna, NUNCA `alter default privileges`: tabela nova não fica visível para o
-- `card` até alguém acrescentá-la aqui (tests/card-role.test.ts confere a lista exata e uma tabela criada depois).
-- Fora de propósito: users, session, membership, login_attempt, product, download_token/link, email_log, conversion,
-- checkout_view, page_check, order_item, as conexões que não são do Asaas e a leitura da fila de jobs.
--
-- O migrate.ts chama esta função DEPOIS das migrations do drizzle (as tabelas precisam existir). Idempotente: tira tudo
-- e concede de novo, numa chamada só (atômica: o serviço em execução nunca vê o papel sem permissão). Lista final:
--
--   schema public   usage                    resolver os nomes das tabelas.
--   orders          select                   ler o pedido (total, método, estado, comprador) e travá-lo (FOR UPDATE).
--                   update (status, paid_at) transitionOrder("paid") ao aprovar (pending -> paid, card.ts) ou na
--                                            conferência no Asaas (applyAsaasPayment: pending/expired -> paid). Também é
--                                            o que permite o FOR UPDATE. Nada de insert/delete nem de outras colunas.
--                                            Gatilho `orders_card_guard`: para o `card`, só pedido `card_asaas` e só
--                                            pending/expired -> paid com paid_at = coalesce(paid_at, now()) e nenhuma
--                                            outra coluna mudando. Sem ele, o `card` tiraria pedidos de `paid` (o
--                                            download confere `status = 'paid'`) ou liberaria pedidos de Pix.
--   offer           select                   máximo de parcelas da oferta (dados públicos do checkout).
--   customer        select                   e-mail, nome, telefone e CPF do comprador para o cliente/cobrança no Asaas.
--                   update (asaas_customer_id, asaas_account_key)
--                                            ensureAsaasCustomer guarda o cliente criado no Asaas.
--   integration     select                   chave de API do Asaas da loja. Política restritiva `card_asaas_only`: o
--                                            `card` só enxerga linhas `kind = 'asaas'` (SMTP e Meta guardam segredos).
--                                            Sem insert, update nem delete.
--   card_attempt    select, insert           tentativa (idempotência, janela de bloqueio, repetição com a mesma chave).
--                   update (status, asaas_payment_id, error_message, resolved_at)
--                                            fechar a tentativa.
--   payment         select, insert           cobrança aprovada (applyCharge) e a liquidada na conferência
--                                            (applyAsaasPayment, o caminho do webhook).
--                   update (status)          a conferência atualiza o status de uma cobrança que o pedido já conhecia.
--                                            `raw` e orders.refund_requested_at (estorno) ficam de fora: só um estorno em
--                                            pedido já pago chegaria lá, e aí a conferência falha fechada (conflict).
--   rate_limit      select, insert, update, delete
--                                            limites por IP/e-mail, recusas, disjuntor e a limpeza ocasional. Política
--                                            `rate_limit_card`: só chaves `card:` (não lê nem apaga os limites do app,
--                                            como `account:password:` ou os do checkout).
--   job             insert                   jobs da confirmação (deliver_order, meta_event, notify_seller, notify_telegram
--                                            `sale`), o e-mail do disjuntor (notify_seller) e o aviso de recusa
--                                            (notify_telegram `card_declined`). Política `job_card_insert`: só esses tipos (e,
--                                            no notify_telegram, só esses dois eventos) e da loja fixada (nunca refund_order,
--                                            revoke_downloads, pix_generated, abandoned...). Sem select.
--   store_alert     insert                   aviso do disjuntor ao vendedor (alertSeller).
--   audit_log       insert                   a conferência liquida pelo runAction(applyAsaasPayment), que audita.
--   store           select (id, slug, domain) origens da loja para o frame-ancestors do iframe (storeCheckoutOrigins);
--                                            notify_email e o resto ficam de fora.
--
-- Segurança: a política por loja depende de `app.store_id`, que quem tem a conexão escolhe; não é barreira contra um
-- serviço `card` comprometido. Esse serviço AINDA consegue, em qualquer loja: marcar pedido de cartão (`card_asaas`)
-- pendente/expirado como pago e enfileirar a entrega; enfileirar avisos do Telegram de pedidos da loja (venda e cartão
-- recusado), com texto montado do banco pelo job e no máximo um envio por pedido e evento; ler pedidos e clientes (PII)
-- e a chave de API do Asaas; gravar auditoria e avisos falsos; mudar status de cobrança e o cliente Asaas guardado. NÃO
-- consegue: tirar pedido de pago, reembolsar ou revogar (fila), mexer nos limites do app, ler usuários, sessões,
-- produtos, a fila e as conexões SMTP/Meta.
create or replace function card_role_grants() returns void
language plpgsql as $$
begin
  revoke all on all tables in schema public from card;
  revoke all on all sequences in schema public from card;
  revoke all on schema public from card;

  grant usage on schema public to card;
  grant select on orders, offer, customer, integration, card_attempt, payment to card;
  grant update (status, paid_at) on orders to card;
  grant update (asaas_customer_id, asaas_account_key) on customer to card;
  grant insert on card_attempt, payment to card;
  grant update (status, asaas_payment_id, error_message, resolved_at) on card_attempt to card;
  grant update (status) on payment to card;
  grant select, insert, update, delete on rate_limit to card;
  grant insert on job, store_alert, audit_log to card;
  grant select (id, slug, domain) on store to card;

  -- Conexões: além do store_isolation (permissiva, todos os papéis), o `card` só vê a do Asaas.
  drop policy if exists card_asaas_only on integration;
  create policy card_asaas_only on integration as restrictive for select to card using (kind = 'asaas');

  -- rate_limit e job não têm store_id obrigatório nem RLS por loja: o `app` segue vendo tudo; o `card` só o que é dele.
  -- Sem FORCE: o dono (migrações, CLIs) continua de fora das políticas.
  -- Só liga quando ainda está desligado: `alter table` pega ACCESS EXCLUSIVE, e isto roda a cada subida.
  if not (select relrowsecurity from pg_class where oid = 'rate_limit'::regclass) then
    alter table rate_limit enable row level security;
  end if;
  drop policy if exists rate_limit_app on rate_limit;
  create policy rate_limit_app on rate_limit to app using (true) with check (true);
  drop policy if exists rate_limit_card on rate_limit;
  create policy rate_limit_card on rate_limit to card using (starts_with(key, 'card:')) with check (starts_with(key, 'card:'));

  if not (select relrowsecurity from pg_class where oid = 'job'::regclass) then
    alter table job enable row level security;
  end if;
  drop policy if exists job_app on job;
  create policy job_app on job to app using (true) with check (true);
  drop policy if exists job_card_insert on job;
  create policy job_card_insert on job for insert to card with check (
    store_id = nullif(current_setting('app.store_id', true), '')::uuid
    and (
      type in ('deliver_order', 'meta_event', 'notify_seller')
      or (type = 'notify_telegram' and payload->>'event' in ('sale', 'card_declined'))
    )
  );

  -- Pedidos: a regra de transição do `card` (orders_card_guard, abaixo). Criado uma vez, pelo nome (sem trava a cada
  -- subida): mudar o WHEN ou a definição do gatilho (não o corpo da função, que o `create or replace` atualiza) exige
  -- um `drop trigger if exists orders_card_guard on orders` explícito antes deste bloco, senão a mudança não chega
  -- aos bancos que já têm o gatilho.
  if not exists (select 1 from pg_trigger where tgrelid = 'orders'::regclass and tgname = 'orders_card_guard') then
    create trigger orders_card_guard before update on orders
      for each row when (current_user = 'card') execute function orders_card_guard();
  end if;
end;
$$;
-- Só o dono (migrate.ts) chama.
revoke execute on function card_role_grants() from public;

-- Papel `card` em `orders`: só marca como pago um pedido pendente ou expirado (o que transitionOrder faz no caminho do
-- cartão: card.ts e a conferência via applyAsaasPayment), só em pedido `card_asaas` (o serviço de cartão não toca Pix),
-- com paid_at = coalesce(paid_at, now()) e nenhuma outra coluna mudando. Nunca tira um pedido de `paid`.
-- Gatilho, não política: uma política restritiva de UPDATE também valeria para o SELECT ... FOR UPDATE, que trava
-- pedidos já pagos. Para os outros papéis o gatilho nem dispara (WHEN). search_path fixo: o gatilho roda na sessão do
-- `card`, e quem tem a sessão não escolhe o que `to_jsonb`, `coalesce` etc. resolvem.
create or replace function orders_card_guard() returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if not (old.method = 'card_asaas' and old.status in ('pending', 'expired') and new.status = 'paid'
          and new.paid_at is not distinct from coalesce(old.paid_at, now()))
     or (to_jsonb(new) - 'status' - 'paid_at') is distinct from (to_jsonb(old) - 'status' - 'paid_at') then
    raise exception 'papel card só marca como pago um pedido de cartão pendente ou expirado (%: % -> %)',
      old.method, old.status, new.status
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
