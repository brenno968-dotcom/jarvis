import { z } from 'zod';
import type { Banco } from './banco.ts';
import { emTransacao } from './banco.ts';
import { numeroAutorizado, responderAprovacao, type RespostaAprovacao } from './aprovacoes.ts';
import { idWebhook } from './assinatura.ts';
import { registrarAuditoria } from './auditoria.ts';
import { pararTudo } from './emergencia.ts';
import type { Regras } from './regras.ts';

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
]);

export type EventoNexus = z.infer<typeof esquemaEventoNexus>;

export type ResultadoEvento =
  | { tipo: 'aprovacao'; resultado: RespostaAprovacao }
  | { tipo: 'emergencia'; canceladas: number }
  | { tipo: 'ignorado'; motivo: string };

/** Marca o webhook como visto; devolve false se já tinha sido processado (repetição). */
export async function marcarWebhookVisto(banco: Banco, assinatura: string): Promise<boolean> {
  return emTransacao(banco, async (c) => {
    await c.query(`delete from webhooks_recebidos where recebido_em < now() - interval '1 day'`);
    const r = await c.query(`insert into webhooks_recebidos (id) values ($1) on conflict do nothing`, [idWebhook(assinatura)]);
    return (r.rowCount ?? 0) > 0;
  });
}

export async function processarEventoNexus(banco: Banco, regras: Regras, bruto: unknown): Promise<ResultadoEvento> {
  const ev = esquemaEventoNexus.safeParse(bruto);
  if (!ev.success) return { tipo: 'ignorado', motivo: 'evento inválido' };
  const e = ev.data;

  if (e.tipo === 'botao') {
    const [acao, token] = e.botao_id.split(':') as ['aprovar' | 'recusar', string];
    return { tipo: 'aprovacao', resultado: await responderAprovacao(banco, regras, token, acao, e.numero) };
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
