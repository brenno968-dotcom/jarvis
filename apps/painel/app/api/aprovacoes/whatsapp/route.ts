import { NextResponse, type NextRequest } from 'next/server';
import {
  criarCerebroAnthropic,
  criarGravadorBanco,
  criarClienteNexusMcp,
  criarGanchoConversaFatos,
  criarProvedorMcp,
  type ProvedorMcp,
  urlDoMcp,
  destinoDosAvisos,
  enviarDecisoesPendentesAoNexus,
  log,
  auditoriaDeInjecao,
  marcarWebhookVisto,
  notificadorNexus,
  processarEventoNexus,
  verificarAssinatura,
  type DepsEventoNexus,
  type Regras,
} from '@jarvis/core';
import { obterBanco, obterRegras } from '../../../../lib/servidor';

export const dynamic = 'force-dynamic';

/** Item 793: ponte MCP com cache por processo (60 s). Sem config/URL/servidor, segue sem MCP. */
let provedorMcp: ProvedorMcp | null = null;
function mcpDoPainel(): ProvedorMcp {
  provedorMcp ??= criarProvedorMcp({ db: obterBanco(), regras: obterRegras() });
  return provedorMcp;
}

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
  const resultado = await processarEventoNexus(banco, regras, evento, depsDoPainel(regras));
  // Pedido que nasceu no Nexus (ex.: xavier_lancamento): devolve a decisão assinada; falha fica para o reenvio do worker.
  if (resultado.tipo === 'aprovacao') {
    await enviarDecisoesPendentesAoNexus(banco).catch((e) => log('erro', 'envio da decisão ao Nexus falhou', { erro: String(e) }));
  }
  return NextResponse.json({ ok: true, resultado });
}

/** Chave da IA e caminho dos avisos (opcionais). Modelo da conversa: pela escada (finalidade conversa = Haiku); JARVIS_MODELO_IA_CONVERSA fixa um modelo (override). */
function depsDoPainel(regras: Regras): DepsEventoNexus {
  const numerosAutorizados = regras.aprovacao.numeros_autorizados;
  const chave = process.env.JARVIS_CORE_ANTHROPIC_API_KEY;
  const url = process.env.JARVIS_CORE_NEXUS_AVISOS_URL;
  const segredo = process.env.JARVIS_CORE_NEXUS_WEBHOOK_SEGREDO;
  const destino = destinoDosAvisos(numerosAutorizados);
  const urlMcp = urlDoMcp({ JARVIS_CORE_NEXUS_MCP_URL: process.env.JARVIS_CORE_NEXUS_MCP_URL, JARVIS_CORE_NEXUS_AVISOS_URL: url });
  const cerebro = chave ? criarCerebroAnthropic({ chave, modelo: process.env.JARVIS_MODELO_IA_CONVERSA, escada: regras.modelos, loopGuard: regras.loop_guard, gravador: criarGravadorBanco(obterBanco()) }) : null;
  return {
    cerebro,
    // item 845: fatos duráveis da conversa, em segundo plano (a escada manda a finalidade `fatos` para o Haiku)
    fatos: cerebro && regras.fatos.ligado ? criarGanchoConversaFatos({ banco: obterBanco(), cerebro, config: regras.fatos, aoDetectar: auditoriaDeInjecao(obterBanco(), 'fatos') }) : null,
    // item 416 (parte 2): a conversa usa as ferramentas do Nexus, assinando com o mesmo segredo dos avisos
    nexus: urlMcp && segredo ? criarClienteNexusMcp({ url: urlMcp, segredo }) : null,
    // item 793: tools do OpenJarvis (e outros servidores MCP da config); amarelo/vermelho viram pedido de aprovação
    mcp: chave ? mcpDoPainel() : null,
    avisarAgora:
      url && segredo
        ? async (m) => {
            await notificadorNexus(url, segredo, destino)(m);
            return destino;
          }
        : undefined,
  };
}
