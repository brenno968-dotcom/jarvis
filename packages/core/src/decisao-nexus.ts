import type { Consultavel } from './banco.ts';
import { assinar } from './assinatura.ts';
import { log } from './log.ts';

/**
 * Jarvis → Nexus: o Breno aprovou ou recusou um pedido que nasceu no Nexus; o Nexus executa o que esperava.
 * Contrato do lado do Nexus: POST <JARVIS_NEXUS_URL>/api/jarvis/decisao, corpo { componente, escopo, decisao },
 * assinado como os avisos (x-jarvis-timestamp + x-jarvis-assinatura = HMAC-SHA256 de "timestamp.corpo" com
 * JARVIS_CORE_NEXUS_WEBHOOK_SEGREDO). Respostas: 200 aplicado; 409 não aplicou (já decidido etc.); 401 assinatura;
 * 400 corpo; 503 Nexus sem Jarvis configurado. Repetir a mesma decisão é seguro.
 */
export type DecisaoNexus = 'aprovado' | 'recusado';

/** Componentes do Nexus que têm executor de decisão (src/lib/maestro/decisao-jarvis.ts do Nexus). */
export const COMPONENTES_COM_DECISAO = ['estruturador', 'renave_cancelamento', 'conversor_carga', 'xavier_lancamento'] as const;

export function componenteTemDecisao(componente: string): boolean {
  return (COMPONENTES_COM_DECISAO as readonly string[]).includes(componente);
}

export interface PayloadDecisao {
  componente: string;
  escopo: string;
  decisao: DecisaoNexus;
}

/** Corpo exato (string) que será assinado e enviado; a assinatura é conferida sobre estes mesmos bytes. */
export function montarCorpoDecisao(p: PayloadDecisao): string {
  return JSON.stringify({ componente: p.componente, escopo: p.escopo, decisao: p.decisao });
}

export function assinarDecisao(segredo: string, corpo: string, timestampSegundos = Math.floor(Date.now() / 1000)): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-jarvis-timestamp': String(timestampSegundos),
    'x-jarvis-assinatura': assinar(segredo, timestampSegundos, corpo),
  };
}

/** Endereço do Nexus: JARVIS_NEXUS_URL, senão a origem de JARVIS_CORE_NEXUS_AVISOS_URL, senão o padrão do painel. */
export function urlDecisaoNexus(env: Record<string, string | undefined> = process.env): string {
  let base = (env.JARVIS_NEXUS_URL ?? '').trim().replace(/\/+$/, '');
  if (!base && env.JARVIS_CORE_NEXUS_AVISOS_URL) {
    try {
      base = new URL(env.JARVIS_CORE_NEXUS_AVISOS_URL).origin;
    } catch {
      base = '';
    }
  }
  return `${base || 'https://nexus-hub.api.br'}/api/jarvis/decisao`;
}

export interface ResultadoEnvioDecisao {
  /** Nexus respondeu de forma definitiva (200 ou 409): não precisa reenviar. */
  entregue: boolean;
  status?: number;
  tentativas: number;
  motivo?: string;
}

export interface OpcoesEnvioDecisao {
  url?: string;
  segredo?: string;
  fetchImpl?: typeof fetch;
  tentativas?: number;
  esperaBaseMs?: number;
  agora?: () => number;
  dormir?: (ms: number) => Promise<void>;
}

/** Envia a decisão com retry simples (rede, 5xx e 429; 400/401/409 são definitivos). Nunca lança; log sem segredo. */
export async function enviarDecisaoAoNexus(p: PayloadDecisao, o: OpcoesEnvioDecisao = {}): Promise<ResultadoEnvioDecisao> {
  const segredo = o.segredo ?? process.env.JARVIS_CORE_NEXUS_WEBHOOK_SEGREDO;
  if (!segredo || segredo.length < 32) {
    log('erro', 'decisão ao Nexus não enviada: JARVIS_CORE_NEXUS_WEBHOOK_SEGREDO ausente ou curto', { componente: p.componente });
    return { entregue: false, tentativas: 0, motivo: 'sem_segredo' };
  }
  const url = o.url ?? urlDecisaoNexus();
  const f = o.fetchImpl ?? fetch;
  const max = o.tentativas ?? 3;
  const espera = o.esperaBaseMs ?? 1000;
  const dormir = o.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const corpo = montarCorpoDecisao(p);
  let motivo = 'erro';
  let status: number | undefined;
  for (let i = 1; i <= max; i++) {
    try {
      const ts = o.agora ? o.agora() : Math.floor(Date.now() / 1000);
      const resp = await f(url, { method: 'POST', headers: assinarDecisao(segredo, corpo, ts), body: corpo, signal: AbortSignal.timeout(15_000) });
      status = resp.status;
      if (resp.ok) return { entregue: true, status, tentativas: i };
      if (resp.status === 409) {
        log('aviso', 'Nexus não aplicou a decisão (já decidida, expirada ou sem executor)', { componente: p.componente, status });
        return { entregue: true, status, tentativas: i, motivo: 'nao_aplicada' };
      }
      motivo = `http_${resp.status}`;
      if (resp.status !== 429 && resp.status < 500) {
        log('erro', 'Nexus recusou a decisão', { componente: p.componente, status });
        return { entregue: false, status, tentativas: i, motivo };
      }
    } catch (e) {
      motivo = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'rede';
    }
    if (i < max) await dormir(espera * 2 ** (i - 1));
  }
  log('erro', 'decisão ao Nexus falhou após as tentativas', { componente: p.componente, tentativas: max, motivo, ...(status ? { status } : {}) });
  return { entregue: false, status, tentativas: max, motivo };
}

export const MAX_TENTATIVAS_DECISAO = 10;

/**
 * Envia ao Nexus as decisões já tomadas (WhatsApp ou painel) que ainda não foram entregues.
 * Chamada logo depois da resposta do Breno e de novo a cada ciclo do worker (reenvio de quem falhou).
 */
export async function enviarDecisoesPendentesAoNexus(
  db: Consultavel,
  o: OpcoesEnvioDecisao = {},
  limite = 10,
): Promise<{ entregues: number; falhas: number }> {
  const r = await db.query(
    `select id, origem_componente, origem_escopo, status from aprovacoes
      where origem_componente is not null and origem_escopo is not null
        and status in ('aprovada','recusada') and decisao_enviada_em is null
        and decisao_tentativas < $2 and respondido_em > now() - interval '7 days'
      order by respondido_em limit $1`,
    [limite, MAX_TENTATIVAS_DECISAO],
  );
  const total = { entregues: 0, falhas: 0 };
  for (const ap of r.rows as { id: string; origem_componente: string; origem_escopo: string; status: string }[]) {
    const res = await enviarDecisaoAoNexus(
      { componente: ap.origem_componente, escopo: ap.origem_escopo, decisao: ap.status === 'aprovada' ? 'aprovado' : 'recusado' },
      o,
    );
    if (res.entregue) {
      await db.query(`update aprovacoes set decisao_enviada_em = now(), decisao_tentativas = decisao_tentativas + $2 where id = $1`, [ap.id, res.tentativas]);
      total.entregues++;
    } else {
      await db.query(`update aprovacoes set decisao_tentativas = decisao_tentativas + $2 where id = $1`, [ap.id, Math.max(res.tentativas, 1)]);
      total.falhas++;
    }
  }
  return total;
}
