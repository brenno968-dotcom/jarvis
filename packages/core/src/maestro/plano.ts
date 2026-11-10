// Plano do Maestro (seção 15.1), validação e viabilidade (seção 11).
import { z } from 'zod';
import { classificarAcao, type Regras } from '../regras.ts';
import { ROTEIROS, type ModeloNegocio } from './modelos.ts';

const resultadoChecagem = z.enum(['ok', 'reprovado', 'nao_aplicavel', 'pendente_contador', 'pendente_breno']);
export const CHECAGENS = ['politicas_plataforma', 'opt_in_whatsapp', 'lgpd_consumidor', 'fiscal', 'regulacao_produto'] as const;

export const esquemaEtapa = z.object({
  etapa_id: z.string().regex(/^[a-z0-9_]+$/),
  titulo: z.string().min(3),
  agente: z.enum(['maestro', 'jarvis_infra', 'oferta', 'trafego', 'vendas', 'fornecedores', 'logistica', 'fiscal']),
  acao: z.string().regex(/^[a-z0-9_]+$/),
  plataforma: z.string().regex(/^[a-z0-9_]+$/).optional(),
  nivel_semaforo: z.enum(['verde', 'amarelo', 'vermelho']).optional(),
  depende_de: z.array(z.string()).default([]),
  custo_estimado_brl: z.number().nonnegative().default(0),
  parametros: z.record(z.unknown()).default({}),
});

export const esquemaPlano = z.object({
  modelo_negocio: z.enum(['produto_digital', 'fisico_estoque', 'fisico_sem_estoque', 'marketplace', 'servico', 'afiliado']),
  objetivo: z.string().min(10),
  justificativa_modelo: z.string().min(10),
  orcamento: z.object({
    teto_total_brl: z.number().positive(),
    teto_mensal_anuncios_brl: z.number().nonnegative(),
    teto_por_compra_brl: z.number().nonnegative(),
  }),
  viabilidade: z.object({
    custo_fixo_brl: z.number().nonnegative(),
    custo_variavel_unitario_brl: z.number().nonnegative(),
    taxas_percentual: z.number().min(0).max(100).default(0),
    preco_venda_brl: z.number().positive(),
    riscos: z.array(z.string()).default([]),
    checagens: z.object(Object.fromEntries(CHECAGENS.map((c) => [c, resultadoChecagem])) as Record<(typeof CHECAGENS)[number], typeof resultadoChecagem>),
  }),
  etapas: z.array(esquemaEtapa).min(1).max(40),
});

export type PlanoBruto = z.infer<typeof esquemaPlano>;
export type EtapaPlano = z.infer<typeof esquemaEtapa>;

export interface Viabilidade {
  margem_unitaria_brl: number;
  vendas_para_empatar: number | null;
  viavel: boolean;
}

/** Ponto de empate: quantas vendas pagam o custo fixo, descontando custo variável e taxas. */
export function calcularViabilidade(v: PlanoBruto['viabilidade']): Viabilidade {
  const margem = v.preco_venda_brl * (1 - v.taxas_percentual / 100) - v.custo_variavel_unitario_brl;
  const m = Math.round(margem * 100) / 100;
  if (m <= 0) return { margem_unitaria_brl: m, vendas_para_empatar: null, viavel: false };
  return { margem_unitaria_brl: m, vendas_para_empatar: Math.ceil(v.custo_fixo_brl / m), viavel: true };
}

export interface PlanoValidado {
  plano: PlanoBruto & { etapas: (EtapaPlano & { nivel_semaforo: 'verde' | 'amarelo' | 'vermelho' })[] };
  viabilidade: Viabilidade;
  custo_estimado_brl: number;
  bloqueios: string[];
  pendencias: string[];
}

/**
 * Valida o plano: estrutura, dependências (sem ciclo), semáforo recalculado pelas regras,
 * orçamento, viabilidade e checagens. Qualquer item em `bloqueios` impede o plano (seção 11).
 */
