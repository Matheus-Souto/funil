-- Aplicado pelo migrate.ts ANTES das migrations do drizzle (elas chamam enable_store_rls).
-- Idempotente. O papel `app` é criado pelo migrate.ts (senha vem do ambiente).

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
