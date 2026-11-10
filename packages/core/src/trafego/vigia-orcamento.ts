import type { Banco } from '../banco.ts';
import { emTransacao } from '../banco.ts';
import { registrarAuditoria } from '../auditoria.ts';
import { enfileirarAviso } from '../avisos.ts';
import { criarTarefa } from '../fila.ts';
import type { Regras } from '../regras.ts';
import { decidir, situacaoOrcamento, somar, type Metas, type Metricas } from './metricas.ts';

/** Grava (ou atualiza) as métricas de um dia de uma campanha. */
export async function gravarMetricas(banco: Pick<Banco, 'query'>, campanhaId: string, dia: string, m: Metricas): Promise<void> {
  await banco.query(
    `insert into metricas_campanha (campanha_id, dia, gasto_brl, impressoes, cliques, leads, vendas, receita_brl)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (campanha_id, dia) do update set gasto_brl = excluded.gasto_brl, impressoes = excluded.impressoes,
       cliques = excluded.cliques, leads = excluded.leads, vendas = excluded.vendas, receita_brl = excluded.receita_brl,
       atualizado_em = now()`,
    [campanhaId, dia, m.gasto_brl, m.impressoes, m.cliques, m.leads, m.vendas, m.receita_brl],
  );
}

interface LinhaNegocio {
  negocio_id: string;
  empresa_id: string;
  nome: string;
  teto: string | null;
  gasto: string;
}

/**
 * Vigia de orçamento (roda no worker): 80% do teto do mês → aviso (uma vez por mês);
 * teto estourado → tarefas para pausar todas as campanhas ativas do negócio.
 */
export async function vigiarOrcamentos(banco: Banco, regras: Regras, agora = new Date()): Promise<{ alertas: number; pausas: number }> {
  const mes = agora.toISOString().slice(0, 7);
  const r = await banco.query<LinhaNegocio>(
    `select n.id as negocio_id, n.empresa_id, n.nome, n.orcamento->>'teto_mensal_anuncios_brl' as teto,
            coalesce(sum(m.gasto_brl), 0)::text as gasto
       from negocios n
       join campanhas c on c.negocio_id = n.id
       left join metricas_campanha m on m.campanha_id = c.id and to_char(m.dia, 'YYYY-MM') = $1
      group by n.id`,
    [mes],
  );
  let alertas = 0;
  let pausas = 0;
  for (const n of r.rows) {
    const teto = n.teto === null ? regras.orcamento_padrao.teto_mensal_por_negocio_brl : Number(n.teto);
    const gasto = Number(n.gasto);
    const s = situacaoOrcamento(gasto, teto);
    if (s === 'ok') continue;
    const marca = `orcamento_${s}:${mes}`;
    const ja = await banco.query(`select 1 from auditoria where acao = $1 and negocio_id = $2 limit 1`, [marca, n.negocio_id]);
    if (s === 'alerta' && !ja.rowCount) {
      await emTransacao(banco, async (c) => {
        await enfileirarAviso(c, {
          tipo: 'texto',
          conteudo: { texto: `Anúncios de "${n.nome}": R$ ${gasto.toFixed(2)} gastos no mês, ${Math.round((gasto / teto) * 100)}% do teto de R$ ${teto}.` },
        });
        await registrarAuditoria(c, { quem: 'agente:trafego', acao: marca, negocioId: n.negocio_id, detalhes: { gasto, teto } });
      });
      alertas++;
    }
    if (s === 'estourou') {
      const ativas = await banco.query<{ id: string; id_externo: string | null }>(
        `select id, id_externo from campanhas where negocio_id = $1 and status = 'ativa'`,
        [n.negocio_id],
      );
      for (const c of ativas.rows) {
        const t = await criarTarefa(
          banco,
          regras,
          {
            empresaId: n.empresa_id,
            negocioId: n.negocio_id,
            agente: 'trafego',
            acao: 'pausar_campanha',
            plataforma: 'meta',
            parametros: { campanha_id: c.id, id_externo: c.id_externo },
            idempotencyKey: `pausar:${c.id}:${mes}:teto`,
          },
          'agente:trafego',
        );
        if (!t.jaExistia) pausas++;
      }
      if (!ja.rowCount) {
        await emTransacao(banco, async (c) => {
          await enfileirarAviso(c, {
            tipo: 'texto',
            conteudo: { texto: `Teto de anúncios de "${n.nome}" atingido (R$ ${gasto.toFixed(2)} de R$ ${teto}). Campanhas sendo pausadas.` },
          });
          await registrarAuditoria(c, { quem: 'agente:trafego', acao: marca, negocioId: n.negocio_id, detalhes: { gasto, teto } });
        });
      }
    }
  }
  return { alertas, pausas };
}

/** Aplica as regras de otimização nas campanhas ativas (últimos `dias`). */
export async function otimizarCampanhas(
  banco: Banco,
  regras: Regras,
  metasPorNegocio: (negocioId: string) => Promise<Metas | null>,
  dias = 7,
): Promise<{ pausas: number; sugestoes: number }> {
  const camp = await banco.query<{ id: string; negocio_id: string; empresa_id: string; nome: string; id_externo: string | null }>(
    `select c.id, c.negocio_id, n.empresa_id, c.nome, c.id_externo from campanhas c join negocios n on n.id = c.negocio_id
      where c.status = 'ativa'`,
  );
  let pausas = 0;
  let sugestoes = 0;
  for (const c of camp.rows) {
    const metas = await metasPorNegocio(c.negocio_id);
    if (!metas) continue;
    const m = await banco.query<Metricas>(
      `select gasto_brl::float as gasto_brl, impressoes, cliques, leads, vendas, receita_brl::float as receita_brl
         from metricas_campanha where campanha_id = $1 and dia >= current_date - $2::int`,
      [c.id, dias],
    );
    const d = decidir(somar(m.rows), metas);
    if (d.acao === 'pausar') {
      const t = await criarTarefa(
        banco,
        regras,
        {
          empresaId: c.empresa_id,
          negocioId: c.negocio_id,
          agente: 'trafego',
          acao: 'pausar_campanha',
          plataforma: 'meta',
          parametros: { campanha_id: c.id, id_externo: c.id_externo, motivo: d.motivo },
          idempotencyKey: `pausar:${c.id}:${new Date().toISOString().slice(0, 10)}:regra`,
        },
        'agente:trafego',
      );
      if (!t.jaExistia) pausas++;
    } else if (d.acao === 'sugerir_aumento') {
      await enfileirarAviso(banco, { tipo: 'texto', conteudo: { texto: `Campanha "${c.nome}": ${d.motivo}. Aumentar orçamento precisa do seu OK.` } });
      sugestoes++;
    }
  }
  return { pausas, sugestoes };
}
