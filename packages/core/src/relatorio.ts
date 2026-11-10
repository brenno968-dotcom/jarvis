// Relatório diário no WhatsApp (seções 12.7 e 27) e lembrete de renovação de contas (seção 12.3).
import type { Banco } from './banco.ts';
import { enfileirarAviso } from './avisos.ts';

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export async function montarRelatorioDiario(banco: Banco): Promise<string> {
  const [porStatus, falhas, aprov, vendas, gasto, workers, em] = await Promise.all([
    banco.query<{ status: string; n: number }>(
      `select status, count(*)::int as n from tarefas where atualizado_em > now() - interval '24 hours' group by status order by status`,
    ),
    banco.query<{ acao: string; codigo: string | null }>(
      `select acao, erro->>'codigo' as codigo from tarefas where status in ('falhou','aguardando_humano') and atualizado_em > now() - interval '24 hours' limit 5`,
    ),
    banco.query<{ n: number; velhas: number }>(
      `select count(*)::int as n, count(*) filter (where criado_em < now() - interval '1 hour')::int as velhas from aprovacoes where status = 'pendente'`,
    ),
    banco.query<{ n: number; total: string }>(
      `select count(*)::int as n, coalesce(sum(valor_brl), 0)::text as total from vendas where status = 'paga' and pago_em > now() - interval '24 hours'`,
    ),
    banco.query<{ total: string }>(`select coalesce(sum(gasto_brl), 0)::text as total from metricas_campanha where dia = current_date - 1`),
    banco.query<{ id: string; estado: string; parado: boolean }>(
      `select id, estado, ultimo_sinal < now() - interval '10 minutes' as parado from workers order by ultimo_sinal desc limit 5`,
    ),
    banco.query<{ parado: boolean }>(`select coalesce((valor->>'parado')::boolean, false) as parado from controle where chave = 'emergencia'`),
  ]);
  const linhas = ['Jarvis — resumo das últimas 24 h'];
  if (em.rows[0]?.parado) linhas.push('⚠ EMERGÊNCIA LIGADA: nada está rodando até você retomar.');
  linhas.push(
    `Tarefas: ${porStatus.rows.length ? porStatus.rows.map((r) => `${r.status} ${r.n}`).join(', ') : 'nenhuma movimentação'}.`,
    `Vendas: ${vendas.rows[0]!.n} (${brl(Number(vendas.rows[0]!.total))}). Anúncios ontem: ${brl(Number(gasto.rows[0]!.total))}.`,
    `Aprovações esperando você: ${aprov.rows[0]!.n}${aprov.rows[0]!.velhas ? ` (${aprov.rows[0]!.velhas} há mais de 1 h)` : ''}.`,
  );
  if (falhas.rows.length) linhas.push(`Precisam de atenção: ${falhas.rows.map((f) => `${f.acao}${f.codigo ? ` (${f.codigo})` : ''}`).join('; ')}.`);
  const parados = workers.rows.filter((w) => w.parado);
  linhas.push(workers.rows.length ? (parados.length ? `Workers sem sinal: ${parados.map((w) => w.id).join(', ')}.` : 'Workers: todos com sinal.') : 'Workers: nenhum deu sinal ainda.');
  return linhas.join('\n');
}

export async function enviarRelatorioDiario(banco: Banco): Promise<void> {
  await enfileirarAviso(banco, { tipo: 'texto', conteudo: { texto: await montarRelatorioDiario(banco) } });
}

/** Contas que renovam (ou vencem o plano grátis) nos próximos `dias`: um aviso por conta por data. */
export async function lembrarRenovacoes(banco: Banco, dias = 7): Promise<number> {
  const r = await banco.query<{ id: string; plataforma: string; plano: string | null; renovacao_em: Date }>(
    `select c.id, c.plataforma, c.plano, c.renovacao_em from contas c
      where c.status = 'ativa' and c.renovacao_em between current_date and current_date + $1::int
        and not exists (select 1 from auditoria a where a.acao = 'lembrete_renovacao' and a.detalhes->>'conta' = c.id::text
                          and a.detalhes->>'data' = c.renovacao_em::text)`,
    [dias],
  );
  for (const c of r.rows) {
    const data = c.renovacao_em.toISOString().slice(0, 10);
    await enfileirarAviso(banco, {
      tipo: 'texto',
      conteudo: { texto: `Conta ${c.plataforma} (${c.plano ?? 'plano não informado'}) renova ou vence em ${data.split('-').reverse().join('/')}.` },
    });
    await banco.query(`insert into auditoria (quem, acao, detalhes) values ('jarvis', 'lembrete_renovacao', $1)`, [
      JSON.stringify({ conta: c.id, data }),
    ]);
  }
  return r.rowCount ?? 0;
}
