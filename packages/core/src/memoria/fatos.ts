// Item 845: extrator de fatos duráveis para a memória semântica.
// Depois de cada conversa e de cada tarefa concluída, a IA (finalidade `fatos` = Haiku na escada) tira fatos curtos e
// duráveis (preferência, decisão, negócio, cliente, regra) e eles entram em `memoria_trechos` com metadados.tipo = 'fato'.
// Regras de ferro:
//  - segredo/senha/token/CPF/telefone completo/cartão NUNCA são gravados (redação + rejeição do fato que ainda tiver algo sensível);
//  - fato derivado de conteúdo externo (ou de texto que o scanner de injeção acusou) leva taint e confiança reduzida,
//    e nunca vira preferência/regra do Breno: só o que o próprio Breno disse vale como preferência/regra;
//  - dedup: fato equivalente só atualiza visto_em/contagem; fato contraditório e mais novo marca o antigo como substituído
//    (nos metadados, sem apagar). Fato menos confiável nunca substitui um mais confiável.
//  - nada aqui derruba a conversa ou a tarefa: `memorizarFatos` nunca lança.
import { z } from 'zod';
import type { Consultavel } from '../banco.ts';
import { log } from '../log.ts';
import type { ContextoLlm } from '../maestro/telemetria.ts';
import type { Cerebro } from '../maestro/cerebro.ts';
import { redator } from '../redacao.ts';
import type { Resultado, Tarefa } from '../tipos.ts';
import { escanearInjecao } from '../seguranca/injecao.ts';
import { comRegraDadoExterno, type AoDetectarInjecao, type OrigemConteudo } from '../seguranca/taint.ts';
import { hashDoTrecho, lembrar, recordar, type OpcoesMemoria, type OrigemMemoria } from './memoria.ts';

export const FINALIDADE_FATOS = 'fatos';

export const CATEGORIAS_FATO = ['preferencia', 'decisao', 'negocio', 'cliente', 'regra'] as const;
export type CategoriaFato = (typeof CATEGORIAS_FATO)[number];
/** Categorias que só valem como "do Breno" se o próprio Breno disse. */
const CATEGORIAS_DO_BRENO: readonly CategoriaFato[] = ['preferencia', 'regra'];

export const esquemaFatos = z.object({
  ligado: z.boolean().default(true),
  /** Fato com confiança (já com o fator de taint) abaixo disso é descartado. */
  limiar_confianca: z.number().min(0).max(1).default(0.6),
  max_fatos_por_texto: z.number().int().min(1).max(20).default(5),
  /** Texto menor que isso nem chama a IA ("ok", "valeu"). */
  tamanho_min_texto: z.number().int().min(0).default(25),
  /** Multiplicador da confiança de fato derivado de conteúdo externo. */
  fator_taint: z.number().min(0).max(1).default(0.7),
  /** Similaridade (Jaccard de palavras) a partir da qual dois fatos contam como o mesmo. */
  similaridade_dedup: z.number().min(0).max(1).default(0.8),
});
export type ConfigFatos = z.infer<typeof esquemaFatos>;

export function configFatosPadrao(): ConfigFatos {
  return esquemaFatos.parse({});
}

const FONTES = ['breno', 'sistema', 'externo'] as const;
export type FonteFato = (typeof FONTES)[number];
const CONFIANCA_DA_FONTE: Record<FonteFato, number> = { breno: 2, sistema: 1, externo: 0 };

const dataIso = z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'validade deve ser uma data ISO (AAAA-MM-DD)');

/** Um fato como a IA devolve (cada item é validado sozinho: um item ruim não derruba os outros). */
export const esquemaFatoBruto = z.object({
  fato: z.string().trim().min(8).max(300),
  categoria: z.enum(CATEGORIAS_FATO),
  confianca: z.number().min(0).max(1),
  validade: dataIso.optional().nullable(),
  /** Quem disse: o Breno, o sistema (resultado de tarefa, dado do Nexus) ou terceiro/conteúdo externo. */
  fonte: z.enum(FONTES).default('externo'),
  /** Assunto estável em slug (ex.: "idioma_respostas"): mesmo assunto + texto diferente = fato que mudou. */
  assunto: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{2,60}$/)
    .optional()
    .nullable(),
});
export type FatoBruto = z.infer<typeof esquemaFatoBruto>;

