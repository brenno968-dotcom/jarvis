import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { criarBanco, lerRegrasDeTexto, redator, type Banco, type Regras } from '@jarvis/core';

export const URL_TESTE = process.env.DATABASE_URL_TESTE ?? 'postgres://postgres:postgres@localhost:5432/jarvis_test';

const RAIZ = new URL('..', import.meta.url).pathname;

/** Banco zerado com todas as migrations aplicadas em ordem. */
export async function bancoLimpo(): Promise<Banco> {
  const c = new pg.Client({ connectionString: URL_TESTE });
  await c.connect();
  await c.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$;`);
  await c.query('drop schema if exists public cascade; create schema public;');
  await c.query('grant usage on schema public to anon, authenticated;');
  const pasta = join(RAIZ, 'supabase/migrations');
  for (const f of readdirSync(pasta).filter((x) => x.endsWith('.sql')).sort()) {
    await c.query(readFileSync(join(pasta, f), 'utf8'));
  }
  // Para os testes rodarem como o Supabase: anon/authenticated recebem grants amplos
  // por padrão lá; aqui damos grants explícitos para provar que o RLS bloqueia.
  await c.end();
  redator.limpar();
  return criarBanco(URL_TESTE);
}

export function regrasTeste(sobrescrever: (texto: string) => string = (t) => t): Regras {
  const texto = readFileSync(join(RAIZ, 'config/regras.yaml'), 'utf8').replace(
    '"<numero_do_breno>"',
    '"+55 62 99999-0000"',
  );
  return lerRegrasDeTexto(sobrescrever(texto));
}

export const NUMERO_BRENO = '5562999990000';

export async function criarEmpresa(banco: Banco, nome = 'Empresa Teste'): Promise<string> {
  const r = await banco.query(`insert into empresas (nome) values ($1) returning id`, [nome]);
  return r.rows[0].id as string;
}

export { RAIZ };
