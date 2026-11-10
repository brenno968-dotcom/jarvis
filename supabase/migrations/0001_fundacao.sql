-- Projeto Jarvis — Fase 0 — Fundação
-- Tabelas da especificação (docs/JARVIS.md, seção 17) + controle, efeitos e workers.
-- Idempotente: pode rodar num banco vazio do Supabase ou num Postgres local de teste.

create extension if not exists pgcrypto;

-- Empresas e negócios ---------------------------------------------------------
create table if not exists empresas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  nexus_empresa_id text,
  criado_em timestamptz not null default now()
);

create table if not exists negocios (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  nome text not null,
  modelo_negocio text not null check (modelo_negocio in
    ('produto_digital','fisico_estoque','fisico_sem_estoque','marketplace','servico','afiliado')),
  status text not null default 'planejamento' check (status in
    ('planejamento','montagem','ativo','pausado','encerrado')),
  orcamento jsonb not null default '{}',
  criado_em timestamptz not null default now()
);

-- Inventário de contas --------------------------------------------------------
create table if not exists contas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  negocio_id uuid references negocios(id),
  plataforma text not null,
  email_usado text,
  id_externo text,
  plano text,
  limites jsonb default '{}',
  renovacao_em date,
  status text not null default 'ativa',
  criado_em timestamptz not null default now()
);

-- Referências de segredos (NUNCA o valor) -------------------------------------
create table if not exists segredos_ref (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  negocio_id uuid references negocios(id),
  nome text not null unique,
  bitwarden_secret_id text not null,
  bitwarden_projeto text not null,
  plataforma text not null,
  destinos jsonb default '[]',
  criado_em timestamptz not null default now(),
  rotacionado_em timestamptz,
  ultimo_teste_em timestamptz,
  ultimo_teste_ok boolean,
  constraint segredos_ref_nome_formato check (nome ~ '^[A-Z0-9_]+$')
);

-- Planos do Maestro -----------------------------------------------------------
create table if not exists planos (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid references negocios(id),
  versao int not null default 1,
  conteudo jsonb not null,
  status text not null default 'aguardando_aprovacao',
  criado_em timestamptz not null default now()
);

-- Fila de tarefas -------------------------------------------------------------
create table if not exists tarefas (
  id uuid primary key default gen_random_uuid(),
  plano_id uuid references planos(id),
  etapa_id text,
  empresa_id uuid not null references empresas(id),
  negocio_id uuid references negocios(id),
  agente text not null,
  acao text not null,
  plataforma text,
  parametros jsonb not null default '{}',
  idempotency_key text not null unique,
  nivel_semaforo text not null check (nivel_semaforo in ('verde','amarelo','vermelho')),
  status text not null default 'pendente' check (status in
    ('pendente','aguardando_aprovacao','aprovada','executando','aguardando_humano',
     'aguardando_externo','erro_temporario','concluida','falhou','recusada','cancelada')),
  tentativas int not null default 0,
  max_tentativas int not null default 5,
  proxima_tentativa_em timestamptz default now(),
  travada_por text,
  travada_ate timestamptz,
  resultado jsonb,
  erro jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists tarefas_fila_idx on tarefas (status, proxima_tentativa_em);
create index if not exists tarefas_travadas_idx on tarefas (travada_ate) where status = 'executando';

create or replace function jarvis_toca_atualizado_em() returns trigger
language plpgsql as $$
begin
  new.atualizado_em := now();
  return new;
end $$;

drop trigger if exists tarefas_atualizado_em on tarefas;
create trigger tarefas_atualizado_em before update on tarefas
  for each row execute function jarvis_toca_atualizado_em();

-- Aprovações ------------------------------------------------------------------
create table if not exists aprovacoes (
  id uuid primary key default gen_random_uuid(),
  tarefa_id uuid references tarefas(id),
  plano_id uuid references planos(id),
  resumo text not null,
  token_hash text not null unique,
  status text not null default 'pendente' check (status in
    ('pendente','aprovada','recusada','expirada')),
  respondido_por text,
  expira_em timestamptz not null,
  respondido_em timestamptz,
  lembrete_enviado_em timestamptz,
  criado_em timestamptz not null default now()
);
create index if not exists aprovacoes_tarefa_idx on aprovacoes (tarefa_id);

-- Receitas de navegador -------------------------------------------------------
create table if not exists receitas (
  id uuid primary key default gen_random_uuid(),
  plataforma text not null,
  acao text not null,
  versao int not null default 1,
  passos jsonb not null,
  ultima_execucao_ok timestamptz,
  falhas_seguidas int not null default 0,
  aprovada_pelo_vigia boolean not null default false,
  unique (plataforma, acao, versao)
);

-- Auditoria (só inclusão) -----------------------------------------------------
create table if not exists auditoria (
  id bigint generated always as identity primary key,
  quando timestamptz not null default now(),
  quem text not null,
  acao text not null,
  empresa_id uuid,
  negocio_id uuid,
  tarefa_id uuid,
  detalhes jsonb default '{}'
);

create or replace function jarvis_auditoria_imutavel() returns trigger
language plpgsql as $$
begin
  raise exception 'auditoria é só de inclusão: % bloqueado', tg_op;
end $$;

drop trigger if exists auditoria_sem_update on auditoria;
create trigger auditoria_sem_update before update or delete on auditoria
  for each row execute function jarvis_auditoria_imutavel();
drop trigger if exists auditoria_sem_truncate on auditoria;
create trigger auditoria_sem_truncate before truncate on auditoria
  for each statement execute function jarvis_auditoria_imutavel();

-- Financeiro e físico ---------------------------------------------------------
create table if not exists movimentos (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id),
  tipo text not null check (tipo in ('custo','receita')),
  categoria text not null,
  valor_brl numeric(12,2) not null,
  origem text,
  id_externo text,
  ocorrido_em timestamptz not null default now()
);

