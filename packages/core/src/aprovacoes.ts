import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Banco, Consultavel } from './banco.ts';
import { emTransacao } from './banco.ts';
import { registrarAuditoria } from './auditoria.ts';
import type { Regras } from './regras.ts';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Token de uma aprovação. Com o segredo do servidor (JARVIS_CORE_APROVACAO_SEGREDO) o token é
 * derivado do id da aprovação: nunca precisa ser guardado, e o worker o recalcula na hora de enviar.
 * Sem o segredo, o token é aleatório e só pode ser usado na hora (a aprovação ainda funciona pelo painel).
 */
export function tokenDaAprovacao(segredo: string, aprovacaoId: string): string {
  return createHmac('sha256', segredo).update(`aprovacao:${aprovacaoId}`).digest('base64url');
}

export function segredoAprovacao(): string | undefined {
  const s = process.env.JARVIS_CORE_APROVACAO_SEGREDO;
  return s && s.length >= 32 ? s : undefined;
}

/** Cria o pedido de aprovação. Devolve o id e o token em claro (vai só no botão do WhatsApp). */
export async function criarAprovacao(
  db: Consultavel,
  regras: Regras,
  p: { tarefaId?: string; planoId?: string; resumo: string; exigePainel?: boolean },
  segredo: string | undefined = segredoAprovacao(),
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const token = segredo ? tokenDaAprovacao(segredo, id) : randomBytes(24).toString('base64url');
  await db.query(
    `insert into aprovacoes (id, tarefa_id, plano_id, resumo, token_hash, expira_em, exige_painel)
     values ($1, $2, $3, $4, $5, now() + make_interval(mins => $6), $7)`,
    [id, p.tarefaId ?? null, p.planoId ?? null, p.resumo, hashToken(token), regras.aprovacao.expira_em_minutos, Boolean(p.exigePainel)],
  );
  return { id, token };
}

function normalizarNumero(n: string): string {
  return n.replace(/\D/g, '');
}

export function numeroAutorizado(regras: Regras, numero: string): boolean {
  const alvo = Buffer.from(normalizarNumero(numero));
  return regras.aprovacao.numeros_autorizados.some((a) => {
    const b = Buffer.from(normalizarNumero(a));
    return b.length === alvo.length && b.length > 0 && timingSafeEqual(b, alvo);
  });
}

export type RespostaAprovacao =
  | 'aprovada'
  | 'recusada'
  | 'expirada'
  | 'token_invalido'
  | 'ja_respondida'
  | 'numero_nao_autorizado'
  /** Confirmação dupla: o WhatsApp confirmou, falta o painel (ou o contrário). */
  | 'falta_painel'
  | 'falta_whatsapp';

/** Uso único: depois de respondida, o mesmo token não vale mais (seção 22). */
export async function responderAprovacao(
  banco: Banco,
  regras: Regras,
  token: string,
  resposta: 'aprovar' | 'recusar',
  numero: string,
): Promise<RespostaAprovacao> {
  if (!numeroAutorizado(regras, numero)) {
    await registrarAuditoria(banco, { quem: 'whatsapp', acao: 'aprovacao_numero_nao_autorizado', detalhes: {} });
    return 'numero_nao_autorizado';
  }
  return emTransacao(banco, async (c) => {
    const r = await c.query(
      `select id, tarefa_id, plano_id, status, exige_painel, confirmado_whatsapp_em, expira_em < now() as vencida
         from aprovacoes where token_hash = $1 for update`,
      [hashToken(token)],
    );
    const ap = r.rows[0] as
      | { id: string; tarefa_id: string | null; plano_id: string | null; status: string; vencida: boolean; exige_painel: boolean; confirmado_whatsapp_em: Date | null }
      | undefined;
    if (!ap) return 'token_invalido';
    if (ap.status !== 'pendente') return 'ja_respondida';
    if (ap.vencida) {
      await c.query(`update aprovacoes set status = 'expirada', respondido_em = now() where id = $1`, [ap.id]);
      return 'expirada';
    }
    if (ap.exige_painel && resposta === 'aprovar') {
      if (ap.confirmado_whatsapp_em) return 'ja_respondida';
      await c.query(`update aprovacoes set confirmado_whatsapp_em = now() where id = $1`, [ap.id]);
      await registrarAuditoria(c, { quem: 'breno', acao: 'aprovacao_confirmada_whatsapp', tarefaId: ap.tarefa_id });
      return 'falta_painel';
    }
    const novo = resposta === 'aprovar' ? 'aprovada' : 'recusada';
    await c.query(
      `update aprovacoes set status = $2, respondido_por = $3, respondido_em = now() where id = $1`,
      [ap.id, novo, `whatsapp:${normalizarNumero(numero).slice(-4)}`],
    );
    if (ap.tarefa_id) {
      await c.query(
        `update tarefas set status = $2 where id = $1 and status = 'aguardando_aprovacao'`,
        [ap.tarefa_id, novo],
      );
    }
    if (ap.plano_id) {
      await c.query(`update planos set status = $2 where id = $1 and status = 'aguardando_aprovacao'`, [
        ap.plano_id,
        novo === 'aprovada' ? 'aprovado' : 'recusado',
      ]);
    }
    await registrarAuditoria(c, { quem: 'breno', acao: `aprovacao_${novo}`, tarefaId: ap.tarefa_id });
    return novo;
  });
}

