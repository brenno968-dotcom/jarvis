import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  aplicarKitBase,
  emitirCodigo,
  executarSeVencida,
  gravarMetricas,
  kitDaEmpresa,
  lembrarRenovacoes,
  montarRelatorioDiario,
  pararTudo,
  registrarCliente,
  registrarConta,
  registrarRecursoKit,
  renovar,
  ROTEIROS,
  trocarCodigo,
  tratarMensagemMcp,
  usuarioDoToken,
  validarPedidoAutorizacao,
  validarPlano,
  type Banco,
} from '@jarvis/core';
import { agendarLeituraMeta, metasDoNegocio, rodarAgendadas } from '@jarvis/worker';
import { bancoLimpo, criarEmpresa, regrasTeste } from './ajuda.ts';

const regras = regrasTeste();
let banco: Banco;
let empresa: string;

beforeEach(async () => {
  banco = await bancoLimpo();
  empresa = await criarEmpresa(banco);
});
afterEach(async () => banco.end());

async function negocio(modelo = 'produto_digital', status = 'ativo') {
  const r = await banco.query(
    `insert into negocios (empresa_id, nome, modelo_negocio, status, orcamento) values ($1, 'N', $2, $3, '{"teto_mensal_anuncios_brl": 500}') returning id`,
    [empresa, modelo, status],
  );
  return r.rows[0].id as string;
}

describe('rotinas agendadas', () => {
  it('só roda quando vence, e uma vez por janela', async () => {
    let n = 0;
    expect((await executarSeVencida(banco, 'x', 60_000, async () => ++n)).executou).toBe(true);
    expect((await executarSeVencida(banco, 'x', 60_000, async () => ++n)).executou).toBe(false);
    await banco.query(`update rotinas set ultima_execucao = now() - interval '2 minutes'`);
    expect((await executarSeVencida(banco, 'x', 60_000, async () => ++n)).executou).toBe(true);
    expect(n).toBe(2);
  });

  it('dois workers ao mesmo tempo: só um executa', async () => {
    let n = 0;
    const r = await Promise.all([1, 2, 3, 4].map(() => executarSeVencida(banco, 'y', 60_000, async () => ++n)));
    expect(r.filter((x) => x.executou).length).toBe(1);
    expect(n).toBe(1);
  });

  it('o ciclo de rotinas roda tudo na primeira vez e nada na segunda', async () => {
    const a = await rodarAgendadas(banco, regras);
    expect(Object.values(a).every(Boolean)).toBe(true);
    const b = await rodarAgendadas(banco, regras);
    expect(Object.values(b).some(Boolean)).toBe(false);
    const av = await banco.query(`select conteudo->>'texto' as t from avisos`);
    expect(av.rows.some((r) => String(r.t).includes('resumo das últimas 24 h'))).toBe(true);
  });

  it('metas do negócio vêm do preço do plano aprovado', async () => {
    const n = await negocio();
    expect(await metasDoNegocio(banco, n)).toBeNull();
    await banco.query(`insert into planos (negocio_id, conteudo, status) values ($1, '{"viabilidade":{"preco_venda_brl":97}}', 'aprovado')`, [n]);
    expect(await metasDoNegocio(banco, n)).toEqual({ preco_brl: 97, roas_minimo: 1, roas_para_escalar: 3, gasto_minimo_brl: 97 });
  });

  it('leitura diária da Meta: uma tarefa por negócio com campanha ativa e conta no kit', async () => {
    const n = await negocio();
    await banco.query(`insert into campanhas (negocio_id, nome, status, id_externo) values ($1, 'C', 'ativa', '1')`, [n]);
    expect(await agendarLeituraMeta(banco, regras)).toBe(0); // sem conta de anúncios no kit
    await registrarRecursoKit(banco, { empresaId: empresa, recurso: 'conta_anuncios', identificador: 'act_123' });
    expect(await agendarLeituraMeta(banco, regras)).toBe(1);
    expect(await agendarLeituraMeta(banco, regras)).toBe(0);
    const t = await banco.query(`select acao, parametros->>'conta' as conta from tarefas`);
    expect(t.rows).toEqual([{ acao: 'ler_metricas_campanha', conta: 'act_123' }]);
  });
});

