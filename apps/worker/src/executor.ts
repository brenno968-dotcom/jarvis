import {
  concluir,
  enfileirarAviso,
  lerEfeito,
  log,
  redator,
  registrarAuditoria,
  registrarFalha,
  salvarEfeito,
  salvarSegredoNaDory,
  type Cofre,
  type Banco,
  type ContextoExecucao,
  type ProvedorSegredos,
  type Regras,
  type Resultado,
  type Tarefa,
} from '@jarvis/core';
import type { RegistroAdaptadores } from './registro.ts';

export interface DepsExecutor {
  banco: Banco;
  regras: Regras;
  registro: RegistroAdaptadores;
  segredos: ProvedorSegredos;
  workerId: string;
  /** Dory (Bitwarden). Sem ele, salvarSegredo recusa. */
  cofre?: Cofre;
  /** Só para testes: simula o worker caindo depois do efeito e antes de concluir. */
  aposEfeito?: (t: Tarefa) => Promise<void>;
}

function criarContexto(d: DepsExecutor, t: Tarefa): ContextoExecucao {
  return {
    empresaId: t.empresa_id,
    negocioId: t.negocio_id,
    tarefaId: t.id,
    idempotencyKey: t.idempotency_key,
    obterSegredo: (nome) => d.segredos.obter(nome),
    salvarSegredo: async (nome, valor, meta) => {
      if (!d.cofre) throw new Error('Dory (cofre) não configurada neste worker');
      await salvarSegredoNaDory(d.banco, d.cofre, nome, valor, meta, `worker:${d.workerId}`);
    },
    registrarAuditoria: (acao, detalhes) =>
      registrarAuditoria(d.banco, {
        quem: `worker:${d.workerId}`,
        acao,
        empresaId: t.empresa_id,
        negocioId: t.negocio_id,
        tarefaId: t.id,
        detalhes,
      }),
    pedirHumano: async (motivo, linkAoVivo) => {
      // Seção 20: o Breno recebe o motivo e, se houver, o link do navegador ao vivo.
      await enfileirarAviso(d.banco, {
        tipo: 'pedido_humano',
        tarefaId: t.id,
        conteudo: { texto: `Jarvis precisa de você: ${motivo}`, ...(linkAoVivo ? { link: linkAoVivo } : {}) },
      });
      await registrarAuditoria(d.banco, {
        quem: `worker:${d.workerId}`,
        acao: 'pedido_humano',
        tarefaId: t.id,
        detalhes: { motivo, tem_link: Boolean(linkAoVivo) },
      });
    },
  };
}

/** Executa uma tarefa já travada por este worker. */
export async function executarTarefa(d: DepsExecutor, t: Tarefa): Promise<Tarefa['status']> {
  const adaptador = d.registro.obter(t.plataforma);
  if (!adaptador || !adaptador.acoesSuportadas.includes(t.acao)) {
    return registrarFalha(d.banco, d.regras, t, d.workerId, {
      tipo: 'definitivo',
      codigo: 'SEM_ADAPTADOR',
      mensagem: `nenhum adaptador para ${t.plataforma ?? '(sem plataforma)'}/${t.acao}`,
    });
  }

  // Idempotência (seção 19): se o efeito já aconteceu, devolve o resultado salvo.
  const salvo = await lerEfeito(d.banco, t.idempotency_key);
  if (salvo) {
    log('info', 'efeito já existia, reaproveitando resultado', { tarefa: t.id });
    await concluir(d.banco, t, d.workerId, salvo);
    return 'concluida';
  }

  let resultado: Resultado;
  try {
    resultado = await adaptador.executar(t.acao, t.parametros ?? {}, criarContexto(d, t));
  } catch (e) {
    const msg = redator.redigir((e as Error)?.message ?? String(e));
    log('erro', 'adaptador lançou exceção', { tarefa: t.id, erro: msg });
    return registrarFalha(d.banco, d.regras, t, d.workerId, { tipo: 'temporario', codigo: 'EXCECAO', mensagem: msg });
  }

  if (!resultado.ok) {
    return registrarFalha(
      d.banco,
      d.regras,
      t,
      d.workerId,
      resultado.erro ?? { tipo: 'definitivo', codigo: 'SEM_DETALHE', mensagem: 'adaptador falhou sem detalhar' },
    );
  }

  await salvarEfeito(d.banco, t.idempotency_key, t.id, resultado);
  if (d.aposEfeito) await d.aposEfeito(t);
  await concluir(d.banco, t, d.workerId, resultado);
  return 'concluida';
}