/** Expira os pedidos vencidos (rotina periódica do worker). */
export async function expirarAprovacoesVencidas(banco: Consultavel): Promise<number> {
  const r = await banco.query(
    `with exp as (
       update aprovacoes set status = 'expirada', respondido_em = now()
        where status = 'pendente' and expira_em < now()
        returning tarefa_id)
     update tarefas set status = 'recusada',
            erro = jsonb_build_object('tipo','precisa_aprovacao','codigo','APROVACAO_EXPIRADA','mensagem','aprovação não respondida a tempo')
      where id in (select tarefa_id from exp where tarefa_id is not null) and status = 'aguardando_aprovacao'`,
  );
  return r.rowCount ?? 0;
}

/** Resposta pelo painel (login do Breno). Usada também como 2ª confirmação de ações irreversíveis. */
export async function responderAprovacaoPeloPainel(
  banco: Banco,
  aprovacaoId: string,
  resposta: 'aprovar' | 'recusar',
  quem: string,
): Promise<RespostaAprovacao> {
  return emTransacao(banco, async (c) => {
    const r = await c.query(
      `select id, tarefa_id, plano_id, status, exige_painel, confirmado_whatsapp_em, expira_em < now() as vencida
         from aprovacoes where id = $1 for update`,
      [aprovacaoId],
    );
    const ap = r.rows[0] as
      | { id: string; tarefa_id: string | null; plano_id: string | null; status: string; vencida: boolean; exige_painel: boolean; confirmado_whatsapp_em: Date | null }
      | undefined;
    if (!ap) return 'token_invalido';
    if (ap.status !== 'pendente') return 'ja_respondida';
    if (ap.vencida) {
      await c.query(`update aprovacoes set status = 'expirada', respondido_em = now() where id = $1`, [ap.id]);
      return 'expirada';
    }
    if (ap.exige_painel && resposta === 'aprovar' && !ap.confirmado_whatsapp_em) return 'falta_whatsapp';
    const novo = resposta === 'aprovar' ? 'aprovada' : 'recusada';
    await c.query(`update aprovacoes set status = $2, respondido_por = $3, respondido_em = now() where id = $1`, [
      ap.id,
      novo,
      `painel:${quem}`,
    ]);
    if (ap.tarefa_id) {
      await c.query(`update tarefas set status = $2 where id = $1 and status = 'aguardando_aprovacao'`, [ap.tarefa_id, novo]);
    }
    if (ap.plano_id) {
      await c.query(`update planos set status = $2 where id = $1 and status = 'aguardando_aprovacao'`, [
        ap.plano_id,
        novo === 'aprovada' ? 'aprovado' : 'recusado',
      ]);
    }
    await registrarAuditoria(c, { quem: `painel:${quem}`, acao: `aprovacao_${novo}`, tarefaId: ap.tarefa_id });
    return novo;
  });
}
