// Memória semântica de longo prazo (item 790): lembrar = chunk + embedding + insert idempotente;
// recordar = busca híbrida (vetor + full-text, RRF) pela função SQL memoria_buscar.
import { createHash } from 'node:crypto';
import type { Consultavel } from '../banco.ts';
import { dividirEmTrechos, type OpcoesChunker } from './chunker.ts';
import { provedorEmbeddingsDoAmbiente, type ProvedorEmbeddings } from './embeddings.ts';
import { escanearInjecao } from '../seguranca/injecao.ts';
import { marcarTaint, type AoDetectarInjecao, type OrigemConteudo } from '../seguranca/taint.ts';
import { redator } from '../redacao.ts';

export const ORIGENS_MEMORIA = ['conversa', 'documento', 'gmail', 'tarefa', 'plano', 'outro'] as const;
export type OrigemMemoria = (typeof ORIGENS_MEMORIA)[number];

export interface EntradaMemoria {
  texto: string;
  origem: OrigemMemoria;
  referencia?: string;
  empresaId?: string | null;
  negocioId?: string | null;
  metadados?: Record<string, unknown>;
  /** Origem do conteúdo para o taint (item 815). Padrão: gmail/documento = externo; o resto = sistema. */
  origemTaint?: OrigemConteudo;
}

export interface OpcoesMemoria {
  /** Item 815: auditoria de cada detecção de injeção ao gravar/recuperar (sem o texto inteiro). */
  aoDetectar?: AoDetectarInjecao;
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

/** Origens cujo conteúdo vem de fora (e-mail, documento recebido). */
const ORIGENS_EXTERNAS: readonly OrigemMemoria[] = ['gmail', 'documento'];

async function detectar(o: OpcoesMemoria, fonte: string, origem: OrigemConteudo, r: ReturnType<typeof escanearInjecao>): Promise<void> {
  if (r.nivel === 'limpo' || !o.aoDetectar) return;
  try {
    await o.aoDetectar({ fonte, origem, nivel: r.nivel, motivos: r.motivos, trechos: r.achados.slice(0, 3).map((a) => redator.redigir(a.trecho).slice(0, 120)), desfecho: 'detectado' });
  } catch {
    /* auditoria não derruba a memória */
  }
}

export async function lembrar(banco: Consultavel, e: EntradaMemoria, o: OpcoesMemoria = {}): Promise<ResultadoLembrar> {
  // item 815: marca o taint nos metadados e grava o texto neutralizado (conteúdo útil preservado)
  const origemTaint = e.origemTaint ?? (ORIGENS_EXTERNAS.includes(e.origem) ? 'externo' : 'sistema');
  const marca = marcarTaint(e.texto, origemTaint);
  await detectar(o, `memoria:gravar:${e.origem}`, origemTaint, marca.resultado);
  e = { ...e, texto: marca.resultado.texto, metadados: { ...e.metadados, taint: marca.taint } };
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
  // item 815: memória recuperada é dado, não ordem: reescaneia (a memória pode ser anterior ao scanner ou ter sido
  // contaminada), neutraliza e herda o pior nível entre o que foi gravado e o que o scanner vê agora.
  const saida: TrechoRecordado[] = [];
  for (const t of r.rows) {
    const novo = escanearInjecao(t.texto);
    const antigo = (t.metadados?.taint ?? {}) as { origem?: OrigemConteudo; nivel?: 'limpo' | 'suspeito' | 'malicioso'; motivos?: string[] };
    const nivel = antigo.nivel === 'malicioso' || novo.nivel === 'malicioso' ? 'malicioso' : antigo.nivel === 'suspeito' || novo.nivel === 'suspeito' ? 'suspeito' : 'limpo';
    const motivos = [...new Set([...(antigo.motivos ?? []), ...novo.motivos])];
    await detectar(o, `memoria:recordar:${t.origem}`, 'externo', { ...novo, nivel, motivos });
    saida.push({ ...t, texto: novo.texto, metadados: { ...t.metadados, taint: { origem: antigo.origem ?? 'externo', nivel, motivos } } });
  }
  return saida;
}
