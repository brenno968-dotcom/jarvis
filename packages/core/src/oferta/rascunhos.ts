// Agente de oferta (Fase 4): produz RASCUNHOS. Publicar é sempre vermelho e depende do OK do Breno.
import { z } from 'zod';
import type { Banco, Consultavel } from '../banco.ts';
import { emTransacao } from '../banco.ts';
import { registrarAuditoria } from '../auditoria.ts';
import { enfileirarAviso } from '../avisos.ts';
import type { Cerebro } from '../maestro/cerebro.ts';
import { textoDe, verificarPromessas, type Problema } from './filtro.ts';

export type TipoRascunho = 'produto' | 'pagina_venda' | 'anuncios' | 'descricao';

export const esquemas = {
  produto: z.object({
    titulo: z.string().min(3),
    publico: z.string().min(3),
    promessa_honesta: z.string().min(10),
    modulos: z.array(z.object({ titulo: z.string(), conteudo: z.string().min(20) })).min(1),
  }),
  pagina_venda: z.object({
    titulo: z.string().min(3),
    subtitulo: z.string().min(3),
    para_quem: z.array(z.string()).min(1),
    o_que_recebe: z.array(z.string()).min(1),
    perguntas: z.array(z.object({ pergunta: z.string(), resposta: z.string() })).default([]),
    preco_brl: z.number().positive(),
    garantia_dias: z.number().int().min(7), // CDC: direito de arrependimento mínimo de 7 dias
    chamada: z.string().min(2),
  }),
  anuncios: z.object({
    variacoes: z
      .array(z.object({ texto_principal: z.string().max(600), titulo: z.string().max(60), descricao: z.string().max(120).default('') }))
      .min(1)
      .max(10),
  }),
  descricao: z.object({ curta: z.string().max(200), longa: z.string().min(20) }),
} satisfies Record<TipoRascunho, z.ZodTypeAny>;

const INSTRUCOES: Record<TipoRascunho, string> = {
  produto:
    'Escreva o conteúdo original do produto (estrutura em módulos/capítulos). Sem copiar materiais de terceiros. JSON: {"titulo","publico","promessa_honesta","modulos":[{"titulo","conteudo"}]}',
  pagina_venda:
    'Escreva a página de venda. Sem promessas de resultado garantido, sem depoimentos inventados, sem urgência falsa. Garantia mínima de 7 dias. JSON: {"titulo","subtitulo","para_quem":[],"o_que_recebe":[],"perguntas":[{"pergunta","resposta"}],"preco_brl","garantia_dias","chamada"}',
  anuncios:
    'Escreva até 5 variações de anúncio para Meta, respeitando as políticas de anúncios (sem promessas de ganho, sem atributos pessoais). JSON: {"variacoes":[{"texto_principal","titulo","descricao"}]}',
  descricao: 'Escreva a descrição do produto. JSON: {"curta","longa"}',
};

