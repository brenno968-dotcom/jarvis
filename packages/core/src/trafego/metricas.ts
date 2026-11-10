// Fase 5: contas de tráfego e regras de otimização (puras, testáveis sem a Meta).

export interface Metricas {
  gasto_brl: number;
  impressoes: number;
  cliques: number;
  leads: number;
  vendas: number;
  receita_brl: number;
}

export interface Derivadas {
  ctr: number | null; // cliques / impressões
  cpc_brl: number | null;
  cpl_brl: number | null; // custo por lead
  cpa_brl: number | null; // custo por venda
  roas: number | null; // receita / gasto
}

const div = (a: number, b: number, casas = 2) => (b > 0 ? Math.round((a / b) * 10 ** casas) / 10 ** casas : null);

export function derivar(m: Metricas): Derivadas {
  return {
    ctr: div(m.cliques, m.impressoes, 4),
    cpc_brl: div(m.gasto_brl, m.cliques),
    cpl_brl: div(m.gasto_brl, m.leads),
    cpa_brl: div(m.gasto_brl, m.vendas),
    roas: div(m.receita_brl, m.gasto_brl),
  };
}

export function somar(lista: Metricas[]): Metricas {
  return lista.reduce(
    (s, m) => ({
      gasto_brl: Math.round((s.gasto_brl + m.gasto_brl) * 100) / 100,
      impressoes: s.impressoes + m.impressoes,
      cliques: s.cliques + m.cliques,
      leads: s.leads + m.leads,
      vendas: s.vendas + m.vendas,
      receita_brl: Math.round((s.receita_brl + m.receita_brl) * 100) / 100,
    }),
    { gasto_brl: 0, impressoes: 0, cliques: 0, leads: 0, vendas: 0, receita_brl: 0 },
  );
}

export interface Metas {
  /** Preço do produto: base para "gastou X sem vender". */
  preco_brl: number;
  /** Retorno mínimo aceitável (ex.: 1 = empata no anúncio). */
  roas_minimo: number;
  /** Retorno a partir do qual vale sugerir aumento de orçamento. */
  roas_para_escalar: number;
  /** Mínimo de gasto antes de qualquer conclusão (evita decidir com pouco dado). */
  gasto_minimo_brl: number;
}

export type Decisao =
  | { acao: 'esperar'; motivo: string }
  | { acao: 'manter'; motivo: string }
  | { acao: 'pausar'; motivo: string }
  | { acao: 'sugerir_aumento'; motivo: string };

/**
 * Regras de otimização. Pausar é verde (protege o dinheiro); aumentar é SEMPRE só sugestão
 * (aumento de orçamento é vermelho, seção 24 Tráfego).
 */
export function decidir(m: Metricas, metas: Metas): Decisao {
  const d = derivar(m);
  if (m.gasto_brl < metas.gasto_minimo_brl) return { acao: 'esperar', motivo: 'pouco gasto para concluir' };
  if (m.vendas === 0 && m.gasto_brl >= 2 * metas.preco_brl) {
    return { acao: 'pausar', motivo: `gastou R$ ${m.gasto_brl.toFixed(2)} (2× o preço) sem nenhuma venda` };
  }
  if (d.roas !== null && d.roas < metas.roas_minimo && m.vendas > 0) {
    return { acao: 'pausar', motivo: `retorno ${d.roas} abaixo do mínimo ${metas.roas_minimo}` };
  }
  if (d.roas !== null && d.roas >= metas.roas_para_escalar) {
    return { acao: 'sugerir_aumento', motivo: `retorno ${d.roas} acima de ${metas.roas_para_escalar}: vale considerar aumentar` };
  }
  return { acao: 'manter', motivo: 'dentro do esperado' };
}

export type SituacaoOrcamento = 'ok' | 'alerta' | 'estourou';

/** Seção 24: ao atingir 80% do teto, avisar; ao passar do teto, pausar. */
export function situacaoOrcamento(gastoMes: number, tetoMes: number): SituacaoOrcamento {
  if (tetoMes <= 0) return gastoMes > 0 ? 'estourou' : 'ok';
  if (gastoMes >= tetoMes) return 'estourou';
  if (gastoMes >= 0.8 * tetoMes) return 'alerta';
  return 'ok';
}