describe('relatório diário e renovações', () => {
  it('resume tarefas, vendas, anúncios, aprovações e workers', async () => {
    const n = await negocio();
    await banco.query(`insert into vendas (negocio_id, origem, id_externo, valor_brl, status) values ($1, 'asaas', 'p1', 97, 'paga')`, [n]);
    const c = await banco.query(`insert into campanhas (negocio_id, nome) values ($1, 'C') returning id`, [n]);
    const ontem = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await gravarMetricas(banco, c.rows[0].id, ontem, { gasto_brl: 42.5, impressoes: 1, cliques: 1, leads: 0, vendas: 0, receita_brl: 0 });
    const r = await montarRelatorioDiario(banco);
    expect(r).toContain('Vendas: 1');
    expect(r).toContain('42,50');
    expect(r).toContain('Aprovações esperando você: 0');
  });

  it('avisa renovação uma vez por conta e data', async () => {
    const em5 = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    await registrarConta(banco, { empresaId: empresa, plataforma: 'hotmart', plano: 'pro', renovacaoEm: em5 });
    await registrarConta(banco, { empresaId: empresa, plataforma: 'vercel', renovacaoEm: '2099-01-01' });
    expect(await lembrarRenovacoes(banco)).toBe(1);
    expect(await lembrarRenovacoes(banco)).toBe(0);
  });
});

describe('kit base', () => {
  it('etapas que o kit cobre saem do plano e as dependências são ajustadas', async () => {
    await registrarRecursoKit(banco, { empresaId: empresa, recurso: 'hotmart', identificador: 'conta-hotmart-euro' });
    await registrarRecursoKit(banco, { empresaId: empresa, recurso: 'whatsapp_numero', identificador: '5562999990000' });
    const kit = await kitDaEmpresa(banco, empresa);
    const plano = {
      modelo_negocio: 'produto_digital',
      objetivo: 'Vender e-book de gestão para lojistas',
      justificativa_modelo: 'Sem estoque, validação barata.',
      orcamento: { teto_total_brl: 1500, teto_mensal_anuncios_brl: 500, teto_por_compra_brl: 200 },
      viabilidade: {
        custo_fixo_brl: 600,
        custo_variavel_unitario_brl: 0,
        taxas_percentual: 10,
        preco_venda_brl: 97,
        checagens: { politicas_plataforma: 'ok', opt_in_whatsapp: 'ok', lgpd_consumidor: 'ok', fiscal: 'ok', regulacao_produto: 'nao_aplicavel' },
      },
      etapas: ROTEIROS.produto_digital.etapas.map((e) => ({ ...e, custo_estimado_brl: 50 })),
    };
    const v = aplicarKitBase(validarPlano(plano, regras), kit);
    const ids = v.plano.etapas.map((e) => e.etapa_id);
    expect(ids).not.toContain('conta_venda');
    expect(ids).not.toContain('whatsapp');
    expect(v.reaproveitado.map((r) => r.recurso).sort()).toEqual(['hotmart', 'whatsapp_numero']);
    expect(v.plano.etapas.find((e) => e.etapa_id === 'publicar')!.depende_de).toEqual(['produto']);
    expect(v.custo_estimado_brl).toBe(250);
  });

  it('o plano proposto pelo Claude já usa o kit', async () => {
    await registrarRecursoKit(banco, { empresaId: empresa, recurso: 'dominio', identificador: 'eurocar.com.br' });
    const plano = {
      modelo_negocio: 'servico',
      objetivo: 'Consultoria de gestão para lojistas de veículos',
      justificativa_modelo: 'Serviço com entrega própria.',
      orcamento: { teto_total_brl: 800, teto_mensal_anuncios_brl: 300, teto_por_compra_brl: 200 },
      viabilidade: {
        custo_fixo_brl: 300,
        custo_variavel_unitario_brl: 50,
        taxas_percentual: 5,
        preco_venda_brl: 500,
        checagens: { politicas_plataforma: 'ok', opt_in_whatsapp: 'ok', lgpd_consumidor: 'ok', fiscal: 'ok', regulacao_produto: 'nao_aplicavel' },
      },
      etapas: ROTEIROS.servico.etapas,
    };
    const r = (await tratarMensagemMcp(banco, regras, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'jarvis_propor_plano', arguments: { empresa_id: empresa, nome_negocio: 'Consultoria', plano } },
    })) as { result: { content: { text: string }[] } };
    const d = JSON.parse(r.result.content[0]!.text);
    expect(d.aceito).toBe(true);
    expect(d.reaproveitado_do_kit).toEqual([{ etapa: 'dominio', recurso: 'dominio', identificador: 'eurocar.com.br' }]);
  });
});

