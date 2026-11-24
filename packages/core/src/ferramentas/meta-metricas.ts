// Item 852: ferramenta `meta_metricas` (verde, SÓ LEITURA). Desempenho dos anúncios da Meta por período e nível.
// 1) Lê do banco (`metricas_campanha`, gravada pela rotina diária `ler_metricas_meta`) quando o nível é conta/campanha e as
//    métricas pedidas existem lá; 2) senão (sem dado no período, ou nível/métrica que o banco não tem) chama a Graph API
//    SÓ com GET em `/{conta}/insights` (e `/{conta}?fields=currency`). Nunca escreve nada na Meta.
// Contas: só as cadastradas no kit (`kit_base`, recurso `conta_anuncios`), por negócio. Token: `JARVIS_CORE_META_ADS_TOKEN`
// (o mesmo do adaptador do worker), lido do ambiente e nunca devolvido.
import { z } from 'zod';
import type { Consultavel } from '../banco.ts';
import { ErroHttp, requisitarJson } from '../http.ts';
import type { FerramentaIa } from '../nexus-mcp.ts';
import { redator } from '../redacao.ts';
import { ProvedorAmbiente, SegredoAusente } from '../segredos.ts';
import { NOME_META_METRICAS } from './nomes.ts';

export const TOKEN_META_ADS = 'JARVIS_CORE_META_ADS_TOKEN';
export const MAX_DIAS_META = 90;
export const PADRAO_DIAS_META = 7;
export const MAX_ITENS_META = 10;
export const PADRAO_ITENS_META = 5;
const LIMITE_GRAPH = 500;

export const METRICAS = ['gasto', 'impressoes', 'cliques', 'ctr', 'cpc', 'cpm', 'alcance', 'frequencia', 'conversoes', 'custo_por_resultado'] as const;
export type Metrica = (typeof METRICAS)[number];
export const NIVEIS = ['conta', 'campanha', 'conjunto', 'anuncio'] as const;
export type Nivel = (typeof NIVEIS)[number];
const PADRAO_METRICAS: Metrica[] = ['gasto', 'impressoes', 'cliques', 'ctr', 'cpc', 'conversoes', 'custo_por_resultado'];
/** O banco só guarda isto por dia e campanha; alcance e frequência (e conjunto/anúncio) só a Graph API tem. */
const METRICAS_DO_BANCO = new Set<Metrica>(['gasto', 'impressoes', 'cliques', 'ctr', 'cpc', 'cpm', 'conversoes', 'custo_por_resultado']);

/** Campos de insights que esta ferramenta pode pedir à Graph API (os do adaptador + os de nível e alcance/frequência). */
export const CAMPOS_GRAPH_PERMITIDOS: ReadonlySet<string> = new Set([
  'spend', 'impressions', 'clicks', 'actions', 'reach', 'frequency',
  'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
]);
const NIVEL_GRAPH: Record<Nivel, string> = { conta: 'account', campanha: 'campaign', conjunto: 'adset', anuncio: 'ad' };
const CAMPOS_DO_NIVEL: Record<Nivel, { id: string; nome: string } | null> = {
  conta: null,
  campanha: { id: 'campaign_id', nome: 'campaign_name' },
  conjunto: { id: 'adset_id', nome: 'adset_name' },
  anuncio: { id: 'ad_id', nome: 'ad_name' },
};
// mesmas ações que o adaptador do worker soma como lead e venda
const ACOES_LEAD = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
const ACOES_VENDA = ['purchase', 'offsite_conversion.fb_pixel_purchase'];

const semAcento = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[\s-]+/g, '_');
const ALIAS_METRICA: Record<string, Metrica> = { resultados: 'conversoes', resultado: 'conversoes', conversao: 'conversoes', impressao: 'impressoes', custo_por_conversao: 'custo_por_resultado', cpr: 'custo_por_resultado' };

const dataIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'data no formato AAAA-MM-DD');

const esquemaArgs = z
  .object({
    negocio: z.string().trim().min(1).max(120).optional(),
    conta: z.string().trim().regex(/^(act_)?\d{1,20}$/, 'conta no formato act_123').optional(),
    dias: z.coerce.number().int().optional(),
    desde: dataIso.optional(),
    ate: dataIso.optional(),
    nivel: z
      .string()
      .transform(semAcento)
      .pipe(z.enum(NIVEIS))
      .optional(),
    metricas: z
      .array(z.string().transform((m) => { const n = semAcento(m); return ALIAS_METRICA[n] ?? n; }).pipe(z.enum(METRICAS)))
      .min(1)
      .max(METRICAS.length)
      .optional(),
    limite: z.coerce.number().int().min(1).max(MAX_ITENS_META).optional(),
  })
  .strict();

