-- Item 845 — extrator de fatos duráveis. Os fatos moram em memoria_trechos (metadados.tipo = 'fato').
-- Dedup e substituição só mexem nos metadados (visto_em, contagem, substituido_em): libera o update dessa coluna.
-- Idempotente. O código tolera a ausência (grava o fato novo e só deixa de atualizar o antigo até esta migration rodar).
grant update (metadados) on memoria_trechos to jarvis_worker, jarvis_painel;

create index if not exists memoria_fatos_idx
  on memoria_trechos ((metadados->>'categoria'), criado_em desc)
  where metadados->>'tipo' = 'fato';
