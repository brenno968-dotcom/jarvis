// Item 815: scanner de injeção de prompt (camada 1). Dado externo (e-mail, mensagem de terceiro, resultado de tool
// MCP, página web, memória recuperada) é DADO, nunca ordem. Aqui só se mede o risco do texto e se neutraliza o que
// dá para neutralizar sem apagar o conteúdo útil; a decisão de executar (ou não) uma tool fica no taint.ts.
//
// Pontuação: cada regra tem um peso; cada regra conta uma vez. Soma >= 5 = malicioso; >= 2 = suspeito.
// Regras isoladas de peso 2 (ex.: "você agora é", tag falsa) só chegam a suspeito; duas ou mais juntas, ou uma
// regra de peso 5 (ex.: "ignore as instruções anteriores"), chegam a malicioso.
import { redator } from '../redacao.ts';

export type NivelInjecao = 'limpo' | 'suspeito' | 'malicioso';

export interface AchadoInjecao {
  regra: string;
  motivo: string;
  peso: number;
  /** Trecho curto (redigido) onde a regra casou; nunca o texto inteiro. */
  trecho: string;
}

export interface ResultadoInjecao {
  nivel: NivelInjecao;
  /** Motivos legíveis, sem repetição. */
  motivos: string[];
  achados: AchadoInjecao[];
  pontos: number;
  /** Texto neutralizado: sem caracteres invisíveis, homóglifos corrigidos, HTML oculto/base64 longo trocados por marca, tags falsas escapadas. */
  texto: string;
  /** O neutralizador mudou o texto. */
  alterado: boolean;
}

export const LIMITE_SUSPEITO = 2;
export const LIMITE_MALICIOSO = 5;
const TRECHO_MAX = 90;
const BASE64_MIN = 100;

const ORDEM: Record<NivelInjecao, number> = { limpo: 0, suspeito: 1, malicioso: 2 };
export const piorNivel = (a: NivelInjecao, b: NivelInjecao): NivelInjecao => (ORDEM[a] >= ORDEM[b] ? a : b);

// ---------- invisíveis, homóglifos, HTML oculto ----------

/** Zero-width, bidi e "tag characters" (U+E0000..E007F, usados para contrabandear ASCII). ZWJ tratado à parte (emoji). */
const INVISIVEIS = /[\u200B\u200C\u2060\uFEFF\u00AD\u180E\u202A-\u202E\u2066-\u2069]|[\u{E0000}-\u{E007F}]/gu;
/** ZWJ só é legítimo entre emojis. */
const ZWJ_SOLTO = /(?<![\p{Extended_Pictographic}\uFE0F])\u200D|\u200D(?![\p{Extended_Pictographic}])/gu;
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;

/** Letras cirílicas/gregas que imitam letras latinas. */
const HOMOGLIFOS: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', І: 'I', Ј: 'J', Ѕ: 'S', У: 'Y',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', γ: 'y',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
};
const NAO_LATINO = /[Ͱ-ϿЀ-ӿ]/;
const TEM_LATINO = /[A-Za-z]/;

/** Troca homóglifos só dentro de palavras que MISTURAM letras latinas com cirílico/grego (texto cirílico puro fica intacto). */
function corrigirHomoglifos(texto: string): { texto: string; trocas: number } {
  let trocas = 0;
  const saida = texto.replace(/[\p{L}\p{M}]+/gu, (palavra) => {
    if (!NAO_LATINO.test(palavra) || !TEM_LATINO.test(palavra)) return palavra;
    return [...palavra].map((c) => {
      const l = HOMOGLIFOS[c];
      if (l) trocas++;
      return l ?? c;
    }).join('');
  });
  return { texto: saida, trocas };
}

