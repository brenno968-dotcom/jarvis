import type { Consultavel } from './banco.ts';

export async function sinalWorker(
  db: Consultavel,
  id: string,
  estado: 'ativo' | 'suspenso' | 'parado',
  tarefaAtual: string | null = null,
): Promise<void> {
  await db.query(
    `insert into workers (id, estado, tarefa_atual) values ($1, $2, $3)
     on conflict (id) do update set ultimo_sinal = now(), estado = excluded.estado, tarefa_atual = excluded.tarefa_atual`,
    [id, estado, tarefaAtual],
  );
}
