import type { Consultavel } from './banco.ts';

/**
 * Roda `fn` se a rotina não rodou nos últimos `intervaloMs`. A marcação é atômica:
 * com vários workers, só um executa cada janela.
 */
export async function executarSeVencida<T>(
  db: Consultavel,
  nome: string,
  intervaloMs: number,
  fn: () => Promise<T>,
): Promise<{ executou: boolean; resultado?: T }> {
  await db.query(`insert into rotinas (nome) values ($1) on conflict do nothing`, [nome]);
  const r = await db.query(
    `update rotinas set ultima_execucao = now()
      where nome = $1 and (ultima_execucao is null or ultima_execucao < now() - make_interval(secs => $2::float / 1000))
      returning nome`,
    [nome, intervaloMs],
  );
  if (!r.rowCount) return { executou: false };
  const resultado = await fn();
  await db.query(`update rotinas set ultimo_resultado = $2 where nome = $1`, [nome, JSON.stringify(resultado ?? null)]);
  return { executou: true, resultado };
}
