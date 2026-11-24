// "Cérebro" do Maestro: transforma o comando do Breno num plano (seção 24, Maestro).
// A IA só PROPÕE: o plano passa pela validação (seção 11) e pela aprovação do Breno.
import { ErroHttp, requisitarJson } from '../http.ts';
import { log } from '../log.ts';
import type { FerramentaIa } from '../nexus-mcp.ts';
import type { Regras } from '../regras.ts';
import { comRegraDadoExterno, REGRA_DADO_EXTERNO, type RastroTaint } from '../seguranca/taint.ts';
import { LoopGuard, loopGuardPadrao, type ConfigLoopGuard, type VeredictoLoop } from '../loop-guard.ts';
import { executarComEscada, escolherModelo, type ConfigModelos, type Escolha } from './escada.ts';
import { ROTEIROS } from './modelos.ts';
import { validarPlano, type PlanoValidado } from './plano.ts';
import type { UsoAnthropic } from './precos.ts';
import { montarChamada, registrarChamada, type ContextoLlm, type GravadorLlm } from './telemetria.ts';

export interface Cerebro {
  /** Devolve o texto da resposta da IA (deve conter um JSON de plano). */
  pensar(sistema: string, mensagens: { role: 'user' | 'assistant'; content: string }[], contexto?: ContextoLlm): Promise<string>;
  /** Item 416 (parte 2): conversa usando ferramentas (tool use), com limite de rodadas e de tempo total. */
  pensarComFerramentas?(sistema: string, pergunta: string, ferramentas: FerramentaIa[], executar: ExecutarFerramenta, o?: OpcoesFerramentas): Promise<string>;
}

export type ExecutarFerramenta = (nome: string, args: Record<string, unknown>, timeoutMs: number) => Promise<string>;
export interface OpcoesFerramentas {
  /** Rodadas de ferramenta (padrão 5). */
  rodadas?: number;
  /** Tempo total em ms (padrão 20 s: o Nexus espera 25 s pela resposta da conversa). */
  prazoMs?: number;
  agora?: () => number;
  /** Telemetria (item 791): tarefa/empresa/negócio/finalidade desta conversa. */
  contexto?: ContextoLlm;
  /** LoopGuard (item 792): limites; padrão = `loopGuardPadrao()`. Complementa o bloqueio de args idênticos da ponte MCP. */
  loopGuard?: ConfigLoopGuard;
  /** Chamado quando o LoopGuard interrompe (ex.: registrar na auditoria). Falha aqui nunca derruba a conversa. */
  aoLoop?: (v: VeredictoLoop) => void | Promise<void>;
  /**
   * Taint anti-injeção (item 815): decide, a cada tool_use, se a tool pode executar dado o que já entrou no contexto e
   * escaneia/neutraliza cada resultado. Sem ele o laço se comporta como antes.
   */
  taint?: RastroTaint;
}

/** Texto devolvido quando o LoopGuard interrompe o laço de ferramentas. */
export const mensagemLoop = (v: VeredictoLoop) =>
  `Parei para não entrar em loop: ${v.motivo}. Tente de outro jeito ou peça uma parte por vez.`;
/** Prazo padrão da conversa com ferramentas: abaixo dos 22 s combinados (o Nexus corta em 25 s). */
export const PRAZO_CONVERSA_MS = 20_000;

type Bloco = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } | { type: 'tool_result'; tool_use_id: string; content: string };
type MensagemIa = { role: 'user' | 'assistant'; content: string | Bloco[] };

