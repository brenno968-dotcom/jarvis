// Fase 7: estoque, pedidos, margem real, reposição e frete (lógica; integrações vêm depois).
import type { Banco } from '../banco.ts';
import { emTransacao } from '../banco.ts';
import { registrarAuditoria } from '../auditoria.ts';
import { criarTarefa } from '../fila.ts';
import type { Regras } from '../regras.ts';

export class EstoqueInsuficiente extends Error {
  constructor(public readonly sku: string, public readonly disponivel: number, public readonly pedido: number) {
    super(`estoque insuficiente de ${sku}: ${disponivel} disponível, ${pedido} pedido`);
    this.name = 'EstoqueInsuficiente';
  }
}

export async function registrarEntrada(banco: Banco, negocioId: string, sku: string, quantidade: number, custoUnitario?: number): Promise<void> {
  if (!Number.isInteger(quantidade) || quantidade <= 0) throw new Error('quantidade inválida');
  await emTransacao(banco, async (c) => {
    const r = await c.query<{ id: string }>(
      `insert into estoque (negocio_id, sku, quantidade, custo_unitario_brl) values ($1, $2, $3, $4)
       on conflict (negocio_id, sku) do update set quantidade = estoque.quantidade + excluded.quantidade,
         custo_unitario_brl = coalesce(excluded.custo_unitario_brl, estoque.custo_unitario_brl)
       returning id`,
      [negocioId, sku, quantidade, custoUnitario ?? null],
    );
    await c.query(`insert into movimentos_estoque (estoque_id, tipo, quantidade) values ($1, 'entrada', $2)`, [r.rows[0]!.id, quantidade]);
  });
}

/** Cria o pedido e baixa o estoque de uma vez (tudo ou nada). Mesmo id externo não baixa duas vezes. */
export async function criarPedido(
  banco: Banco,
  p: { negocioId: string; canal: string; idExterno: string; itens: { sku: string; quantidade: number }[]; valorBrl: number },
): Promise<{ pedidoId: string; jaExistia: boolean }> {
  return emTransacao(banco, async (c) => {
    const existe = await c.query<{ id: string }>(`select id from pedidos where negocio_id = $1 and canal = $2 and id_externo = $3`, [
      p.negocioId,
      p.canal,
      p.idExterno,
    ]);
    if (existe.rows[0]) return { pedidoId: existe.rows[0].id, jaExistia: true };
    const ped = await c.query<{ id: string }>(
      `insert into pedidos (negocio_id, canal, id_externo, status, valor_brl, itens) values ($1, $2, $3, 'reservado', $4, $5) returning id`,
      [p.negocioId, p.canal, p.idExterno, p.valorBrl, JSON.stringify(p.itens)],
    );
    const pedidoId = ped.rows[0]!.id;
    // Ordena os SKUs para evitar travamento entre pedidos simultâneos.
    for (const item of [...p.itens].sort((a, b) => a.sku.localeCompare(b.sku))) {
      if (!Number.isInteger(item.quantidade) || item.quantidade <= 0) throw new Error(`quantidade inválida para ${item.sku}`);
      const e = await c.query<{ id: string; quantidade: number }>(
        `select id, quantidade from estoque where negocio_id = $1 and sku = $2 for update`,
        [p.negocioId, item.sku],
      );
      const linha = e.rows[0];
      if (!linha || linha.quantidade < item.quantidade) throw new EstoqueInsuficiente(item.sku, linha?.quantidade ?? 0, item.quantidade);
      await c.query(`update estoque set quantidade = quantidade - $2 where id = $1`, [linha.id, item.quantidade]);
      await c.query(`insert into movimentos_estoque (estoque_id, pedido_id, tipo, quantidade) values ($1, $2, 'saida', $3)`, [
        linha.id,
        pedidoId,
        item.quantidade,
      ]);
    }
    await registrarAuditoria(c, { quem: 'agente:logistica', acao: 'pedido_criado', negocioId: p.negocioId, detalhes: { pedido: pedidoId } });
    return { pedidoId, jaExistia: false };
  });
}

/** Devolução: repõe o estoque do pedido (uma vez só). */
export async function devolverPedido(banco: Banco, pedidoId: string): Promise<boolean> {
  return emTransacao(banco, async (c) => {
    const p = await c.query<{ status: string; negocio_id: string }>(`select status, negocio_id from pedidos where id = $1 for update`, [pedidoId]);
    if (!p.rows[0] || p.rows[0].status === 'devolvido') return false;
    const saidas = await c.query<{ estoque_id: string; quantidade: number }>(
      `select estoque_id, quantidade from movimentos_estoque where pedido_id = $1 and tipo = 'saida'`,
      [pedidoId],
    );
    for (const s of saidas.rows) {
      await c.query(`update estoque set quantidade = quantidade + $2 where id = $1`, [s.estoque_id, s.quantidade]);
      await c.query(`insert into movimentos_estoque (estoque_id, pedido_id, tipo, quantidade) values ($1, $2, 'devolucao', $3)`, [
        s.estoque_id,
        pedidoId,
        s.quantidade,
      ]);
    }
    await c.query(`update pedidos set status = 'devolvido' where id = $1`, [pedidoId]);
    await registrarAuditoria(c, { quem: 'agente:logistica', acao: 'pedido_devolvido', negocioId: p.rows[0].negocio_id, detalhes: { pedido: pedidoId } });
    return true;
  });
}

