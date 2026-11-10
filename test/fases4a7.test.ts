import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buscarTarefa,
  compararFretes,
  criarPedido,
  criarTarefa,
  decidir,
  derivar,
  devolverPedido,
  EstoqueInsuficiente,
  ehPedidoDescadastro,
  gerarHtmlPaginaVenda,
  gerarRascunho,
  gravarMetricas,
  margemReal,
  normalizarContato,
  normalizarPagamento,
  otimizarCampanhas,
  podeContatar,
  ProvedorMemoria,
  quantoRepor,
  rascunhoAprovado,
  registrarEntrada,
  registrarOptin,
  registrarPagamento,
  resultadoDoNegocio,
  revisarRascunho,
  revogarOptin,
  situacaoOrcamento,
  verificarPromessas,
  verificarReposicao,
  vigiarOrcamentos,
  type Banco,
  type Cerebro,
} from '@jarvis/core';
import { ciclo, criarAdaptadorMetaAds, criarAdaptadorOferta, RegistroAdaptadores, TOKEN_META } from '@jarvis/worker';
import { bancoLimpo, criarEmpresa, regrasTeste } from './ajuda.ts';

const regras = regrasTeste();
let banco: Banco;
let empresa: string;
let negocio: string;

beforeEach(async () => {
  banco = await bancoLimpo();
  empresa = await criarEmpresa(banco);
  const n = await banco.query(
    `insert into negocios (empresa_id, nome, modelo_negocio, orcamento) values ($1, 'E-book lojistas', 'produto_digital', $2) returning id`,
    [empresa, JSON.stringify({ teto_total_brl: 1500, teto_mensal_anuncios_brl: 500, teto_por_compra_brl: 200 })],
  );
  negocio = n.rows[0].id;
});
afterEach(async () => banco.end());

const paginaOk = {
  titulo: 'Gestão de estoque para lojas de veículos',
  subtitulo: 'Um método simples para organizar compras e vendas',
  para_quem: ['Donos de lojas pequenas'],
  o_que_recebe: ['E-book de 80 páginas', 'Planilha de controle'],
  perguntas: [{ pergunta: 'Serve para loja pequena?', resposta: 'Sim, foi pensado para isso.' }],
  preco_brl: 97,
  garantia_dias: 7,
  chamada: 'Quero o e-book',
};

