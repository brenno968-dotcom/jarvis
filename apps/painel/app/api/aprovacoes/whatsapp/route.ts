import { NextResponse, type NextRequest } from 'next/server';
import {
  criarCerebroAnthropic,
  criarGravadorBanco,
  criarClienteNexusMcp,
  urlDoMcp,
  destinoDosAvisos,
  enviarDecisoesPendentesAoNexus,
  log,
  marcarWebhookVisto,
  notificadorNexus,
  processarEventoNexus,
  verificarAssinatura,
  type DepsEventoNexus,
} from '@jarvis/core';
import { obterBanco, obterRegras } from '../../../../lib/servidor';

export const dynamic = 'force-dynamic';

/**
 * Webhook chamado pelo Nexus quando o Breno toca num botão, manda "PARA TUDO", conversa ("Jarvis…", item 330)
 * ou pede o teste de aviso (botão "Pedir teste ao Jarvis").
 * Contrato: docs/INTEGRACAO-NEXUS.md. Sem assinatura válida, nada acontece.
 */
export async function POST(req: NextRequest) {
  const corpo = await req.text();
  const assinatura = req.headers.get('x-jarvis-assinatura');
  const verificacao = verificarAssinatura(
    process.env.JARVIS_CORE_NEXUS_WEBHOOK_SEGREDO,
    req.headers.get('x-jarvis-timestamp'),
    corpo,
    assinatura,
  );
  if (verificacao !== 'ok') {
    return NextResponse.json({ ok: false }, { status: verificacao === 'sem_segredo' ? 503 : 401 });
  }
  const banco = obterBanco();
  if (!(await marcarWebhookVisto(banco, assinatura!))) {
    return NextResponse.json({ ok: true, repetido: true });
  }
  let evento: unknown;
  try {
    evento = JSON.parse(corpo);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const regras = obterRegras();
  const resultado = await processarEventoNexus(banco, regras, evento, depsDoPainel(regras.aprovacao.numeros_autorizados));
  // Pedido que nasceu no Nexus (ex.: xavier_lancamento): devolve a decisão assinada; falha fica para o reenvio do worker.
  if (resultado.tipo === 'aprovacao') {
    await enviarDecisoesPendentesAoNexus(banco).catch((e) => log('erro', 'envio da decisão ao Nexus falhou', { erro: String(e) }));
  }
  return NextResponse.json({ ok: true, resultado });
}

/** Chave da IA e caminho dos avisos (opcionais). Modelo da conversa: Haiku por padrão (regra do Breno: sem Sonnet). */
function depsDoPainel(numerosAutorizados: string[]): DepsEventoNexus {
  const chave = process.env.JARVIS_CORE_ANTHROPIC_API_KEY;
  const url = process.env.JARVIS_CORE_NEXUS_AVISOS_URL;
  const segredo = process.env.JARVIS_CORE_NEXUS_WEBHOOK_SEGREDO;
  const destino = destinoDosAvisos(numerosAutorizados);
  const urlMcp = urlDoMcp({ JARVIS_CORE_NEXUS_MCP_URL: process.env.JARVIS_CORE_NEXUS_MCP_URL, JARVIS_CORE_NEXUS_AVISOS_URL: url });
  return {
    cerebro: chave ? criarCerebroAnthropic({ chave, modelo: process.env.JARVIS_MODELO_IA_CONVERSA ?? 'claude-haiku-5-5', gravador: criarGravadorBanco(obterBanco()) }) : null,
    // item 416 (parte 2): a conversa usa as ferramentas do Nexus, assinando com o mesmo segredo dos avisos
    nexus: urlMcp && segredo ? criarClienteNexusMcp({ url: urlMcp, segredo }) : null,
    avisarAgora:
      url && segredo
        ? async (m) => {
            await notificadorNexus(url, segredo, destino)(m);
            return destino;
          }
        : undefined,
  };
}