describe('OAuth do conector MCP', () => {
  const verificador = 'v'.repeat(50);
  const desafio = createHash('sha256').update(verificador).digest('base64url');
  const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

  it('fluxo completo: registro → autorização → token → acesso → renovação', async () => {
    await expect(registrarCliente(banco, { redirectUris: ['https://golpe.exemplo/cb'] })).rejects.toThrow();
    const { client_id } = await registrarCliente(banco, { nome: 'Claude', redirectUris: [REDIRECT] });

    const pedido = { clientId: client_id, redirectUri: REDIRECT, codeChallenge: desafio, metodo: 'S256', responseType: 'code' };
    expect(await validarPedidoAutorizacao(banco, pedido)).toBeNull();
    expect(await validarPedidoAutorizacao(banco, { ...pedido, metodo: 'plain' })).toMatch(/PKCE/);
    expect(await validarPedidoAutorizacao(banco, { ...pedido, redirectUri: 'https://claude.ai/outro' })).toMatch(/não registrado/);

    const codigo = await emitirCodigo(banco, { clientId: client_id, redirectUri: REDIRECT, codeChallenge: desafio, usuario: 'breno' });
    expect(await trocarCodigo(banco, { codigo, clientId: client_id, redirectUri: REDIRECT, codeVerifier: 'errado'.repeat(8) })).toMatchObject({
      error: 'invalid_grant',
    });
    // código é de uso único: a tentativa errada já o consumiu
    const codigo2 = await emitirCodigo(banco, { clientId: client_id, redirectUri: REDIRECT, codeChallenge: desafio, usuario: 'breno' });
    const tokens = await trocarCodigo(banco, { codigo: codigo2, clientId: client_id, redirectUri: REDIRECT, codeVerifier: verificador });
    if ('error' in tokens) throw new Error(tokens.error_description);
    expect(await usuarioDoToken(banco, tokens.access_token)).toBe('breno');
    expect(await trocarCodigo(banco, { codigo: codigo2, clientId: client_id, redirectUri: REDIRECT, codeVerifier: verificador })).toMatchObject({
      error: 'invalid_grant',
    });

    const novos = await renovar(banco, { refreshToken: tokens.refresh_token, clientId: client_id });
    if ('error' in novos) throw new Error(novos.error_description);
    expect(await renovar(banco, { refreshToken: tokens.refresh_token, clientId: client_id })).toMatchObject({ error: 'invalid_grant' });

    // nada em claro no banco
    const t = await banco.query(`select count(*)::int as n from oauth_tokens where token_hash in ($1, $2)`, [tokens.access_token, novos.access_token]);
    expect(t.rows[0].n).toBe(0);

    // "PARA TUDO" corta o conector
    await pararTudo(banco, 'breno');
    expect(await usuarioDoToken(banco, novos.access_token)).toBeNull();
  });
});
