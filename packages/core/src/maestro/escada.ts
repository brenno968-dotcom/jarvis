// Item 792: escada de modelos (haiku → sonnet → opus) e fallback entre degraus.
// Inspirado no roteador do OpenJarvis (seleção por complexidade) sem copiar o desenho: aqui a escolha é por
// finalidade (mapa fixo) e, quando a finalidade não está no mapa, por heurística de complexidade do pedido.
// Opus só entra com `permitir_opus: true`. Tudo é função pura/injetável (relógio e espera), para dar para testar.
import { z } from 'zod';
import { ErroHttp } from '../http.ts';

export const DEGRAUS = ['haiku', 'sonnet', 'opus'] as const;
export type Degrau = (typeof DEGRAUS)[number];
const degrau = z.enum(DEGRAUS);

export const PALAVRAS_PADRAO = {
  raciocinio: ['analise', 'analisar', 'compar', 'estrateg', 'planej', 'diagnostic', 'investig', 'otimiz', 'passo a passo', 'por que', 'tradeoff', 'priorizar'],
  codigo: ['codigo', 'funcao', 'typescript', 'refator', 'migration', 'stack trace', 'bug', 'sql', 'regex', 'algoritmo', 'implement'],
  dinheiro: ['r$', 'preco', 'pagamento', 'reembolso', 'orcamento', 'fatura', 'imposto', 'comissao', 'margem', 'cobranca', 'pix', 'estorno'],
};

export const esquemaModelos = z.object({
  permitir_opus: z.boolean().default(false),
  degraus: z
    .object({
      haiku: z.string().min(1).default('claude-haiku-5-5'),
      sonnet: z.string().min(1).default('claude-sonnet-5-5'),
      opus: z.string().min(1).default('claude-opus-5-5'),
    })
    .default({}),
  /** finalidade → degrau. Finalidade fora do mapa usa a heurística. */
  por_finalidade: z.record(z.string(), degrau).default({ conversa: 'haiku', plano: 'sonnet', oferta: 'sonnet', proativo: 'sonnet' }),
  heuristica: z
    .object({
      prompt_medio_chars: z.number().int().positive().default(6000),
      prompt_grande_chars: z.number().int().positive().default(20000),
      tools_medio: z.number().int().positive().default(6),
      tools_muitos: z.number().int().positive().default(12),
      /** Pontos para sair do Haiku. */
      subir_sonnet_a_partir: z.number().int().positive().default(2),
      /** Pontos para tentar o Opus (só vale com permitir_opus). */
      subir_opus_a_partir: z.number().int().positive().default(6),
      /** Pontos de cada categoria de palavras que aparecer no pedido. */
      pontos_por_categoria: z.number().int().positive().default(2),
      palavras: z
        .object({
          raciocinio: z.array(z.string()).default(PALAVRAS_PADRAO.raciocinio),
          codigo: z.array(z.string()).default(PALAVRAS_PADRAO.codigo),
          dinheiro: z.array(z.string()).default(PALAVRAS_PADRAO.dinheiro),
        })
        .default({}),
    })
    .default({}),
  fallback: z
    .object({
      status_transitorios: z.array(z.number().int()).default([429, 500, 502, 503, 504, 529]),
      /** Tentativas no mesmo modelo antes de trocar de degrau (1 = não repete). */
      tentativas_por_degrau: z.number().int().min(1).default(2),
      backoff_inicial_ms: z.number().int().min(0).default(300),
      backoff_maximo_ms: z.number().int().min(0).default(2000),
      max_trocas: z.number().int().min(0).default(2),
    })
    .default({}),
});
export type ConfigModelos = z.infer<typeof esquemaModelos>;

export function configModelosPadrao(): ConfigModelos {
  return esquemaModelos.parse({});
}

// ---------------------------------------------------------------- seleção

export interface EntradaEscolha {
  finalidade?: string;
  /** Texto do pedido (sistema + mensagens), só para a heurística. */
  texto?: string;
  nTools?: number;
  /** Override explícito da chamada (modelo por id). Vale sobre mapa e heurística. */
  modelo?: string;
}

