import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  avancarPlanos,
  calcularViabilidade,
  criarCerebroAnthropic,
  enviarAvisosPendentes,
  planejar,
  processarEventoNexus,
  ROTEIROS,
  salvarPlano,
  tratarMensagemMcp,
  validarPlano,
  type Banco,
  type Cerebro,
  type MensagemParaBreno,
} from '@jarvis/core';
import { bancoLimpo, criarEmpresa, NUMERO_BRENO, regrasTeste } from './ajuda.ts';

const regras = regrasTeste();
const SEGREDO = 'segredo-de-aprovacao-com-mais-de-32-caracteres';
let banco: Banco;
let empresa: string;

beforeEach(async () => {
  process.env.JARVIS_CORE_APROVACAO_SEGREDO = SEGREDO;
  banco = await bancoLimpo();
  empresa = await criarEmpresa(banco);
});
afterEach(async () => {
  delete process.env.JARVIS_CORE_APROVACAO_SEGREDO;
  await banco.end();
});

function planoBase(etapas?: unknown[]) {
  return {
    modelo_negocio: 'produto_digital',
    objetivo: 'Vender e-book de gestão para donos de lojas de veículos',
    justificativa_modelo: 'Produto digital não tem estoque nem frete; dá para validar barato.',
    orcamento: { teto_total_brl: 1500, teto_mensal_anuncios_brl: 500, teto_por_compra_brl: 200 },
    viabilidade: {
      custo_fixo_brl: 1200,
      custo_variavel_unitario_brl: 0,
      taxas_percentual: 10,
      preco_venda_brl: 97,
      riscos: ['Conta de anúncios nova tem limite baixo'],
      checagens: {
        politicas_plataforma: 'ok',
        opt_in_whatsapp: 'ok',
        lgpd_consumidor: 'ok',
        fiscal: 'pendente_contador',
        regulacao_produto: 'nao_aplicavel',
      },
    },
    etapas: etapas ?? ROTEIROS.produto_digital.etapas.map((e) => ({ ...e, custo_estimado_brl: 100 })),
  };
}

describe('Fase 3 — viabilidade e validação do plano', () => {
  it('calcula o ponto de empate com taxas', () => {
    expect(calcularViabilidade({ custo_fixo_brl: 1200, custo_variavel_unitario_brl: 0, taxas_percentual: 10, preco_venda_brl: 97, riscos: [], checagens: {} as never })).toEqual({
      margem_unitaria_brl: 87.3,
      vendas_para_empatar: 14,
      viavel: true,
    });
    expect(calcularViabilidade({ custo_fixo_brl: 100, custo_variavel_unitario_brl: 50, taxas_percentual: 0, preco_venda_brl: 40, riscos: [], checagens: {} as never }).viavel).toBe(false);
  });

  it('plano do roteiro é válido; o semáforo vem das regras, não do plano', () => {
    const etapas = ROTEIROS.produto_digital.etapas.map((e) => ({ ...e, nivel_semaforo: 'verde', custo_estimado_brl: 100 }));
    const v = validarPlano(planoBase(etapas), regras);
    expect(v.bloqueios).toEqual([]);
    expect(v.plano.etapas.find((e) => e.etapa_id === 'conta_venda')?.nivel_semaforo).toBe('vermelho');
    expect(v.pendencias).toContain('checagem pendente: fiscal (pendente_contador)');
    expect(v.custo_estimado_brl).toBe(700);
  });

  it('bloqueia: ciclo, dependência inexistente, checagem reprovada, obrigatória como não aplicável, teto, margem', () => {
    const ciclo = validarPlano(
      planoBase([
        { etapa_id: 'a', titulo: 'Etapa A', agente: 'oferta', acao: 'x', depende_de: ['b'] },
        { etapa_id: 'b', titulo: 'Etapa B', agente: 'oferta', acao: 'y', depende_de: ['a', 'zz'] },
      ]),
      regras,
    );
    expect(ciclo.bloqueios.join('|')).toMatch(/ciclo/);
    expect(ciclo.bloqueios.join('|')).toMatch(/"zz", que não existe/);

    const p = planoBase();
    p.viabilidade.checagens.opt_in_whatsapp = 'reprovado';
    p.viabilidade.checagens.fiscal = 'nao_aplicavel';
    p.orcamento.teto_total_brl = 100;
    p.viabilidade.preco_venda_brl = 1;
    p.viabilidade.custo_variavel_unitario_brl = 5;
    const b = validarPlano(p, regras).bloqueios.join('|');
    expect(b).toMatch(/reprovada: opt_in_whatsapp/);
    expect(b).toMatch(/fiscal é obrigatória/);
    expect(b).toMatch(/acima do teto total/);
    expect(b).toMatch(/não fecha a conta/);
  });
});