const ESTILO_OCULTO = String.raw`(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em|rem|%)?\s*(?:;|"|')|opacity\s*:\s*0(?:\.0+)?\s*(?:;|"|')|color\s*:\s*(?:#fff(?:fff)?|white)\s*;[^"']*background[^"']*:\s*(?:#fff(?:fff)?|white)|height\s*:\s*0(?:px)?\s*;[^"']*overflow\s*:\s*hidden)`;
const HTML_COMENTARIO = /<!--[\s\S]*?-->/g;
const HTML_OCULTO_ESTILO = new RegExp(String.raw`<([a-z][a-z0-9]*)\b[^>]*\bstyle\s*=\s*["'][^"']*${ESTILO_OCULTO}[^"']*["'][^>]*>[\s\S]*?</\1\s*>`, 'gi');
const HTML_OCULTO_ATRIBUTO = /<([a-z][a-z0-9]*)\b[^>]*\s(?:hidden|aria-hidden\s*=\s*["']?true["']?)(?:\s[^>]*|)>[\s\S]*?<\/\1\s*>/gi;
const HTML_SCRIPT = /<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

const BASE64_LONGO = new RegExp(String.raw`(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/]{${BASE64_MIN},}={0,2}(?![A-Za-z0-9+/=_-])`, 'g');

/** Tags/marcadores que imitam o sistema, o assistente ou o resultado de ferramenta. */
const TAG_FALSA = /<\s*\/?\s*(?:system|sistema|assistant|assistente|human|user|developer|admin|instructions?|instru[cç][oõ]es|prompt|tool_use|tool_result|function_calls?|invoke|dado_externo|im_start|im_end|inst)\b[^>]*>|<<\s*\/?\s*(?:SYS|INST)\s*>>|\[\s*\/?\s*(?:SYSTEM|SISTEMA|INST|ADMIN|ASSISTANT|DEVELOPER|IMPORTANT|IMPORTANTE)\s*\]|<\|(?:im_start|im_end|system|endoftext)\|>/gi;
const LINHA_SYSTEM = /^[ \t]*(?:system|sistema|assistant|assistente|developer)\s*:\s*\S/gim;

// ---------- regras de conteúdo ----------

interface Regra {
  id: string;
  motivo: string;
  peso: number;
  padrao: RegExp;
}

const VERBO_IGNORAR = String.raw`(?:ignor\w*|desconsider\w*|esque[cç]\w*|descart\w*|desobede[cç]\w*|desrespeit\w*|sobrescrev\w*|substitu\w*|anul\w*|disregard|forget|override|bypass|skip|discard)`;
const OBJETO_INSTRUCAO = String.raw`(?:instru[cç][oõ]es|instru[cç][aã]o|regras|ordens|diretrizes|comandos|orienta[cç][oõ]es|restri[cç][oõ]es|prompts?|instructions?|rules|guidelines|directives|commands|constraints|restrictions|programming|guardrails)`;
const QUALIFICADOR_ANTERIOR = String.raw`(?:anteriores|anterior|acima|pr[eé]vias|passadas|originais|iniciais|todas|qualquer|do sistema|que (?:voc[eê]|vc) (?:recebeu|tem)|previous|prior|above|earlier|original|initial|all|any|system|your|you were given)`;

const REGRAS: Regra[] = [
  {
    id: 'ignorar_instrucoes',
    motivo: 'pede para ignorar/substituir as instruções anteriores',
    peso: 5,
    padrao: new RegExp(String.raw`\b${VERBO_IGNORAR}\b[^.\n]{0,50}\b${OBJETO_INSTRUCAO}\b[^.\n]{0,30}\b${QUALIFICADOR_ANTERIOR}\b|\b${VERBO_IGNORAR}\b[^.\n]{0,30}\b${QUALIFICADOR_ANTERIOR}\b[^.\n]{0,30}\b${OBJETO_INSTRUCAO}\b`, 'i'),
  },
  {
    id: 'ignorar_instrucoes_fraco',
    motivo: 'menciona ignorar instruções/regras',
    peso: 2,
    padrao: new RegExp(String.raw`\b${VERBO_IGNORAR}\b[^.\n]{0,40}\b${OBJETO_INSTRUCAO}\b`, 'i'),
  },
  {
    id: 'novas_instrucoes',
    motivo: 'declara "novas instruções" que substituem as atuais',
    peso: 2,
    padrao: /\b(?:novas?\s+instru[cç][oõ]es|nova\s+ordem|new\s+(?:instructions?|orders?|rules)|updated\s+instructions?|instru[cç][oõ]es\s+atualizadas)\s*[:\-–]/i,
  },
  {
    id: 'papel_pt',
    motivo: 'tenta redefinir o papel do assistente ("você agora é…")',
    peso: 2,
    padrao: /\b(?:voc[eê]|vc)\s+(?:agora\s+)?(?:é|e|passa\s+a\s+ser|vai\s+ser|deve\s+agir\s+como|deve\s+atuar\s+como)\s+(?:agora\s+)?(?:um|uma|o|a)\b|\bvoc[eê]\s+agora\s+(?:é|e)\b|\ba\s+partir\s+de\s+agora,?\s+(?:voc[eê]|vc)\b|\b(?:finja|fingir|aja|atue|comporte-se)\s+(?:que\s+(?:é|e|voc[eê])|como\s+(?:se|um|uma))\b|\bassuma\s+o\s+papel\b/i,
  },
  {
    id: 'papel_en',
    motivo: 'tenta redefinir o papel do assistente ("you are now…")',
    peso: 2,
    padrao: /\byou\s+are\s+now\b|\bfrom\s+now\s+on,?\s+you\b|\bact\s+as\s+(?:an?|the)\s+(?:unrestricted|unfiltered|different|new|admin|root|system)|\bpretend\s+(?:to\s+be|you\s+are|that\s+you)\b|\bassume\s+the\s+role\b|\byour\s+new\s+(?:role|task|instructions?|goal)\b/i,
  },
  {
    id: 'modo_burlar',
    motivo: 'invoca modo sem restrições (jailbreak/DAN/developer mode)',
    peso: 5,
    padrao: /\b(?:jailbreak(?:ed)?|DAN\s+mode|developer\s+mode|modo\s+desenvolvedor|modo\s+deus|god\s+mode|sem\s+(?:nenhuma\s+)?restri[cç][oõ]es|without\s+(?:any\s+)?(?:restrictions|filters|limits)|do\s+anything\s+now)\b/i,
  },
  {
    id: 'revelar_prompt',
    motivo: 'pede para revelar o prompt/as instruções internas',
    peso: 5,
    padrao: /\b(?:revele|mostre|exiba|imprima|repita|liste|envie|vaze|copie|diga|reveal|show|print|repeat|output|display|leak|dump|tell\s+me)\b[^.\n]{0,40}\b(?:prompt\s+(?:do\s+sistema|de\s+sistema|inicial)|system\s+prompt|(?:suas|seus|your)\s+(?:instru[cç][oõ]es|regras|instructions|rules|prompt)|instru[cç][oõ]es\s+(?:internas|do\s+sistema|iniciais)|initial\s+instructions|hidden\s+instructions)/i,
  },
  {
    id: 'revelar_segredos',
    motivo: 'pede para revelar/enviar segredos, senhas, tokens ou chaves',
    peso: 5,
    padrao: /\b(?:revele|mostre|exiba|imprima|repita|liste|envie|mande|encaminhe|vaze|copie|inclua|responda\s+com|reveal|show|print|send|forward|email|leak|dump|include|exfiltrate|share)\b[^.\n]{0,50}\b(?:senhas?|tokens?|chaves?\s+(?:de\s+api|secretas?|privadas?)|api[\s_-]?keys?|segredos?|credenciais|credentials|secrets?|passwords?|private\s+keys?|refresh[\s_-]?tokens?|\.env|vari[aá]veis\s+de\s+ambiente|environment\s+variables)\b/i,
  },
  {
    id: 'desvio_pagamento',
    motivo: 'pede para trocar destinatário, conta, PIX ou valor',
    peso: 2,
    padrao: /\b(?:alter\w*|mud\w*|troc\w*|substitu\w*|atualiz\w*|redirecion\w*|use|usar|utilize|change|replace|update|redirect|switch|set)\b[^.\n]{0,40}\b(?:destinat[aá]rio|recipient|beneficiary|benefici[aá]rio|chave\s+pix|pix|conta\s+(?:banc[aá]ria|de\s+destino|corrente)|bank\s+account|iban|wallet|carteira|e-?mail\s+de\s+destino|valor|amount|total)\b[^.\n]{0,40}\b(?:para|por|to|with)\b/i,
  },
  {
    id: 'transferir_dinheiro',
    motivo: 'ordena mover dinheiro ou fazer pagamento',
    peso: 2,
    padrao: /\b(?:transfira|transferir|pague\s+agora|fa[cç]a\s+(?:um\s+)?(?:pix|pagamento|transfer[eê]ncia)|envie\s+(?:r\$|\d+\s*(?:reais|usd|btc))|wire|send\s+(?:all|the\s+funds|\$|\d+)|transfer\s+(?:all|the\s+funds|\$|\d+))\b/i,
  },
  {
    id: 'alvo_ia',
    motivo: 'dirige instruções ao assistente/IA/Jarvis dentro do conteúdo',
    peso: 2,
    padrao: /(?:^|\n)\s*(?:note|aviso|nota|importante|important|attention|aten[cç][aã]o)?\s*(?:to|para|ao|à|pra)?\s*(?:o\s+|a\s+)?(?:the\s+)?(?:assistente|assistant|jarvis|claude|(?:a\s+)?ia|ai|llm|modelo|agente|agent|bot)\s*[,:!-]|\b(?:note|message|instruction)s?\s+(?:to|for)\s+(?:the\s+)?(?:ai|assistant|llm|model|agent)\b|\b(?:mensagem|instru[cç][aã]o|aviso|recado)\s+(?:para|pra)\s+(?:a\s+)?(?:ia|assistente|jarvis)\b|\bse\s+voc[eê]\s+(?:é|e)\s+(?:uma?\s+)?(?:ia|assistente|modelo|llm)\b|\bif\s+you\s+are\s+(?:an?\s+)?(?:ai|assistant|llm|language\s+model)\b|\bas\s+an?\s+(?:ai|assistant)\s*,\s*you\s+(?:must|should|will)\b/i,
  },
  {
    id: 'ordem_acao_sensivel',
    motivo: 'ordena que o assistente execute ação sensível (enviar, apagar, publicar, aprovar)',
    peso: 2,
    padrao: /\b(?:execute|rode|chame|use\s+a\s+ferramenta|call\s+the\s+tool|run\s+the\s+tool|invoke)\b[^.\n]{0,40}\b(?:ferramenta|tool|fun[cç][aã]o|function|comando|command|mcp__\w+)\b|\b(?:aprove|aprovar|approve)\b[^.\n]{0,20}\b(?:automaticamente|sem\s+(?:perguntar|confirmar|aprova[cç][aã]o)|automatically|without\s+(?:asking|confirmation|approval))\b|\b(?:sem\s+(?:avisar|perguntar\s+ao\s+breno|pedir\s+aprova[cç][aã]o)|without\s+(?:telling|asking)\s+(?:the\s+)?user)\b/i,
  },
  {
    id: 'ocultar_do_usuario',
    motivo: 'pede para esconder algo do usuário',
    peso: 2,
    padrao: /\b(?:n[aã]o\s+(?:conte|diga|avise|mencione)\s+(?:isso\s+)?(?:ao|para\s+o)\s+(?:breno|usu[aá]rio|dono)|do\s+not\s+(?:tell|mention|reveal\s+this\s+to)\s+(?:the\s+)?user|keep\s+this\s+(?:secret|hidden)\s+from\s+(?:the\s+)?user)\b/i,
  },
];

// ---------- varredura ----------

function trechoRedigido(texto: string, ini: number, tam: number): string {
  const de = Math.max(0, ini - 15);
  const bruto = texto.slice(de, de + Math.min(TRECHO_MAX, tam + 30)).replace(/\s+/g, ' ').trim();
  return redator.redigir(bruto);
}

function decodificarBase64(b: string): string | null {
  try {
    const t = Buffer.from(b, 'base64').toString('utf8');
    if (!t) return null;
    const imprimiveis = [...t].filter((c) => /[\p{L}\p{N}\p{P}\p{Zs}]/u.test(c)).length;
    return imprimiveis / [...t].length >= 0.85 ? t : null;
  } catch {
    return null;
  }
}

/** Texto sem invisíveis, com Unicode compatível: usado só para casar regras (não é devolvido). */
function normalizarParaRegra(texto: string): string {
  const semInvisiveis = texto.replace(INVISIVEIS, '').replace(ZWJ_SOLTO, '');
  return corrigirHomoglifos(semInvisiveis.normalize('NFKC')).texto;
}

/** Regras de conteúdo + estruturais sobre `bruto`, somando em `achados` (cada regra uma vez). */
function aplicarRegras(bruto: string, achados: Map<string, AchadoInjecao>, prefixo = ''): void {
  const norm = normalizarParaRegra(bruto);
  const add = (id: string, motivo: string, peso: number, trecho: string) => {
    const chave = `${prefixo}${id}`;
    if (!achados.has(chave)) achados.set(chave, { regra: chave, motivo: prefixo ? `${motivo} (dentro de texto codificado)` : motivo, peso, trecho });
  };
  for (const r of REGRAS) {
    const m = r.padrao.exec(norm);
    if (m) add(r.id, r.motivo, r.peso, trechoRedigido(norm, m.index, m[0].length));
  }
  // peso 5 já cobre o "fraco": não soma os dois
  if (achados.has(`${prefixo}ignorar_instrucoes`)) achados.delete(`${prefixo}ignorar_instrucoes_fraco`);
  if (achados.has(`${prefixo}revelar_prompt`) && achados.has(`${prefixo}revelar_segredos`)) achados.get(`${prefixo}revelar_segredos`)!.peso = 5;

  TAG_FALSA.lastIndex = 0;
  const tag = TAG_FALSA.exec(norm);
  if (tag) add('tag_falsa', 'contém tag/marcador que imita sistema, assistente ou resultado de ferramenta', 3, trechoRedigido(norm, tag.index, tag[0].length));
  LINHA_SYSTEM.lastIndex = 0;
  const linha = LINHA_SYSTEM.exec(norm);
  if (linha) add('linha_system', 'linha que se apresenta como "system:"/"assistant:"', 3, trechoRedigido(norm, linha.index, linha[0].length));
}

/**
 * Mede o risco de injeção do texto e devolve uma versão neutralizada.
 * Cada regra vale uma vez; o nível sai da soma dos pesos (ver cabeçalho). Texto vazio = limpo.
 */
export function escanearInjecao(texto: string): ResultadoInjecao {
  if (!texto) return { nivel: 'limpo', motivos: [], achados: [], pontos: 0, texto: texto ?? '', alterado: false };
  const achados = new Map<string, AchadoInjecao>();

  // estruturais (olham o texto cru, antes de qualquer limpeza)
  const invisiveis = texto.match(INVISIVEIS)?.length ?? 0;
  const zwj = texto.match(ZWJ_SOLTO)?.length ?? 0;
  const tagChars = texto.match(TAG_CHARS)?.length ?? 0;
  if (tagChars > 0) achados.set('tag_chars', { regra: 'tag_chars', motivo: 'caracteres Unicode "tag" invisíveis (contrabando de texto)', peso: 5, trecho: `${tagChars} caractere(s)` });
  const nInv = invisiveis - tagChars + zwj;
  if (nInv > 0) achados.set('zero_width', { regra: 'zero_width', motivo: 'caracteres invisíveis (zero-width/bidi) no texto', peso: nInv >= 3 ? 2 : 1, trecho: `${nInv} caractere(s)` });

  const homo = corrigirHomoglifos(texto.replace(INVISIVEIS, '').replace(ZWJ_SOLTO, ''));
  if (homo.trocas > 0) achados.set('homoglifos', { regra: 'homoglifos', motivo: 'letras cirílicas/gregas misturadas com latinas (homóglifos)', peso: homo.trocas >= 2 ? 2 : 1, trecho: `${homo.trocas} letra(s)` });

  const ocultos: string[] = [];
  for (const re of [HTML_COMENTARIO, HTML_OCULTO_ESTILO, HTML_OCULTO_ATRIBUTO, HTML_SCRIPT]) {
    re.lastIndex = 0;
    for (const m of texto.matchAll(re)) ocultos.push(m[0]);
  }
  if (ocultos.length) {
    const conteudo = ocultos.join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // comentário/CSS comum sem texto útil não conta; com texto, é conteúdo que o humano não vê
    achados.set('html_oculto', { regra: 'html_oculto', motivo: 'HTML oculto (comentário, display:none, texto invisível)', peso: conteudo.length >= 20 ? 2 : 0, trecho: trechoRedigido(conteudo, 0, TRECHO_MAX) });
  }

  // regras de conteúdo: texto visível + texto escondido (o ataque costuma estar justamente no escondido)
  aplicarRegras(texto, achados);

  // base64 longo: sinaliza e olha o que tem dentro
  for (const m of texto.matchAll(BASE64_LONGO)) {
    const dec = decodificarBase64(m[0]);
    if (!achados.has('base64_longo')) achados.set('base64_longo', { regra: 'base64_longo', motivo: 'bloco base64 longo no texto', peso: dec ? 2 : 1, trecho: `${m[0].length} caracteres` });
    if (dec) aplicarRegras(dec, achados, 'b64:');
  }

  const lista = [...achados.values()].filter((a) => a.peso > 0);
  const pontos = lista.reduce((s, a) => s + a.peso, 0);
  const nivel: NivelInjecao = pontos >= LIMITE_MALICIOSO ? 'malicioso' : pontos >= LIMITE_SUSPEITO ? 'suspeito' : 'limpo';
  const neutro = neutralizarTexto(texto);
  return {
    nivel,
    motivos: [...new Set(lista.map((a) => a.motivo))],
    achados: lista,
    pontos,
    texto: neutro,
    alterado: neutro !== texto,
  };
}

/**
 * Neutraliza sem apagar conteúdo útil: remove invisíveis, corrige homóglifos (só em palavras mistas), troca HTML oculto
 * e base64 longo por uma marca curta, e escapa tags/marcadores que imitam o sistema (`<system>` vira `‹system›`).
 */
export function neutralizarTexto(texto: string): string {
  if (!texto) return texto;
  let t = texto.replace(INVISIVEIS, '').replace(ZWJ_SOLTO, '');
  t = corrigirHomoglifos(t).texto;
  t = t.replace(HTML_COMENTARIO, ' ').replace(HTML_OCULTO_ESTILO, ' ').replace(HTML_OCULTO_ATRIBUTO, ' ').replace(HTML_SCRIPT, ' ');
  t = t.replace(BASE64_LONGO, (b) => `[base64 removido: ${b.length} caracteres]`);
  t = t.replace(TAG_FALSA, (m) => m.replace(/</g, '‹').replace(/>/g, '›').replace(/\[/g, '(').replace(/\]/g, ')'));
  t = t.replace(LINHA_SYSTEM, (m) => m.replace(/^([ \t]*)(\w+)(\s*):/, '$1$2 (citado)$3 -'));
  return t;
}

/** Junta resultados (várias partes de uma mesma fonte): pior nível, motivos únicos. */
export function combinarResultados(rs: ResultadoInjecao[]): Pick<ResultadoInjecao, 'nivel' | 'motivos'> {
  let nivel: NivelInjecao = 'limpo';
  const motivos = new Set<string>();
  for (const r of rs) {
    nivel = piorNivel(nivel, r.nivel);
    for (const m of r.motivos) motivos.add(m);
  }
  return { nivel, motivos: [...motivos] };
}
