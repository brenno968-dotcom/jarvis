import 'server-only';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { carregarRegras, criarBanco, type Banco, type Regras } from '@jarvis/core';

let banco: Banco | undefined;
let regras: Regras | undefined;

export function obterBanco(): Banco {
  banco ??= criarBanco();
  return banco;
}

/** Procura o config/regras.yaml (local: raiz do repositório; Vercel: incluído pelo outputFileTracingIncludes). */
function caminhoRegras(): string {
  const candidatos = [
    process.env.JARVIS_REGRAS,
    join(process.cwd(), 'config/regras.yaml'),
    join(process.cwd(), '../../config/regras.yaml'),
  ].filter((c): c is string => Boolean(c));
  const achado = candidatos.find((c) => existsSync(c));
  if (!achado) throw new Error(`config/regras.yaml não encontrado (procurado em: ${candidatos.join(', ')})`);
  return achado;
}

export function obterRegras(): Regras {
  regras ??= carregarRegras(caminhoRegras());
  return regras;
}