export type MotivoEscolha = 'override' | 'finalidade' | 'heuristica' | 'opus_bloqueado';

export interface Escolha {
  modelo: string;
  /** Degrau do modelo; nulo quando o override é um modelo fora da escada (sem fallback de degrau). */
  degrau: Degrau | null;
  motivo: MotivoEscolha;
  /** Pontos da heurística (só quando `motivo` = heuristica). */
  pontos?: number;
}

const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Degrau de um id de modelo (aceita id com data: claude-sonnet-5-5-20261101). */
export function degrauDoModelo(cfg: ConfigModelos, modelo: string): Degrau | null {
  for (const d of DEGRAUS) {
    const id = cfg.degraus[d];
    if (modelo === id || modelo.startsWith(`${id}-`)) return d;
  }
  return null;
}

/** Pontos de complexidade: tamanho do prompt, nº de tools e categorias de palavras (raciocínio/código/dinheiro). */
export function pontuarComplexidade(cfg: ConfigModelos, texto: string, nTools: number): number {
  const h = cfg.heuristica;
  let pontos = 0;
  if (texto.length >= h.prompt_grande_chars) pontos += 2;
  else if (texto.length >= h.prompt_medio_chars) pontos += 1;
  if (nTools >= h.tools_muitos) pontos += 2;
  else if (nTools >= h.tools_medio) pontos += 1;
  const t = semAcento(texto);
  for (const lista of Object.values(h.palavras)) {
    if (lista.some((p) => p && t.includes(semAcento(p)))) pontos += h.pontos_por_categoria;
  }
  return pontos;
}

/** Escolhe o modelo da chamada: override > finalidade mapeada > heurística. Opus nunca sai sem `permitir_opus`. */
export function escolherModelo(cfg: ConfigModelos, e: EntradaEscolha): Escolha {
  let escolha: Escolha;
  if (e.modelo) {
    escolha = { modelo: e.modelo, degrau: degrauDoModelo(cfg, e.modelo), motivo: 'override' };
  } else {
    const mapeado = e.finalidade ? cfg.por_finalidade[e.finalidade] : undefined;
    if (mapeado) {
      escolha = { modelo: cfg.degraus[mapeado], degrau: mapeado, motivo: 'finalidade' };
    } else {
      const pontos = pontuarComplexidade(cfg, e.texto ?? '', e.nTools ?? 0);
      const d: Degrau = pontos >= cfg.heuristica.subir_opus_a_partir ? 'opus' : pontos >= cfg.heuristica.subir_sonnet_a_partir ? 'sonnet' : 'haiku';
      escolha = { modelo: cfg.degraus[d], degrau: d, motivo: 'heuristica', pontos };
    }
  }
  if (escolha.degrau === 'opus' && !cfg.permitir_opus) {
    return { ...escolha, modelo: cfg.degraus.sonnet, degrau: 'sonnet', motivo: 'opus_bloqueado' };
  }
  return escolha;
}

// ---------------------------------------------------------------- fallback

/** Erro que vale repetir/trocar de modelo: status da lista (429/5xx/529) ou falha de rede/timeout (status 0). */
export function erroTransitorio(cfg: ConfigModelos, e: unknown): boolean {
  if (!(e instanceof ErroHttp)) return false;
  return e.status === 0 || cfg.fallback.status_transitorios.includes(e.status);
}

/** Vizinho do degrau. `servidor`: modelo sobrecarregado (desce; haiku sobe). `resposta`: resposta ruim (sobe). */
export function vizinho(cfg: ConfigModelos, d: Degrau, motivo: 'servidor' | 'resposta'): Degrau | null {
  if (motivo === 'servidor') return d === 'opus' ? 'sonnet' : d === 'sonnet' ? 'haiku' : 'sonnet';
  if (d === 'haiku') return 'sonnet';
  if (d === 'sonnet') return cfg.permitir_opus ? 'opus' : null;
  return null;
}

export interface TentativaEscada {
  modelo: string;
  /** Modelo de onde se caiu (nulo na primeira). Vai para `llm_chamadas.fallback_de`. */
  fallbackDe: string | null;
  /** Tempo que ainda sobra para esta tentativa. */
  timeoutMs: number;
}

