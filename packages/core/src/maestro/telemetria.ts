// Telemetria por chamada de LLM (item 791): tokens, custo, latência e modelo, gravados em `llm_chamadas`.
// Regra de ouro: telemetria NUNCA derruba a chamada. O gravador é injetado por interface (testa-se sem banco).
import type { Banco } from '../banco.ts';
import { log } from '../log.ts';
import { redator } from '../redacao.ts';
import { calcularCusto, tokensDoUso, type UsoAnthropic } from './precos.ts';

/** De onde veio a chamada (tudo opcional). */
export interface ContextoLlm {
  /** Para que serve a chamada: 'plano', 'conversa', 'oferta'... (coluna `finalidade`). */
  finalidade?: string;
  /** Override explícito do modelo desta chamada (vale sobre o mapa por finalidade e a heurística; item 792). */
  modelo?: string;
  tarefaId?: string;
  empresaId?: string;
  negocioId?: string;
}

/** Uma linha de `llm_chamadas`, já com custo calculado. */
export interface ChamadaLlm {
  modelo: string;
  finalidade: string;
  tarefaId?: string;
  empresaId?: string;
  negocioId?: string;
  tokensEntrada: number;
  tokensSaida: number;
  tokensCacheLeitura: number;
  tokensCacheEscrita: number;
  custoUsd: number | null;
  custoBrl: number | null;
  latenciaMs: number;
  statusHttp: number | null;
  erro: string | null;
  stopReason: string | null;
  /** Modelo de onde a chamada caiu (fallback, item 792); nulo = chamada normal. */
  fallbackDe?: string | null;
}