/** Laço de tool use, separado do HTTP para dar para testar. `chamarIa` recebe o tempo que sobra. */
export async function lacoFerramentas(
  chamarIa: (mensagens: MensagemIa[], timeoutMs: number, comFerramentas: boolean) => Promise<{ content: Bloco[]; stop_reason?: string }>,
  pergunta: string,
  executar: ExecutarFerramenta,
  o: OpcoesFerramentas = {},
): Promise<string> {
  const agora = o.agora ?? Date.now;
  const fim = agora() + (o.prazoMs ?? PRAZO_CONVERSA_MS);
  const rodadas = o.rodadas ?? 5;
  const mensagens: MensagemIa[] = [{ role: 'user', content: pergunta }];
  const guarda = new LoopGuard(o.loopGuard ?? loopGuardPadrao());
  const interromper = async (v: VeredictoLoop): Promise<string> => {
    try {
      await o.aoLoop?.(v);
    } catch {
      /* auditoria não derruba a conversa */
    }
    return mensagemLoop(v);
  };
  for (let i = 0; i <= rodadas; i++) {
    const sobra = fim - agora();
    if (sobra < 1500) return 'Demorei demais para juntar tudo. Pergunte de um jeito mais curto ou peça uma parte por vez.';
    // última rodada: sem ferramentas, a IA tem de responder com o que já juntou
    const r = await chamarIa(mensagens, sobra, i < rodadas);
    const usos = r.content.filter((b): b is Extract<Bloco, { type: 'tool_use' }> => b.type === 'tool_use');
    const texto = r.content.filter((b): b is Extract<Bloco, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!usos.length || r.stop_reason !== 'tool_use') return texto;
    mensagens.push({ role: 'assistant', content: r.content });
    const resultados: Bloco[] = [];
    // item 815: todas as decisões desta rodada saem ANTES de qualquer resultado dela (o modelo decidiu sem vê-los)
    const vereditos = o.taint ? await Promise.all(usos.map((u) => o.taint!.avaliar(u.name, u.input ?? {}))) : [];
    for (const [i, u] of usos.entries()) {
      const negado = guarda.antes(u.name, u.input ?? {});
      if (negado) return interromper(negado);
      const veredito = vereditos[i];
      let saida: string;
      if (veredito && veredito.acao !== 'executar') {
        saida = veredito.resposta;
      } else {
        const resto = Math.max(500, fim - agora() - 1500);
        saida = await executar(u.name, u.input ?? {}, Math.min(10_000, resto));
        if (o.taint) saida = await o.taint.registrarResultado(u.name, saida);
      }
      guarda.depois(u.name, saida);
      resultados.push({ type: 'tool_result', tool_use_id: u.id, content: saida });
    }
    const parado = guarda.fecharRodada();
    if (parado) return interromper(parado);
    mensagens.push({ role: 'user', content: resultados });
  }
  return 'Não consegui fechar a resposta a tempo.';
}

export interface OpcoesCerebroAnthropic {
  chave: string;
  modelo?: string;
  fetchImpl?: typeof fetch;
  /** Telemetria por chamada (item 791). Sem gravador, nada é gravado. Falha do gravador nunca derruba a chamada. */
  gravador?: GravadorLlm;
  /** Contexto padrão da telemetria (a chamada pode sobrescrever). */
  contexto?: ContextoLlm;
  /** Relógio em ms (testes). */
  agora?: () => number;
  /**
   * Escada de modelos + fallback (item 792; `regras.modelos`). Sem ela o comportamento é o antigo: um modelo fixo
   * (`modelo` ou o padrão da chamada), sem repetição nem troca. Com ela, `modelo` vira override explícito.
   */
  escada?: ConfigModelos;
  /** LoopGuard padrão das conversas com ferramentas (item 792; `regras.loop_guard`). */
  loopGuard?: ConfigLoopGuard;
  /** Auditoria do LoopGuard (conversa). */
  aoLoop?: (v: VeredictoLoop) => void | Promise<void>;
  /** Espera do backoff (testes). */
  dormir?: (ms: number) => Promise<void>;
}

const URL_MENSAGENS = 'https://api.anthropic.com/v1/messages';

/**
 * Chama /v1/messages medindo latência e lendo `usage`; grava a telemetria em segundo plano
 * (também quando a chamada falha) e devolve a resposta ou repete o erro original.
 */
async function chamarMensagens<T extends { usage?: UsoAnthropic; stop_reason?: string }>(
  o: OpcoesCerebroAnthropic,
  modelo: string,
  corpo: Record<string, unknown>,
  timeoutMs: number,
  finalidadePadrao: string,
  contexto?: ContextoLlm,
  fallbackDe: string | null = null,
): Promise<T> {
  const agora = o.agora ?? Date.now;
  const ini = agora();
  const ctx = { ...o.contexto, ...contexto };
  try {
    const r = await requisitarJson<T>(URL_MENSAGENS, {
      metodo: 'POST',
      fetchImpl: o.fetchImpl,
      cabecalhos: { 'x-api-key': o.chave, 'anthropic-version': '2023-06-01' },
      corpo: { model: modelo, ...corpo },
      timeoutMs,
    });
    void registrarChamada(o.gravador, () =>
      montarChamada({ modelo, contexto: ctx, finalidadePadrao, uso: r?.usage, latenciaMs: agora() - ini, statusHttp: 200, stopReason: r?.stop_reason, fallbackDe }),
    );
    return r;
  } catch (e) {
    void registrarChamada(o.gravador, () =>
      montarChamada({
        modelo,
        contexto: ctx,
        finalidadePadrao,
        latenciaMs: agora() - ini,
        fallbackDe,
        statusHttp: e instanceof ErroHttp ? e.status : null,
        erro: e instanceof ErroHttp ? `${e.erro.codigo}: ${e.erro.mensagem}` : String((e as Error)?.message ?? e),
      }),
    );
    throw e;
  }
}