export const ferramentaMetaMetricas: FerramentaIa = {
  name: NOME_META_METRICAS,
  description:
    'Métricas dos anúncios da Meta (só leitura): gasto, impressões, cliques, ctr, cpc, cpm, alcance, frequência, conversões (leads + vendas) e custo por resultado. ' +
    'Padrão: últimos 7 dias; máximo 90. Nível: conta, campanha, conjunto ou anuncio. Devolve totais e as maiores linhas por gasto, em reais. ' +
    'Lê do banco do Jarvis e só vai à Meta se faltar dado. Não altera nada nos anúncios.',
  input_schema: {
    type: 'object',
    properties: {
      negocio: { type: 'string', description: 'Nome ou id do negócio (opcional se só houver uma conta de anúncios)' },
      conta: { type: 'string', description: 'Conta de anúncios cadastrada (act_123), opcional' },
      dias: { type: 'integer', minimum: 1, maximum: MAX_DIAS_META, description: 'Últimos N dias até ontem (padrão 7)' },
      desde: { type: 'string', description: 'AAAA-MM-DD (use com "ate", no lugar de "dias")' },
      ate: { type: 'string', description: 'AAAA-MM-DD' },
      nivel: { type: 'string', enum: [...NIVEIS], description: 'Padrão: campanha' },
      metricas: { type: 'array', items: { type: 'string', enum: [...METRICAS] }, description: 'Padrão: gasto, impressoes, cliques, ctr, cpc, conversoes, custo_por_resultado' },
      limite: { type: 'integer', minimum: 1, maximum: MAX_ITENS_META, description: `Linhas no ranking por gasto (padrão ${PADRAO_ITENS_META})` },
    },
  },
};

// ---------- período ----------

export const diaSP = (d: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const somarDias = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const diasEntre = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
const dataValida = (iso: string): boolean => Number.isFinite(Date.parse(`${iso}T00:00:00Z`)) && new Date(`${iso}T00:00:00Z`).toISOString().startsWith(iso);

export interface Periodo {
  desde: string;
  ate: string;
  dias: number;
}

export function resolverPeriodo(a: { dias?: number; desde?: string; ate?: string }, agora: Date): Periodo | string {
  const ontem = somarDias(diaSP(agora), -1);
  if (a.desde || a.ate) {
    if (a.dias !== undefined) return 'Use "dias" OU "desde" e "ate", não os dois.';
    if (!a.desde || !a.ate) return 'Informe "desde" e "ate" juntos.';
    if (!dataValida(a.desde) || !dataValida(a.ate)) return 'Data inválida (use AAAA-MM-DD).';
    if (a.desde > a.ate) return '"desde" não pode ser depois de "ate".';
    if (a.ate > diaSP(agora)) return '"ate" não pode estar no futuro.';
    const n = diasEntre(a.desde, a.ate);
    if (n > MAX_DIAS_META) return `Período de ${n} dias passa do máximo de ${MAX_DIAS_META}. Peça um intervalo menor.`;
    return { desde: a.desde, ate: a.ate, dias: n };
  }
  const dias = a.dias ?? PADRAO_DIAS_META;
  if (dias < 1) return 'O período mínimo é 1 dia.';
  if (dias > MAX_DIAS_META) return `Período de ${dias} dias passa do máximo de ${MAX_DIAS_META}. Peça um intervalo menor.`;
  return { desde: somarDias(ontem, -(dias - 1)), ate: ontem, dias };
}

// ---------- contas ----------

interface AlvoMeta {
  conta: string;
  negocioIds: string[];
  negocioNome: string | null;
}

const contaCurta = (conta: string) => `act_…${conta.replace(/\D/g, '').slice(-4)}`;
const nomeSeguro = (t: string, max = 60) => redator.redigir(t.replace(/[<>]|\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, max);

async function resolverAlvo(db: Consultavel, a: { negocio?: string; conta?: string }): Promise<AlvoMeta | string> {
  const { rows } = await db.query(
    `select k.identificador as conta, n.id as negocio_id, n.nome as negocio_nome
       from kit_base k join negocios n on n.empresa_id = k.empresa_id
      where k.recurso = 'conta_anuncios' and k.ativo
      order by n.criado_em, n.nome`,
  );
  const todas = rows as { conta: string; negocio_id: string; negocio_nome: string }[];
  const conta = a.conta ? (a.conta.startsWith('act_') ? a.conta : `act_${a.conta}`) : undefined;
  const neg = a.negocio ? semAcento(a.negocio).replace(/_/g, ' ') : undefined;
  const candidatas = todas.filter(
    (l) => (!conta || l.conta === conta) && (!neg || l.negocio_id === a.negocio || semAcento(l.negocio_nome).replace(/_/g, ' ').includes(neg)),
  );
  const contas = [...new Set(candidatas.map((l) => l.conta))];
  if (!todas.length) return 'Não há conta de anúncios da Meta cadastrada no kit de nenhuma empresa.';
  if (!contas.length) {
    const nomes = [...new Set(todas.map((l) => nomeSeguro(l.negocio_nome)))].slice(0, 10).join(', ');
    return `Não achei essa conta/negócio entre as cadastradas. Negócios com conta de anúncios: ${nomes}.`;
  }
  if (contas.length > 1) {
    const opcoes = contas.slice(0, 10).map((c) => `${contaCurta(c)} (${[...new Set(candidatas.filter((l) => l.conta === c).map((l) => nomeSeguro(l.negocio_nome)))].join(', ')})`);
    return `Há mais de uma conta de anúncios. Diga o negócio ou a conta: ${opcoes.join('; ')}.`;
  }
  const doAlvo = candidatas.filter((l) => l.conta === contas[0]);
  return { conta: contas[0]!, negocioIds: doAlvo.map((l) => l.negocio_id), negocioNome: neg ? nomeSeguro(doAlvo[0]!.negocio_nome) : null };
}

// ---------- cálculo e formato ----------

interface Linha {
  nome: string;
  gasto: number;
  impressoes: number;
  cliques: number;
  conversoes: number | null;
  alcance: number | null;
  frequencia: number | null;
}

const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const arred = (n: number | null, casas = 2): number | null => (n === null ? null : Math.round(n * 10 ** casas) / 10 ** casas);

function moeda(valor: number | null, codigo: string): string | null {
  if (valor === null) return null;
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: codigo }).format(valor).replace(/\u00a0/g, ' ');
  } catch {
    return `${codigo} ${valor.toFixed(2)}`;
  }
}