export interface EntradaMargem {
  preco_brl: number;
  custo_produto_brl: number;
  frete_brl: number;
  embalagem_brl?: number;
  taxa_plataforma_percentual: number;
  imposto_percentual: number;
  /** Chance de devolução (%) e custo de cada devolução (frete de volta, perda). */
  devolucao_percentual?: number;
  custo_devolucao_brl?: number;
}

/** Margem real por venda (seção 11: "custo x retorno" do produto físico). */
export function margemReal(e: EntradaMargem): { margem_brl: number; margem_percentual: number } {
  const taxas = e.preco_brl * ((e.taxa_plataforma_percentual + e.imposto_percentual) / 100);
  const devolucao = ((e.devolucao_percentual ?? 0) / 100) * (e.custo_devolucao_brl ?? 0);
  const margem = e.preco_brl - e.custo_produto_brl - e.frete_brl - (e.embalagem_brl ?? 0) - taxas - devolucao;
  const m = Math.round(margem * 100) / 100;
  return { margem_brl: m, margem_percentual: e.preco_brl > 0 ? Math.round((m / e.preco_brl) * 1000) / 10 : 0 };
}

/** Quanto pedir: cobre o prazo do fornecedor + dias de segurança, descontando o que já tem. */
export function quantoRepor(p: { vendasPorDia: number; prazoFornecedorDias: number; segurancaDias: number; emEstoque: number }): number {
  const necessario = Math.ceil(p.vendasPorDia * (p.prazoFornecedorDias + p.segurancaDias));
  return Math.max(0, necessario - p.emEstoque);
}

/**
 * Sugere reposição: cria tarefa vermelha `comprar_estoque` (sempre com OK do Breno) para SKUs
 * que vão acabar antes do fornecedor entregar. Usa as saídas dos últimos 30 dias.
 */
export async function verificarReposicao(
  banco: Banco,
  regras: Regras,
  negocioId: string,
  o: { prazoFornecedorDias: number; segurancaDias: number },
): Promise<{ sugestoes: { sku: string; quantidade: number }[] }> {
  const r = await banco.query<{ sku: string; quantidade: number; saidas: string; empresa_id: string; custo: string | null }>(
    `select e.sku, e.quantidade, n.empresa_id, e.custo_unitario_brl::text as custo,
            coalesce((select sum(m.quantidade) from movimentos_estoque m
                       where m.estoque_id = e.id and m.tipo = 'saida' and m.criado_em > now() - interval '30 days'), 0)::text as saidas
       from estoque e join negocios n on n.id = e.negocio_id where e.negocio_id = $1`,
    [negocioId],
  );
  const sugestoes: { sku: string; quantidade: number }[] = [];
  const semana = new Date().toISOString().slice(0, 10);
  for (const l of r.rows) {
    const vendasPorDia = Number(l.saidas) / 30;
    if (vendasPorDia <= 0) continue;
    const q = quantoRepor({ vendasPorDia, prazoFornecedorDias: o.prazoFornecedorDias, segurancaDias: o.segurancaDias, emEstoque: l.quantidade });
    if (q <= 0) continue;
    sugestoes.push({ sku: l.sku, quantidade: q });
    const custo = l.custo ? Number(l.custo) * q : null;
    await criarTarefa(
      banco,
      regras,
      {
        empresaId: l.empresa_id,
        negocioId,
        agente: 'fornecedores',
        acao: 'comprar_estoque',
        plataforma: 'fornecedores',
        parametros: { sku: l.sku, quantidade: q },
        idempotencyKey: `repor:${negocioId}:${l.sku}:${semana}`,
        resumo: `Comprar ${q} unidade(s) de ${l.sku}${custo !== null ? ` (cerca de R$ ${custo.toFixed(2)})` : ''}: estoque acaba antes do fornecedor entregar.`,
      },
      'agente:fornecedores',
    );
  }
  return { sugestoes };
}

export interface CotacaoFrete {
  servico: string;
  preco_brl: number;
  prazo_dias: number;
}

/** Ordena as cotações: mais barata primeiro, mas cada dia a mais "custa" `valorDoDia` (padrão R$ 2). */
export function compararFretes(cotacoes: CotacaoFrete[], valorDoDia = 2): (CotacaoFrete & { nota: number })[] {
  return cotacoes
    .filter((c) => c.preco_brl >= 0 && c.prazo_dias > 0)
    .map((c) => ({ ...c, nota: Math.round((c.preco_brl + c.prazo_dias * valorDoDia) * 100) / 100 }))
    .sort((a, b) => a.nota - b.nota || a.prazo_dias - b.prazo_dias);
}
