-- Item 791 — telemetria por chamada de LLM (tokens, custo, latência, modelo).
-- Uma linha por chamada à API de mensagens (inclusive as que falharam). A gravação é feita pelo código
-- em segundo plano e nunca derruba a chamada. custo_usd/custo_brl ficam nulos quando o modelo não tem preço
-- conhecido (ver packages/core/src/maestro/precos.ts). Idempotente.

create table if not exists llm_chamadas (
  id uuid primary key default gen_random_uuid(),
  criado_em timestamptz not null default now(),
  empresa_id uuid references empresas(id),
  negocio_id uuid references negocios(id),
  tarefa_id uuid references tarefas(id) on delete set null,
  modelo text not null,
  finalidade text not null default 'outro',   -- ex.: plano, conversa, oferta (roteiro/uso da chamada)
  tokens_entrada int not null default 0 check (tokens_entrada >= 0),
  tokens_saida int not null default 0 check (tokens_saida >= 0),
  tokens_cache_leitura int not null default 0 check (tokens_cache_leitura >= 0),
  tokens_cache_escrita int not null default 0 check (tokens_cache_escrita >= 0),
  custo_usd numeric(14, 6),
  custo_brl numeric(14, 6),
  latencia_ms int not null default 0 check (latencia_ms >= 0),
  status_http int,                            -- 0 = falha de rede/timeout; nulo = erro antes da resposta
  erro text,                                  -- mensagem curta já redigida (sem segredo)
  stop_reason text
);

create index if not exists llm_chamadas_criado_em_idx on llm_chamadas (criado_em desc);
create index if not exists llm_chamadas_tarefa_idx on llm_chamadas (tarefa_id) where tarefa_id is not null;
create index if not exists llm_chamadas_modelo_idx on llm_chamadas (modelo, criado_em desc);

-- Segurança: mesmo padrão das outras tabelas (RLS ligado, anon/authenticated sem acesso).
alter table llm_chamadas enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on llm_chamadas from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on llm_chamadas from authenticated; end if;
end $$;
drop policy if exists jarvis_worker_tudo on llm_chamadas;
create policy jarvis_worker_tudo on llm_chamadas to jarvis_worker using (true) with check (true);
drop policy if exists jarvis_painel_tudo on llm_chamadas;
create policy jarvis_painel_tudo on llm_chamadas to jarvis_painel using (true) with check (true);

-- O worker e o painel gravam; o conector MCP (painel) lê. Registro é imutável: sem update/delete.
grant select, insert on llm_chamadas to jarvis_worker, jarvis_painel;

-- Resumo diário por modelo (dia no fuso de São Paulo). security_invoker: a view respeita o RLS de quem consulta.
create or replace view llm_custos_diarios with (security_invoker = true) as
select
  (criado_em at time zone 'America/Sao_Paulo')::date as dia,
  modelo,
  count(*)::int as chamadas,
  count(*) filter (where erro is not null or coalesce(status_http, 200) >= 400 or status_http = 0)::int as erros,
  count(*) filter (where custo_usd is null)::int as sem_preco,
  coalesce(sum(tokens_entrada), 0)::bigint as tokens_entrada,
  coalesce(sum(tokens_saida), 0)::bigint as tokens_saida,
  coalesce(sum(tokens_cache_leitura), 0)::bigint as tokens_cache_leitura,
  coalesce(sum(tokens_cache_escrita), 0)::bigint as tokens_cache_escrita,
  coalesce(sum(custo_usd), 0)::numeric(14, 6) as custo_usd,
  coalesce(sum(custo_brl), 0)::numeric(14, 6) as custo_brl,
  round(avg(latencia_ms))::int as latencia_media_ms,
  max(latencia_ms)::int as latencia_max_ms
from llm_chamadas
group by 1, 2;

grant select on llm_custos_diarios to jarvis_worker, jarvis_painel;
