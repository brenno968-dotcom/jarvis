import pg from 'pg';

export type Banco = pg.Pool;
export type Cliente = pg.PoolClient;
export type Consultavel = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export function criarBanco(url = process.env.DATABASE_URL): Banco {
  if (!url) throw new Error('DATABASE_URL não definida');
  return new pg.Pool({ connectionString: url, max: 5 });
}

/** Executa `fn` dentro de uma transação. */
export async function emTransacao<T>(banco: Banco, fn: (c: Cliente) => Promise<T>): Promise<T> {
  const cliente = await banco.connect();
  try {
    await cliente.query('begin');
    const r = await fn(cliente);
    await cliente.query('commit');
    return r;
  } catch (e) {
    await cliente.query('rollback').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}
