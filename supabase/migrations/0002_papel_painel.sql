-- Papel do painel (Vercel): lê tudo que mostra, cria tarefas de teste, responde aprovações
-- e aciona/retoma a emergência. Não apaga nada e não altera auditoria.
-- No Supabase: criar um usuário de login e dar `grant jarvis_painel to <usuario>`.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'jarvis_painel') then
    create role jarvis_painel nologin;
  end if;
end $$;

grant usage on schema public to jarvis_painel;
grant select on empresas, negocios, contas, segredos_ref, planos, tarefas, aprovacoes, receitas,
  auditoria, movimentos, estoque, pedidos, controle, workers to jarvis_painel;
grant insert on empresas, tarefas, aprovacoes, auditoria to jarvis_painel;
grant update on tarefas, aprovacoes, controle to jarvis_painel;
grant insert on controle to jarvis_painel;

do $$
declare t text;
begin
  foreach t in array array['empresas','negocios','contas','segredos_ref','planos','tarefas','aprovacoes',
    'receitas','auditoria','movimentos','estoque','pedidos','controle','workers']
  loop
    execute format('drop policy if exists jarvis_painel_tudo on %I', t);
    execute format('create policy jarvis_painel_tudo on %I to jarvis_painel using (true) with check (true)', t);
  end loop;
end $$;
