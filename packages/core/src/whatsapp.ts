import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Banco } from './banco.ts';
import { emTransacao } from './banco.ts';
import { numeroAutorizado, responderAprovacao, type RespostaAprovacao } from './aprovacoes.ts';
import { idWebhook } from './assinatura.ts';
import { registrarAuditoria } from './auditoria.ts';
import { pararTudo } from './emergencia.ts';
import type { Regras } from './regras.ts';
import { responderConversa } from './conversa.ts';
import type { Cerebro } from './maestro/cerebro.ts';
import type { MensagemParaBreno } from './avisos.ts';

/** Eventos que o Nexus manda para o Jarvis (contrato em docs/INTEGRACAO-NEXUS.md). */
export const esquemaEventoNexus = z.discriminatedUnion('tipo', [
  z.object({
    tipo: z.literal('botao'),
    numero: z.string().min(8),
    botao_id: z.string().regex(/^(aprovar|recusar):[A-Za-z0-9_-]{20,}$/),
  }),
  z.object({
    tipo: z.literal('texto'),
    numero: z.string().min(8),
    texto: z.string().max(2000),
  }),
  // item 330: conversa livre do Breno ("Jarvis…") — via número autorizado ou sessão aberta com a senha no Nexus
  z.object({
    tipo: z.literal('conversa'),
    numero: z.string().min(8),
    texto: z.string().min(1).max(2000),
    via: z.enum(['numero', 'senha']),
  }),
  // item 330: botão "Pedir teste ao Jarvis" no Nexus — o Jarvis manda "teste ok" pelo caminho normal dos avisos
  z.object({ tipo: z.literal('teste') }),
]);

export type EventoNexus = z.infer<typeof esquemaEventoNexus>;

export type ResultadoEvento =
  | { tipo: 'aprovacao'; resultado: RespostaAprovacao }
  | { tipo: 'emergencia'; canceladas: number }
  | { tipo: 'conversa'; resposta: string }
  | { tipo: 'teste'; enviado: boolean; numeros: string[]; emails: string[]; erro?: string }
  | { tipo: 'ignorado'; motivo: string };

/** Marca o webhook como visto; devolve false se já tinha sido processado (repetição). */
export async function marcarWebhookVisto(banco: Banco, assinatura: string): Promise<boolean> {
  return emTransacao(banco, async (c) => {
    await c.query(`delete from webhooks_recebidos where recebido_em < now() - interval '1 day'`);
    const r = await c.query(`insert into webhooks_recebidos (id) values ($1) on conflict do nothing`, [idWebhook(assinatura)]);
    return (r.rowCount ?? 0) > 0;
  });
}

/** O que o painel liga (tudo opcional: sem a chave da IA a conversa só entende "status" e "ajuda"). */
export interface DepsEventoNexus {
  cerebro?: Cerebro | null;
  /** manda um aviso direto ao Nexus (o mesmo caminho dos avisos do worker) e diz para quem foi */
  avisarAgora?: (m: MensagemParaBreno) => Promise<{ numeros: string[]; emails: string[] }>;
}

export async function processarEventoNexus(banco: Banco, regras: Regras, bruto: unknown, deps: DepsEventoNexus = {}): Promise<ResultadoEvento> {
  const ev = esquemaEventoNexus.safeParse(bruto);
  if (!ev.success) return { tipo: 'ignorado', motivo: 'evento inválido' };
  const e = ev.data;

  if (e.tipo === 'botao') {
    const [acao, token] = e.botao_id.split(':') as ['aprovar' | 'recusar', string];
    return { tipo: 'aprovacao', resultado: await responderAprovacao(banco, regras, token, acao, e.numero) };
  }

  if (e.tipo === 'conversa') {
    const r = await responderConversa(banco, regras, e, deps.cerebro ?? null);
    return 'resposta' in r ? { tipo: 'conversa', resposta: r.resposta } : { tipo: 'ignorado', motivo: r.ignorado };
  }

  if (e.tipo === 'teste') {
    await registrarAuditoria(banco, { quem: 'nexus', acao: 'teste_aviso_pedido' });
    if (!deps.avisarAgora) return { tipo: 'teste', enviado: false, numeros: [], emails: [], erro: 'o painel do Jarvis não tem JARVIS_CORE_NEXUS_AVISOS_URL configurado' };
    try {
      const para = await deps.avisarAgora({ aviso_id: randomUUID() /* o Nexus só aceita [0-9a-f-] no aviso_id */, tipo: 'texto', texto: 'teste ok — o Jarvis está falando com você pelo Nexus.' });
      return { tipo: 'teste', enviado: true, ...para };
    } catch (err) {
      return { tipo: 'teste', enviado: false, numeros: [], emails: [], erro: err instanceof Error ? err.message : 'erro ao avisar' };
    }
  }

  const comando = regras.emergencia.comando_whatsapp.trim().toUpperCase();
  if (e.texto.trim().toUpperCase() === comando) {
    if (!numeroAutorizado(regras, e.numero)) {
      await registrarAuditoria(banco, { quem: 'whatsapp', acao: 'emergencia_numero_nao_autorizado' });
      return { tipo: 'ignorado', motivo: 'número não autorizado' };
    }
    return { tipo: 'emergencia', canceladas: await pararTudo(banco, 'whatsapp:breno', comando) };
  }
  return { tipo: 'ignorado', motivo: 'texto sem comando' };
}