interface PedidoEscalonado<T> {
  finalidadePadrao: string;
  sistema: string;
  mensagens: unknown;
  nTools: number;
  /** Modelo quando não há escada (comportamento antigo). */
  modeloPadrao: string;
  corpo: Record<string, unknown>;
  timeoutMs: number;
  contexto?: ContextoLlm;
  valida: (r: T) => boolean;
}

/** Uma chamada ao modelo: com escada (seleção + fallback) ou, sem ela, direta no modelo fixo. */
async function chamarEscalonado<T extends { usage?: UsoAnthropic; stop_reason?: string }>(o: OpcoesCerebroAnthropic, p: PedidoEscalonado<T>): Promise<T> {
  const ctx = { ...o.contexto, ...p.contexto };
  const finalidade = ctx.finalidade ?? p.finalidadePadrao;
  if (!o.escada) {
    return chamarMensagens<T>(o, o.modelo ?? p.modeloPadrao, p.corpo, p.timeoutMs, p.finalidadePadrao, p.contexto);
  }
  const escolha: Escolha = escolherModelo(o.escada, {
    finalidade,
    texto: `${p.sistema}\n${JSON.stringify(p.mensagens)}`,
    nTools: p.nTools,
    modelo: ctx.modelo ?? o.modelo,
  });
  const r = await executarComEscada<T>(
    o.escada,
    escolha,
    (t) => chamarMensagens<T>(o, t.modelo, p.corpo, t.timeoutMs, p.finalidadePadrao, p.contexto, t.fallbackDe),
    {
      valida: p.valida,
      timeoutMs: p.timeoutMs,
      agora: o.agora,
      dormir: o.dormir,
      aoTrocar: (t) => log('aviso', 'fallback de modelo', { de: t.de, para: t.para, motivo: t.motivo, finalidade }),
    },
  );
  return r.resposta;
}

