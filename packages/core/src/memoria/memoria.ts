// Memória semântica de longo prazo (item 790): lembrar = chunk + embedding + insert idempotente;
// recordar = busca híbrida (vetor + full-text, RRF) pela função SQL memoria_buscar.
import { createHash } from 'node:crypto';
import type { Consultavel } from '../banco.ts';
import { dividirEmTrechos, type OpcoesChunker } from './chunker.ts';
import { provedorEmbeddingsDoAmbiente, type ProvedorEmbeddings } from './embeddings.ts';

export const ORIGENS_MEMORIA = ['conversa', 'documento', 'gmail', 'tarefa', 'plano', 'outro'] as const;
export type OrigemMemoria = (typeof ORIGENS_MEMORIA)[number];

export interface EntradaMemoria {
  texto: string;
  origem: OrigemMemoria;
  referencia?: string;
  empresaId?: string | null;
  negocioId?: string | null;
  metadados?: Record<string, unknown>;
}

export interface OpcoesMemoria {
  /** Padrão: Voyage pela env VOYAGE_API_KEY; sem chave, grava e busca só por full-text. */
  provedor?: ProvedorEmbeddings | null;
  chunker?: OpcoesChunker;
}

export interface ResultadoLembrar {
  trechos: number;
  inseridos: number;
  ja_existiam: number;
  com_embedding: boolean;
}

export interface FiltrosMemoria {
  empresaId?: string | null;
  negocioId?: string | null;
  origem?: OrigemMemoria | null;
}

export interface TrechoRecordado {
  id: string;
  origem: string;
  referencia: string;
  texto: string;
  metadados: Record<string, unknown>;
  criado_em: Date;
  score: number;
}

export function hashDoTrecho(texto: string): string {
  return createHash('sha256').update(texto.trim()).digest('hex');
}

/** Formato de literal do pgvector: [0.1,0.2,...] */
export function literalVetor(v: number[]): string {
  return `[${v.join(',')}]`;
}

function resolverProvedor(o: OpcoesMemoria): ProvedorEmbeddings | undefined {
  if (o.provedor === null) return undefined;
  return o.provedor ?? provedorEmbeddingsDoAmbiente();
}

/** Embeddings são opcionais: se o provedor falhar, a memória continua só com full-text. */
async function tentarEmbutir(p: ProvedorEmbeddings | undefined, textos: string[], tipo: 'documento' | 'consulta'): Promise<(number[] | null)[]> {
  if (!p || !textos.length) return textos.map(() => null);
  try {
    return await p.embutir(textos, tipo);
  } catch {
    return textos.map(() => null);
  }
}

export async function lembrar(banco: Consultavel, e: EntradaMemoria, o: OpcoesMemoria = {}): Promise<ResultadoLembrar> {
  const trechos = dividirEmTrechos(e.texto, o.chunker);
  if (!trechos.length) throw new Error('texto vazio: nada para lembrar');
  const vetores = await tentarEmbutir(resolverProvedor(o), trechos, 'documento');
  let inseridos = 0;
  for (let i = 0; i < trechos.length; i++) {
    const t = trechos[i]!;
    const v = vetores[i];
    // Conflito = mesmo conteúdo já gravado: só completa o embedding se ele estava vazio.
    const r = await banco.query(
      `insert into memoria_trechos (empresa_id, negocio_id, origem, referencia, texto, hash_conteudo, metadados, embedding)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::vector)
       on conflict ((coalesce(empresa_id, '00000000-0000-0000-0000-000000000000'::uuid)), origem, referencia, hash_conteudo)
       do update set embedding = excluded.embedding where memoria_trechos.embedding is null and excluded.embedding is not null
       returning (xmax = 0) as inserido`,
      [e.empresaId ?? null, e.negocioId ?? null, e.origem, e.referencia ?? '', t, hashDoTrecho(t), JSON.stringify(e.metadados ?? {}), v ? literalVetor(v) : null],
    );
    if (r.rows[0]?.inserido === true) inseridos++;
  }
  return { trechos: trechos.length, inseridos, ja_existiam: trechos.length - inseridos, com_embedding: vetores.some((v) => v !== null) };
}

export async function recordar(banco: Consultavel, consulta: string, filtros: FiltrosMemoria = {}, limite = 10, o: OpcoesMemoria = {}): Promise<TrechoRecordado[]> {
  const q = consulta.trim();
  if (!q) throw new Error('consulta vazia');
  const [v] = await tentarEmbutir(resolverProvedor(o), [q], 'consulta');
  const r = await banco.query<TrechoRecordado>(
    `select id, origem, referencia, texto, metadados, criado_em, score
       from memoria_buscar($1::text, $2::vector, $3::uuid, $4::uuid, $5::text, $6::int)`,
    [q, v ? literalVetor(v) : null, filtros.empresaId ?? null, filtros.negocioId ?? null, filtros.origem ?? null, limite],
  );
  return r.rows;
}
