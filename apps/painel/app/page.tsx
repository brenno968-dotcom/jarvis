import { lerEmergencia } from '@jarvis/core';
import { obterBanco } from '../lib/servidor';
import { acionarParaTudo, acionarRetomar, criarTarefaTeste, responder, revisar, sair } from './acoes';

export const dynamic = 'force-dynamic';

interface LinhaTarefa {
  id: string;
  acao: string;
  plataforma: string | null;
  nivel_semaforo: string;
  status: string;
  tentativas: number;
  atualizado_em: Date;
}

interface LinhaAprovacao {
  id: string;
  resumo: string;
  expira_em: Date;
  exige_painel: boolean;
  confirmado_whatsapp_em: Date | null;
}

const hora = (d: Date) =>
  new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'America/Sao_Paulo' }).format(d);

export default async function Painel() {
  const banco = obterBanco();
  const [emergencia, tarefas, aprovacoes, workers, rascunhos] = await Promise.all([
    lerEmergencia(banco),
    banco.query<LinhaTarefa>(
      `select id, acao, plataforma, nivel_semaforo, status, tentativas, atualizado_em
         from tarefas order by criado_em desc limit 50`,
    ),
    banco.query<LinhaAprovacao>(
      `select id, resumo, expira_em, exige_painel, confirmado_whatsapp_em from aprovacoes where status = 'pendente' order by criado_em`,
    ),
    banco.query<{ id: string; estado: string; ultimo_sinal: Date }>(
      `select id, estado, ultimo_sinal from workers order by ultimo_sinal desc limit 10`,
    ),
    banco.query<{ id: string; tipo: string; titulo: string; versao: number; problemas: { gravidade: string; trecho: string; motivo: string }[] }>(
      `select id, tipo, titulo, versao, problemas from rascunhos where status = 'rascunho' order by criado_em limit 20`,
    ),
  ]);

  return (
    <main>
      <div className="topo">
        <h1>Jarvis</h1>
        <a href="/negocios" style={{ color: 'var(--tinta)' }}>
          Negócios →
        </a>
        <form action={sair}>
          <button type="submit">Sair</button>
        </form>
      </div>

      <h2>Emergência</h2>
      <div className="cartao emergencia">
        <span className={`estado ${emergencia.parado ? 'parado' : 'ativo'}`}>
          {emergencia.parado ? `PARADO — ${emergencia.motivo ?? ''}` : 'Funcionando'}
        </span>
        {emergencia.parado ? (
          <form action={acionarRetomar}>
            <button type="submit">Retomar</button>
          </form>
        ) : (
          <form action={acionarParaTudo}>
            <button type="submit" className="perigo">
              PARA TUDO
            </button>
          </form>
        )}
      </div>

      <h2>Aprovações pendentes</h2>
      <div className="cartao">
        {aprovacoes.rows.length === 0 ? (
          <span className="vazio">Nada esperando aprovação.</span>
        ) : (
          aprovacoes.rows.map((a) => (
            <form key={a.id} action={responder} className="linha" style={{ marginBottom: 8 }}>
              <input type="hidden" name="id" value={a.id} />
              <span style={{ flex: 1 }}>
                {a.resumo} <span className="vazio">(vence {hora(a.expira_em)})</span>
                {a.exige_painel && (
                  <span style={{ color: 'var(--amarelo)' }}>
                    {' '}
                    — confirmação dupla: {a.confirmado_whatsapp_em ? 'WhatsApp ok, falta confirmar aqui' : 'aprove primeiro no WhatsApp'}
                  </span>
                )}
              </span>
              <button type="submit" name="resposta" value="aprovar">
                Aprovar
              </button>
              <button type="submit" name="resposta" value="recusar" className="perigo">
                Recusar
              </button>
            </form>
          ))
        )}
      </div>

      <h2>Rascunhos para revisar</h2>
      <div className="cartao">
        {rascunhos.rows.length === 0 ? (
          <span className="vazio">Nenhum rascunho esperando revisão.</span>
        ) : (
          rascunhos.rows.map((r) => {
            const bloqueado = r.problemas.some((p) => p.gravidade === 'bloqueio');
            return (
              <form key={r.id} action={revisar} className="linha" style={{ marginBottom: 8 }}>
                <input type="hidden" name="id" value={r.id} />
                <span style={{ flex: 1 }}>
                  {r.titulo} <span className="vazio">({r.tipo} v{r.versao})</span>
                  {r.problemas.length > 0 && (
                    <span style={{ color: bloqueado ? 'var(--vermelho)' : 'var(--amarelo)' }}>
                      {' '}
                      — {r.problemas.map((p) => `${p.motivo}: "${p.trecho}"`).join('; ')}
                    </span>
                  )}
                </span>
                {!bloqueado && (
                  <button type="submit" name="decisao" value="aprovar">
                    Aprovar
                  </button>
                )}
                <button type="submit" name="decisao" value="recusar" className="perigo">
                  Recusar
                </button>
              </form>
            );
          })
        )}
      </div>

      <h2>Tarefa de teste</h2>
      <form action={criarTarefaTeste} className="cartao linha">
        <input name="texto" placeholder="texto para o eco" maxLength={200} style={{ flex: 1 }} />
        <button type="submit">Criar tarefa</button>
      </form>

      <h2>Workers</h2>
      <div className="cartao tabela">
        {workers.rows.length === 0 ? (
          <span className="vazio">Nenhum worker deu sinal ainda.</span>
        ) : (
          <table>
            <tbody>
              {workers.rows.map((w) => (
                <tr key={w.id}>
                  <td>{w.id}</td>
                  <td>{w.estado}</td>
                  <td>{hora(w.ultimo_sinal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Últimas tarefas</h2>
      <div className="cartao tabela">
        <table>
          <thead>
            <tr>
              <th>Ação</th>
              <th>Plataforma</th>
              <th>Nível</th>
              <th>Status</th>
              <th>Tent.</th>
              <th>Atualizada</th>
            </tr>
          </thead>
          <tbody>
            {tarefas.rows.map((t) => (
              <tr key={t.id}>
                <td>{t.acao}</td>
                <td>{t.plataforma ?? '—'}</td>
                <td className={`nivel-${t.nivel_semaforo}`}>{t.nivel_semaforo}</td>
                <td>{t.status}</td>
                <td>{t.tentativas}</td>
                <td>{hora(t.atualizado_em)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {tarefas.rows.length === 0 && <p className="vazio">Nenhuma tarefa ainda.</p>}
      </div>
    </main>
  );
}
