-- Rotinas agendadas do worker, kit base e OAuth do conector MCP.

-- Rotinas: só um worker roda cada rotina por vez (trava pela própria linha).
create table if not exists rotinas (
  nome text primary key,
  ultima_execucao timestamptz,
  ultimo_resultado jsonb
);

-- Kit base (seção 10): recursos já criados e verificados que todo negócio pode reaproveitar.
create table if not exists kit_base (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  recurso text not null check (recurso in ('meta_business','conta_anuncios','hotmart','dominio','email','whatsapp_numero')),
  identificador text not null,
  conta_id uuid references contas(id),
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  unique (empresa_id, recurso, identificador)
);

-- OAuth 2.1 do conector MCP (o claude.ai exige OAuth em conectores personalizados).
create table if not exists oauth_clientes (
  client_id text primary key,
  nome text,
  redirect_uris jsonb not null,
  criado_em timestamptz not null default now()
);
create table if not exists oauth_codigos (
  codigo_hash text primary key,
  client_id text not null references oauth_clientes(client_id),
  redirect_uri text not null,
  code_challenge text not null,
  usuario text not null,
  escopo text not null default 'jarvis',
  expira_em timestamptz not null,
  usado_em timestamptz
);
create table if not exists oauth_tokens (
  token_hash text primary key,
  tipo text not null check (tipo in ('acesso','renovacao')),
  client_id text not null references oauth_clientes(client_id),
  usuario text not null,
  expira_em timestamptz not null,
  revogado_em timestamptz,
  criado_em timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['rotinas','kit_base','oauth_clientes','oauth_codigos','oauth_tokens'] loop
    execute format('alter table %I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on %I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on %I from authenticated', t); end if;
  end loop;
  foreach t in array array['rotinas','kit_base'] loop
    execute format('drop policy if exists jarvis_worker_tudo on %I', t);
    execute format('create policy jarvis_worker_tudo on %I to jarvis_worker using (true) with check (true)', t);
  end loop;
  foreach t in array array['kit_base','oauth_clientes','oauth_codigos','oauth_tokens','rotinas'] loop
    execute format('drop policy if exists jarvis_painel_tudo on %I', t);
    execute format('create policy jarvis_painel_tudo on %I to jarvis_painel using (true) with check (true)', t);
  end loop;
end $$;

grant select, insert, update on rotinas to jarvis_worker;
grant select on rotinas to jarvis_painel;
grant select on kit_base to jarvis_worker;
grant select, insert, update (ativo) on kit_base to jarvis_painel;
grant select, insert on oauth_clientes to jarvis_painel;
grant select, insert, update (usado_em) on oauth_codigos to jarvis_painel;
grant select, insert, update (revogado_em) on oauth_tokens to jarvis_painel;
-- Inventário de contas: o worker registra a conta criada por receita.
grant select, insert on contas to jarvis_worker;
grant select on contas to jarvis_painel;
-- Relatório diário lê vendas e métricas.
grant select on movimentos to jarvis_worker;

-- "PARA TUDO" (rodando como painel ou worker) revoga os tokens do conector MCP.
grant update (revogado_em) on oauth_tokens to jarvis_worker;
drop policy if exists jarvis_worker_tudo on oauth_tokens;
create policy jarvis_worker_tudo on oauth_tokens to jarvis_worker using (true) with check (true);

-- Tela de negócios do painel.
grant select on contatos_optin to jarvis_painel;
