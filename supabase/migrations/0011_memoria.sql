-- Item 790 — memória semântica de longo prazo (chunker → embeddings → busca híbrida).
-- Exige a extensão pgvector (Supabase: disponível; Postgres local/CI: imagem pgvector/pgvector).
-- Embedding de 1024 dimensões = voyage-3.5 (padrão). Trocar de modelo/dimensão exige nova migration.
-- Idempotente.

create extension if not exists vector;

create table if not exists memoria_trechos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid references empresas(id),
  negocio_id uuid references negocios(id),
  origem text not null check (origem in ('conversa','documento','gmail','tarefa','plano','outro')),
  referencia text not null default '',
  texto text not null,
  hash_conteudo text not null,
  metadados jsonb not null default '{}',
  embedding vector(1024),
  busca tsvector generated always as (to_tsvector('portuguese', texto)) stored,
  criado_em timestamptz not null default now()
);

-- Idempotência: o mesmo trecho (mesmo conteúdo) da mesma origem/referência/empresa entra uma vez só.
create unique index if not exists memoria_trechos_unico
  on memoria_trechos ((coalesce(empresa_id, '00000000-0000-0000-0000-000000000000'::uuid)), origem, referencia, hash_conteudo);
create index if not exists memoria_trechos_busca_idx on memoria_trechos using gin (busca);
create index if not exists memoria_trechos_embedding_idx on memoria_trechos using hnsw (embedding vector_cosine_ops);
create index if not exists memoria_trechos_empresa_idx on memoria_trechos (empresa_id, origem, criado_em desc);

-- Segurança: mesmo padrão das outras tabelas (RLS ligado, anon/authenticated sem acesso).
alter table memoria_trechos enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on memoria_trechos from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on memoria_trechos from authenticated; end if;
end $$;
drop policy if exists jarvis_worker_tudo on memoria_trechos;
create policy jarvis_worker_tudo on memoria_trechos to jarvis_worker using (true) with check (true);
drop policy if exists jarvis_painel_tudo on memoria_trechos;
create policy jarvis_painel_tudo on memoria_trechos to jarvis_painel using (true) with check (true);

-- O conector MCP roda no painel (grava e busca); o worker também pode lembrar. Embedding pode ser
-- preenchido depois (update só dessa coluna).
grant select, insert on memoria_trechos to jarvis_worker, jarvis_painel;
grant update (embedding) on memoria_trechos to jarvis_worker, jarvis_painel;

-- Busca híbrida por RRF (reciprocal rank fusion): soma 1/(k + posição) do ranking vetorial (cosseno)
-- e do ranking full-text (ts_rank). Com p_embedding nulo, só o full-text conta.
create or replace function memoria_buscar(
  p_consulta text,
  p_embedding vector(1024) default null,
  p_empresa uuid default null,
  p_negocio uuid default null,
  p_origem text default null,
  p_limite int default 10,
  p_k int default 60
) returns table (
  id uuid,
  origem text,
  referencia text,
  texto text,
  metadados jsonb,
  criado_em timestamptz,
  score double precision
)
language sql stable
as $$
  with filtro as (
    select m.id, m.busca, m.embedding
      from memoria_trechos m
     where (p_empresa is null or m.empresa_id = p_empresa)
       and (p_negocio is null or m.negocio_id = p_negocio)
       and (p_origem is null or m.origem = p_origem)
  ),
  consulta as (select websearch_to_tsquery('portuguese', coalesce(p_consulta, '')) as q),
  texto_rank as (
    select f.id, row_number() over (order by ts_rank(f.busca, c.q) desc, f.id) as r
      from filtro f, consulta c
     where f.busca @@ c.q
     order by ts_rank(f.busca, c.q) desc, f.id
     limit 50
  ),
  vetor_rank as (
    select f.id, row_number() over (order by f.embedding <=> p_embedding, f.id) as r
      from filtro f
     where p_embedding is not null and f.embedding is not null
     order by f.embedding <=> p_embedding, f.id
     limit 50
  ),
  fundido as (
    select coalesce(t.id, v.id) as id,
           coalesce(1.0 / (p_k + t.r), 0) + coalesce(1.0 / (p_k + v.r), 0) as score
      from texto_rank t
      full join vetor_rank v on v.id = t.id
  )
  select m.id, m.origem, m.referencia, m.texto, m.metadados, m.criado_em, fu.score::double precision
    from fundido fu
    join memoria_trechos m on m.id = fu.id
   order by fu.score desc, m.criado_em desc
   limit greatest(1, least(coalesce(p_limite, 10), 50));
$$;

grant execute on function memoria_buscar(text, vector, uuid, uuid, text, int, int) to jarvis_worker, jarvis_painel;
