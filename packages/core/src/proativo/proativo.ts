// Item 829: agente PROATIVO. A cada `intervalo_h` junta contexto (coletor), pede ao cérebro propostas de ação e cria
// cada uma como tarefa PENDENTE DE APROVAÇÃO (fluxo real: semáforo + aprovações), com um único aviso-resumo ao Breno.
// Nunca executa nada: o OK do Breno (painel/WhatsApp) é o único caminho para a tarefa rodar.
import type { Banco } from '../banco.ts';
import { registrarAuditoria } from '../auditoria.ts';
import { enfileirarAviso } from '../avisos.ts';
import { lerEmergencia } from '../emergencia.ts';
import { criarTarefa } from '../fila.ts';
import { log } from '../log.ts';
import type { Cerebro } from '../maestro/cerebro.ts';
import { temChaveSuspeita } from '../mcp.ts';
import { classificarAcao, type Regras } from '../regras.ts';
import { neutralizarTexto } from '../seguranca/injecao.ts';
import { auditoriaDeInjecao, toolSensivelPeloNome, type AoDetectarInjecao } from '../seguranca/taint.ts';
import { hashProposta, lerPropostas, promptProativo, type Proposta } from './agente.ts';
import { coletarContexto, type OpcoesColeta } from './coletor.ts';
import { emSilencio, FINALIDADE_PROATIVO } from './config.ts';

export type MotivoNaoRodou = 'desligado' | 'emergencia' | 'silencio' | 'orcamento' | 'sem_cerebro';

export interface DepsProativo {
  cerebro?: Cerebro;
  agora?: Date;
  aoDetectar?: AoDetectarInjecao;
  recordarMemoria?: OpcoesColeta['recordarMemoria'];
}

export interface ResultadoProativo {
  rodou: boolean;
  motivo?: MotivoNaoRodou;
  /** Propostas viradas em tarefa pendente de aprovação. */
  criadas: { tarefaId: string; titulo: string; acao: string }[];
  /** Propostas descartadas, por motivo (formato, injecao, orcamento, segredo, duplicada, limite). */
  descartadas: Record<string, number>;
  avisou: boolean;
}

export const DIA_MS = 24 * 60 * 60 * 1000;

/** Quando a rodada não pode acontecer (e nem deve marcar a janela da rotina como feita). Nulo = pode rodar. */
export async function motivoDeNaoRodar(banco: Banco, regras: Regras, agora: Date = new Date()): Promise<MotivoNaoRodou | null> {
  const cfg = regras.proativo;
  if (!cfg.ligado) return 'desligado';
  if ((await lerEmergencia(banco)).parado) return 'emergencia';
  if (emSilencio(cfg, agora)) return 'silencio';
  const r = await banco.query<{ custo: string }>(
    `select coalesce(sum(custo_brl), 0) as custo from llm_chamadas where finalidade = $1 and criado_em >= date_trunc('month', now())`,
    [FINALIDADE_PROATIVO],
  );
  if (Number(r.rows[0]?.custo ?? 0) >= cfg.teto_custo_mensal_brl) return 'orcamento';
  return null;
}

const real = (n: number) => `R$ ${n.toFixed(2).replace('.', ',')}`;