function formatarLinha(l: Linha, pedidas: Metrica[], cod: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of pedidas) {
    switch (m) {
      case 'gasto': out.gasto = moeda(arred(l.gasto), cod); break;
      case 'impressoes': out.impressoes = l.impressoes; break;
      case 'cliques': out.cliques = l.cliques; break;
      case 'ctr': { const v = arred(div(l.cliques * 100, l.impressoes)); out.ctr = v === null ? null : `${String(v).replace('.', ',')}%`; break; }
      case 'cpc': out.cpc = moeda(arred(div(l.gasto, l.cliques)), cod); break;
      case 'cpm': out.cpm = moeda(arred(div(l.gasto * 1000, l.impressoes)), cod); break;
      case 'alcance': out.alcance = l.alcance; break;
      case 'frequencia': out.frequencia = arred(l.frequencia); break;
      case 'conversoes': out.conversoes = l.conversoes; break;
      case 'custo_por_resultado': out.custo_por_resultado = l.conversoes === null ? null : moeda(arred(div(l.gasto, l.conversoes)), cod); break;
    }
  }
  return out;
}

function totalDe(linhas: Linha[]): Linha {
  const soma = (f: (l: Linha) => number) => linhas.reduce((s, l) => s + f(l), 0);
  const unica = linhas.length === 1 ? linhas[0]! : null; // alcance e frequência não se somam entre linhas
  return {
    nome: 'total',
    gasto: soma((l) => l.gasto),
    impressoes: soma((l) => l.impressoes),
    cliques: soma((l) => l.cliques),
    conversoes: linhas.some((l) => l.conversoes === null) ? null : soma((l) => l.conversoes ?? 0),
    alcance: unica?.alcance ?? null,
    frequencia: unica?.frequencia ?? null,
  };
}

// ---------- fontes ----------

export interface EventoMetaMetricas {
  desfecho: 'ok' | 'erro';
  fonte?: 'banco' | 'graph_api';
  nivel?: Nivel;
  dias?: number;
  motivo?: string;
}

export interface DepsMetaMetricas {
  banco: Consultavel;
  fetchImpl?: typeof fetch;
  /** Token da Meta (padrão: variável JARVIS_CORE_META_ADS_TOKEN). Nunca é devolvido nem registrado. */
  obterToken?: () => Promise<string>;
  versaoApi?: string;
  agora?: () => Date;
}

