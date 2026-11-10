import type { Banco, Consultavel } from './banco.ts';
import { emTransacao } from './banco.ts';
import { registrarAuditoria } from './auditoria.ts';
import { criarAprovacao } from './aprovacoes.ts';
import { enfileirarAviso } from './avisos.ts';
import { redator } from './redacao.ts';
import { classificarAcao, esperaParaTentativa, exigeConfirmacaoNoPainel, type Regras } from './regras.ts';
import type { ErroResultado, NovaTarefa, Resultado, Tarefa } from './tipos.ts';

export const DURACAO_TRAVA_MINUTOS = 5;

export interface TarefaCriada {
  tarefa: Tarefa;
  /** Presente só quando a ação é vermelha: token de uso único para os botões do WhatsApp. */
  tokenAprovacao?: string;
  jaExistia: boolean;
}

/**
 * Cria uma tarefa. O nível do semáforo vem SEMPRE das regras, nunca de quem pede.
 * Vermelha → nasce aguardando aprovação, com o pedido de aprovação criado junto.
 * Mesma idempotency_key → devolve a tarefa existente, sem duplicar.
 */
export async function criarTarefa(banco: Banco, regras: Regras, nova: NovaTarefa, quem: string): Promise<TarefaCriada> {
  const nivel = classificarAcao(regras, nova.acao);
  if (nivel === 'vermelho' && !nova.resumo) {
    throw new Error('ação vermelha precisa de um resumo em linguagem simples para a aprovação');
  }
  return emTransacao(banco, async (c) => {
    const ins = await c.query(
      `insert into tarefas (plano_id, etapa_id, empresa_id, negocio_id, agente, acao, plataforma,
                            parametros, idempotency_key, nivel_semaforo, status, max_tentativas)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (idempotency_key) do nothing
       returning *`,
      [
        nova.planoId ?? null,
        nova.etapaId ?? null,
        nova.empresaId,
        nova.negocioId ?? null,
        nova.agente,
        nova.acao,
        nova.plataforma ?? null,
        JSON.stringify(redator.redigirValor(nova.parametros ?? {})),
        nova.idempotencyKey,
        nivel,
        nivel === 'vermelho' ? 'aguardando_aprovacao' : 'pendente',
        nova.maxTentativas ?? regras.tentativas.max_padrao,
      ],
    );
    if (ins.rowCount === 0) {
      const existente = await c.query(`select * from tarefas where idempotency_key = $1`, [nova.idempotencyKey]);
      return { tarefa: existente.rows[0] as Tarefa, jaExistia: true };
    }
    const tarefa = ins.rows[0] as Tarefa;
    let tokenAprovacao: string | undefined;
    if (nivel === 'vermelho') {
      const ap = await criarAprovacao(c, regras, {
        tarefaId: tarefa.id,
        resumo: nova.resumo!,
        exigePainel: exigeConfirmacaoNoPainel(regras, nova.acao, nova.parametros),
      });
      tokenAprovacao = ap.token;
      await enfileirarAviso(c, { tipo: 'pedido_aprovacao', aprovacaoId: ap.id, tarefaId: tarefa.id });
    }
    await registrarAuditoria(c, {
      quem,
      acao: 'tarefa_criada',
      empresaId: tarefa.empresa_id,
      negocioId: tarefa.negocio_id,
      tarefaId: tarefa.id,
      detalhes: { acao: tarefa.acao, plataforma: tarefa.plataforma, nivel },
    });
    return { tarefa, tokenAprovacao, jaExistia: false };
  });
}

/**
 * Pega a próxima tarefa disponível sem que dois workers peguem a mesma (seção 18).
 * Não pega nada se a emergência estiver ligada. Vermelha só com aprovação aprovada.
 */
export async function pegarProxima(banco: Consultavel, workerId: string): Promise<Tarefa | null> {
  const r = await banco.query(
    `update tarefas
        set status = 'executando',
            travada_por = $1,
            travada_ate = now() + make_interval(mins => $2),
            tentativas = tentativas + 1
      where id = (
        select t.id from tarefas t
         where t.status in ('pendente','aprovada')
           and coalesce(t.proxima_tentativa_em, now()) <= now()
           and not coalesce((select (valor->>'parado')::boolean from controle where chave = 'emergencia'), false)
           and (t.nivel_semaforo <> 'vermelho'
                or exists (select 1 from aprovacoes a where a.tarefa_id = t.id and a.status = 'aprovada'))
         order by t.criado_em
         for update skip locked
         limit 1
      )
      returning *`,
    [workerId, DURACAO_TRAVA_MINUTOS],
  );
  return (r.rows[0] as Tarefa | undefined) ?? null;
}