describe('Fase 4 — oferta', () => {
  it('filtro barra promessa de resultado e aponta urgência', () => {
    expect(verificarPromessas('Resultado garantido! Ganhe R$ 5.000 por mês e fique rico.').filter((p) => p.gravidade === 'bloqueio').length).toBe(3);
    expect(verificarPromessas('Últimas vagas!')[0]).toMatchObject({ gravidade: 'aviso' });
    expect(verificarPromessas('Um método simples para organizar o estoque.')).toEqual([]);
  });

  it('rascunho limpo vai para revisão; aprovado pelo Breno vira o "aprovado"', async () => {
    const cerebro: Cerebro = { pensar: async () => JSON.stringify(paginaOk) };
    const r = await gerarRascunho(banco, cerebro, { negocioId: negocio, tipo: 'pagina_venda', briefing: 'e-book de gestão', quem: 'teste' });
    expect(r).toMatchObject({ versao: 1, bloqueado: false });
    expect(await rascunhoAprovado(banco, negocio, 'pagina_venda')).toBeUndefined();
    expect(await revisarRascunho(banco, r.id, 'aprovar', 'breno')).toBe('aprovado');
    expect(await revisarRascunho(banco, r.id, 'recusar', 'breno')).toBe('ja_revisado');
    expect((await rascunhoAprovado(banco, negocio, 'pagina_venda'))?.id).toBe(r.id);
    const av = await banco.query(`select conteudo->>'texto' as t from avisos`);
    expect(av.rows[0].t).toContain('pronto para sua revisão');
  });

  it('rascunho com promessa proibida não pode ser aprovado', async () => {
    const ruim = { ...paginaOk, subtitulo: 'Lucro garantido em 30 dias' };
    const r = await gerarRascunho(banco, { pensar: async () => JSON.stringify(ruim) }, { negocioId: negocio, tipo: 'pagina_venda', briefing: 'x'.repeat(20), quem: 't' });
    expect(r.bloqueado).toBe(true);
    expect(await revisarRascunho(banco, r.id, 'aprovar', 'breno')).toBe('bloqueado');
  });

  it('garantia menor que 7 dias é recusada pelo formato (direito de arrependimento)', async () => {
    const respostas = [JSON.stringify({ ...paginaOk, garantia_dias: 3 }), JSON.stringify(paginaOk)];
    const r = await gerarRascunho(banco, { pensar: async () => respostas.shift()! }, { negocioId: negocio, tipo: 'pagina_venda', briefing: 'x'.repeat(20), quem: 't' });
    expect(r.versao).toBe(1);
    const c = await banco.query(`select conteudo->>'garantia_dias' as g from rascunhos`);
    expect(c.rows[0].g).toBe('7');
  });

  it('página de venda escapa HTML e exige links https', () => {
    const html = gerarHtmlPaginaVenda(
      { ...paginaOk, titulo: '<script>alert(1)</script>' },
      { linkCompra: 'https://pay.hotmart.com/x', linkPrivacidade: 'https://exemplo.com/privacidade' },
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Garantia de 7 dias');
    expect(() => gerarHtmlPaginaVenda(paginaOk, { linkCompra: 'javascript:alert(1)', linkPrivacidade: 'https://x.com' })).toThrow();
  });

  it('o agente de oferta roda como tarefa e não publica nada', async () => {
    const reg = new RegistroAdaptadores().registrar(criarAdaptadorOferta({ banco, cerebro: { pensar: async () => JSON.stringify(paginaOk) } }));
    const { tarefa } = await criarTarefa(
      banco,
      regras,
      { empresaId: empresa, negocioId: negocio, agente: 'oferta', acao: 'produzir_pagina_venda', plataforma: 'oferta', parametros: { briefing: 'página do e-book de gestão' }, idempotencyKey: 'of1' },
      't',
    );
    expect(tarefa.nivel_semaforo).toBe('verde');
    await ciclo({ banco, regras, registro: reg, segredos: new ProvedorMemoria({}), workerId: 'w1' });
    expect(await buscarTarefa(banco, tarefa.id)).toMatchObject({ status: 'concluida', resultado: { mensagem: 'rascunho pronto para revisão' } });
    const st = await banco.query(`select status from rascunhos`);
    expect(st.rows[0].status).toBe('rascunho');
  });
});

describe('Fase 5 — tráfego', () => {
  const metas = { preco_brl: 97, roas_minimo: 1, roas_para_escalar: 3, gasto_minimo_brl: 50 };
  const m = (gasto: number, vendas: number, receita: number) => ({ gasto_brl: gasto, impressoes: 10000, cliques: 200, leads: 20, vendas, receita_brl: receita });

  it('métricas derivadas e regras de decisão', () => {
    expect(derivar(m(100, 2, 194))).toMatchObject({ ctr: 0.02, cpc_brl: 0.5, cpl_brl: 5, cpa_brl: 50, roas: 1.94 });
    expect(decidir(m(20, 0, 0), metas).acao).toBe('esperar');
    expect(decidir(m(200, 0, 0), metas).acao).toBe('pausar');
    expect(decidir(m(300, 2, 194), metas).acao).toBe('pausar'); // retorno 0,65
    expect(decidir(m(100, 4, 388), metas).acao).toBe('sugerir_aumento');
    expect(decidir(m(100, 2, 194), metas).acao).toBe('manter');
  });

  it('orçamento: 80% avisa, teto pausa', () => {
    expect(situacaoOrcamento(399, 500)).toBe('ok');
    expect(situacaoOrcamento(400, 500)).toBe('alerta');
    expect(situacaoOrcamento(500, 500)).toBe('estourou');
  });

  async function campanha(nome = 'Campanha 1', externo = '120000000001') {
    const c = await banco.query(`insert into campanhas (negocio_id, nome, status, id_externo) values ($1, $2, 'ativa', $3) returning id`, [negocio, nome, externo]);
    return c.rows[0].id as string;
  }

  it('vigia de orçamento: aviso uma vez aos 80% e pausa ao estourar', async () => {
    const c = await campanha();
    const hoje = new Date().toISOString().slice(0, 10);
    await gravarMetricas(banco, c, hoje, m(420, 1, 97));
    expect(await vigiarOrcamentos(banco, regras)).toEqual({ alertas: 1, pausas: 0 });
    expect(await vigiarOrcamentos(banco, regras)).toEqual({ alertas: 0, pausas: 0 });
    await gravarMetricas(banco, c, hoje, m(510, 1, 97));
    expect(await vigiarOrcamentos(banco, regras)).toEqual({ alertas: 0, pausas: 1 });
    const t = await banco.query(`select acao, nivel_semaforo, status from tarefas`);
    expect(t.rows).toEqual([{ acao: 'pausar_campanha', nivel_semaforo: 'verde', status: 'pendente' }]);
  });

  it('otimização: pausa campanha sem venda e só SUGERE aumento', async () => {
    const ruim = await campanha('Ruim', '1');
    const boa = await campanha('Boa', '2');
    const hoje = new Date().toISOString().slice(0, 10);
    await gravarMetricas(banco, ruim, hoje, m(250, 0, 0));
    await gravarMetricas(banco, boa, hoje, m(100, 4, 388));
    expect(await otimizarCampanhas(banco, regras, async () => metas)).toEqual({ pausas: 1, sugestoes: 1 });
    const t = await banco.query(`select count(*)::int as n from tarefas where acao = 'aumentar_orcamento'`);
    expect(t.rows[0].n).toBe(0);
  });

  it('adaptador Meta: lê métricas por campanha conhecida e pausa', async () => {
    const c = await campanha('C', '120000000001');
    const chamadas: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      chamadas.push({ url, init });
      if (url.includes('/insights')) {
        return new Response(
          JSON.stringify({
            data: [
              { campaign_id: '120000000001', date_start: '2026-11-01', spend: '50.5', impressions: '1000', clicks: '30', actions: [{ action_type: 'lead', value: '4' }, { action_type: 'purchase', value: '1' }], action_values: [{ action_type: 'purchase', value: '97' }] },
              { campaign_id: '999', date_start: '2026-11-01', spend: '10' },
            ],
          }),
        );
      }
      return new Response(JSON.stringify({ success: true }));
    }) as unknown as typeof fetch;
    const reg = new RegistroAdaptadores().registrar(criarAdaptadorMetaAds({ banco, fetchImpl: f }));
    const opc = { banco, regras, registro: reg, segredos: new ProvedorMemoria({ [TOKEN_META]: 'EAAB-token-falso-123' }), workerId: 'w1' };
    await criarTarefa(banco, regras, { empresaId: empresa, negocioId: negocio, agente: 'trafego', acao: 'ler_metricas_campanha', plataforma: 'meta', parametros: { conta: 'act_123', desde: '2026-11-01', ate: '2026-11-01' }, idempotencyKey: 'l1' }, 't');
    await ciclo(opc);
    const met = await banco.query(`select gasto_brl::float as g, leads, vendas, receita_brl::float as r from metricas_campanha where campanha_id = $1`, [c]);
    expect(met.rows[0]).toEqual({ g: 50.5, leads: 4, vendas: 1, r: 97 });

    await criarTarefa(banco, regras, { empresaId: empresa, negocioId: negocio, agente: 'trafego', acao: 'pausar_campanha', plataforma: 'meta', parametros: { campanha_id: c, id_externo: '120000000001' }, idempotencyKey: 'p1' }, 't');
    await ciclo(opc);
    expect(JSON.parse(String(chamadas.at(-1)!.init.body))).toEqual({ status: 'PAUSED' });
    expect((await banco.query(`select status from campanhas where id = $1`, [c])).rows[0].status).toBe('pausada');
  });
});

