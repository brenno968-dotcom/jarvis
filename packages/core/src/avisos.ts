import type { Banco, Consultavel } from './banco.ts';
import { tokenDaAprovacao } from './aprovacoes.ts';
import { assinar } from './assinatura.ts';
import { redator } from './redacao.ts';

export type TipoAviso = 'pedido_aprovacao' | 'lembrete_aprovacao' | 'emergencia' | 'pedido_humano' | 'texto';

export async function enfileirarAviso(
  db: Consultavel,
  a: { tipo: TipoAviso; aprovacaoId?: string; tarefaId?: string; conteudo?: Record<string, unknown> },
): Promise<void> {
  await db.query(`insert into avisos (tipo, aprovacao_id, tarefa_id, conteudo) values ($1, $2, $3, $4)`, [
    a.tipo,
    a.aprovacaoId ?? null,
    a.tarefaId ?? null,
    JSON.stringify(redator.redigirValor(a.conteudo ?? {})),
  ]);
}

/** O que vai para o Nexus mandar no WhatsApp do Breno (contrato em docs/INTEGRACAO-NEXUS.md). */
export interface MensagemParaBreno {
  aviso_id: string;
  tipo: TipoAviso;
  texto: string;
  botoes?: { id: string; titulo: string }[];
  link?: string;
}

const hora = (d: Date) =>
  new Intl.DateTimeFormat('pt-BR', { timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(d);

interface LinhaAviso {
  id: string;
  tipo: TipoAviso;
  aprovacao_id: string | null;
  conteudo: Record<string, unknown>;
  tentativas: number;
  resumo: string | null;
  expira_em: Date | null;
  status_aprovacao: string | null;
  exige_painel?: boolean | null;
}

/** Monta a mensagem. Para aprovação, o token é recalculado aqui (não fica guardado). */
export function montarMensagem(a: LinhaAviso, segredoAprovacao: string | undefined): MensagemParaBreno | null {
  switch (a.tipo) {
    case 'pedido_aprovacao':
    case 'lembrete_aprovacao': {
      if (!a.aprovacao_id || !segredoAprovacao || a.status_aprovacao !== 'pendente') return null;
      const token = tokenDaAprovacao(segredoAprovacao, a.aprovacao_id);
      const prefixo = a.tipo === 'lembrete_aprovacao' ? 'Lembrete — ' : '';
      return {
        aviso_id: a.id,
        tipo: a.tipo,
        texto: `${prefixo}Jarvis precisa do seu OK:\n${a.resumo}\n\nVale até ${a.expira_em ? hora(a.expira_em) : '—'}.${
          a.exige_painel ? '\nAção irreversível/de valor alto: depois do "Aprovar", confirme também no painel.' : ''
        }`,
        botoes: [
          { id: `aprovar:${token}`, titulo: 'Aprovar' },
          { id: `recusar:${token}`, titulo: 'Recusar' },
        ],
      };
    }
    default:
      return {
        aviso_id: a.id,
        tipo: a.tipo,
        texto: String(a.conteudo.texto ?? ''),
        ...(a.conteudo.link ? { link: String(a.conteudo.link) } : {}),
      };
  }
}

export type Notificador = (m: MensagemParaBreno) => Promise<void>;

/** Envia os avisos pendentes. Falha = nova tentativa com espera; 5 falhas = falhou. */
export async function enviarAvisosPendentes(
  banco: Banco,
  notificar: Notificador,
  segredoAprovacao: string | undefined,
  limite = 10,
): Promise<{ enviados: number; descartados: number; falhas: number }> {
  const r = await banco.query<LinhaAviso>(
    `select v.id, v.tipo, v.aprovacao_id, v.conteudo, v.tentativas,
            a.resumo, a.expira_em, a.status as status_aprovacao, a.exige_painel
       from avisos v left join aprovacoes a on a.id = v.aprovacao_id
      where v.status = 'pendente' and v.proxima_tentativa_em <= now()
      order by v.criado_em limit $1`,
    [limite],
  );
  const totais = { enviados: 0, descartados: 0, falhas: 0 };
  for (const aviso of r.rows) {
    const msg = montarMensagem(aviso, segredoAprovacao);
    if (!msg) {
      // Aprovação já respondida/expirada, ou sem segredo para gerar o token: não manda.
      await banco.query(
        `update avisos set status = 'falhou', ultimo_erro = $2 where id = $1`,
        [aviso.id, segredoAprovacao ? 'aprovação não está mais pendente' : 'JARVIS_CORE_APROVACAO_SEGREDO ausente'],
      );
      totais.descartados++;
      continue;
    }
    try {
      await notificar(msg);
      await banco.query(`update avisos set status = 'enviado', enviado_em = now(), tentativas = tentativas + 1 where id = $1`, [
        aviso.id,
      ]);
      totais.enviados++;
    } catch (e) {
      const tentativas = aviso.tentativas + 1;
      await banco.query(
        `update avisos set tentativas = $2, ultimo_erro = $3,
                status = case when $2 >= 5 then 'falhou' else 'pendente' end,
                proxima_tentativa_em = now() + make_interval(secs => least(600, 15 * power(2, $2)::int))
          where id = $1`,
        [aviso.id, tentativas, redator.redigir(String((e as Error)?.message ?? e)).slice(0, 500)],
      );
      totais.falhas++;
    }
  }
  return totais;
}

/** Cria um lembrete (uma vez só) para aprovações pendentes há mais de `lembrete_apos_minutos`. */
export async function criarLembretesDeAprovacao(banco: Consultavel, lembreteAposMinutos: number): Promise<number> {
  const r = await banco.query(
    `with alvo as (
       update aprovacoes set lembrete_enviado_em = now()
        where status = 'pendente' and lembrete_enviado_em is null
          and criado_em < now() - make_interval(mins => $1) and expira_em > now()
        returning id, tarefa_id)
     insert into avisos (tipo, aprovacao_id, tarefa_id) select 'lembrete_aprovacao', id, tarefa_id from alvo`,
    [lembreteAposMinutos],
  );
  return r.rowCount ?? 0;
}

/** Notificador HTTP para o Nexus, com assinatura (contrato em docs/INTEGRACAO-NEXUS.md). */
export function notificadorNexus(url: string, segredo: string, fetchImpl: typeof fetch = fetch): Notificador {
  return async (m) => {
    const corpo = JSON.stringify(m);
    const ts = Math.floor(Date.now() / 1000);
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-jarvis-timestamp': String(ts),
        'x-jarvis-assinatura': assinar(segredo, ts, corpo),
      },
      body: corpo,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) throw new Error(`Nexus respondeu ${resp.status}`);
  };
}
