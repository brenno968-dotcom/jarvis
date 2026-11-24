// Item 829: coletor de contexto do agente proativo. Junta tarefas, aprovações, avisos do Nexus, métricas Meta,
// memória e custos de UMA empresa, com limites de tamanho. TUDO passa pelo scanner de injeção (item 815): seção
// maliciosa é omitida, suspeita entra neutralizada e marcada, e o pior nível volta para o filtro das propostas.
import type { Consultavel } from '../banco.ts';
import { recordar } from '../memoria/memoria.ts';
import { piorNivel, type NivelInjecao } from '../seguranca/injecao.ts';
import { tratarConteudoExterno, type AoDetectarInjecao } from '../seguranca/taint.ts';
import type { ConfigProativo } from './config.ts';

export interface SecaoContexto {
  nome: string;
  itens: number;
  nivel: NivelInjecao;
  omitida: boolean;
}

export interface ContextoProativo {
  texto: string;
  /** Pior nível de injeção entre as seções. */
  nivel: NivelInjecao;
  secoes: SecaoContexto[];
}

export interface OpcoesColeta {
  aoDetectar?: AoDetectarInjecao;
  /** Busca na memória (testes trocam; padrão `recordar`). Falha aqui nunca derruba a coleta. */
  recordarMemoria?: (banco: Consultavel, consulta: string, empresaId: string, limite: number) => Promise<{ origem: string; referencia: string; texto: string }[]>;
}

const CONSULTA_MEMORIA = 'pendências, decisões, problemas e próximos passos recentes';

const linha = (s: unknown, max: number): string =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const dia = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));

type Coletora = () => Promise<string[]>;

async function seguro(f: Coletora): Promise<string[]> {
  try {
    return await f();
  } catch {
    return []; // tabela/função ausente (migration não aplicada) ou memória fora do ar: a seção some, a rodada segue
  }
}

