-- Fases 4 a 7 (parte de programação): rascunhos da oferta, campanhas e métricas,
-- opt-in e vendas, movimentação de estoque.

-- Fase 4 — rascunhos produzidos pelo agente de oferta (nada é publicado sem o OK do Breno)
create table if not exists rascunhos (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id),
  tarefa_id uuid references tarefas(id),
  tipo text not null check (tipo in ('produto','pagina_venda','anuncios','descricao')),
  titulo text not null,
  conteudo jsonb not null,
  versao int not null default 1,
  status text not null default 'rascunho' check (status in ('rascunho','aprovado','recusado','publicado')),
  problemas jsonb not null default '[]',
  revisado_por text,
  revisado_em timestamptz,
  criado_em timestamptz not null default now()
);
create index if not exists rascunhos_negocio_idx on rascunhos (negocio_id, tipo, versao);

-- Fase 5 — campanhas e métricas diárias
create table if not exists campanhas (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id),
  plataforma text not null default 'meta',
  id_externo text,
  nome text not null,
  status text not null default 'rascunho' check (status in ('rascunho','ativa','pausada','encerrada')),
  orcamento_diario_brl numeric(12,2) not null default 0,
  criado_em timestamptz not null default now(),
  unique (plataforma, id_externo)
);

create table if not exists metricas_campanha (
  campanha_id uuid not null references campanhas(id),
  dia date not null,
  gasto_brl numeric(12,2) not null default 0,
  impressoes int not null default 0,
  cliques int not null default 0,
  leads int not null default 0,
  vendas int not null default 0,
  receita_brl numeric(12,2) not null default 0,
  atualizado_em timestamptz not null default now(),
  primary key (campanha_id, dia)
);

-- Fase 6 — consentimento (opt-in) e vendas
create table if not exists contatos_optin (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id),
  canal text not null check (canal in ('whatsapp','email')),
  contato text not null,
  origem text not null,
  texto_consentimento text not null,
  consentido_em timestamptz not null default now(),
  revogado_em timestamptz,
  unique (negocio_id, canal, contato)
);

create table if not exists vendas (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id),
  origem text not null,
  id_externo text not null,
  contato text,
  valor_brl numeric(12,2) not null,
  status text not null check (status in ('paga','estornada')),
  pago_em timestamptz not null default now(),
  estornado_em timestamptz,
  unique (origem, id_externo)
);

-- Fase 7 — histórico de estoque
create table if not exists movimentos_estoque (
  id bigint generated always as identity primary key,
  estoque_id uuid not null references estoque(id),
  pedido_id uuid references pedidos(id),
  tipo text not null check (tipo in ('entrada','saida','devolucao','ajuste')),
  quantidade int not null,
  criado_em timestamptz not null default now()
);
alter table estoque drop constraint if exists estoque_quantidade_nao_negativa;
alter table estoque add constraint estoque_quantidade_nao_negativa check (quantidade >= 0);
alter table pedidos add column if not exists itens jsonb not null default '[]';

-- Segurança: mesmo padrão das outras tabelas
do $$
declare t text;
begin
  foreach t in array array['rascunhos','campanhas','metricas_campanha','contatos_optin','vendas','movimentos_estoque'] loop
    execute format('alter table %I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on %I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on %I from authenticated', t); end if;
    execute format('drop policy if exists jarvis_worker_tudo on %I', t);
    execute format('create policy jarvis_worker_tudo on %I to jarvis_worker using (true) with check (true)', t);
    execute format('drop policy if exists jarvis_painel_tudo on %I', t);
    execute format('create policy jarvis_painel_tudo on %I to jarvis_painel using (true) with check (true)', t);
  end loop;
end $$;

grant select, insert on rascunhos to jarvis_worker;
grant select, update (status, revisado_por, revisado_em) on rascunhos to jarvis_painel;
grant select, insert, update on campanhas, metricas_campanha to jarvis_worker;
grant select on campanhas, metricas_campanha to jarvis_painel;
grant select, insert, update (revogado_em) on contatos_optin to jarvis_worker, jarvis_painel;
grant select, insert, update (status, estornado_em) on vendas to jarvis_worker;
grant select, insert on movimentos to jarvis_worker;
grant select on vendas to jarvis_painel;
grant select, insert, update on estoque, pedidos to jarvis_worker;
grant select, insert on movimentos_estoque to jarvis_worker;
grant select on estoque, pedidos, movimentos_estoque to jarvis_painel;
do $$
declare t text;
begin
  foreach t in array array['estoque','pedidos','movimentos'] loop
    execute format('drop policy if exists jarvis_worker_tudo on %I', t);
    execute format('create policy jarvis_worker_tudo on %I to jarvis_worker using (true) with check (true)', t);
  end loop;
end $$;

-- O webhook de pagamentos roda no painel.
grant select, insert, update (status, estornado_em) on vendas to jarvis_painel;
grant insert on movimentos to jarvis_painel;
drop policy if exists jarvis_painel_tudo on movimentos;
create policy jarvis_painel_tudo on movimentos to jarvis_painel using (true) with check (true);

-- O mesmo pedido externo não entra duas vezes.
create unique index if not exists pedidos_externo_unico on pedidos (negocio_id, canal, id_externo) where id_externo is not null;
