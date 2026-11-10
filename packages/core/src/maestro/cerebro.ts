// "Cérebro" do Maestro: transforma o comando do Breno num plano (seção 24, Maestro).
// A IA só PROPÕE: o plano passa pela validação (seção 11) e pela aprovação do Breno.
import { requisitarJson } from '../http.ts';
import type { Regras } from '../regras.ts';
import { ROTEIROS } from './modelos.ts';
import { validarPlano, type PlanoValidado } from './plano.ts';

export interface Cerebro {
  /** Devolve o texto da resposta da IA (deve conter um JSON de plano). */
  pensar(sistema: string, mensagens: { role: 'user' | 'assistant'; content: string }[]): Promise<string>;
}

export function criarCerebroAnthropic(o: { chave: string; modelo?: string; fetchImpl?: typeof fetch }): Cerebro {
  return {
    async pensar(sistema, mensagens) {
      const r = await requisitarJson<{ content: { type: string; text?: string }[] }>('https://api.anthropic.com/v1/messages', {
        metodo: 'POST',
        fetchImpl: o.fetchImpl,
        cabecalhos: { 'x-api-key': o.chave, 'anthropic-version': '2023-06-01' },
        corpo: { model: o.modelo ?? 'claude-sonnet-5-5', max_tokens: 8000, system: sistema, messages: mensagens },
        timeoutMs: 120_000,
      });
      return r.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
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
