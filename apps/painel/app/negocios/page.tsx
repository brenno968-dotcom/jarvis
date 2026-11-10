import { resultadoDoNegocio } from '@jarvis/core';
import { obterBanco } from '../../lib/servidor';

export const dynamic = 'force-dynamic';

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

interface LinhaNegocio {
  id: string;
  nome: string;
  modelo_negocio: string;
  status: string;
  plano_status: string | null;
  etapas_total: number;
  etapas_feitas: number;
  gasto_mes: string;
  campanhas_ativas: number;
  estoque_baixo: number;
  optins: number;
}

export default async function Negocios() {
  const banco = obterBanco();
  const r = await banco.query<LinhaNegocio>(
    `select n.id, n.nome, n.modelo_negocio, n.status,
            (select p.status from planos p where p.negocio_id = n.id order by p.criado_em desc limit 1) as plano_status,
            (select coalesce(jsonb_array_length(p.conteudo->'etapas'), 0) from planos p where p.negocio_id = n.id order by p.criado_em desc limit 1)::int as etapas_total,
            (select count(*) from tarefas t where t.negocio_id = n.id and t.plano_id is not null and t.status = 'concluida')::int as etapas_feitas,
            (select coalesce(sum(m.gasto_brl), 0) from metricas_campanha m join campanhas c on c.id = m.campanha_id
              where c.negocio_id = n.id and date_trunc('month', m.dia) = date_trunc('month', current_date))::text as gasto_mes,
            (select count(*) from campanhas c where c.negocio_id = n.id and c.status = 'ativa')::int as campanhas_ativas,
            (select count(*) from estoque e where e.negocio_id = n.id and e.quantidade <= 3)::int as estoque_baixo,
            (select count(*) from contatos_optin o where o.negocio_id = n.id and o.revogado_em is null)::int as optins
       from negocios n order by n.criado_em desc limit 50`,
  );
  const resultados = await Promise.all(r.rows.map((n) => resultadoDoNegocio(banco, n.id)));

  return (
    <main>
      <div className="topo">
        <h1>Negócios</h1>
        <a href="/" style={{ color: 'var(--tinta)' }}>
          ← Painel
        </a>
      </div>
      {r.rows.length === 0 ? (
        <p className="vazio">Nenhum negócio ainda. Peça um plano ao Maestro.</p>
      ) : (
        <div className="cartao tabela" style={{ marginTop: 20 }}>
          <table>
            <thead>
              <tr>
                <th>Negócio</th>
                <th>Modelo</th>
                <th>Status</th>
                <th>Plano</th>
                <th>Etapas</th>
                <th>Vendas</th>
                <th>Receitas</th>
                <th>Custos</th>
                <th>Resultado</th>
                <th>Anúncios (mês)</th>
                <th>Opt-ins</th>
                <th>Estoque baixo</th>
              </tr>
            </thead>
            <tbody>
              {r.rows.map((n, i) => {
                const res = resultados[i]!;
                return (
                  <tr key={n.id}>
                    <td>{n.nome}</td>
                    <td>{n.modelo_negocio}</td>
                    <td>{n.status}</td>
                    <td>{n.plano_status ?? '—'}</td>
                    <td>
                      {n.etapas_feitas}/{n.etapas_total ?? 0}
                    </td>
                    <td>{res.vendas}</td>
                    <td>{brl(res.receitas)}</td>
                    <td>{brl(res.custos)}</td>
                    <td style={{ color: res.resultado < 0 ? 'var(--vermelho)' : 'var(--verde)' }}>{brl(res.resultado)}</td>
                    <td>
                      {brl(Number(n.gasto_mes))} ({n.campanhas_ativas} ativa{n.campanhas_ativas === 1 ? '' : 's'})
                    </td>
                    <td>{n.optins}</td>
                    <td style={{ color: n.estoque_baixo ? 'var(--amarelo)' : undefined }}>{n.estoque_baixo || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