export interface GravadorLlm {
  gravar(chamada: ChamadaLlm): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOuNulo = (v: string | undefined): string | null => (v && UUID.test(v) ? v : null);

/** Grava no Postgres. Ids que não são UUID viram nulos (a telemetria não pode falhar por FK/formato). */
export function criarGravadorBanco(banco: Pick<Banco, 'query'>): GravadorLlm {
  return {
    async gravar(c) {
      const base = [
        uuidOuNulo(c.empresaId),
        uuidOuNulo(c.negocioId),
        uuidOuNulo(c.tarefaId),
        c.modelo,
        c.finalidade,
        c.tokensEntrada,
        c.tokensSaida,
        c.tokensCacheLeitura,
        c.tokensCacheEscrita,
        c.custoUsd,
        c.custoBrl,
        c.latenciaMs,
        c.statusHttp,
        c.erro,
        c.stopReason,
      ];
      try {
        await banco.query(
          `insert into llm_chamadas
             (empresa_id, negocio_id, tarefa_id, modelo, finalidade, tokens_entrada, tokens_saida, tokens_cache_leitura,
              tokens_cache_escrita, custo_usd, custo_brl, latencia_ms, status_http, erro, stop_reason, fallback_de)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [...base, c.fallbackDe ?? null],
        );
      } catch (e) {
        // 42703 = coluna inexistente: a migration 0014 ainda não foi aplicada. Grava sem `fallback_de`.
        if ((e as { code?: string })?.code !== '42703') throw e;
        await banco.query(
          `insert into llm_chamadas
             (empresa_id, negocio_id, tarefa_id, modelo, finalidade, tokens_entrada, tokens_saida, tokens_cache_leitura,
              tokens_cache_escrita, custo_usd, custo_brl, latencia_ms, status_http, erro, stop_reason)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          base,
        );
      }
    },
  };
}

export interface DadosChamada {
  modelo: string;
  contexto?: ContextoLlm;
  finalidadePadrao: string;
  uso?: UsoAnthropic | null;
  latenciaMs: number;
  statusHttp: number | null;
  erro?: string | null;
  stopReason?: string | null;
  fallbackDe?: string | null;
}

/** Monta a linha (com custo) a partir do que a chamada devolveu. */
export function montarChamada(d: DadosChamada, env: Record<string, string | undefined> = process.env): ChamadaLlm {
  const t = tokensDoUso(d.uso);
  const custo = calcularCusto(d.modelo, t, env);
  return {
    modelo: d.modelo,
    finalidade: (d.contexto?.finalidade ?? d.finalidadePadrao).slice(0, 80),
    tarefaId: d.contexto?.tarefaId,
    empresaId: d.contexto?.empresaId,
    negocioId: d.contexto?.negocioId,
    tokensEntrada: t.entrada,
    tokensSaida: t.saida,
    tokensCacheLeitura: t.cacheLeitura,
    tokensCacheEscrita: t.cacheEscrita,
    custoUsd: custo?.usd ?? null,
    custoBrl: custo?.brl ?? null,
    latenciaMs: Math.max(0, Math.round(d.latenciaMs)),
    statusHttp: d.statusHttp,
    erro: d.erro ? redator.redigir(d.erro).slice(0, 300) : null,
    stopReason: d.stopReason ?? null,
    fallbackDe: d.fallbackDe ?? null,
  };
}

/**
 * Grava sem bloquear e sem nunca rejeitar: erro (síncrono ou assíncrono) do gravador só vira log.
 * Devolve a promessa para quem quiser esperar (testes); o chamador normal ignora.
 */
export function registrarChamada(gravador: GravadorLlm | undefined, chamada: () => ChamadaLlm): Promise<void> {
  if (!gravador) return Promise.resolve();
  try {
    return Promise.resolve(gravador.gravar(chamada())).catch((e: unknown) => avisarFalha(e));
  } catch (e) {
    avisarFalha(e);
    return Promise.resolve();
  }
}

function avisarFalha(e: unknown): void {
  try {
    log('aviso', 'telemetria de LLM não gravada', { erro: String((e as Error)?.message ?? e).slice(0, 200) });
  } catch {
    /* nem o log pode derrubar a chamada */
  }
}

// ---------------------------------------------------------------- consulta (tool MCP jarvis_custos)

export type AgruparCustos = 'dia' | 'modelo' | 'finalidade';

export interface FiltroCustos {
  /** Janela em dias a partir de agora (padrão 7). Ignorada se `desde` vier. */
  dias?: number;
  desde?: string;
  ate?: string;
  agruparPor?: AgruparCustos;
}

const COLUNA_GRUPO: Record<AgruparCustos, string> = {
  dia: `to_char((criado_em at time zone 'America/Sao_Paulo')::date, 'YYYY-MM-DD')`,
  modelo: 'modelo',
  finalidade: 'finalidade',
};

export async function resumirCustos(banco: Pick<Banco, 'query'>, f: FiltroCustos = {}) {
  const agrupar = f.agruparPor ?? 'dia';
  const grupo = COLUNA_GRUPO[agrupar]; // vem de lista fechada: seguro para interpolar
  const dias = Math.min(366, Math.max(1, Math.floor(f.dias ?? 7)));
  const r = await banco.query(
    `select ${grupo} as grupo,
            count(*)::int as chamadas,
            count(*) filter (where erro is not null or status_http = 0 or status_http >= 400)::int as erros,
            count(*) filter (where custo_usd is null)::int as sem_preco,
            coalesce(sum(tokens_entrada), 0)::float8 as tokens_entrada,
            coalesce(sum(tokens_saida), 0)::float8 as tokens_saida,
            coalesce(sum(tokens_cache_leitura), 0)::float8 as tokens_cache_leitura,
            coalesce(sum(tokens_cache_escrita), 0)::float8 as tokens_cache_escrita,
            coalesce(sum(custo_usd), 0)::float8 as custo_usd,
            coalesce(sum(custo_brl), 0)::float8 as custo_brl,
            round(avg(latencia_ms))::int as latencia_media_ms,
            max(latencia_ms)::int as latencia_max_ms
       from llm_chamadas
      where criado_em >= coalesce($1::timestamptz, now() - make_interval(days => $3::int))
        and ($2::timestamptz is null or criado_em < $2::timestamptz)
      group by 1
      order by 1 ${agrupar === 'dia' ? 'desc' : 'asc'}
      limit 400`,
    [f.desde ?? null, f.ate ?? null, dias],
  );
  const linhas = r.rows as Array<Record<string, unknown>>;
  const soma = (k: string) => linhas.reduce((s, l) => s + Number(l[k] ?? 0), 0);
  const arred = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    agrupado_por: agrupar,
    total: {
      chamadas: soma('chamadas'),
      erros: soma('erros'),
      sem_preco: soma('sem_preco'),
      tokens_entrada: soma('tokens_entrada'),
      tokens_saida: soma('tokens_saida'),
      custo_usd: arred(soma('custo_usd')),
      custo_brl: arred(soma('custo_brl')),
    },
    grupos: linhas,
  };
}