async function lerDoBanco(db: Consultavel, negocioIds: string[], p: Periodo): Promise<{ linhas: Linha[]; diasComDado: number } | null> {
  const r = await db.query(
    `select c.nome, coalesce(sum(m.gasto_brl), 0) as gasto, coalesce(sum(m.impressoes), 0) as impressoes, coalesce(sum(m.cliques), 0) as cliques,
            coalesce(sum(m.leads), 0) + coalesce(sum(m.vendas), 0) as conversoes, count(distinct m.dia) as dias
       from campanhas c join metricas_campanha m on m.campanha_id = c.id
      where c.plataforma = 'meta' and c.negocio_id = any($1::uuid[]) and m.dia between $2 and $3
      group by c.id, c.nome
      order by sum(m.gasto_brl) desc`,
    [negocioIds, p.desde, p.ate],
  );
  const rows = r.rows as { nome: string; gasto: string; impressoes: string; cliques: string; conversoes: string; dias: string }[];
  if (!rows.length) return null;
  const linhas: Linha[] = rows.map((x) => ({
    nome: nomeSeguro(x.nome),
    gasto: Number(x.gasto),
    impressoes: Number(x.impressoes),
    cliques: Number(x.cliques),
    conversoes: Number(x.conversoes),
    alcance: null,
    frequencia: null,
  }));
  return { linhas, diasComDado: Math.max(...rows.map((x) => Number(x.dias))) };
}

interface LinhaInsight {
  spend?: string;
  impressions?: string;
  clicks?: string;
  reach?: string;
  frequency?: string;
  actions?: { action_type: string; value: string }[];
  [campo: string]: unknown;
}

const somaAcoes = (lista: LinhaInsight['actions'], tipos: string[]) => (lista ?? []).filter((a) => tipos.includes(a.action_type)).reduce((s, a) => s + Number(a.value || 0), 0);

async function lerDaGraph(d: DepsMetaMetricas, conta: string, p: Periodo, nivel: Nivel, pedidas: Metrica[]): Promise<{ linhas: Linha[]; moeda: string | null; truncado: boolean } | string> {
  let token: string;
  try {
    token = await (d.obterToken ? d.obterToken() : new ProvedorAmbiente().obter(TOKEN_META_ADS));
  } catch (e) {
    if (e instanceof SegredoAusente) return 'Sem dado no banco para esse período e o token da Meta não está disponível neste ambiente.';
    throw e;
  }
  const versao = d.versaoApi ?? process.env.JARVIS_META_API_VERSAO ?? 'v21.0';
  const api = `https://graph.facebook.com/${versao}`;
  const campos = new Set(['spend', 'impressions', 'clicks']);
  if (pedidas.includes('conversoes') || pedidas.includes('custo_por_resultado')) campos.add('actions');
  if (pedidas.includes('alcance')) campos.add('reach');
  if (pedidas.includes('frequencia')) campos.add('frequency');
  const ids = CAMPOS_DO_NIVEL[nivel];
  if (ids) {
    campos.add(ids.id);
    campos.add(ids.nome);
  }
  for (const c of campos) if (!CAMPOS_GRAPH_PERMITIDOS.has(c)) throw new Error(`campo fora da allowlist: ${c}`);
  const qs = new URLSearchParams({
    level: NIVEL_GRAPH[nivel],
    fields: [...campos].join(','),
    time_range: JSON.stringify({ since: p.desde, until: p.ate }),
    limit: String(LIMITE_GRAPH),
  });
  // somente GET (requisitarJson usa GET por padrão); o token vai no cabeçalho, nunca na URL
  const r = await requisitarJson<{ data?: LinhaInsight[]; paging?: { next?: string } }>(`${api}/${conta}/insights?${qs}`, { token, fetchImpl: d.fetchImpl, timeoutMs: 9_000 });
  let cod: string | null = null;
  try {
    const c = await requisitarJson<{ currency?: string }>(`${api}/${conta}?fields=currency`, { token, fetchImpl: d.fetchImpl, timeoutMs: 3_000 });
    cod = c.currency && /^[A-Z]{3}$/.test(c.currency) ? c.currency : null;
  } catch {
    /* sem a moeda: assume BRL e avisa */
  }
  const comConversao = campos.has('actions');
  const linhas: Linha[] = (r.data ?? []).map((x) => ({
    nome: ids ? nomeSeguro(String(x[ids.nome] ?? x[ids.id] ?? 'sem nome')) : 'conta',
    gasto: Number(x.spend ?? 0),
    impressoes: Number(x.impressions ?? 0),
    cliques: Number(x.clicks ?? 0),
    conversoes: comConversao ? somaAcoes(x.actions, [...ACOES_LEAD, ...ACOES_VENDA]) : null,
    alcance: x.reach === undefined ? null : Number(x.reach),
    frequencia: x.frequency === undefined ? null : Number(x.frequency),
  }));
  return { linhas, moeda: cod, truncado: Boolean(r.paging?.next) };
}

