-- Fase 0 (pendências): avisos para o Breno pelo WhatsApp do Nexus e proteção contra repetição de webhooks.

-- Caixa de saída: o worker envia ao Nexus, que manda pelo WhatsApp do número que fala com o Breno.
-- Nunca guarda token de aprovação: o token é derivado na hora do envio (HMAC do id da aprovação).
create table if not exists avisos (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('pedido_aprovacao','lembrete_aprovacao','emergencia','pedido_humano','texto')),
  aprovacao_id uuid references aprovacoes(id),
  tarefa_id uuid references tarefas(id),
  conteudo jsonb not null default '{}',
  status text not null default 'pendente' check (status in ('pendente','enviado','falhou')),
  tentativas int not null default 0,
  proxima_tentativa_em timestamptz not null default now(),
  ultimo_erro text,
  enviado_em timestamptz,
  criado_em timestamptz not null default now()
);
create index if not exists avisos_fila_idx on avisos (status, proxima_tentativa_em);

-- Webhooks já processados (assinatura vista), para recusar repetição dentro da janela de tempo.
create table if not exists webhooks_recebidos (
  id text primary key,
  recebido_em timestamptz not null default now()
);

alter table avisos enable row level security;
alter table webhooks_recebidos enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on avisos, webhooks_recebidos from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on avisos, webhooks_recebidos from authenticated;
  end if;
end $$;

grant select, insert, update on avisos to jarvis_worker;
grant update (lembrete_enviado_em) on aprovacoes to jarvis_worker;
grant insert on avisos to jarvis_painel;
grant select, insert, delete on webhooks_recebidos to jarvis_painel;
-- O webhook do Nexus (no painel) responde aprovações e aciona a emergência.
grant update on tarefas, aprovacoes, controle to jarvis_painel;

do $$
declare t text; papel text;
begin
  foreach papel in array array['jarvis_worker','jarvis_painel'] loop
    foreach t in array array['avisos','webhooks_recebidos'] loop
      execute format('drop policy if exists %I on %I', papel || '_tudo', t);
      execute format('create policy %I on %I to %I using (true) with check (true)', papel || '_tudo', t, papel);
    end loop;
  end loop;
end $$;
