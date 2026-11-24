-- Aprovações que nascem de um pedido do Nexus (ex.: lançamento do Xavier acima de R$ 20 mil):
-- guardam componente/escopo para o Jarvis devolver a decisão assinada ao Nexus (POST /api/jarvis/decisao).
alter table aprovacoes add column if not exists origem_componente text;
alter table aprovacoes add column if not exists origem_escopo text;
alter table aprovacoes add column if not exists decisao_enviada_em timestamptz;
alter table aprovacoes add column if not exists decisao_tentativas int not null default 0;

-- Um pedido do Nexus pendente por componente+escopo (repetição do mesmo pedido não cria outra aprovação).
create unique index if not exists aprovacoes_origem_pendente_idx
  on aprovacoes (origem_componente, origem_escopo)
  where origem_componente is not null and status = 'pendente';

-- O painel já tem update na tabela; o worker reenvia decisões que falharam.
grant update (decisao_enviada_em, decisao_tentativas) on aprovacoes to jarvis_painel, jarvis_worker;
