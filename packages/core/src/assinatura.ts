import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Assinatura das mensagens entre Jarvis e Nexus (nos dois sentidos).
 * Cabeçalhos: x-jarvis-timestamp (segundos Unix) e x-jarvis-assinatura (hex do HMAC-SHA256 de "timestamp.corpo").
 */
export function assinar(segredo: string, timestamp: number, corpo: string): string {
  return createHmac('sha256', segredo).update(`${timestamp}.${corpo}`).digest('hex');
}

export type ResultadoAssinatura = 'ok' | 'sem_segredo' | 'faltando' | 'fora_da_janela' | 'invalida';

export function verificarAssinatura(
  segredo: string | undefined,
  timestampTexto: string | null,
  corpo: string,
  assinatura: string | null,
  agoraSegundos = Math.floor(Date.now() / 1000),
  janelaSegundos = 300,
): ResultadoAssinatura {
  if (!segredo || segredo.length < 32) return 'sem_segredo';
  if (!timestampTexto || !assinatura) return 'faltando';
  const ts = Number(timestampTexto);
  if (!Number.isInteger(ts) || Math.abs(agoraSegundos - ts) > janelaSegundos) return 'fora_da_janela';
  const esperado = Buffer.from(assinar(segredo, ts, corpo), 'hex');
  const recebido = Buffer.from(assinatura, 'hex');
  if (recebido.length !== esperado.length || !timingSafeEqual(recebido, esperado)) return 'invalida';
  return 'ok';
}

/** Id estável de um webhook já visto (para recusar repetição). */
export function idWebhook(assinatura: string): string {
  return createHash('sha256').update(assinatura).digest('hex');
}
