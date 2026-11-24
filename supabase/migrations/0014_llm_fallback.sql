-- Item 792 — fallback de modelo: registra de qual modelo a chamada caiu (nulo = chamada normal).
-- Idempotente. O código tolera a coluna ausente (grava sem ela até esta migration ser aplicada).
alter table llm_chamadas add column if not exists fallback_de text;
create index if not exists llm_chamadas_fallback_idx on llm_chamadas (criado_em desc) where fallback_de is not null;