// ---------- execução ----------

/** Nunca lança: erro vira texto curto para o modelo. */
export async function executarMetaMetricas(bruto: Record<string, unknown>, d: DepsMetaMetricas, aoUsar?: (e: EventoMetaMetricas) => void): Promise<string> {
  const falha = (motivo: string, msg: string) => {
    aoUsar?.({ desfecho: 'erro', motivo });
    return msg;
  };
  const p = esquemaArgs.safeParse(bruto);
  if (!p.success) return falha('argumentos', `Erro em meta_metricas: ${p.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ').slice(0, 300)}.`);
  const a = p.data;
  const periodo = resolverPeriodo(a, d.agora?.() ?? new Date());
  if (typeof periodo === 'string') return falha('periodo', `Erro em meta_metricas: ${periodo}`);
  const nivel: Nivel = a.nivel ?? 'campanha';
  const pedidas = [...new Set(a.metricas ?? PADRAO_METRICAS)];
  const limite = a.limite ?? PADRAO_ITENS_META;
  try {
    const alvo = await resolverAlvo(d.banco, a);
    if (typeof alvo === 'string') return falha('conta', alvo);
    const avisos: string[] = [];
    let fonte: 'banco' | 'graph_api' = 'banco';
    let linhas: Linha[] | null = null;
    let cod = 'BRL';
    let diasComDado: number | undefined;
    if ((nivel === 'conta' || nivel === 'campanha') && pedidas.every((m) => METRICAS_DO_BANCO.has(m))) {
      const b = await lerDoBanco(d.banco, alvo.negocioIds, periodo);
      if (b) {
        linhas = b.linhas;
        diasComDado = b.diasComDado;
        if (b.diasComDado < periodo.dias) avisos.push(`o banco tem dado de ${b.diasComDado} de ${periodo.dias} dias neste período`);
      }
    }
    if (!linhas) {
      const g = await lerDaGraph(d, alvo.conta, periodo, nivel, pedidas);
      if (typeof g === 'string') return falha('sem_fonte', g);
      fonte = 'graph_api';
      linhas = g.linhas;
      if (g.moeda) cod = g.moeda;
      else avisos.push('não confirmei a moeda da conta; valores tratados como reais');
      if (g.truncado) avisos.push(`a Meta tem mais de ${LIMITE_GRAPH} linhas; o ranking usa só as ${LIMITE_GRAPH} primeiras`);
      if (alvo.negocioNome) avisos.push('a leitura na Meta vale para a conta inteira, não só para esse negócio');
    }
    if (!linhas.length) {
      aoUsar?.({ desfecho: 'ok', fonte, nivel, dias: periodo.dias });
      return JSON.stringify({ fonte, periodo, nivel, conta: contaCurta(alvo.conta), itens_total: 0, avisos: [...avisos, 'sem dados no período'] });
    }
    if (nivel !== 'conta' && pedidas.some((m) => m === 'alcance' || m === 'frequencia')) avisos.push('alcance e frequência por linha não somam: o total não os traz');
    const ordenadas = [...linhas].sort((x, y) => y.gasto - x.gasto);
    const topo = nivel === 'conta' ? [] : ordenadas.slice(0, limite);
    const saida = {
      fonte,
      ...(alvo.negocioNome ? { negocio: alvo.negocioNome } : {}),
      conta: contaCurta(alvo.conta),
      periodo,
      nivel,
      moeda: cod,
      ...(diasComDado !== undefined ? { dias_com_dado: diasComDado } : {}),
      totais: formatarLinha(totalDe(linhas), pedidas, cod),
      itens_total: nivel === 'conta' ? 1 : linhas.length,
      itens: topo.map((l) => ({ nome: l.nome, ...formatarLinha(l, pedidas, cod) })),
      ...(nivel !== 'conta' && linhas.length > topo.length ? { itens_omitidos: linhas.length - topo.length } : {}),
      ...(avisos.length ? { avisos } : {}),
    };
    aoUsar?.({ desfecho: 'ok', fonte, nivel, dias: periodo.dias });
    return redator.redigir(JSON.stringify(saida));
  } catch (e) {
    const msg = e instanceof ErroHttp ? e.erro.mensagem : redator.redigir(String((e as Error)?.message ?? e)).slice(0, 200);
    return falha('erro', `Erro ao ler as métricas da Meta: ${msg}`);
  }
}
