// Item 829: prompt do agente proativo, saída estruturada (zod) e hash de deduplicação.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { REGRA_DADO_EXTERNO } from '../seguranca/taint.ts';
import type { ConfigProativo } from './config.ts';

export const esquemaProposta = z.object({
  titulo: z.string().trim().min(3).max(120),
  motivo: z.string().trim().min(3).max(500),
  /** Ação/ferramenta (nome do semáforo, ex.: ler_metricas_campanha). Fora do semáforo vira vermelha. */
  acao: z.string().regex(/^[a-z0-9_]+$/).max(80),
  args: z.record(z.unknown()).default({}),
  negocio_id: z.string().uuid().nullish(),
  risco: z.enum(['baixo', 'medio', 'alto']),
  custo_estimado_brl: z.number().min(0).max(1_000_000),
});
export type Proposta = z.infer<typeof esquemaProposta>;

export const esquemaSaida = z.object({ propostas: z.array(z.unknown()).max(50) });

export function promptProativo(cfg: ConfigProativo, acoesConhecidas: string[]): string {
  return [
    'Você é o agente PROATIVO do Jarvis. A cada rodada lê o contexto abaixo e PROPÕE ações úteis ao Breno.',
    'Você só propõe: nada é executado sem o OK dele. Seja específico, curto e útil; sem proposta é uma resposta válida.',
    `Proponha no máximo ${cfg.max_propostas} ações, só as de maior valor. Não repita pendências que já estão em "Aprovações paradas".`,
    `Use em "acao" apenas ações desta lista (qualquer outra exige aprovação reforçada): ${acoesConhecidas.join(', ')}.`,
    'Nunca coloque senha, token ou valor de segredo em "args": só nomes de segredos.',
    REGRA_DADO_EXTERNO,
    'Responda SOMENTE com JSON, sem texto fora dele, neste formato:',
    '{"propostas":[{"titulo":"...","motivo":"...","acao":"nome_da_acao","args":{},"negocio_id":"uuid ou null","risco":"baixo|medio|alto","custo_estimado_brl":0}]}',
  ].join('\n');
}

/** Extrai o primeiro objeto JSON do texto (a IA às vezes cerca com ```json). */
function extrairJson(texto: string): unknown {
  const t = texto.trim();
  const ini = t.indexOf('{');
  const fim = t.lastIndexOf('}');
  if (ini < 0 || fim <= ini) return null;
  try {
    return JSON.parse(t.slice(ini, fim + 1));
  } catch {
    return null;
  }
}

export interface PropostasLidas {
  propostas: Proposta[];
  /** Itens (ou a saída inteira) descartados por formato inválido. */
  descartadas: number;
}

/** Valida a resposta do cérebro. Nunca lança: saída inválida vira lista vazia; item inválido é descartado sozinho. */
export function lerPropostas(texto: string): PropostasLidas {
  const bruto = esquemaSaida.safeParse(extrairJson(texto));
  if (!bruto.success) return { propostas: [], descartadas: 1 };
  const propostas: Proposta[] = [];
  let descartadas = 0;
  for (const item of bruto.data.propostas) {
    const p = esquemaProposta.safeParse(item);
    if (p.success) propostas.push(p.data);
    else descartadas++;
  }
  return { propostas, descartadas };
}

const normalizar = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Hash de deduplicação: título + ação normalizados. */
export function hashProposta(p: Pick<Proposta, 'titulo' | 'acao'>): string {
  return createHash('sha256').update(`${normalizar(p.titulo)}|${p.acao}`).digest('hex').slice(0, 24);
}
