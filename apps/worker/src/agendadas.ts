// Rotinas periódicas do worker (frequências em ROTINAS; cada uma roda em um worker só por janela).
import {
  criarTarefa,
  motivoDeNaoRodar,
  rodarProativo,
  type DepsProativo,
  enviarRelatorioDiario,
  executarSeVencida,
  lembrarRenovacoes,
  otimizarCampanhas,
  verificarReposicao,
  vigiarOrcamentos,
  type Banco,
  type Metas,
  type Regras,
} from '@jarvis/core';

const HORA = 60 * 60 * 1000;

export const ROTINAS = {
  vigiar_orcamentos: HORA,
  otimizar_campanhas: 6 * HORA,
  ler_metricas_meta: 24 * HORA,
  verificar_reposicao: 24 * HORA,
  lembrar_renovacoes: 24 * HORA,
  relatorio_diario: 24 * HORA,
  /** Item 829: intervalo real vem de `regras.proativo.intervalo_h` (este é só o padrão). */
  proativo: 5 * HORA,
} as const;

/** Prazos padrão da reposição (ajustar por fornecedor quando houver o cadastro de fornecedores). */
export const REPOSICAO_PADRAO = { prazoFornecedorDias: 10, segurancaDias: 5 };

/** Metas de tráfego tiradas do plano do negócio (preço) + padrões conservadores. */
export async function metasDoNegocio(banco: Banco, negocioId: string): Promise<Metas | null> {
  const r = await banco.query<{ preco: string | null }>(
    `select conteudo->'viabilidade'->>'preco_venda_brl' as preco from planos
      where negocio_id = $1 and status in ('aprovado','concluido') order by criado_em desc limit 1`,
    [negocioId],
  );
  const preco = Number(r.rows[0]?.preco ?? 0);
  if (!preco) return null;
  return { preco_brl: preco, roas_minimo: 1, roas_para_escalar: 3, gasto_minimo_brl: preco };
}

/** Cria uma tarefa por negócio para ler as métricas de ontem da conta de anúncios do kit. */
export async function agendarLeituraMeta(banco: Banco, regras: Regras, hoje = new Date()): Promise<number> {
  const ontem = new Date(hoje.getTime() - 24 * HORA).toISOString().slice(0, 10);
  const r = await banco.query<{ negocio_id: string; empresa_id: string; conta: string }>(
    `select distinct n.id as negocio_id, n.empresa_id, k.identificador as conta
       from negocios n join campanhas c on c.negocio_id = n.id and c.plataforma = 'meta' and c.status = 'ativa'
       join kit_base k on k.empresa_id = n.empresa_id and k.recurso = 'conta_anuncios' and k.ativo`,
  );
  let n = 0;
  for (const l of r.rows) {
    const t = await criarTarefa(
      banco,
      regras,
      {
        empresaId: l.empresa_id,
        negocioId: l.negocio_id,
        agente: 'trafego',
        acao: 'ler_metricas_campanha',
        plataforma: 'meta',
        parametros: { conta: l.conta, desde: ontem, ate: ontem },
        idempotencyKey: `metricas:${l.negocio_id}:${ontem}`,
      },
      'agente:trafego',
    );
    if (!t.jaExistia) n++;
  }
  return n;
}

export async function rodarAgendadas(banco: Banco, regras: Regras, proativo: DepsProativo = {}): Promise<Record<string, boolean>> {
  const feitas: Record<string, boolean> = {};
  const marca = async (nome: keyof typeof ROTINAS, fn: () => Promise<unknown>, intervaloMs: number = ROTINAS[nome]) => {
    feitas[nome] = (await executarSeVencida(banco, nome, intervaloMs, fn)).executou;
  };
  await marca('vigiar_orcamentos', () => vigiarOrcamentos(banco, regras));
  await marca('otimizar_campanhas', () => otimizarCampanhas(banco, regras, (id) => metasDoNegocio(banco, id)));
  await marca('ler_metricas_meta', () => agendarLeituraMeta(banco, regras));
  await marca('verificar_reposicao', async () => {
    const r = await banco.query<{ id: string }>(`select id from negocios where modelo_negocio = 'fisico_estoque' and status = 'ativo'`);
    let total = 0;
    for (const n of r.rows) total += (await verificarReposicao(banco, regras, n.id, REPOSICAO_PADRAO)).sugestoes.length;
    return { sugestoes: total };
  });
  await marca('lembrar_renovacoes', () => lembrarRenovacoes(banco));
  await marca('relatorio_diario', () => enviarRelatorioDiario(banco));
  // Item 829: desligado, PARA TUDO, silêncio noturno ou teto de custo = nem marca a janela (roda assim que liberar).
  if (!(await motivoDeNaoRodar(banco, regras, proativo.agora))) {
    await marca('proativo', () => rodarProativo(banco, regras, proativo), regras.proativo.intervalo_h * HORA);
  } else {
    feitas.proativo = false;
  }
  return feitas;
}
