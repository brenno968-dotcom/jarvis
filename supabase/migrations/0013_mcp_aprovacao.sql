-- Item 793 (parte 2): aprovação de tool MCP externa amarela/vermelha.
-- A aprovação guarda a chamada (servidor, tool, argumentos já redigidos). Depois de aprovada, o worker executa
-- a tools/call UMA vez: mcp_estado pendente -> executando -> executada | erro. Nunca volta atrás nem repete em falha.
alter table aprovacoes add column if not exists mcp_servidor text;
alter table aprovacoes add column if not exists mcp_tool text;
alter table aprovacoes add column if not exists mcp_acao text;
alter table aprovacoes add column if not exists mcp_args jsonb;
alter table aprovacoes add column if not exists mcp_estado text
  check (mcp_estado is null or mcp_estado in ('pendente','executando','executada','erro'));
alter table aprovacoes add column if not exists mcp_iniciada_em timestamptz;
alter table aprovacoes add column if not exists mcp_concluida_em timestamptz;
alter table aprovacoes add column if not exists mcp_resultado text;
alter table aprovacoes add column if not exists mcp_erro text;

-- Fila de execução: só as aprovadas ainda não tocadas.
create index if not exists aprovacoes_mcp_pendente_idx on aprovacoes (respondido_em)
  where mcp_estado = 'pendente';

-- Quem executa é o worker; o painel também pode (mesma regra dos outros campos de controle).
grant update (mcp_estado, mcp_iniciada_em, mcp_concluida_em, mcp_resultado, mcp_erro) on aprovacoes to jarvis_worker, jarvis_painel;
