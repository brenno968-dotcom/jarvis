import type { Consultavel } from './banco.ts';
import { redator } from './redacao.ts';
import type { Resultado } from './tipos.ts';

/** Resultado já salvo para esta chave (a ação já teve efeito externo). */
export async function lerEfeito(db: Consultavel, chave: string): Promise<Resultado | null> {
  const r = await db.query(`select resultado from efeitos where idempotency_key = $1`, [chave]);
  return (r.rows[0]?.resultado as Resultado | undefined) ?? null;
}

export async function salvarEfeito(db: Consultavel, chave: string, tarefaId: string, resultado: Resultado): Promise<void> {
  await db.query(
    `insert into efeitos (idempotency_key, tarefa_id, resultado) values ($1, $2, $3)
     on conflict (idempotency_key) do nothing`,
    [chave, tarefaId, JSON.stringify(redator.redigirValor(resultado))],
  );
}
