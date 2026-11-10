import { hostname } from 'node:os';
import {
  carregarRegras,
  criarBanco,
  log,
  notificadorNexus,
  ProvedorAmbiente,
  CofreBitwarden,
  criarCerebroAnthropic,
  executarSeVencida,
  RegrasInvalidas,
  type Cofre,
  type Notificador,
} from '@jarvis/core';
import { criarAdaptadorMetaAds } from './adaptadores/meta-ads.ts';
import { criarAdaptadorOferta } from './adaptadores/oferta.ts';
import { criarAdaptadorSupabase } from './adaptadores/supabase.ts';
import { criarAbridorBrowserbase } from './navegador/browserbase.ts';
import { criarAdaptadorPorReceita } from './navegador/adaptador-receitas.ts';
import { criarClienteGmail, type ClienteGmail } from './navegador/gmail.ts';
import { adaptadorTeste } from './adaptadores/teste.ts';
import { criarAdaptadorVercel } from './adaptadores/vercel.ts';
import { RegistroAdaptadores } from './registro.ts';
import { rodar } from './worker.ts';

async function principal(): Promise<void> {
  let regras;
  try {
    regras = carregarRegras();
  } catch (e) {
    // Regra da seção 16: regras inválidas (ou CAPTCHA automático ligado) = worker não sobe.
    const msg = e instanceof RegrasInvalidas ? e.message : String(e);
    log('erro', 'worker recusou iniciar: regras inválidas', { problema: msg });
    process.exit(1);
  }

  const banco = criarBanco();
  const workerId = process.env.JARVIS_WORKER_ID || `${hostname()}-${process.pid}`;
  const registro = new RegistroAdaptadores()
    .registrar(adaptadorTeste)
    .registrar(criarAdaptadorVercel())
    .registrar(criarAdaptadorSupabase())
    .registrar(criarAdaptadorMetaAds({ banco }));
  const controle = new AbortController();

  for (const s of ['SIGTERM', 'SIGINT'] as const) {
    process.on(s, () => {
      log('info', `recebido ${s}, encerrando após a tarefa atual`);
      controle.abort();
    });
  }

  const segredos = new ProvedorAmbiente();
  const opcional = (nome: string) => segredos.obter(nome).catch(() => undefined);
  const urlAvisos = process.env.JARVIS_CORE_NEXUS_AVISOS_URL;
  const segredoWebhook = await opcional('JARVIS_CORE_NEXUS_WEBHOOK_SEGREDO');
  const segredoAprovacao = await opcional('JARVIS_CORE_APROVACAO_SEGREDO');
  let notificar: Notificador | undefined;
  if (urlAvisos && segredoWebhook) notificar = notificadorNexus(urlAvisos, segredoWebhook);
  else log('aviso', 'avisos ao Breno desligados (falta JARVIS_CORE_NEXUS_AVISOS_URL ou o segredo do webhook)');

  // Dory: precisa do token da conta de máquina (o mesmo do bws run) e do id da organização.
  let cofre: Cofre | undefined;
  const tokenBws = await opcional('BWS_ACCESS_TOKEN');
  const orgBws = process.env.JARVIS_CORE_BITWARDEN_ORG_ID;
  if (tokenBws && orgBws) cofre = new CofreBitwarden(tokenBws, orgBws);
  else log('aviso', 'Dory desligada neste worker: salvarSegredo vai recusar');

  // Agente de oferta: precisa da chave da IA (sem ela, as etapas de oferta esperam).
  const chaveIa = await opcional('JARVIS_CORE_ANTHROPIC_API_KEY');
  if (chaveIa) registro.registrar(criarAdaptadorOferta({ banco, cerebro: criarCerebroAnthropic({ chave: chaveIa, modelo: process.env.JARVIS_MODELO_IA }) }));

  // Gmail (códigos de verificação) e aviso instantâneo.
  let gmail: ClienteGmail | undefined;
  const gId = await opcional('JARVIS_CORE_GMAIL_CLIENT_ID');
  const gSec = await opcional('JARVIS_CORE_GMAIL_CLIENT_SECRET');
  const gRef = await opcional('JARVIS_CORE_GMAIL_REFRESH_TOKEN');
  if (gId && gSec && gRef) gmail = criarClienteGmail({ clientId: gId, clientSecret: gSec, refreshToken: gRef });
  const topicoGmail = process.env.JARVIS_GMAIL_TOPICO_PUBSUB;

  // Plataformas sem API: uma por receita aprovada pelo Vigia, com navegador na nuvem.
  const bbChave = await opcional('JARVIS_CORE_BROWSERBASE_API_KEY');
  const bbProjeto = process.env.JARVIS_BROWSERBASE_PROJETO;
  if (bbChave && bbProjeto) {
    const abrirSessao = criarAbridorBrowserbase({ chave: bbChave, projeto: bbProjeto });
    const rec = await banco.query<{ plataforma: string; acoes: string[] }>(
      `select plataforma, array_agg(distinct acao) as acoes from receitas where aprovada_pelo_vigia group by plataforma`,
    );
    for (const r of rec.rows) {
      if (registro.obter(r.plataforma)) continue;
      registro.registrar(
        criarAdaptadorPorReceita({
          plataforma: r.plataforma,
          acoes: r.acoes,
          banco,
          abrirSessao,
          deps: {
            gmail,
            metaSegredo: { bitwardenProjeto: process.env.JARVIS_BITWARDEN_PROJETO_PADRAO ?? 'jarvis-core', plataforma: r.plataforma },
          },
        }),
      );
    }
  } else log('aviso', 'navegador na nuvem desligado: plataformas sem API ficam sem adaptador');

  const extras = async () => {
    if (gmail?.renovarWatch && topicoGmail) {
      // Seção 21: renovar diariamente (a assinatura dura no máximo 7 dias e para sem erro).
      await executarSeVencida(banco, 'renovar_watch_gmail', 24 * 60 * 60 * 1000, () => gmail!.renovarWatch!(topicoGmail));
    }
  };

  log('info', 'worker iniciado', { workerId, adaptadores: registro.todos().map((a) => a.plataforma) });
  await rodar(
    { banco, regras, registro, segredos, workerId, notificar, segredoAprovacao, cofre, testarChaves: true, maestro: true, rotinas: true, extras },
    controle.signal,
  );
  await banco.end();
  log('info', 'worker encerrado');
}

principal().catch((e) => {
  log('erro', 'falha fatal no worker', { erro: String(e) });
  process.exit(1);
});
