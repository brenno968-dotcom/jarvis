import {
  avancarPlanos,
  criarLembretesDeAprovacao,
  devolverTravadasVencidas,
  enviarAvisosPendentes,
  expirarAprovacoesVencidas,
  lerEmergencia,
  log,
  pegarProxima,
  renovarTrava,
  sinalWorker,
} from '@jarvis/core';
import { rodarAgendadas } from './agendadas.ts';
import { testarChavesSeVencido } from './chaves.ts';
import { executarTarefa, type DepsExecutor } from './executor.ts';

export interface OpcoesWorker extends DepsExecutor {
  /** Envia avisos ao Breno (via Nexus). Sem ele, os avisos ficam na fila. */
  notificar?: import('@jarvis/core').Notificador;
  segredoAprovacao?: string;
  /** Liga o teste diário das chaves (desligado nos testes de fila). */
  testarChaves?: boolean;
  /** Liga o orquestrador do Maestro (anda com os planos aprovados). */
  maestro?: boolean;
  /** Liga as rotinas periódicas (orçamento, otimização, métricas, reposição, renovações, relatório). */
  rotinas?: boolean;
  /** Rotinas que dependem de configuração (ex.: renovar o watch do Gmail). */
  extras?: () => Promise<void>;
  intervaloVazioMs?: number;
  heartbeatMs?: number;
}

export type ResultadoCiclo = 'suspenso' | 'vazio' | 'executou';

/** Um ciclo: manutenção, checagem de emergência, pega e executa no máximo uma tarefa. */
export async function ciclo(o: OpcoesWorker): Promise<ResultadoCiclo> {
  const { banco, workerId } = o;
  await devolverTravadasVencidas(banco);
  await expirarAprovacoesVencidas(banco);
  await criarLembretesDeAprovacao(banco, o.regras.aprovacao.lembrete_apos_minutos);
  if (o.notificar) await enviarAvisosPendentes(banco, o.notificar, o.segredoAprovacao);
  if (o.testarChaves) await testarChavesSeVencido(o);
  if (o.maestro) await avancarPlanos(banco, o.regras);
  if (o.rotinas) await rodarAgendadas(banco, o.regras);
  if (o.extras) await o.extras();

  if ((await lerEmergencia(banco)).parado) {
    await sinalWorker(banco, workerId, 'suspenso');
    return 'suspenso';
  }

  const tarefa = await pegarProxima(banco, workerId);
  if (!tarefa) {
    await sinalWorker(banco, workerId, 'ativo');
    return 'vazio';
  }

  await sinalWorker(banco, workerId, 'ativo', tarefa.id);
  const batimento = setInterval(() => {
    renovarTrava(banco, tarefa.id, workerId).catch((e) =>
      log('aviso', 'falha ao renovar trava', { tarefa: tarefa.id, erro: String(e) }),
    );
  }, o.heartbeatMs ?? 60_000);
  try {
    const status = await executarTarefa(o, tarefa);
    log('info', 'tarefa processada', { tarefa: tarefa.id, acao: tarefa.acao, status });
  } finally {
    clearInterval(batimento);
    await sinalWorker(banco, workerId, 'ativo');
  }
  return 'executou';
}

/** Loop principal. Para quando `sinal` for abortado (SIGTERM). Suspenso: fica parado esperando. */
export async function rodar(o: OpcoesWorker, sinal: AbortSignal): Promise<void> {
  const espera = o.intervaloVazioMs ?? 2_000;
  let avisouSuspensao = false;
  while (!sinal.aborted) {
    let r: ResultadoCiclo;
    try {
      r = await ciclo(o);
    } catch (e) {
      log('erro', 'erro no ciclo do worker', { erro: String(e) });
      r = 'vazio';
    }
    if (r === 'suspenso' && !avisouSuspensao) {
      log('aviso', 'emergência ligada: worker suspenso até o Breno retomar');
      avisouSuspensao = true;
    }
    if (r !== 'suspenso') avisouSuspensao = false;
    if (r !== 'executou') await new Promise((res) => setTimeout(res, espera));
  }
  await sinalWorker(o.banco, o.workerId, 'parado').catch(() => {});
}
