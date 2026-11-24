// Item 793 (parte 2): executa, uma única vez, a tool MCP de uma aprovação aprovada.
// - Só roda aprovação com status 'aprovada' (recusada/expirada nunca) e mcp_estado 'pendente'.
// - A reivindicação é um UPDATE atômico (pendente -> executando): duas decisões, dois workers ou dois ciclos
//   nunca executam a mesma aprovação duas vezes. Em falha NÃO repete: vai para 'erro' e o Breno é avisado.
// - O resultado é redigido (redacao.ts) antes de gravar, auditar e avisar.
import type { Consultavel } from '../banco.ts';
import { registrarAuditoria } from '../auditoria.ts';
import { enfileirarAviso } from '../avisos.ts';
import { log } from '../log.ts';
import { redator } from '../redacao.ts';
import { criarClienteMcp, type ClienteMcp } from './cliente.ts';
import { timeoutDaTool, type ServidorMcpResolvido } from './config.ts';

export const LIMITE_RESULTADO_GRAVADO = 20_000;
export const LIMITE_RESULTADO_AVISO = 1_200;
/** `executando` há mais que isto: o processo caiu no meio; marca erro e NÃO repete. */
export const MINUTOS_EXECUCAO_TRAVADA = 20;

export interface DepsExecucaoMcp {
  servidores: ServidorMcpResolvido[];
  criarCliente?: (s: ServidorMcpResolvido) => ClienteMcp;
}

export interface ResumoExecucaoMcp {
  executadas: number;
  erros: number;
}

interface Reivindicada {
  id: string;
  mcp_servidor: string;
  mcp_tool: string;
  mcp_acao: string | null;
  mcp_args: Record<string, unknown> | null;
}

async function concluir(db: Consultavel, id: string, estado: 'executada' | 'erro', resultado: string | null, erro: string | null): Promise<void> {
  await db.query(
    `update aprovacoes set mcp_estado = $2, mcp_concluida_em = now(), mcp_resultado = $3, mcp_erro = $4
      where id = $1 and mcp_estado = 'executando'`,
    [id, estado, resultado, erro],
  );
}

async function executarUma(db: Consultavel, ap: Reivindicada, servidor: ServidorMcpResolvido, fabrica: (s: ServidorMcpResolvido) => ClienteMcp): Promise<'executada' | 'erro'> {
  const acao = ap.mcp_acao ?? `mcp_${ap.mcp_servidor}_${ap.mcp_tool}`;
  let estado: 'executada' | 'erro' = 'erro';
  let texto = '';
  let erro: string | null = null;
  if (!servidor.tools.includes(ap.mcp_tool)) {
    erro = 'a tool não está mais na allowlist do servidor: não executei';
  } else {
    const cliente = fabrica(servidor);
    try {
      const r = await cliente.chamarTool(ap.mcp_tool, ap.mcp_args ?? {}, timeoutDaTool(servidor, ap.mcp_tool));
      texto = redator.redigir(r.texto || '(sem conteúdo)').slice(0, LIMITE_RESULTADO_GRAVADO);
      if (r.erro) erro = 'o servidor marcou o resultado como erro de ferramenta';
      else estado = 'executada';
    } catch (e) {
      erro = redator.redigir(String((e as Error)?.message ?? e)).slice(0, 500);
    } finally {
      await cliente.encerrar().catch(() => undefined);
    }
  }
  await concluir(db, ap.id, estado, texto || null, erro);
  await registrarAuditoria(db, {
    quem: 'mcp-cliente',
    acao: estado === 'executada' ? 'mcp_aprovada_executada' : 'mcp_aprovada_erro',
    detalhes: { aprovacao: ap.id, servidor: ap.mcp_servidor, tool: ap.mcp_tool, acao, tamanho_resultado: texto.length, ...(erro ? { erro } : {}) },
  });
  const cabeca = estado === 'executada' ? `Executei ${ap.mcp_servidor}/${ap.mcp_tool} (aprovado por você).` : `A execução de ${ap.mcp_servidor}/${ap.mcp_tool} falhou e NÃO foi repetida: ${erro}.`;
  const corpo = texto ? `\n${texto.slice(0, LIMITE_RESULTADO_AVISO)}${texto.length > LIMITE_RESULTADO_AVISO ? '…' : ''}` : '';
  await enfileirarAviso(db, { tipo: 'texto', conteudo: { texto: `${cabeca}${corpo}` } }).catch((e) =>
    log('aviso', 'aviso do resultado MCP não enfileirado', { aprovacao: ap.id, erro: String(e) }),
  );
  return estado;
}

/**
 * Executa as aprovações MCP aprovadas e ainda não tocadas, dos servidores configurados neste processo.
 * Rode no ciclo do worker. Servidor sem URL no ambiente deste processo não é reivindicado (outro processo pode).
 */
export async function executarMcpAprovadas(db: Consultavel, deps: DepsExecucaoMcp, limite = 3): Promise<ResumoExecucaoMcp> {
  const resumo: ResumoExecucaoMcp = { executadas: 0, erros: 0 };
  // processo que caiu no meio da execução: marca erro, nunca repete (pode ter tido efeito)
  await db.query(
    `update aprovacoes set mcp_estado = 'erro', mcp_concluida_em = now(), mcp_erro = 'execução interrompida; não repetida'
      where mcp_estado = 'executando' and mcp_iniciada_em < now() - make_interval(mins => $1)`,
    [MINUTOS_EXECUCAO_TRAVADA],
  );
  const nomes = deps.servidores.map((s) => s.nome);
  if (!nomes.length) return resumo;
  const fabrica = deps.criarCliente ?? ((s: ServidorMcpResolvido) => criarClienteMcp({ url: s.url, token: s.token, timeoutMs: Math.min(s.timeoutMs, 15_000) }));
  for (let i = 0; i < limite; i++) {
    const r = await db.query(
      `update aprovacoes set mcp_estado = 'executando', mcp_iniciada_em = now()
        where id = (select id from aprovacoes
                     where status = 'aprovada' and mcp_estado = 'pendente' and mcp_tool is not null and mcp_servidor = any($1)
                     order by respondido_em limit 1 for update skip locked)
        returning id, mcp_servidor, mcp_tool, mcp_acao, mcp_args`,
      [nomes],
    );
    const ap = r.rows[0] as Reivindicada | undefined;
    if (!ap) break;
    const servidor = deps.servidores.find((s) => s.nome === ap.mcp_servidor)!;
    try {
      const estado = await executarUma(db, ap, servidor, fabrica);
      if (estado === 'executada') resumo.executadas++;
      else resumo.erros++;
    } catch (e) {
      // falha ao gravar o desfecho: não volta a 'pendente' (não repete); o varredor marca erro depois
      log('erro', 'falha ao concluir execução MCP aprovada', { aprovacao: ap.id, erro: String(e) });
      resumo.erros++;
    }
  }
  return resumo;
}
