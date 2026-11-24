// Provedor de embeddings da memória semântica (item 790), atrás de uma interface.
// Implementação: Voyage AI (voyage-3.5, 1024 dimensões). Sem chave, não há provedor: a memória
// grava sem embedding e a busca usa só full-text.
import { requisitarJson } from '../http.ts';
import { redator } from '../redacao.ts';

export const DIMENSAO_EMBEDDING = 1024;

export interface ProvedorEmbeddings {
  readonly modelo: string;
  readonly dimensao: number;
  /** `tipo` ajuda o modelo a separar o que é documento do que é pergunta. */
  embutir(textos: string[], tipo: 'documento' | 'consulta'): Promise<number[][]>;
}

const URL_VOYAGE = 'https://api.voyageai.com/v1/embeddings';
const LOTE_VOYAGE = 64;

export function criarProvedorVoyage(o: { chave: string; modelo?: string; fetchImpl?: typeof fetch }): ProvedorEmbeddings {
  const modelo = o.modelo ?? 'voyage-3.5';
  redator.registrar('VOYAGE_API_KEY', o.chave);
  return {
    modelo,
    dimensao: DIMENSAO_EMBEDDING,
    async embutir(textos, tipo) {
      const saida: number[][] = [];
      for (let i = 0; i < textos.length; i += LOTE_VOYAGE) {
        const lote = textos.slice(i, i + LOTE_VOYAGE);
        const r = await requisitarJson<{ data: { index: number; embedding: number[] }[] }>(URL_VOYAGE, {
          metodo: 'POST',
          token: o.chave,
          fetchImpl: o.fetchImpl,
          corpo: { input: lote, model: modelo, input_type: tipo === 'consulta' ? 'query' : 'document', output_dimension: DIMENSAO_EMBEDDING },
          timeoutMs: 60_000,
        });
        const ordenado = [...r.data].sort((a, b) => a.index - b.index);
        if (ordenado.length !== lote.length || ordenado.some((d) => d.embedding.length !== DIMENSAO_EMBEDDING)) {
          throw new Error('resposta de embeddings inesperada (quantidade ou dimensão)');
        }
        saida.push(...ordenado.map((d) => d.embedding));
      }
      return saida;
    },
  };
}

/** Lê a chave do ambiente (VOYAGE_API_KEY ou JARVIS_CORE_VOYAGE_API_KEY). Sem chave: undefined. */
export function provedorEmbeddingsDoAmbiente(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): ProvedorEmbeddings | undefined {
  const chave = env.VOYAGE_API_KEY || env.JARVIS_CORE_VOYAGE_API_KEY;
  if (!chave) return undefined;
  return criarProvedorVoyage({ chave, fetchImpl });
}