function extrairJson(texto: string): unknown {
  const limpo = texto.replace(/```(?:json)?/g, '');
  const a = limpo.indexOf('{');
  const b = limpo.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('a resposta não contém JSON');
  return JSON.parse(limpo.slice(a, b + 1));
}

export interface RascunhoGerado {
  id: string;
  versao: number;
  problemas: Problema[];
  bloqueado: boolean;
}

/** Gera um rascunho com a IA, valida o formato, passa no filtro e grava para revisão. */
export async function gerarRascunho(
  banco: Banco,
  cerebro: Cerebro,
  p: { negocioId: string; tarefaId?: string; tipo: TipoRascunho; briefing: string; quem: string },
): Promise<RascunhoGerado> {
  const sistema = [
    'Você é o agente de Oferta do Jarvis. Produza conteúdo ORIGINAL, em português do Brasil, honesto e sem promessas de resultado.',
    'Nunca invente depoimentos, números ou estatísticas. Tudo é rascunho até o Breno aprovar.',
    INSTRUCOES[p.tipo],
    'Responda SOMENTE com o JSON.',
  ].join('\n');
  const mensagens: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: p.briefing }];
  let conteudo: unknown;
  let ultimoErro = '';
  for (let i = 0; i < 2 && conteudo === undefined; i++) {
    const resposta = await cerebro.pensar(sistema, mensagens);
    try {
      conteudo = esquemas[p.tipo].parse(extrairJson(resposta));
    } catch (e) {
      const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
      ultimoErro = issues ? issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') : String((e as Error).message);
      mensagens.push({ role: 'assistant', content: resposta }, { role: 'user', content: `JSON inválido: ${ultimoErro}. Corrija.` });
    }
  }
  if (conteudo === undefined) throw new Error(`o agente de oferta não gerou um ${p.tipo} válido: ${ultimoErro}`);

  const problemas = verificarPromessas(textoDe(conteudo));
  const bloqueado = problemas.some((x) => x.gravidade === 'bloqueio');
  const titulo = String((conteudo as { titulo?: string }).titulo ?? p.tipo);

  return emTransacao(banco, async (c) => {
    const v = await c.query<{ v: number }>(
      `select coalesce(max(versao), 0) + 1 as v from rascunhos where negocio_id = $1 and tipo = $2`,
      [p.negocioId, p.tipo],
    );
    const versao = v.rows[0]!.v;
    const r = await c.query<{ id: string }>(
      `insert into rascunhos (negocio_id, tarefa_id, tipo, titulo, conteudo, versao, problemas)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [p.negocioId, p.tarefaId ?? null, p.tipo, titulo, JSON.stringify(conteudo), versao, JSON.stringify(problemas)],
    );
    await enfileirarAviso(c, {
      tipo: 'texto',
      conteudo: {
        texto: bloqueado
          ? `Rascunho "${titulo}" (${p.tipo} v${versao}) tem promessa proibida e precisa ser refeito: ${problemas
              .filter((x) => x.gravidade === 'bloqueio')
              .map((x) => `"${x.trecho}"`)
              .join(', ')}.`
          : `Rascunho pronto para sua revisão no painel: "${titulo}" (${p.tipo} v${versao}).${problemas.length ? ` ${problemas.length} ponto(s) de atenção.` : ''}`,
      },
    });
    await registrarAuditoria(c, { quem: p.quem, acao: 'rascunho_gerado', negocioId: p.negocioId, detalhes: { tipo: p.tipo, versao, bloqueado } });
    return { id: r.rows[0]!.id, versao, problemas, bloqueado };
  });
}

/** Revisão do Breno. Rascunho com bloqueio não pode ser aprovado. */
export async function revisarRascunho(
  banco: Banco,
  id: string,
  decisao: 'aprovar' | 'recusar',
  quem: string,
): Promise<'aprovado' | 'recusado' | 'bloqueado' | 'ja_revisado' | 'nao_encontrado'> {
  return emTransacao(banco, async (c) => {
    const r = await c.query<{ status: string; problemas: Problema[]; negocio_id: string }>(
      `select status, problemas, negocio_id from rascunhos where id = $1 for update`,
      [id],
    );
    const rasc = r.rows[0];
    if (!rasc) return 'nao_encontrado';
    if (rasc.status !== 'rascunho') return 'ja_revisado';
    if (decisao === 'aprovar' && rasc.problemas.some((x) => x.gravidade === 'bloqueio')) return 'bloqueado';
    const novo = decisao === 'aprovar' ? 'aprovado' : 'recusado';
    await c.query(`update rascunhos set status = $2, revisado_por = $3, revisado_em = now() where id = $1`, [id, novo, quem]);
    await registrarAuditoria(c, { quem, acao: `rascunho_${novo}`, negocioId: rasc.negocio_id, detalhes: { rascunho: id } });
    return novo;
  });
}

/** Último rascunho aprovado de um tipo (o que pode ser publicado). */
export async function rascunhoAprovado(db: Consultavel, negocioId: string, tipo: TipoRascunho) {
  const r = await db.query(
    `select id, titulo, conteudo, versao from rascunhos where negocio_id = $1 and tipo = $2 and status = 'aprovado'
      order by versao desc limit 1`,
    [negocioId, tipo],
  );
  return r.rows[0] as { id: string; titulo: string; conteudo: unknown; versao: number } | undefined;
}