describe('Fase 6 — vendas', () => {
  it('opt-in: só contata quem aceitou; descadastro vale na hora', async () => {
    expect(normalizarContato('whatsapp', '(62) 99999-0000')).toBe('5562999990000');
    expect(await podeContatar(banco, negocio, 'whatsapp', '62999990000')).toBe(false);
    await registrarOptin(banco, { negocioId: negocio, canal: 'whatsapp', contato: '62 99999-0000', origem: 'anuncio_meta', textoConsentimento: 'Quero receber informações sobre o e-book pelo WhatsApp' });
    expect(await podeContatar(banco, negocio, 'whatsapp', '+55 (62) 99999-0000')).toBe(true);
    expect(ehPedidoDescadastro('Sair')).toBe(true);
    expect(ehPedidoDescadastro('não quero mais receber')).toBe(true);
    expect(ehPedidoDescadastro('quero saber o preço')).toBe(false);
    expect(await revogarOptin(banco, negocio, 'whatsapp', '62999990000')).toBe(true);
    expect(await podeContatar(banco, negocio, 'whatsapp', '62999990000')).toBe(false);
    await expect(registrarOptin(banco, { negocioId: negocio, canal: 'whatsapp', contato: '62999990000', origem: 'x', textoConsentimento: 'ok' })).rejects.toThrow();
  });

  it('pagamento: registra a venda uma vez, avisa o Breno e entra no resultado; estorno desconta', async () => {
    const ev = normalizarPagamento('asaas', { event: 'PAYMENT_RECEIVED', payment: { id: 'pay_123', value: 97, customer: 'cus_1' } });
    expect(await registrarPagamento(banco, negocio, ev)).toBe('venda_registrada');
    expect(await registrarPagamento(banco, negocio, ev)).toBe('ja_registrada');
    const av = await banco.query(`select conteudo->>'texto' as t from avisos`);
    expect(av.rows[0].t).toContain('Venda feita');
    expect(await resultadoDoNegocio(banco, negocio)).toEqual({ receitas: 97, custos: 0, resultado: 97, vendas: 1 });

    const est = normalizarPagamento('asaas', { event: 'PAYMENT_REFUNDED', payment: { id: 'pay_123', value: 97 } });
    expect(await registrarPagamento(banco, negocio, est)).toBe('estorno_registrado');
    expect(await resultadoDoNegocio(banco, negocio)).toEqual({ receitas: 97, custos: 97, resultado: 0, vendas: 0 });
  });

  it('Hotmart: compra aprovada vira venda; evento desconhecido é ignorado', async () => {
    const ev = normalizarPagamento('hotmart', { event: 'PURCHASE_APPROVED', data: { purchase: { transaction: 'HP123', price: { value: 47 } }, buyer: { email: 'a@b.com' } } });
    expect(ev).toMatchObject({ tipo: 'pago', idExterno: 'HP123', valorBrl: 47, contato: 'a@b.com' });
    expect(await registrarPagamento(banco, negocio, ev)).toBe('venda_registrada');
    expect(await registrarPagamento(banco, negocio, normalizarPagamento('hotmart', { event: 'PURCHASE_DELAYED', data: { purchase: { transaction: 'HP124' } } }))).toBe('ignorado');
  });
});