export function validarPlano(bruto: unknown, regras: Regras): PlanoValidado {
  const p = esquemaPlano.parse(bruto);
  const bloqueios: string[] = [];
  const pendencias: string[] = [];

  const ids = new Set<string>();
  for (const e of p.etapas) {
    if (ids.has(e.etapa_id)) bloqueios.push(`etapa repetida: ${e.etapa_id}`);
    ids.add(e.etapa_id);
  }
  for (const e of p.etapas) {
    for (const d of e.depende_de) if (!ids.has(d)) bloqueios.push(`etapa ${e.etapa_id} depende de "${d}", que não existe`);
  }
  // Ciclo de dependência
  const estado = new Map<string, 0 | 1 | 2>();
  const porId = new Map(p.etapas.map((e) => [e.etapa_id, e]));
  const visitar = (id: string): boolean => {
    if (estado.get(id) === 1) return true;
    if (estado.get(id) === 2) return false;
    estado.set(id, 1);
    for (const d of porId.get(id)?.depende_de ?? []) if (porId.has(d) && visitar(d)) return true;
    estado.set(id, 2);
    return false;
  };
  if (p.etapas.some((e) => visitar(e.etapa_id))) bloqueios.push('as dependências entre etapas formam um ciclo');

  // O semáforo é das regras, não do plano.
  const etapas = p.etapas.map((e) => ({ ...e, nivel_semaforo: classificarAcao(regras, e.acao) }));

  const custo = Math.round(etapas.reduce((s, e) => s + e.custo_estimado_brl, 0) * 100) / 100;
  if (custo > p.orcamento.teto_total_brl) bloqueios.push(`custo estimado (R$ ${custo}) acima do teto total (R$ ${p.orcamento.teto_total_brl})`);
  for (const e of etapas) {
    if (e.custo_estimado_brl > p.orcamento.teto_por_compra_brl && e.custo_estimado_brl > 0) {
      pendencias.push(`etapa ${e.etapa_id} custa R$ ${e.custo_estimado_brl}, acima do teto por compra: pede OK do Breno`);
    }
  }
  if (p.orcamento.teto_mensal_anuncios_brl > regras.orcamento_padrao.teto_mensal_por_negocio_brl) {
    pendencias.push('teto mensal de anúncios acima do padrão das regras: aumento de orçamento é vermelho');
  }

  const viab = calcularViabilidade(p.viabilidade);
  if (!viab.viavel) bloqueios.push('margem por venda é zero ou negativa: o plano não fecha a conta');

  const roteiro = ROTEIROS[p.modelo_negocio as ModeloNegocio];
  for (const c of CHECAGENS) {
    const r = p.viabilidade.checagens[c];
    if (r === 'reprovado') bloqueios.push(`checagem reprovada: ${c}`);
    if (r.startsWith('pendente')) pendencias.push(`checagem pendente: ${c} (${r})`);
    if (r === 'nao_aplicavel' && roteiro.checagens_obrigatorias.includes(c)) {
      bloqueios.push(`checagem ${c} é obrigatória para ${p.modelo_negocio} e não pode ser "nao_aplicavel"`);
    }
  }
  if (p.etapas.some((e) => e.agente === 'trafego') && p.viabilidade.checagens.opt_in_whatsapp === 'reprovado') {
    bloqueios.push('campanha sem opt-in no WhatsApp');
  }

  return { plano: { ...p, etapas }, viabilidade: viab, custo_estimado_brl: custo, bloqueios, pendencias };
}

/** Resumo em linguagem simples para a aprovação do Breno. */
export function resumoDoPlano(v: PlanoValidado): string {
  const vermelhas = v.plano.etapas.filter((e) => e.nivel_semaforo === 'vermelho').length;
  const empate = v.viabilidade.vendas_para_empatar;
  return [
    `Plano: ${v.plano.objetivo}`,
    `Modelo: ${v.plano.modelo_negocio}. Custo estimado: R$ ${v.custo_estimado_brl.toFixed(2)} (teto R$ ${v.plano.orcamento.teto_total_brl}).`,
    `Preço: R$ ${v.plano.viabilidade.preco_venda_brl}; margem por venda R$ ${v.viabilidade.margem_unitaria_brl.toFixed(2)}; empata com ${empate} venda(s).`,
    `${v.plano.etapas.length} etapas, ${vermelhas} delas pedem seu OK na hora.`,
    ...(v.pendencias.length ? [`Pendências: ${v.pendencias.join('; ')}`] : []),
  ].join('\n');
}