export interface FatoExtraido {
  fato: string;
  categoria: CategoriaFato;
  /** Confiança final (já multiplicada pelo fator de taint quando for o caso). */
  confianca: number;
  validade?: string;
  /** Fonte efetiva: a menos confiável entre o que a IA declarou e o que o contexto permite. */
  fonte: FonteFato;
  assunto?: string;
  /** Derivado de conteúdo externo ou de texto com cara de injeção. */
  taint: boolean;
}

export interface ContextoFatos {
  cerebro: Pick<Cerebro, 'pensar'>;
  config: ConfigFatos;
  /** De onde vem o texto: `conversa` ou `tarefa` (as origens da memória). */
  origem: OrigemMemoria;
  /** Quem escreveu o texto: o Breno, o sistema (resultado de tarefa) ou conteúdo externo. Limita a `fonte` dos fatos. */
  autor: OrigemConteudo;
  /** Id da tarefa, da conversa... (vai para metadados.fonte_ref). */
  referencia?: string;
  empresaId?: string | null;
  negocioId?: string | null;
  tarefaId?: string;
  /** Item 815: auditoria da detecção de injeção no texto de entrada. */
  aoDetectar?: AoDetectarInjecao;
  agora?: () => Date;
}

// ---------------------------------------------------------------- sensíveis

const LUHN = (digitos: string): boolean => {
  let soma = 0;
  let dobra = false;
  for (let i = digitos.length - 1; i >= 0; i--) {
    let n = Number(digitos[i]);
    if (dobra) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    soma += n;
    dobra = !dobra;
  }
  return soma % 10 === 0;
};