create table if not exists estoque (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id),
  sku text not null,
  descricao text,
  quantidade int not null default 0,
  custo_unitario_brl numeric(12,2),
  unique (negocio_id, sku)
);

create table if not exists pedidos (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id),
  canal text,
  id_externo text,
  status text not null,
  valor_brl numeric(12,2),
  nota_fiscal_id text,
  rastreio text,
  criado_em timestamptz not null default now()
);

-- Acréscimos da Fase 0 (não estavam na especificação) -------------------------
-- controle: chave geral do sistema (ex.: emergencia = {"parado": true, ...}).
create table if not exists controle (
  chave text primary key,
  valor jsonb not null default '{}',
  atualizado_em timestamptz not null default now()
);
insert into controle (chave, valor) values ('emergencia', '{"parado": false}')
  on conflict (chave) do nothing;

-- efeitos: resultado de cada ação com efeito externo, por idempotency_key.
-- Repetir a ação com a mesma chave devolve o resultado salvo (seção 19).
create table if not exists efeitos (
  idempotency_key text primary key,
  tarefa_id uuid references tarefas(id),
  resultado jsonb not null,
  criado_em timestamptz not null default now()
);

-- workers: batimento de cada worker (lido pelo Pulso).
create table if not exists workers (
  id text primary key,
  iniciado_em timestamptz not null default now(),
  ultimo_sinal timestamptz not null default now(),
  estado text not null default 'ativo' check (estado in ('ativo','suspenso','parado')),
  tarefa_atual uuid
);

-- Segurança -------------------------------------------------------------------
-- RLS em todas as tabelas, sem políticas: a API pública do Supabase (anon/authenticated)
-- não lê nem escreve nada. O painel e o worker usam conexão de servidor.
do $$
declare t text;
begin
  foreach t in array array['empresas','negocios','contas','segredos_ref','planos','tarefas',
    'aprovacoes','receitas','auditoria','movimentos','estoque','pedidos','controle','efeitos','workers']
  loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon;
    alter default privileges in schema public revoke all on tables from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema public from authenticated;
    alter default privileges in schema public revoke all on tables from authenticated;
  end if;
end $$;

-- Papel do worker: só o que ele usa. No Supabase, criar um usuário de login
-- e dar `grant jarvis_worker to <usuario>` (ver docs/STATUS.md).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'jarvis_worker') then
    create role jarvis_worker nologin;
  end if;
end $$;

grant usage on schema public to jarvis_worker;
grant select, update on tarefas to jarvis_worker;
grant select on aprovacoes, receitas, controle, empresas, negocios to jarvis_worker;
grant select, insert, update on segredos_ref, contas, efeitos, workers to jarvis_worker;
grant insert on auditoria to jarvis_worker;
grant select on auditoria to jarvis_worker;

-- O papel do worker ignora RLS só nas suas tabelas, via políticas explícitas.
do $$
declare t text;
begin
  foreach t in array array['tarefas','aprovacoes','receitas','controle','empresas','negocios',
    'segredos_ref','contas','efeitos','workers','auditoria']
  loop
    execute format('drop policy if exists jarvis_worker_tudo on %I', t);
    execute format('create policy jarvis_worker_tudo on %I to jarvis_worker using (true) with check (true)', t);
  end loop;
end $$;
