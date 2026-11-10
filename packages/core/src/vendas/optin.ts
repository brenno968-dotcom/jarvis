// Fase 6: consentimento (opt-in). Primeiro contato só com prova de que a pessoa pediu (seção 2, regra 7).
import type { Consultavel } from '../banco.ts';
import { registrarAuditoria } from '../auditoria.ts';

export type Canal = 'whatsapp' | 'email';

export function normalizarContato(canal: Canal, contato: string): string {
  if (canal === 'email') {
    const e = contato.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('e-mail inválido');
    return e;
  }
  const d = contato.replace(/\D/g, '');
  const comPais = d.length === 10 || d.length === 11 ? `55${d}` : d;
  if (comPais.length < 12 || comPais.length > 13) throw new Error('telefone inválido');
  return comPais;
}

export async function registrarOptin(
  db: Consultavel,
  p: { negocioId: string; canal: Canal; contato: string; origem: string; textoConsentimento: string },
): Promise<void> {
  if (p.textoConsentimento.trim().length < 10) throw new Error('guarde o texto exato que a pessoa aceitou');
  const contato = normalizarContato(p.canal, p.contato);
  await db.query(
    `insert into contatos_optin (negocio_id, canal, contato, origem, texto_consentimento)
     values ($1, $2, $3, $4, $5)
     on conflict (negocio_id, canal, contato) do update
       set origem = excluded.origem, texto_consentimento = excluded.texto_consentimento,
           consentido_em = now(), revogado_em = null`,
    [p.negocioId, p.canal, contato, p.origem, p.textoConsentimento],
  );
  await registrarAuditoria(db, { quem: 'agente:vendas', acao: 'optin_registrado', negocioId: p.negocioId, detalhes: { canal: p.canal, origem: p.origem } });
}

/** Descadastro vale na hora (seção 24, Vendas). */
export async function revogarOptin(db: Consultavel, negocioId: string, canal: Canal, contato: string): Promise<boolean> {
  const r = await db.query(
    `update contatos_optin set revogado_em = now() where negocio_id = $1 and canal = $2 and contato = $3 and revogado_em is null`,
    [negocioId, canal, normalizarContato(canal, contato)],
  );
  if (r.rowCount) await registrarAuditoria(db, { quem: 'agente:vendas', acao: 'optin_revogado', negocioId, detalhes: { canal } });
  return (r.rowCount ?? 0) > 0;
}

export async function podeContatar(db: Consultavel, negocioId: string, canal: Canal, contato: string): Promise<boolean> {
  let n: string;
  try {
    n = normalizarContato(canal, contato);
  } catch {
    return false;
  }
  const r = await db.query(
    `select 1 from contatos_optin where negocio_id = $1 and canal = $2 and contato = $3 and revogado_em is null`,
    [negocioId, canal, n],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Mensagem que pede para sair da lista (o atendimento deve parar na hora). */
export function ehPedidoDescadastro(texto: string): boolean {
  return /^\s*(sair|parar|pare|stop|remover|descadastr\w*|cancelar(?:\s+inscri[çc][ãa]o)?|n[ãa]o\s+quero\s+(?:mais\s+)?receber)\b/i.test(texto);
}
