-- Fase 2: o worker atualiza o histórico de execução das receitas (não altera os passos).
grant update (ultima_execucao_ok, falhas_seguidas) on receitas to jarvis_worker;