/** Heartbeat: renova a trava enquanto o worker ainda estiver com a tarefa. */
export async function renovarTrava(banco: Consultavel, tarefaId: string, workerId: string): Promise<boolean> {
  const r = await banco.query(
    `update tarefas set travada_ate = now() + make_interval(mins => $3)
      where id = $1 and travada_por = $2 and status = 'executando'`,
    [tarefaId, workerId, DURACAO_TRAVA_MINUTOS],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Devolve para a fila as tarefas cujo worker caiu (trava vencida). */
export async function devolverTravadasVencidas(banco: Consultavel): Promise<number> {
  const r = await banco.query(
    `update tarefas
        set status = case when tentativas >= max_tentativas then 'falhou' else 'pendente' end,
            erro = case when tentativas >= max_tentativas
                        then jsonb_build_object('tipo','definitivo','codigo','TRAVA_VENCIDA','mensagem','worker caiu e as tentativas acabaram')
                        else erro end,
            travada_por = null,
            travada_ate = null
      where status = 'executando' and travada_ate < now()`,
  );
  return r.rowCount ?? 0;
}

/** Só quem está com a trava pode concluir. */
export async function concluir(banco: Banco, tarefa: Tarefa, workerId: string, resultado: Resultado): Promise<boolean> {
  return emTransacao(banco, async (c) => {
    const r = await c.query(
      `update tarefas set status = 'concluida', resultado = $3, erro = null, travada_por = null, travada_ate = null
        where id = $1 and travada_por = $2 and status = 'executando'`,
      [tarefa.id, workerId, JSON.stringify(redator.redigirValor(resultado))],
    );
    if (!r.rowCount) return false;
    await registrarAuditoria(c, {
      quem: `worker:${workerId}`,
      acao: 'tarefa_concluida',
      empresaId: tarefa.empresa_id,
      negocioId: tarefa.negocio_id,
      tarefaId: tarefa.id,
      detalhes: { acao: tarefa.acao, mensagem: resultado.mensagem ?? null, custo_real_brl: resultado.custoRealBrl ?? 0 },
    });
    return true;
  });
}

/** Decide o próximo estado a partir do tipo de erro (seção 15.2). */
export async function registrarFalha(
  banco: Banco,
  regras: Regras,
  tarefa: Tarefa,
  workerId: string,
  erro: ErroResultado,
): Promise<Tarefa['status']> {
  const tentativasAcabaram = tarefa.tentativas >= tarefa.max_tentativas;
  let status: Tarefa['status'];
  let esperaSegundos: number | null = null;
  switch (erro.tipo) {
    case 'temporario':
      if (tentativasAcabaram) {
        status = 'falhou';
      } else {
        status = 'pendente';
        esperaSegundos = erro.tentarNovamenteEmSegundos ?? esperaParaTentativa(regras, tarefa.tentativas);
      }
      break;
    case 'precisa_humano':
      status = 'aguardando_humano';
      break;
    case 'precisa_aprovacao':
      status = 'aguardando_aprovacao';
      break;
    default:
      status = 'falhou';
  }
  const erroSalvo = redator.redigirValor(erro);
  return emTransacao(banco, async (c) => {
    const r = await c.query(
      `update tarefas
          set status = $3, erro = $4, travada_por = null, travada_ate = null,
              proxima_tentativa_em = case when $5::int is null then proxima_tentativa_em
                                          else now() + make_interval(secs => $5::int) end
        where id = $1 and travada_por = $2 and status = 'executando'`,
      [tarefa.id, workerId, status, JSON.stringify(erroSalvo), esperaSegundos],
    );
    if (!r.rowCount) return tarefa.status;
    await registrarAuditoria(c, {
      quem: `worker:${workerId}`,
      acao: status === 'falhou' ? 'tarefa_falhou' : 'tarefa_adiada',
      empresaId: tarefa.empresa_id,
      negocioId: tarefa.negocio_id,
      tarefaId: tarefa.id,
      detalhes: { novo_status: status, erro: erroSalvo, espera_segundos: esperaSegundos },
    });
    return status;
  });
}

export async function buscarTarefa(banco: Consultavel, id: string): Promise<Tarefa | null> {
  const r = await banco.query(`select * from tarefas where id = $1`, [id]);
  return (r.rows[0] as Tarefa | undefined) ?? null;
}
