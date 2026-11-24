// Preços da API da Anthropic por modelo (item 791). USD por MILHÃO de tokens.
// Fonte: https://platform.claude.com/docs/en/about-claude/pricing (antes docs.claude.com), conferida em 24/11/2026.
// Para mudar/incluir um modelo sem alterar código: JARVIS_CORE_PRECOS_LLM com JSON
//   {"claude-novo":{"entrada":1,"saida":5,"cache_leitura":0.1,"cache_escrita":1.25}}
// (cache_escrita_1h e acima_100k são opcionais). Modelo sem preço conhecido => custo nulo (nunca chute).
import { z } from 'zod';

export interface PrecoModelo {
  /** Entrada sem cache, USD por MTok. */
  entrada: number;
  saida: number;
  /** Leitura de cache (cache hit), USD por MTok. */
  cache_leitura: number;
  /** Escrita de cache de 5 minutos (padrão da API), USD por MTok. */
  cache_escrita: number;
  /** Escrita de cache de 1 hora; se ausente, usa cache_escrita. */
  cache_escrita_1h?: number;
  /** Faixa para prompts acima de 100.000 tokens (só o Haiku 5.5 tem preço diferente). */
  acima_100k?: Omit<PrecoModelo, 'acima_100k'>;
}

export const PRECOS_PADRAO: Record<string, PrecoModelo> = {
  'claude-sonnet-5-5': { entrada: 2, saida: 10, cache_leitura: 0.1, cache_escrita: 2.5, cache_escrita_1h: 4 },
  'claude-haiku-5-5': {
    entrada: 0.1,
    saida: 0.5,
    cache_leitura: 0.01,
    cache_escrita: 0.125,
    cache_escrita_1h: 0.2,
    acima_100k: { entrada: 0.5, saida: 2.5, cache_leitura: 0.05, cache_escrita: 0.625, cache_escrita_1h: 1 },
  },
  'claude-opus-5-5': { entrada: 4, saida: 20, cache_leitura: 0.2, cache_escrita: 5, cache_escrita_1h: 8 },
};

/** Câmbio padrão quando JARVIS_CORE_USD_BRL não está definida (valor provisório: ajuste no .env). */
export const CAMBIO_USD_BRL_PADRAO = 5.5;

const numero = z.number().nonnegative().finite();
const faixa = z.object({
  entrada: numero,
  saida: numero,
  cache_leitura: numero,
  cache_escrita: numero,
  cache_escrita_1h: numero.optional(),
});
const esquemaPrecos = z.record(faixa.extend({ acima_100k: faixa.optional() }));

type Ambiente = Record<string, string | undefined>;

/** Tabela efetiva: padrão + o que vier em JARVIS_CORE_PRECOS_LLM (JSON inválido é ignorado, o padrão vale). */
export function tabelaDePrecos(env: Ambiente = process.env): Record<string, PrecoModelo> {
  const extra = env.JARVIS_CORE_PRECOS_LLM;
  if (!extra) return PRECOS_PADRAO;
  try {
    return { ...PRECOS_PADRAO, ...esquemaPrecos.parse(JSON.parse(extra)) };
  } catch {
    return PRECOS_PADRAO;
  }
}

/** Câmbio USD→BRL de JARVIS_CORE_USD_BRL (número > 0) ou o padrão. */
export function cambioUsdBrl(env: Ambiente = process.env): number {
  const n = Number((env.JARVIS_CORE_USD_BRL ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : CAMBIO_USD_BRL_PADRAO;
}

/** Acha o preço: id exato, id com sufixo de data (-20260101) ou o prefixo mais longo cadastrado. */
export function precoDoModelo(modelo: string, env: Ambiente = process.env): PrecoModelo | null {
  const tabela = tabelaDePrecos(env);
  const id = modelo.trim().toLowerCase();
  if (tabela[id]) return tabela[id]!;
  const semData = id.replace(/-\d{8}$/, '');
  if (tabela[semData]) return tabela[semData]!;
  const chaves = Object.keys(tabela)
    .filter((k) => id.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length);
  return chaves.length ? tabela[chaves[0]!]! : null;
}

/** Campo `usage` da resposta da Anthropic (só o que usamos). */
export interface UsoAnthropic {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export interface TokensChamada {
  entrada: number;
  saida: number;
  cacheLeitura: number;
  cacheEscrita: number;
  /** Parte da escrita de cache que foi de 1 hora (0 se a API não detalhou). */
  cacheEscrita1h: number;
}

const inteiro = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** Converte o `usage` da API em contagens seguras (ausente/ruim vira 0). */
export function tokensDoUso(uso: UsoAnthropic | null | undefined): TokensChamada {
  const escrita = inteiro(uso?.cache_creation_input_tokens);
  return {
    entrada: inteiro(uso?.input_tokens),
    saida: inteiro(uso?.output_tokens),
    cacheLeitura: inteiro(uso?.cache_read_input_tokens),
    cacheEscrita: escrita,
    cacheEscrita1h: Math.min(escrita, inteiro(uso?.cache_creation?.ephemeral_1h_input_tokens)),
  };
}

export interface CustoCalculado {
  usd: number;
  brl: number;
  cambio: number;
}

const arredondar = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Custo de uma chamada, ou null se o modelo não tem preço conhecido. */
export function calcularCusto(modelo: string, t: TokensChamada, env: Ambiente = process.env): CustoCalculado | null {
  const base = precoDoModelo(modelo, env);
  if (!base) return null;
  const promptTotal = t.entrada + t.cacheLeitura + t.cacheEscrita;
  const p = promptTotal > 100_000 && base.acima_100k ? base.acima_100k : base;
  const escrita1h = p.cache_escrita_1h ?? p.cache_escrita;
  const usd =
    (t.entrada * p.entrada +
      t.saida * p.saida +
      t.cacheLeitura * p.cache_leitura +
      (t.cacheEscrita - t.cacheEscrita1h) * p.cache_escrita +
      t.cacheEscrita1h * escrita1h) /
    1_000_000;
  const cambio = cambioUsdBrl(env);
  return { usd: arredondar(usd), brl: arredondar(usd * cambio), cambio };
}
