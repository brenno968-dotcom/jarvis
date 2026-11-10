-- Fase 3: o Maestro (no worker) cria as tarefas das etapas e atualiza o andamento dos planos.
grant insert on tarefas, aprovacoes to jarvis_worker;
grant select on planos to jarvis_worker;
grant update (status) on planos, negocios to jarvis_worker;
-- O painel/conector MCP grava negócios e planos novos (sempre aguardando aprovação).
grant insert on negocios, planos to jarvis_painel;
grant update (status) on planos to jarvis_painel;

drop policy if exists jarvis_worker_tudo on planos;
create policy jarvis_worker_tudo on planos to jarvis_worker using (true) with check (true);