export interface OpcoesEscada<T> {
  /** A resposta serve? (padrão: sempre). Resposta vazia/inválida faz subir um degrau. */
  valida?: (r: T) => boolean;
  /** Prazo total em ms para todas as tentativas e trocas. */
  timeoutMs: number;
  agora?: () => number;
  dormir?: (ms: number) => Promise<void>;
  /** Cada troca de degrau (para log/auditoria). */
  aoTrocar?: (t: { de: string; para: string; motivo: 'servidor' | 'resposta'; erro?: string }) => void;
}

export interface ResultadoEscada<T> {
  resposta: T;
  modelo: string;
  trocas: number;
  tentativas: number;
}

const dormirPadrao = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Executa `tentar` com repetição curta (backoff) e queda para o degrau vizinho.
 * - erro transitório: repete no mesmo modelo (até `tentativas_por_degrau`), depois troca (sonnet→haiku, haiku→sonnet);
 * - resposta vazia/inválida: troca para cima (haiku→sonnet; sonnet→opus só com a flag);
 * - erro definitivo (400/401/403/404): propaga na hora;
 * - no máximo `max_trocas` trocas; modelo que já falhou por servidor não volta na mesma chamada.
 * Cada tentativa chama `tentar`, que grava a telemetria com o modelo real e `fallbackDe`.
 */
export async function executarComEscada<T>(
  cfg: ConfigModelos,
  inicial: Escolha,
  tentar: (t: TentativaEscada) => Promise<T>,
  o: OpcoesEscada<T>,
): Promise<ResultadoEscada<T>> {
  const agora = o.agora ?? Date.now;
  const dormir = o.dormir ?? dormirPadrao;
  const fim = agora() + o.timeoutMs;
  const f = cfg.fallback;
  let modelo = inicial.modelo;
  let atual: Degrau | null = inicial.degrau;
  let fallbackDe: string | null = null;
  let trocas = 0;
  let tentativas = 0;
  let noModelo = 0;
  let ultimaRuim: { resposta: T } | null = null;
  const caidos = new Set<string>();

  const trocar = (motivo: 'servidor' | 'resposta', erro?: string): boolean => {
    if (!atual || trocas >= f.max_trocas) return false;
    const prox = vizinho(cfg, atual, motivo);
    if (!prox || caidos.has(cfg.degraus[prox])) return false;
    const novo = cfg.degraus[prox];
    o.aoTrocar?.({ de: modelo, para: novo, motivo, erro });
    fallbackDe = modelo;
    caidos.add(modelo);
    modelo = novo;
    atual = prox;
    trocas++;
    noModelo = 0;
    return true;
  };

  for (;;) {
    const sobra = fim - agora();
    if (tentativas > 0 && sobra < 1000) throw new ErroHttp(0, { tipo: 'temporario', codigo: 'REDE', mensagem: 'prazo esgotado antes de uma resposta válida' });
    tentativas++;
    noModelo++;
    try {
      const resposta = await tentar({ modelo, fallbackDe, timeoutMs: Math.max(1000, sobra) });
      if (!o.valida || o.valida(resposta)) return { resposta, modelo, trocas, tentativas };
      ultimaRuim = { resposta };
      if (trocar('resposta')) continue;
      return { resposta, modelo, trocas, tentativas };
    } catch (e) {
      if (!erroTransitorio(cfg, e)) throw e;
      if (noModelo < f.tentativas_por_degrau) {
        const espera = Math.min(f.backoff_maximo_ms, f.backoff_inicial_ms * 2 ** (noModelo - 1), Math.max(0, fim - agora() - 1000));
        if (espera > 0) await dormir(espera);
        continue;
      }
      if (trocar('servidor', e instanceof Error ? e.message : String(e))) continue;
      // sem para onde ir: se uma resposta ruim (mas existente) já veio de outro degrau, devolve-a em vez de falhar
      if (ultimaRuim) return { resposta: ultimaRuim.resposta, modelo, trocas, tentativas };
      throw e;
    }
  }
}
