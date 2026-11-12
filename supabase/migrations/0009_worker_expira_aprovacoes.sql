-- O worker expira os pedidos de aprovação vencidos (expirarAprovacoesVencidas):
-- precisa poder mudar status e respondido_em. Sem isso o ciclo do worker falha com
-- "permission denied for table aprovacoes".
grant update (status, respondido_em) on aprovacoes to jarvis_worker;
