// Fase 6: avisos de pagamento → venda registrada → "venda feita" para o Breno.
// Normalizadores escritos pela documentação do Asaas e da Hotmart; ⚠️ conferir com eventos reais.
import { z } from 'zod';
import type { Banco } from '../banco.ts';
import { emTransacao } from '../banco.ts';
import { registrarAuditoria } from '../auditoria.ts';
import { enfileirarAviso } from '../avisos.ts';

export interface EventoPagamento {
  origem: 'asaas' | 'hotmart';
  idExterno: string;
  tipo: 'pago' | 'estornado' | 'ignorar';
  valorBrl: number;
  contato?: string;
}

const asaas = z.object({
  event: z.string(),
  payment: z.object({ id: z.string(), value: z.number(), customer: z.string().optional() }),
});

const hotmart = z.object({
  event: z.string(),
  data: z.object({
    purchase: z.object({ transaction: z.string(), price: z.object({ value: z.number() }).optional() }),
    buyer: z.object({ email: z.string().optional() }).optional(),
  }),
});

export function normalizarPagamento(origem: 'asaas' | 'hotmart', corpo: unknown): EventoPagamento {
  if (origem === 'asaas') {
    const e = asaas.parse(corpo);
    const tipo = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(e.event)
      ? 'pago'
      : ['PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_DELETED'].includes(e.event)
        ? 'estornado'
        : 'ignorar';
    return { origem, idExterno: e.payment.id, tipo, valorBrl: e.payment.value, contato: e.payment.customer };
  }
  const e = hotmart.parse(corpo);
  const tipo = ['PURCHASE_APPROVED', 'PURCHASE_COMPLETE'].includes(e.event)
    ? 'pago'
    : ['PURCHASE_REFUNDED', 'PURCHASE_CHARGEBACK', 'PURCHASE_CANCELED'].includes(e.event)
      ? 'estornado'
      : 'ignorar';
  return { origem, idExterno: e.data.purchase.transaction, tipo, valorBrl: e.data.purchase.price?.value ?? 0, contato: e.data.buyer?.email };
}

export type ResultadoPagamento = 'venda_registrada' | 'ja_registrada' | 'estorno_registrado' | 'ignorado';

/** Idempotente por (origem, id externo): o mesmo aviso duas vezes não duplica a venda. */
export async function registrarPagamento(banco: Banco, negocioId: string, ev: EventoPagamento): Promise<ResultadoPagamento> {
  if (ev.tipo === 'ignorar') return 'ignorado';
  return emTransacao(banco, async (c) => {
    if (ev.tipo === 'pago') {
      const r = await c.query(
        `insert into vendas (negocio_id, origem, id_externo, contato, valor_brl, status) values ($1,$2,$3,$4,$5,'paga')
         on conflict (origem, id_externo) do nothing`,
        [negocioId, ev.origem, ev.idExterno, ev.contato ?? null, ev.valorBrl],
      );
      if (!r.rowCount) return 'ja_registrada';
      await c.query(
        `insert into movimentos (negocio_id, tipo, categoria, valor_brl, origem, id_externo) values ($1,'receita','venda',$2,$3,$4)`,
        [negocioId, ev.valorBrl, ev.origem, ev.idExterno],
      );
      const n = await c.query<{ nome: string }>(`select nome from negocios where id = $1`, [negocioId]);
      await enfileirarAviso(c, {
        tipo: 'texto',
        conteudo: { texto: `Venda feita em "${n.rows[0]?.nome ?? negocioId}": R$ ${ev.valorBrl.toFixed(2)} (${ev.origem}). Pagamento confirmado.` },
      });
      await registrarAuditoria(c, { quem: `pagamento:${ev.origem}`, acao: 'venda_registrada', negocioId, detalhes: { id_externo: ev.idExterno, valor: ev.valorBrl } });
      return 'venda_registrada';
    }
    const r = await c.query(
      `update vendas set status = 'estornada', estornado_em = now() where origem = $1 and id_externo = $2 and status = 'paga' returning valor_brl`,
      [ev.origem, ev.idExterno],
    );
    if (!r.rowCount) return 'ignorado';
    await c.query(
      `insert into movimentos (negocio_id, tipo, categoria, valor_brl, origem, id_externo) values ($1,'custo','estorno',$2,$3,$4)`,
      [negocioId, r.rows[0].valor_brl, ev.origem, ev.idExterno],
    );
    await enfileirarAviso(c, { tipo: 'texto', conteudo: { texto: `Estorno de R$ ${Number(r.rows[0].valor_brl).toFixed(2)} (${ev.origem}).` } });
    await registrarAuditoria(c, { quem: `pagamento:${ev.origem}`, acao: 'venda_estornada', negocioId, detalhes: { id_externo: ev.idExterno } });
    return 'estorno_registrado';
  });
}

/** Resultado financeiro do negócio (receitas − custos), para o painel e o Maestro. */
export async function resultadoDoNegocio(banco: Pick<Banco, 'query'>, negocioId: string) {
  const r = await banco.query<{ receitas: string; custos: string; vendas: string }>(
    `select coalesce(sum(valor_brl) filter (where tipo = 'receita'), 0)::text as receitas,
            coalesce(sum(valor_brl) filter (where tipo = 'custo'), 0)::text as custos,
            (select count(*) from vendas where negocio_id = $1 and status = 'paga')::text as vendas
       from movimentos where negocio_id = $1`,
    [negocioId],
  );
  const x = r.rows[0]!;
  return { receitas: Number(x.receitas), custos: Number(x.custos), resultado: Number(x.receitas) - Number(x.custos), vendas: Number(x.vendas) };
}