describe('Fase 3 — cérebro', () => {
  it('pede correção quando o JSON vem inválido e aceita a segunda resposta', async () => {
    const respostas = ['aqui está: {"modelo_negocio":"inexistente"}', '```json\n' + JSON.stringify(planoBase()) + '\n```'];
    const vistas: unknown[] = [];
    const cerebro: Cerebro = { pensar: async (_s, m) => (vistas.push(m.length), respostas.shift()!) };
    const r = await planejar(cerebro, regras, 'crie uma renda extra vendendo e-book para lojistas');
    expect(r.ok).toBe(true);
    expect(vistas).toEqual([1, 3]);
  });

  it('plano honesto com checagem reprovada é bloqueado e não é salvo', async () => {
    const p = planoBase();
    p.viabilidade.checagens.politicas_plataforma = 'reprovado';
    const r = await planejar({ pensar: async () => JSON.stringify(p) }, regras, 'x');
    expect(r).toMatchObject({ ok: false, motivo: 'bloqueado' });
  });

  it('chama a API da Anthropic com cabeçalhos certos', async () => {
    let req: { url: string; init: RequestInit } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      req = { url, init };
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }));
    }) as unknown as typeof fetch;
    const t = await criarCerebroAnthropic({ chave: 'sk-ant-falsa', fetchImpl: f }).pensar('sistema', [{ role: 'user', content: 'oi' }]);
    expect(t).toBe('{}');
    expect(req!.url).toBe('https://api.anthropic.com/v1/messages');
    const h = req!.init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-ant-falsa');
    expect(h['anthropic-version']).toBe('2023-06-01');
    expect(JSON.parse(String(req!.init.body))).toMatchObject({ system: 'sistema', messages: [{ role: 'user', content: 'oi' }] });
  });
});