describe('Fase 7 — produto físico', () => {
  it('pedido baixa o estoque (tudo ou nada), não duplica e devolução repõe', async () => {
    await registrarEntrada(banco, negocio, 'CAPA-01', 5, 12);
    await registrarEntrada(banco, negocio, 'PEL-02', 1, 4);
    const ok = await criarPedido(banco, { negocioId: negocio, canal: 'loja', idExterno: 'P1', itens: [{ sku: 'CAPA-01', quantidade: 2 }], valorBrl: 60 });
    expect(ok.jaExistia).toBe(false);
    expect((await criarPedido(banco, { negocioId: negocio, canal: 'loja', idExterno: 'P1', itens: [{ sku: 'CAPA-01', quantidade: 2 }], valorBrl: 60 })).jaExistia).toBe(true);

    await expect(
      criarPedido(banco, { negocioId: negocio, canal: 'loja', idExterno: 'P2', itens: [{ sku: 'CAPA-01', quantidade: 1 }, { sku: 'PEL-02', quantidade: 3 }], valorBrl: 50 }),
    ).rejects.toBeInstanceOf(EstoqueInsuficiente);
    const q = await banco.query(`select sku, quantidade from estoque order by sku`);
    expect(q.rows).toEqual([{ sku: 'CAPA-01', quantidade: 3 }, { sku: 'PEL-02', quantidade: 1 }]); // nada foi baixado do P2

    expect(await devolverPedido(banco, ok.pedidoId)).toBe(true);
    expect(await devolverPedido(banco, ok.pedidoId)).toBe(false);
    expect((await banco.query(`select quantidade from estoque where sku = 'CAPA-01'`)).rows[0].quantidade).toBe(5);
  });

  it('margem real considera frete, taxas, imposto e devolução', () => {
    expect(
      margemReal({ preco_brl: 100, custo_produto_brl: 35, frete_brl: 18, embalagem_brl: 2, taxa_plataforma_percentual: 12, imposto_percentual: 6, devolucao_percentual: 5, custo_devolucao_brl: 40 }),
    ).toEqual({ margem_brl: 25, margem_percentual: 25 });
  });

  it('reposição sugere compra (vermelha, com OK) só quando vai faltar', async () => {
    expect(quantoRepor({ vendasPorDia: 2, prazoFornecedorDias: 10, segurancaDias: 5, emEstoque: 10 })).toBe(20);
    expect(quantoRepor({ vendasPorDia: 1, prazoFornecedorDias: 5, segurancaDias: 2, emEstoque: 50 })).toBe(0);
    await registrarEntrada(banco, negocio, 'CAPA-01', 70, 12);
    for (let i = 0; i < 60; i++) {
      await criarPedido(banco, { negocioId: negocio, canal: 'loja', idExterno: `X${i}`, itens: [{ sku: 'CAPA-01', quantidade: 1 }], valorBrl: 30 });
    }
    const r = await verificarReposicao(banco, regras, negocio, { prazoFornecedorDias: 10, segurancaDias: 5 });
    expect(r.sugestoes).toEqual([{ sku: 'CAPA-01', quantidade: 20 }]);
    const t = await banco.query(`select acao, nivel_semaforo, status from tarefas`);
    expect(t.rows).toEqual([{ acao: 'comprar_estoque', nivel_semaforo: 'vermelho', status: 'aguardando_aprovacao' }]);
  });

  it('compara fretes por preço e prazo', () => {
    const r = compararFretes([
      { servico: 'PAC', preco_brl: 20, prazo_dias: 9 },
      { servico: 'SEDEX', preco_brl: 32, prazo_dias: 2 },
      { servico: 'Jadlog', preco_brl: 22, prazo_dias: 5 },
    ]);
    expect(r.map((x) => x.servico)).toEqual(['Jadlog', 'SEDEX', 'PAC']);
  });
});