type RespostaIa = { content: Bloco[]; stop_reason?: string; usage?: UsoAnthropic };
const textoDe = (r: { content?: { type: string; text?: string }[] }) => (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
/** Resposta que serve: tem texto ou pede uma ferramenta. Vazia/sem conteúdo faz o fallback subir de degrau. */
const respostaUtil = (r: RespostaIa) => (r.content ?? []).some((b) => (b.type === 'text' && b.text.trim() !== '') || b.type === 'tool_use');

export function criarCerebroAnthropic(o: OpcoesCerebroAnthropic): Cerebro {
  return {
    async pensar(sistemaBruto, mensagens, contexto) {
      const sistema = comRegraDadoExterno(sistemaBruto);
      const r = await chamarEscalonado<{ content: { type: string; text?: string }[]; usage?: UsoAnthropic; stop_reason?: string }>(o, {
        finalidadePadrao: 'plano',
        sistema,
        mensagens,
        nTools: 0,
        modeloPadrao: 'claude-sonnet-5-5',
        corpo: { max_tokens: 8000, system: sistema, messages: mensagens },
        timeoutMs: 120_000,
        contexto,
        valida: (x) => textoDe(x).trim() !== '',
      });
      return textoDe(r);
    },
    async pensarComFerramentas(sistemaBruto, pergunta, ferramentas, executar, op) {
      const sistema = comRegraDadoExterno(sistemaBruto);
      return lacoFerramentas(
        (mensagens, timeoutMs, comFerramentas) =>
          chamarEscalonado<RespostaIa>(o, {
            finalidadePadrao: 'conversa',
            sistema,
            mensagens,
            nTools: comFerramentas ? ferramentas.length : 0,
            modeloPadrao: 'claude-haiku-5-5',
            corpo: { max_tokens: 1200, system: sistema, messages: mensagens, ...(comFerramentas && ferramentas.length ? { tools: ferramentas } : {}) },
            timeoutMs,
            contexto: op?.contexto,
            valida: respostaUtil,
          }),
        pergunta,
        executar,
        { ...op, loopGuard: op?.loopGuard ?? o.loopGuard, aoLoop: op?.aoLoop ?? o.aoLoop },
      );
    },
  };
}

export function instrucoesMaestro(regras: Regras): string {
  return [
    'Você é o Maestro do Jarvis. Transforme o comando do Breno num PLANO de negócio em JSON.',
    'Regras inegociáveis: nunca peça, exiba ou invente valores de segredos; nunca resolva CAPTCHA; WhatsApp só com opt-in;',
    'nunca invente dados, números, depoimentos ou resultados; prefira começar pequeno e validar a demanda antes de gastar.',
    'Escolha um modelo de negócio e justifique. Preencha a viabilidade com custos REALISTAS (custo fixo, custo variável por venda, taxas %, preço).',
    'Faça as checagens: politicas_plataforma, opt_in_whatsapp, lgpd_consumidor, fiscal, regulacao_produto.',
    'Valores possíveis: "ok", "reprovado", "nao_aplicavel", "pendente_contador", "pendente_breno". Seja honesto: reprovado bloqueia o plano.',
    `Teto mensal de anúncios padrão: R$ ${regras.orcamento_padrao.teto_mensal_por_negocio_brl}; teto por compra: R$ ${regras.orcamento_padrao.teto_por_compra_brl}.`,
    'Use as etapas do roteiro do modelo como ponto de partida (pode ajustar). agente ∈ maestro|jarvis_infra|oferta|trafego|vendas|fornecedores|logistica|fiscal.',
    'Ações e ids em minúsculas_com_underline. Parâmetros nunca contêm senha/token: só nomes de segredos.',
    REGRA_DADO_EXTERNO,
    `Roteiros: ${JSON.stringify(Object.values(ROTEIROS).map((r) => ({ modelo: r.modelo, descricao: r.descricao, etapas: r.etapas, riscos: r.riscos_tipicos })))}`,
    'Responda SOMENTE com o JSON, no formato:',
    '{"modelo_negocio":"...","objetivo":"...","justificativa_modelo":"...","orcamento":{"teto_total_brl":0,"teto_mensal_anuncios_brl":0,"teto_por_compra_brl":0},',
    '"viabilidade":{"custo_fixo_brl":0,"custo_variavel_unitario_brl":0,"taxas_percentual":0,"preco_venda_brl":0,"riscos":[],"checagens":{"politicas_plataforma":"ok","opt_in_whatsapp":"ok","lgpd_consumidor":"ok","fiscal":"pendente_contador","regulacao_produto":"nao_aplicavel"}},',
    '"etapas":[{"etapa_id":"...","titulo":"...","agente":"...","acao":"...","plataforma":"...","depende_de":[],"custo_estimado_brl":0,"parametros":{}}]}',
  ].join('\n');
}

function extrairJson(texto: string): unknown {
  const limpo = texto.replace(/```(?:json)?/g, '');
  const ini = limpo.indexOf('{');
  const fim = limpo.lastIndexOf('}');
  if (ini < 0 || fim <= ini) throw new Error('a resposta não contém JSON');
  return JSON.parse(limpo.slice(ini, fim + 1));
}

export type ResultadoPlanejamento =
  | { ok: true; validado: PlanoValidado }
  | { ok: false; motivo: 'invalido' | 'bloqueado'; detalhes: string[] };

/** Pede o plano à IA, valida e, se vier com problema de formato, pede uma correção (uma vez). */
export async function planejar(cerebro: Cerebro, regras: Regras, comando: string, contexto = ''): Promise<ResultadoPlanejamento> {
  const sistema = instrucoesMaestro(regras);
  const mensagens: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: `Comando do Breno: ${comando}${contexto ? `\nContexto: ${contexto}` : ''}` },
  ];
  let ultimoErro: string[] = [];
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const resposta = await cerebro.pensar(sistema, mensagens);
    try {
      const validado = validarPlano(extrairJson(resposta), regras);
      if (validado.bloqueios.length) return { ok: false, motivo: 'bloqueado', detalhes: validado.bloqueios };
      return { ok: true, validado };
    } catch (e) {
      const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
      ultimoErro = issues ? issues.map((i) => `${i.path.join('.')}: ${i.message}`) : [String((e as Error).message)];
      mensagens.push({ role: 'assistant', content: resposta });
      mensagens.push({ role: 'user', content: `O JSON veio inválido: ${ultimoErro.join('; ')}. Corrija e responda só com o JSON.` });
    }
  }
  return { ok: false, motivo: 'invalido', detalhes: ultimoErro };
}