const PADROES_SENSIVEIS: { nome: string; re: RegExp }[] = [
  { nome: 'cpf', re: /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/ },
  { nome: 'telefone', re: /(?<!\d)(?:\+\d{2}\s?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}(?!\d)/ },
  { nome: 'chave_api', re: /\b(?:sk|pk|rk)[-_](?:live|test|ant|proj)?[-_]?[A-Za-z0-9_-]{16,}/i },
  { nome: 'token_github', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { nome: 'token_slack', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { nome: 'chave_aws', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { nome: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/ },
  { nome: 'bearer', re: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { nome: 'senha_explicita', re: /\b(?:senha|password|passwd|pwd|token|api[_ -]?key|chave secreta|secret)\b\s*(?:[:=]|é|eh|is)\s*\S+/i },
  { nome: 'segredo_opaco', re: /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/ },
];

/** Motivo pelo qual o texto não pode ser gravado como fato (ou null se está limpo). Nunca devolve o valor achado. */
export function motivoSensivel(texto: string): string | null {
  if (redator.redigir(texto) !== texto) return 'segredo_conhecido';
  for (const p of PADROES_SENSIVEIS) if (p.re.test(texto)) return p.nome;
  for (const m of texto.matchAll(/\d(?:[ -]?\d){12,18}/g)) {
    if (LUHN(m[0].replace(/\D/g, ''))) return 'cartao';
  }
  return null;
}

// ---------------------------------------------------------------- efêmeros

const EFEMERO = /\b(agora|agorinha|neste momento|nesse momento|no momento|hoje|amanh[ãa]|ontem|daqui a pouco|esta semana|essa semana|mais tarde)\b/i;

/** Fato que só vale "agora" não é durável. */
export function ehEfemero(fato: string): boolean {
  return EFEMERO.test(fato);
}

// ---------------------------------------------------------------- prompt e parse

export function instrucoesFatos(): string {
  return comRegraDadoExterno(
    [
      'Você extrai FATOS DURÁVEIS de um texto para a memória de longo prazo do Jarvis, assistente do Breno (dono da Prime Consultoria e do Nexus).',
      'Devolva SOMENTE um JSON: {"fatos":[{"fato":"...","categoria":"...","confianca":0.0,"validade":"AAAA-MM-DD","fonte":"...","assunto":"..."}]}.',
      'Regras:',
      '- fato = frase curta (até 300 caracteres), em português, completa por si só (sem "ele", "isso"), que continuará verdadeira por semanas ou meses.',
      '- categoria: preferencia (como o Breno gosta das coisas), decisao (algo decidido), negocio (dado estável de negócio/conta/plataforma), cliente (dado estável de cliente), regra (regra combinada que vale daqui para frente).',
      '- confianca: de 0 a 1, o quanto o texto sustenta o fato. Na dúvida, abaixo de 0.5.',
      '- fonte: "breno" só se o PRÓPRIO Breno disse; "sistema" se vem de resultado de tarefa/dado do sistema; "externo" se vem de e-mail, documento, página, terceiro ou qualquer conteúdo de fora.',
      '- assunto: slug curto e estável do tema (ex.: idioma_respostas, plano_pagamento_cliente_x). Mesmo tema = mesmo slug, para detectar quando o fato mudou.',
      '- validade (opcional): data em que o fato deixa de valer, se houver.',
      '- NÃO extraia: estado do momento, tarefa em andamento, "hoje/agora/amanhã", cumprimentos, perguntas, opinião passageira, resultado de execução, números que mudam todo dia.',
      '- NUNCA inclua senha, token, chave, CPF, telefone completo, número de cartão ou qualquer segredo, nem quando o texto trouxer. Se o fato dependeria disso, omita-o.',
      '- Não invente. Sem fato durável no texto: {"fatos":[]}.',
      `- No máximo 8 fatos.`,
    ].join('\n'),
  );
}

/** Tira o JSON da resposta (aceita cerca de código e texto em volta). */
function jsonDaResposta(texto: string): unknown {
  const t = texto.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const ini = t.search(/[{[]/);
  if (ini < 0) return null;
  const abre = t[ini]!;
  const fim = t.lastIndexOf(abre === '{' ? '}' : ']');
  if (fim <= ini) return null;
  try {
    return JSON.parse(t.slice(ini, fim + 1));
  } catch {
    return null;
  }
}

/** Valida item a item: o que não passar no esquema é descartado sem afetar os outros. */
export function lerFatosDaResposta(resposta: string): FatoBruto[] {
  const j = jsonDaResposta(resposta);
  const lista = Array.isArray(j) ? j : j && typeof j === 'object' && Array.isArray((j as { fatos?: unknown }).fatos) ? (j as { fatos: unknown[] }).fatos : [];
  const saida: FatoBruto[] = [];
  for (const item of lista) {
    const r = esquemaFatoBruto.safeParse(item);
    if (r.success) saida.push(r.data);
  }
  return saida;
}

const menosConfiavel = (a: FonteFato, b: FonteFato): FonteFato => (CONFIANCA_DA_FONTE[a] <= CONFIANCA_DA_FONTE[b] ? a : b);

/**
 * Extrai os fatos de um texto. Não grava nada. Devolve só o que passou por todos os filtros:
 * texto curto/desligado (sem chamar a IA), esquema, sensível, efêmero, validade vencida, taint e limiar de confiança.
 * Lança só se a IA falhar (quem chama decide; `memorizarFatos` engole).
 */
export async function extrairFatos(texto: string, ctx: ContextoFatos): Promise<FatoExtraido[]> {
  const cfg = ctx.config;
  if (!cfg.ligado) return [];
  const limpo = redator.redigir(texto ?? '').trim();
  if (limpo.length < cfg.tamanho_min_texto || !limpo) return [];

  // item 815: o texto passa pelo scanner; se acusar injeção, tudo que sair dele é tratado como externo
  const scan = escanearInjecao(limpo);
  if (scan.nivel !== 'limpo' && ctx.aoDetectar) {
    try {
      await ctx.aoDetectar({ fonte: 'fatos:extrair', origem: ctx.autor, nivel: scan.nivel, motivos: scan.motivos, trechos: [], desfecho: 'detectado' });
    } catch {
      /* auditoria não derruba a extração */
    }
  }
  const autorEfetivo: OrigemConteudo = scan.nivel === 'limpo' ? ctx.autor : 'externo';
  const tainted = autorEfetivo === 'externo';
  // o que a IA pode declarar como fonte é limitado pelo autor do texto
  const tetoFonte: FonteFato = autorEfetivo === 'breno' ? 'breno' : autorEfetivo === 'sistema' ? 'sistema' : 'externo';

  const contexto: ContextoLlm = { finalidade: FINALIDADE_FATOS, empresaId: ctx.empresaId ?? undefined, negocioId: ctx.negocioId ?? undefined, tarefaId: ctx.tarefaId };
  const resposta = await ctx.cerebro.pensar(instrucoesFatos(), [{ role: 'user', content: `Texto (autor: ${autorEfetivo}):\n<<<\n${scan.texto.slice(0, 6000)}\n>>>` }], contexto);

  const agora = (ctx.agora ?? (() => new Date()))();
  const hoje = agora.toISOString().slice(0, 10);
  const vistos = new Set<string>();
  const saida: FatoExtraido[] = [];
  for (const b of lerFatosDaResposta(resposta)) {
    const fonte = menosConfiavel(b.fonte, tetoFonte);
    const taint = tainted || fonte === 'externo';
    if (motivoSensivel(b.fato) || (b.assunto && motivoSensivel(b.assunto))) continue;
    if (ehEfemero(b.fato)) continue;
    if (b.validade && b.validade.slice(0, 10) < hoje) continue;
    // só o que o Breno disse vira preferência/regra dele
    if (CATEGORIAS_DO_BRENO.includes(b.categoria) && fonte !== 'breno') continue;
    const confianca = Math.round(b.confianca * (taint ? cfg.fator_taint : 1) * 1000) / 1000;
    if (confianca < cfg.limiar_confianca) continue;
    const chave = normalizar(b.fato);
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push({ fato: b.fato, categoria: b.categoria, confianca, validade: b.validade ?? undefined, fonte, assunto: b.assunto ?? undefined, taint });
  }
  return saida.sort((a, b) => b.confianca - a.confianca).slice(0, cfg.max_fatos_por_texto);
}

// ---------------------------------------------------------------- dedup

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const normalizar = (s: string): string => semAcento(s).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const palavras = (s: string): Set<string> => new Set(normalizar(s).split(' ').filter((p) => p.length > 2));

/** Similaridade de Jaccard entre as palavras (>2 letras) dos dois textos. */
export function similaridade(a: string, b: string): number {
  const A = palavras(a);
  const B = palavras(b);
  if (!A.size || !B.size) return normalizar(a) === normalizar(b) ? 1 : 0;
  let comuns = 0;
  for (const p of A) if (B.has(p)) comuns++;
  return comuns / (A.size + B.size - comuns);
}

const escopoDe = (empresaId?: string | null, negocioId?: string | null): string => `${empresaId ?? ''}|${negocioId ?? ''}`;

interface Antigo {
  id: string;
  texto: string;
  fonte: FonteFato;
  assunto?: string;
  contagem: number;
  confianca: number;
}

export interface ResumoFatos {
  /** Fatos que passaram nos filtros e foram avaliados. */
  extraidos: number;
  gravados: number;
  /** Equivalentes a um fato já guardado: só visto_em/contagem. */
  atualizados: number;
  /** Fatos antigos marcados como substituídos (contraditórios ou promovidos a uma fonte mais confiável). */
  substituidos: number;
  /** Contradiziam um fato mais confiável (ou já existiam): não gravados. */
  descartados: number;
}

const resumoVazio = (): ResumoFatos => ({ extraidos: 0, gravados: 0, atualizados: 0, substituidos: 0, descartados: 0 });

function lerAntigo(t: { id: string; texto: string; metadados: Record<string, unknown> }, categoria: CategoriaFato, escopo: string): Antigo | null {
  const m = t.metadados ?? {};
  if (m.tipo !== 'fato' || m.categoria !== categoria || m.escopo !== escopo || m.substituido_em) return null;
  const fonte = (FONTES as readonly unknown[]).includes(m.fonte) ? (m.fonte as FonteFato) : 'externo';
  return {
    id: t.id,
    texto: t.texto,
    fonte,
    assunto: typeof m.assunto === 'string' ? m.assunto : undefined,
    contagem: typeof m.contagem === 'number' ? m.contagem : 1,
    confianca: typeof m.confianca === 'number' ? m.confianca : 0,
  };
}

async function atualizarMetadados(banco: Consultavel, id: string, parte: Record<string, unknown>): Promise<boolean> {
  try {
    await banco.query(`update memoria_trechos set metadados = metadados || $2::jsonb where id = $1`, [id, JSON.stringify(parte)]);
    return true;
  } catch (e) {
    // sem a migration 0015 (grant de update em metadados) o fato novo já está gravado; só o antigo fica sem marca
    log('aviso', 'fatos: não consegui atualizar os metadados de um fato', { erro: String(e).slice(0, 200) });
    return false;
  }
}

/** Grava os fatos já filtrados (dedup + substituição). Nunca apaga: o antigo só ganha metadados.substituido_em. */
export async function gravarFatos(banco: Consultavel, fatos: FatoExtraido[], ctx: ContextoFatos, o: OpcoesMemoria = {}): Promise<ResumoFatos> {
  const r = resumoVazio();
  const agora = (ctx.agora ?? (() => new Date()))().toISOString();
  const escopo = escopoDe(ctx.empresaId, ctx.negocioId);
  for (const f of fatos) {
    r.extraidos++;
    const parecidos = await recordar(banco, `${f.assunto ? `${f.assunto.replace(/_/g, ' ')} ` : ''}${f.fato}`, { empresaId: ctx.empresaId, negocioId: ctx.negocioId }, 10, o).catch(() => []);
    const antigos = parecidos.map((t) => lerAntigo(t, f.categoria, escopo)).filter((a): a is Antigo => a !== null);
    const equivalentes: Antigo[] = [];
    const contraditorios: Antigo[] = [];
    for (const a of antigos) {
      if (similaridade(a.texto, f.fato) >= ctx.config.similaridade_dedup) equivalentes.push(a);
      else if (f.assunto && a.assunto === f.assunto) contraditorios.push(a);
    }
    const rank = CONFIANCA_DA_FONTE[f.fonte];
    // equivalente com fonte tão confiável quanto a nova: só atualiza visto_em/contagem
    const igual = equivalentes.find((a) => CONFIANCA_DA_FONTE[a.fonte] >= rank);
    if (igual) {
      await atualizarMetadados(banco, igual.id, { visto_em: agora, contagem: igual.contagem + 1, confianca: Math.max(igual.confianca, f.confianca) });
      r.atualizados++;
      continue;
    }
    // fato menos confiável nunca derruba um mais confiável
    if (contraditorios.some((a) => CONFIANCA_DA_FONTE[a.fonte] > rank)) {
      r.descartados++;
      continue;
    }
    const metadados: Record<string, unknown> = {
      tipo: 'fato',
      categoria: f.categoria,
      confianca: f.confianca,
      fonte: f.fonte,
      escopo,
      visto_em: agora,
      contagem: 1,
      ...(f.assunto ? { assunto: f.assunto } : {}),
      ...(f.validade ? { validade: f.validade } : {}),
      ...(ctx.referencia ? { fonte_ref: ctx.referencia } : {}),
      ...(f.taint ? { derivado_de_externo: true } : {}),
    };
    const gravado = await lembrar(
      banco,
      { texto: f.fato, origem: ctx.origem, referencia: `fato:${f.categoria}`, empresaId: ctx.empresaId, negocioId: ctx.negocioId, metadados, origemTaint: f.taint ? 'externo' : ctx.autor },
      o,
    );
    if (!gravado.inseridos) {
      r.descartados++; // o mesmo conteúdo já estava gravado
      continue;
    }
    r.gravados++;
    const substituidoPor = hashDoTrecho(f.fato);
    for (const a of [...contraditorios, ...equivalentes]) {
      if (await atualizarMetadados(banco, a.id, { substituido_em: agora, substituido_por: substituidoPor })) r.substituidos++;
    }
  }
  return r;
}

/**
 * Extrai e grava. NUNCA lança: falha da IA, do banco ou da memória vira log e resumo vazio, para jamais
 * atrapalhar a conversa ou a tarefa que originou o texto.
 */
export async function memorizarFatos(banco: Consultavel, texto: string, ctx: ContextoFatos, o: OpcoesMemoria = {}): Promise<ResumoFatos> {
  try {
    const fatos = await extrairFatos(texto, ctx);
    if (!fatos.length) return resumoVazio();
    return await gravarFatos(banco, fatos, ctx, o);
  } catch (e) {
    log('aviso', 'fatos: extração falhou (ignorada)', { erro: String(e).slice(0, 200) });
    return resumoVazio();
  }
}

// ---------------------------------------------------------------- fila não bloqueante

const LIMITE_FILA_FATOS = 20;
let fila: Promise<void> = Promise.resolve();
let pendentes = 0;

/**
 * Agenda o trabalho em segundo plano, um por vez (não satura a IA nem o banco) e sem esperar: devolve na hora.
 * Passou de 20 pendentes, descarta (a memória de fatos é best-effort). Erros são engolidos.
 */
export function agendarFatos(trabalho: () => Promise<unknown>): boolean {
  if (pendentes >= LIMITE_FILA_FATOS) return false;
  pendentes++;
  fila = fila
    .then(async () => {
      try {
        await trabalho();
      } catch (e) {
        log('aviso', 'fatos: tarefa em segundo plano falhou (ignorada)', { erro: String(e).slice(0, 200) });
      }
    })
    .finally(() => {
      pendentes--;
    });
  return true;
}

/** Espera a fila esvaziar (testes e encerramento do worker). */
export function aguardarFatos(): Promise<void> {
  return fila;
}

// ---------------------------------------------------------------- ganchos (conversa e tarefa)

export interface InfoConversaFatos {
  pergunta: string;
  resposta: string;
  via: 'numero' | 'senha';
  /** Nomes das ferramentas que a conversa usou (as `mcp__*` são servidores externos). */
  ferramentas: string[];
}

export type GanchoConversaFatos = (i: InfoConversaFatos) => void;

export interface DepsFatos {
  banco: Consultavel;
  cerebro: Pick<Cerebro, 'pensar'>;
  config: ConfigFatos;
  opcoes?: OpcoesMemoria;
  aoDetectar?: AoDetectarInjecao;
}

/**
 * Gancho para depois de `responderConversa`: agenda a extração em segundo plano e devolve na hora (nunca lança).
 * Só a conversa pelo número autorizado conta (a sessão com senha não é confiável o bastante para virar memória).
 * Se a conversa usou ferramenta de servidor externo, o texto todo é tratado como externo (taint, sem preferência/regra).
 */
export function criarGanchoConversaFatos(d: DepsFatos): GanchoConversaFatos {
  return (i) => {
    try {
      if (!d.config.ligado || i.via !== 'numero') return;
      if (i.pergunta.trim().length < d.config.tamanho_min_texto) return;
      const autor: OrigemConteudo = i.ferramentas.some((n) => n.startsWith('mcp__')) ? 'externo' : 'breno';
      const texto = `Breno disse: ${i.pergunta.trim()}\nJarvis respondeu: ${i.resposta.trim()}`;
      agendarFatos(() => memorizarFatos(d.banco, texto, { cerebro: d.cerebro, config: d.config, origem: 'conversa', autor, aoDetectar: d.aoDetectar }, d.opcoes));
    } catch {
      /* o gancho nunca atrapalha a resposta */
    }
  };
}

const CHAVE_SECRETA = /(senha|password|passwd|secret|token|api[_-]?key|valor)/i;

function semChavesSecretas(v: unknown, fundo = 0): unknown {
  if (fundo > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => semChavesSecretas(x, fundo + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !CHAVE_SECRETA.test(k)).map(([k, x]) => [k, semChavesSecretas(x, fundo + 1)]));
}

/** Texto de uma tarefa concluída para o extrator (sem chaves de aparência secreta; o resto passa pela redação depois). */
export function textoDaTarefa(t: Pick<Tarefa, 'acao' | 'plataforma' | 'parametros'>, r: Pick<Resultado, 'mensagem' | 'dados'>): string {
  const parametros = JSON.stringify(semChavesSecretas(t.parametros ?? {})).slice(0, 1500);
  const dados = r.dados === undefined ? '' : JSON.stringify(semChavesSecretas(r.dados)).slice(0, 3000);
  return [`Tarefa concluída: ${t.plataforma ?? 'interno'}/${t.acao}`, `Parâmetros: ${parametros}`, r.mensagem ? `Resultado: ${r.mensagem}` : '', dados ? `Dados: ${dados}` : ''].filter(Boolean).join('\n');
}

/** Gancho para depois de `concluir` no executor: agenda a extração (autor `sistema`) e devolve na hora. Nunca lança. */
export function agendarFatosDaTarefa(d: DepsFatos, t: Tarefa, r: Resultado): void {
  try {
    if (!d.config.ligado) return;
    const texto = textoDaTarefa(t, r);
    agendarFatos(() =>
      memorizarFatos(d.banco, texto, { cerebro: d.cerebro, config: d.config, origem: 'tarefa', autor: 'sistema', referencia: t.id, empresaId: t.empresa_id, negocioId: t.negocio_id, tarefaId: t.id, aoDetectar: d.aoDetectar }, d.opcoes),
    );
  } catch {
    /* o gancho nunca atrapalha a tarefa */
  }
}

// ---------------------------------------------------------------- consulta (MCP)

export interface FiltrosListaFatos {
  categoria?: CategoriaFato;
  empresaId?: string | null;
  negocioId?: string | null;
  /** Texto livre: busca híbrida na memória, só entre fatos. Sem ele, lista os mais recentes. */
  consulta?: string;
  incluirSubstituidos?: boolean;
  limite?: number;
}

export interface FatoGuardado {
  id: string;
  fato: string;
  categoria: string;
  confianca: number | null;
  fonte: string | null;
  assunto: string | null;
  validade: string | null;
  visto_em: string | null;
  contagem: number;
  substituido: boolean;
  taint: boolean;
  negocio_id: string | null;
  criado_em: Date;
}

export async function listarFatos(banco: Consultavel, f: FiltrosListaFatos = {}, o: OpcoesMemoria = {}): Promise<FatoGuardado[]> {
  const limite = Math.min(Math.max(f.limite ?? 20, 1), 50);
  if (f.consulta?.trim()) {
    const achados = await recordar(banco, f.consulta, { empresaId: f.empresaId, negocioId: f.negocioId }, 50, o);
    return achados
      .filter((t) => t.metadados.tipo === 'fato' && (!f.categoria || t.metadados.categoria === f.categoria) && (f.incluirSubstituidos || !t.metadados.substituido_em))
      .slice(0, limite)
      .map((t) => paraFato({ id: t.id, texto: t.texto, metadados: t.metadados, negocio_id: f.negocioId ?? null, criado_em: t.criado_em }));
  }
  const r = await banco.query<{ id: string; texto: string; metadados: Record<string, unknown>; negocio_id: string | null; criado_em: Date }>(
    `select id, texto, metadados, negocio_id, criado_em
       from memoria_trechos
      where metadados->>'tipo' = 'fato'
        and ($1::text is null or metadados->>'categoria' = $1)
        and ($2::uuid is null or empresa_id = $2)
        and ($3::uuid is null or negocio_id = $3)
        and ($4::boolean or not (metadados ? 'substituido_em'))
      order by criado_em desc
      limit $5`,
    [f.categoria ?? null, f.empresaId ?? null, f.negocioId ?? null, f.incluirSubstituidos ?? false, limite],
  );
  return r.rows.map(paraFato);
}

function paraFato(t: { id: string; texto: string; metadados: Record<string, unknown>; negocio_id: string | null; criado_em: Date }): FatoGuardado {
  const m = t.metadados ?? {};
  const taint = (m.taint ?? {}) as { origem?: string; nivel?: string };
  return {
    id: t.id,
    fato: t.texto,
    categoria: String(m.categoria ?? ''),
    confianca: typeof m.confianca === 'number' ? m.confianca : null,
    fonte: typeof m.fonte === 'string' ? m.fonte : null,
    assunto: typeof m.assunto === 'string' ? m.assunto : null,
    validade: typeof m.validade === 'string' ? m.validade : null,
    visto_em: typeof m.visto_em === 'string' ? m.visto_em : null,
    contagem: typeof m.contagem === 'number' ? m.contagem : 1,
    substituido: Boolean(m.substituido_em),
    taint: m.derivado_de_externo === true || taint.origem === 'externo' || (taint.nivel !== undefined && taint.nivel !== 'limpo'),
    negocio_id: t.negocio_id,
    criado_em: t.criado_em,
  };
}