async function jaProposta(banco: Banco, empresaId: string, hash: string, dias: number): Promise<boolean> {
  const r = await banco.query(
    `select 1 from tarefas
      where idempotency_key like $1
        and (status in ('aguardando_aprovacao','pendente','aprovada','executando')
             or criado_em > now() - make_interval(days => $2))
      limit 1`,
    [`proativo:${empresaId}:${hash}:%`, dias],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function rodarProativo(banco: Banco, regras: Regras, deps: DepsProativo = {}): Promise<ResultadoProativo> {
  const agora = deps.agora ?? new Date();
  const cfg = regras.proativo;
  const vazio = (motivo: MotivoNaoRodou): ResultadoProativo => ({ rodou: false, motivo, criadas: [], descartadas: {}, avisou: false });
  const impedimento = await motivoDeNaoRodar(banco, regras, agora);
  if (impedimento) return vazio(impedimento);
  if (!deps.cerebro) return vazio('sem_cerebro');

  const aoDetectar = deps.aoDetectar ?? auditoriaDeInjecao(banco, 'proativo');
  const acoesConhecidas = [...regras.semaforo.verde, ...regras.semaforo.amarelo].filter((a) => !a.startsWith('mcp_'));
  const sistema = promptProativo(cfg, acoesConhecidas);
  const descartadas: Record<string, number> = {};
  const soma = (motivo: string, n = 1) => {
    descartadas[motivo] = (descartadas[motivo] ?? 0) + n;
  };
  const criadas: ResultadoProativo['criadas'] = [];
  const vistas = new Set<string>();
  const dados: { titulo: string; risco: string; custo: number }[] = [];

  const empresas = await banco.query<{ id: string }>(`select id from empresas order by criado_em`);
  for (const emp of empresas.rows) {
    const restante = cfg.max_propostas - criadas.length;
    if (restante <= 0) break;
    let propostas: Proposta[];
    const contexto = await coletarContexto(banco, emp.id, cfg, { aoDetectar, recordarMemoria: deps.recordarMemoria });
    try {
      const texto = await deps.cerebro.pensar(sistema, [{ role: 'user', content: `Contexto desta rodada:\n\n${contexto.texto}` }], {
        finalidade: FINALIDADE_PROATIVO,
        empresaId: emp.id,
      });
      const lidas = lerPropostas(texto);
      if (lidas.descartadas) soma('formato', lidas.descartadas);
      propostas = lidas.propostas;
    } catch (e) {
      log('aviso', 'agente proativo: cérebro falhou nesta empresa', { empresa: emp.id, erro: String((e as Error)?.message ?? e) });
      continue;
    }

    for (const p of propostas) {
      if (criadas.length >= cfg.max_propostas) {
        soma('limite');
        continue;
      }
      const nivel = classificarAcao(regras, p.acao);
      // item 815: com conteúdo suspeito no contexto, nada sensível sai direto; malicioso derruba tudo.
      if (contexto.nivel === 'malicioso' || (contexto.nivel !== 'limpo' && (nivel !== 'verde' || toolSensivelPeloNome(p.acao)))) {
        soma('injecao');
        continue;
      }
      if (p.custo_estimado_brl > regras.orcamento_padrao.teto_por_compra_brl) {
        soma('orcamento');
        continue;
      }
      if (temChaveSuspeita(p.args)) {
        soma('segredo');
        continue;
      }
      const hash = hashProposta(p);
      if (vistas.has(`${emp.id}:${hash}`) || (await jaProposta(banco, emp.id, hash, cfg.dias_dedup))) {
        soma('duplicada');
        continue;
      }
      vistas.add(`${emp.id}:${hash}`);
      let negocioId: string | null = null;
      if (p.negocio_id) {
        const n = await banco.query(`select 1 from negocios where id = $1 and empresa_id = $2`, [p.negocio_id, emp.id]);
        if (n.rowCount) negocioId = p.negocio_id;
      }
      try {
        const t = await criarTarefa(
          banco,
          regras,
          {
            empresaId: emp.id,
            negocioId,
            agente: 'proativo',
            acao: p.acao,
            plataforma: typeof p.args.plataforma === 'string' ? p.args.plataforma : null,
            parametros: p.args,
            idempotencyKey: `proativo:${emp.id}:${hash}:${agora.getTime()}`,
            resumo: `[Proativo] ${neutralizarTexto(p.titulo)}: ${neutralizarTexto(p.motivo)} (risco ${p.risco}, custo estimado ${real(p.custo_estimado_brl)})`.slice(0, 500),
            forcarAprovacao: true,
            semAviso: true,
            expiraEmMinutos: Math.round(cfg.expira_em_horas * 60),
          },
          'agente:proativo',
        );
        criadas.push({ tarefaId: t.tarefa.id, titulo: p.titulo, acao: p.acao });
        dados.push({ titulo: neutralizarTexto(p.titulo).slice(0, 100), risco: p.risco, custo: p.custo_estimado_brl });
      } catch (e) {
        log('erro', 'agente proativo: falha ao criar a proposta', { acao: p.acao, erro: String((e as Error)?.message ?? e) });
        soma('erro');
      }
    }
  }

  let avisou = false;
  if (criadas.length) {
    const linhas = dados.map((d, i) => `${i + 1}. ${d.titulo} (risco ${d.risco}, ~${real(d.custo)})`);
    await enfileirarAviso(banco, {
      tipo: 'texto',
      conteudo: {
        texto: `Jarvis proativo: ${criadas.length} proposta(s) esperando seu OK (valem ${cfg.expira_em_horas}h; aprove ou recuse no painel):\n${linhas.join('\n')}`,
      },
    });
    avisou = true;
  }
  await registrarAuditoria(banco, {
    quem: 'agente:proativo',
    acao: 'proativo_rodada',
    detalhes: { criadas: criadas.length, descartadas, empresas: empresas.rowCount ?? 0 },
  });
  return { rodou: true, criadas, descartadas, avisou };
}