describe('Fase 3 — orquestração do plano', () => {
  const etapasTeste = [
    { etapa_id: 'a', titulo: 'Primeira etapa', agente: 'jarvis_infra', acao: 'teste_eco', plataforma: 'teste', depende_de: [] },
    { etapa_id: 'b', titulo: 'Etapa que pede OK', agente: 'jarvis_infra', acao: 'teste_vermelho', plataforma: 'teste', depende_de: ['a'] },
    { etapa_id: 'c', titulo: 'Etapa final', agente: 'jarvis_infra', acao: 'teste_eco', plataforma: 'teste', depende_de: ['a', 'b'] },
  ];

  async function aprovarPeloWhatsApp() {
    const msgs: MensagemParaBreno[] = [];
    await enviarAvisosPendentes(banco, async (m) => void msgs.push(m), SEGREDO);
    const botao = msgs.at(-1)!.botoes!.find((b) => b.titulo === 'Aprovar')!;
    return processarEventoNexus(banco, regras, { tipo: 'botao', numero: NUMERO_BRENO, botao_id: botao.id });
  }

  async function concluir(etapa: string) {
    await banco.query(`update tarefas set status = 'concluida' where etapa_id = $1`, [etapa]);
  }

  it('aprovação do plano → etapas andam na ordem; vermelha pede OK; fim → negócio ativo', async () => {
    const v = validarPlano(planoBase(etapasTeste), regras);
    const { planoId, negocioId } = await salvarPlano(banco, regras, { empresaId: empresa, nomeNegocio: 'E-book lojistas', validado: v, quem: 'teste' });
    expect(await avancarPlanos(banco, regras)).toEqual({ criadas: 0 }); // ainda não aprovado

    expect(await aprovarPeloWhatsApp()).toEqual({ tipo: 'aprovacao', resultado: 'aprovada' });
    expect((await banco.query(`select status from planos where id = $1`, [planoId])).rows[0].status).toBe('aprovado');

    expect(await avancarPlanos(banco, regras)).toEqual({ criadas: 1 }); // só "a"
    expect(await avancarPlanos(banco, regras)).toEqual({ criadas: 0 }); // não duplica
    await concluir('a');
    expect(await avancarPlanos(banco, regras)).toEqual({ criadas: 1 }); // "b"
    const b = await banco.query(`select status, nivel_semaforo from tarefas where etapa_id = 'b'`);
    expect(b.rows[0]).toEqual({ status: 'aguardando_aprovacao', nivel_semaforo: 'vermelho' });
    await concluir('b');
    expect(await avancarPlanos(banco, regras)).toEqual({ criadas: 1 }); // "c"
    await concluir('c');
    await avancarPlanos(banco, regras);
    expect((await banco.query(`select status from planos where id = $1`, [planoId])).rows[0].status).toBe('concluido');
    expect((await banco.query(`select status from negocios where id = $1`, [negocioId])).rows[0].status).toBe('ativo');
  });

  it('etapa que falha trava o plano e avisa o Breno uma vez', async () => {
    const v = validarPlano(planoBase(etapasTeste), regras);
    const { planoId } = await salvarPlano(banco, regras, { empresaId: empresa, nomeNegocio: 'X', validado: v, quem: 'teste' });
    await aprovarPeloWhatsApp();
    await avancarPlanos(banco, regras);
    await banco.query(`update tarefas set status = 'falhou' where etapa_id = 'a'`);
    await avancarPlanos(banco, regras);
    await avancarPlanos(banco, regras);
    expect((await banco.query(`select status from planos where id = $1`, [planoId])).rows[0].status).toBe('travado');
    const av = await banco.query(`select count(*)::int as n from avisos where conteudo->>'texto' like '%travou%'`);
    expect(av.rows[0].n).toBe(1);
  });

  it('plano recusado não anda', async () => {
    const v = validarPlano(planoBase(etapasTeste), regras);
    const { token, planoId } = await salvarPlano(banco, regras, { empresaId: empresa, nomeNegocio: 'X', validado: v, quem: 'teste' });
    await processarEventoNexus(banco, regras, { tipo: 'botao', numero: NUMERO_BRENO, botao_id: `recusar:${token}` });
    expect((await banco.query(`select status from planos where id = $1`, [planoId])).rows[0].status).toBe('recusado');
    expect(await avancarPlanos(banco, regras)).toEqual({ criadas: 0 });
  });

  it('plano bloqueado não pode ser salvo', async () => {
    const p = planoBase(etapasTeste);
    p.viabilidade.checagens.lgpd_consumidor = 'reprovado';
    await expect(salvarPlano(banco, regras, { empresaId: empresa, nomeNegocio: 'X', validado: validarPlano(p, regras), quem: 't' })).rejects.toThrow(/bloqueado/);
  });
});

describe('Fase 3 — plano proposto pelo Claude (MCP)', () => {
  const chamar = (args: Record<string, unknown>) =>
    tratarMensagemMcp(banco, regras, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'jarvis_propor_plano', arguments: args } }) as Promise<{
      result: { content: { text: string }[] };
    }>;

  it('plano válido é gravado e vai para aprovação', async () => {
    const r = await chamar({ empresa_id: empresa, nome_negocio: 'E-book lojistas', plano: planoBase() });
    const d = JSON.parse(r.result.content[0]!.text);
    expect(d).toMatchObject({ aceito: true, viabilidade: { vendas_para_empatar: 14 } });
    const p = await banco.query(`select status from planos where id = $1`, [d.plano_id]);
    expect(p.rows[0].status).toBe('aguardando_aprovacao');
    const av = await banco.query(`select count(*)::int as n from avisos where tipo = 'pedido_aprovacao'`);
    expect(av.rows[0].n).toBe(1);
  });

  it('plano com bloqueio volta com os motivos e nada é gravado', async () => {
    const p = planoBase();
    p.viabilidade.checagens.politicas_plataforma = 'reprovado';
    const r = await chamar({ empresa_id: empresa, nome_negocio: 'Negócio X', plano: p });
    expect(JSON.parse(r.result.content[0]!.text)).toMatchObject({ aceito: false, bloqueios: ['checagem reprovada: politicas_plataforma'] });
    expect((await banco.query(`select count(*)::int as n from planos`)).rows[0].n).toBe(0);
  });
});
