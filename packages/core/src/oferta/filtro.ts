// Filtro de promessas e afirmações proibidas (seção 24, Oferta: "não prometer resultados garantidos").
// Não substitui a revisão do Breno: só aponta o que é claramente problemático.

export interface Problema {
  gravidade: 'bloqueio' | 'aviso';
  trecho: string;
  motivo: string;
}

const REGRAS: { re: RegExp; gravidade: Problema['gravidade']; motivo: string }[] = [
  { re: /\b(resultados?|ganhos?|lucros?|renda|aprova[çc][ãa]o)\s+garantid[oa]s?\b/gi, gravidade: 'bloqueio', motivo: 'promessa de resultado garantido' },
  { re: /\bgarant(?:imos|o|e)\s+(?:que\s+)?(?:voc[êe]\s+)?(?:vai\s+)?(?:ganhar|lucrar|faturar|vender|aprovar|emagrecer)/gi, gravidade: 'bloqueio', motivo: 'promessa de resultado garantido' },
  { re: /\b(?:ganhe|fature|lucre)\s+(?:at[ée]\s+)?R\$\s?[\d.,]+(?:\s*mil)?/gi, gravidade: 'bloqueio', motivo: 'promessa de ganho em dinheiro' },
  { re: /\b(?:fique|ficar)\s+ric[oa]\b/gi, gravidade: 'bloqueio', motivo: 'promessa de enriquecimento' },
  { re: /\b(?:em|a partir de)\s+\d+\s+(?:dias|horas|semanas)\s+(?:voc[êe]\s+)?(?:vai\s+)?(?:ganhar|lucrar|faturar|resolver|curar)/gi, gravidade: 'bloqueio', motivo: 'promessa de resultado com prazo' },
  { re: /\b100\s?%\s+(?:garantido|aprovado|certo|eficaz)\b/gi, gravidade: 'bloqueio', motivo: 'afirmação absoluta de eficácia' },
  { re: /\b(?:cura|curar|milagros[oa]|milagre)\b/gi, gravidade: 'bloqueio', motivo: 'promessa de cura/milagre (risco regulatório)' },
  { re: /\bsem\s+(?:nenhum\s+)?(?:esfor[çc]o|trabalho|risco)\b/gi, gravidade: 'aviso', motivo: '"sem esforço/risco" costuma ser enganoso' },
  { re: /\b(?:[úu]ltimas?\s+vagas?|s[óo]\s+hoje|acaba\s+hoje|[úu]ltimas?\s+unidades?)\b/gi, gravidade: 'aviso', motivo: 'urgência: só use se for verdade' },
  { re: /\b(?:clientes?|alunos?)\s+(?:dizem|disseram|afirmam)\b/gi, gravidade: 'aviso', motivo: 'depoimento: precisa ser real e autorizado' },
];

// \b do JavaScript não entende acentos ("Últimas"): troca por uma fronteira que entende letras Unicode.
const FRONTEIRA = '(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))';
const COMPILADAS = REGRAS.map((r) => ({ ...r, re: new RegExp(r.re.source.split('\\b').join(FRONTEIRA), 'giu') }));

export function verificarPromessas(texto: string): Problema[] {
  const achados: Problema[] = [];
  for (const r of COMPILADAS) {
    for (const m of texto.matchAll(r.re)) achados.push({ gravidade: r.gravidade, trecho: m[0], motivo: r.motivo });
  }
  return achados;
}

/** Junta todo o texto de um conteúdo estruturado (para passar no filtro). */
export function textoDe(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(textoDe).join('\n');
  if (v && typeof v === 'object') return Object.values(v).map(textoDe).join('\n');
  return '';
}