export async function coletarContexto(banco: Consultavel, empresaId: string, cfg: ConfigProativo, o: OpcoesColeta = {}): Promise<ContextoProativo> {
  const { itens_por_secao: N, chars_por_item: C, max_chars: MAX } = cfg.contexto;

  const secoesBrutas: { nome: string; titulo: string; linhas: Coletora }[] = [
    {
      nome: 'tarefas',
      titulo: 'Tarefas pendentes ou com falha (últimos 3 dias)',
      linhas: async () => {
        const r = await banco.query(
          `select acao, status, plataforma, erro->>'mensagem' as erro, criado_em from tarefas
            where empresa_id = $1 and idempotency_key not like 'proativo:%'
              and (status in ('pendente','erro_temporario','aguardando_humano','aguardando_externo')
                   or (status = 'falhou' and atualizado_em > now() - interval '3 days'))
            order by criado_em desc limit $2`,
          [empresaId, N],
        );
        return r.rows.map((t) => `${dia(t.criado_em)} ${linha(t.acao, 60)}${t.plataforma ? `/${linha(t.plataforma, 30)}` : ''} [${t.status}]${t.erro ? ` erro: ${linha(t.erro, C)}` : ''}`);
      },
    },
    {
      nome: 'aprovacoes',
      titulo: 'Aprovações paradas (esperando o OK do Breno)',
      linhas: async () => {
        const r = await banco.query(
          `select a.resumo, a.criado_em, a.expira_em from aprovacoes a left join tarefas t on t.id = a.tarefa_id
            where a.status = 'pendente' and a.origem_componente is null and (t.empresa_id = $1 or a.tarefa_id is null)
            order by a.criado_em limit $2`,
          [empresaId, N],
        );
        return r.rows.map((a) => `desde ${dia(a.criado_em)}, vence ${dia(a.expira_em)}: ${linha(a.resumo, C)}`);
      },
    },
    {
      nome: 'avisos_nexus',
      titulo: 'Avisos e pedidos vindos do Nexus (últimos 2 dias)',
      linhas: async () => {
        const r = await banco.query(
          `select origem_componente, origem_escopo, status, resumo from aprovacoes
            where origem_componente is not null and (status = 'pendente' or criado_em > now() - interval '2 days')
            order by criado_em desc limit $1`,
          [N],
        );
        return r.rows.map((a) => `${linha(a.origem_componente, 40)}/${linha(a.origem_escopo, 60)} [${a.status}]: ${linha(a.resumo, C)}`);
      },
    },
    {
      nome: 'metricas_meta',
      titulo: 'Métricas Meta (últimos 3 dias, somadas por campanha)',
      linhas: async () => {
        const r = await banco.query(
          `select c.nome, n.id as negocio_id, sum(m.gasto_brl) as gasto, sum(m.impressoes) as impr, sum(m.cliques) as cliques,
                  sum(m.leads) as leads, sum(m.vendas) as vendas, sum(m.receita_brl) as receita
             from metricas_campanha m join campanhas c on c.id = m.campanha_id join negocios n on n.id = c.negocio_id
            where n.empresa_id = $1 and c.plataforma = 'meta' and m.dia >= current_date - 3
            group by c.nome, n.id order by sum(m.gasto_brl) desc limit $2`,
          [empresaId, N],
        );
        return r.rows.map((m) => `${linha(m.nome, 80)} (negocio ${m.negocio_id}): gasto R$ ${m.gasto}, ${m.impr} impressões, ${m.cliques} cliques, ${m.leads} leads, ${m.vendas} vendas, receita R$ ${m.receita}`);
      },
    },
    {
      nome: 'memoria',
      titulo: 'Memória relevante',
      linhas: async () => {
        const busca = o.recordarMemoria ?? (async (b, q, e, l) => (await recordar(b, q, { empresaId: e }, l)).map((t) => ({ origem: t.origem, referencia: t.referencia, texto: t.texto })));
        const trechos = await busca(banco, CONSULTA_MEMORIA, empresaId, Math.min(N, 5));
        return trechos.map((t) => `[${linha(t.origem, 20)}/${linha(t.referencia, 60)}] ${linha(t.texto, C)}`);
      },
    },
    {
      nome: 'custos',
      titulo: 'Custos de IA (últimos 7 dias, R$ por finalidade)',
      linhas: async () => {
        const r = await banco.query(
          `select finalidade, count(*) as chamadas, coalesce(sum(custo_brl), 0) as custo from llm_chamadas
            where criado_em > now() - interval '7 days' and (empresa_id = $1 or empresa_id is null)
            group by finalidade order by sum(custo_brl) desc nulls last limit $2`,
          [empresaId, N],
        );
        return r.rows.map((c) => `${linha(c.finalidade, 40)}: ${c.chamadas} chamadas, R$ ${Number(c.custo).toFixed(2)}`);
      },
    },
  ];

  const secoes: SecaoContexto[] = [];
  const blocos: string[] = [];
  let nivel: NivelInjecao = 'limpo';
  let usado = 0;
  for (const s of secoesBrutas) {
    const linhas = await seguro(s.linhas);
    if (!linhas.length) {
      secoes.push({ nome: s.nome, itens: 0, nivel: 'limpo', omitida: false });
      blocos.push(`## ${s.titulo}\n(nada)`);
      continue;
    }
    const { texto, resultado } = await tratarConteudoExterno(`proativo:${s.nome}`, linhas.join('\n'), o.aoDetectar);
    nivel = piorNivel(nivel, resultado.nivel);
    if (resultado.nivel === 'malicioso') {
      secoes.push({ nome: s.nome, itens: linhas.length, nivel: resultado.nivel, omitida: true });
      blocos.push(`## ${s.titulo}\n(seção omitida: conteúdo com sinais de injeção de prompt)`);
      continue;
    }
    const sobra = Math.max(0, MAX - usado);
    const corpo = texto.slice(0, sobra);
    usado += corpo.length;
    secoes.push({ nome: s.nome, itens: linhas.length, nivel: resultado.nivel, omitida: false });
    const marca = resultado.nivel === 'suspeito' ? ' injecao="suspeito"' : '';
    blocos.push(`## ${s.titulo}\n<dado_externo fonte="${s.nome}"${marca}>\n${corpo}\n</dado_externo>`);
  }
  return { texto: blocos.join('\n\n'), nivel, secoes };
}
