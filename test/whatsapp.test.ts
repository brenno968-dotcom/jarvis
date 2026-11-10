import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assinar,
  buscarTarefa,
  criarLembretesDeAprovacao,
  criarTarefa,
  enviarAvisosPendentes,
  lerEmergencia,
  marcarWebhookVisto,
  notificadorNexus,
  processarEventoNexus,
  verificarAssinatura,
  type Banco,
  type MensagemParaBreno,
} from '@jarvis/core';
import { bancoLimpo, criarEmpresa, NUMERO_BRENO, regrasTeste } from './ajuda.ts';

const regras = regrasTeste();
const SEGREDO = 'segredo-de-aprovacao-com-mais-de-32-caracteres';
const SEGREDO_WEBHOOK = 'segredo-do-webhook-nexus-com-32-caracteres!!';
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

const vermelha = (chave = 'v1') => ({
  empresaId: empresa,
  agente: 'jarvis_infra',
  acao: 'teste_vermelho',
  plataforma: 'teste',
  idempotencyKey: chave,
  resumo: 'Criar conta de teste na plataforma X',
});

describe('assinatura Jarvis ↔ Nexus', () => {
  const agora = 1_800_000_000;
  it('aceita a assinatura certa e recusa o resto', () => {
    const corpo = '{"a":1}';
    const sig = assinar(SEGREDO_WEBHOOK, agora, corpo);
    expect(verificarAssinatura(SEGREDO_WEBHOOK, String(agora), corpo, sig, agora)).toBe('ok');
    expect(verificarAssinatura(SEGREDO_WEBHOOK, String(agora), corpo + ' ', sig, agora)).toBe('invalida');
    expect(verificarAssinatura(SEGREDO_WEBHOOK, String(agora - 301), corpo, sig, agora)).toBe('fora_da_janela');
    expect(verificarAssinatura(undefined, String(agora), corpo, sig, agora)).toBe('sem_segredo');
    expect(verificarAssinatura('curto', String(agora), corpo, sig, agora)).toBe('sem_segredo');
    expect(verificarAssinatura(SEGREDO_WEBHOOK, null, corpo, sig, agora)).toBe('faltando');
    expect(verificarAssinatura(SEGREDO_WEBHOOK, String(agora), corpo, 'zz', agora)).toBe('invalida');
  });

  it('o mesmo webhook não é processado duas vezes', async () => {
    expect(await marcarWebhookVisto(banco, 'abc123')).toBe(true);
    expect(await marcarWebhookVisto(banco, 'abc123')).toBe(false);
  });

  it('notificador assina o que manda ao Nexus', async () => {
    let recebido: { corpo: string; ts: string; sig: string } | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      recebido = { corpo: String(init.body), ts: h['x-jarvis-timestamp']!, sig: h['x-jarvis-assinatura']! };
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await notificadorNexus('https://nexus.exemplo/avisos', SEGREDO_WEBHOOK, fakeFetch)({ aviso_id: 'x', tipo: 'texto', texto: 'oi' });
    expect(verificarAssinatura(SEGREDO_WEBHOOK, recebido!.ts, recebido!.corpo, recebido!.sig)).toBe('ok');
  });
});

describe('aprovação pelo WhatsApp de ponta a ponta', () => {
  it('pedido vai com botões; o toque no botão aprova a tarefa', async () => {
    const { tarefa } = await criarTarefa(banco, regras, vermelha(), 'teste');
    const enviadas: MensagemParaBreno[] = [];
    const r = await enviarAvisosPendentes(banco, async (m) => void enviadas.push(m), SEGREDO);
    expect(r.enviados).toBe(1);
    expect(enviadas[0]!.texto).toContain('Criar conta de teste na plataforma X');
    const botao = enviadas[0]!.botoes!.find((b) => b.titulo === 'Aprovar')!;

    // o token não fica guardado em lugar nenhum
    const tok = botao.id.split(':')[1]!;
    for (const t of ['avisos', 'aprovacoes', 'auditoria']) {
      const q = await banco.query(`select count(*)::int as n from ${t} where ${t}::text like $1`, [`%${tok}%`]);
      expect(q.rows[0].n, t).toBe(0);
    }

    const res = await processarEventoNexus(banco, regras, { tipo: 'botao', numero: NUMERO_BRENO, botao_id: botao.id });
    expect(res).toEqual({ tipo: 'aprovacao', resultado: 'aprovada' });
    expect((await buscarTarefa(banco, tarefa.id))?.status).toBe('aprovada');

    const de_novo = await processarEventoNexus(banco, regras, { tipo: 'botao', numero: NUMERO_BRENO, botao_id: botao.id });
    expect(de_novo).toEqual({ tipo: 'aprovacao', resultado: 'ja_respondida' });
  });

  it('botão vindo de outro número não aprova', async () => {
    await criarTarefa(banco, regras, vermelha(), 'teste');
    const enviadas: MensagemParaBreno[] = [];
    await enviarAvisosPendentes(banco, async (m) => void enviadas.push(m), SEGREDO);
    const res = await processarEventoNexus(banco, regras, {
      tipo: 'botao',
      numero: '5511988887777',
      botao_id: enviadas[0]!.botoes![0]!.id,
    });
    expect(res).toEqual({ tipo: 'aprovacao', resultado: 'numero_nao_autorizado' });
  });

  it('aprovação já respondida não é enviada', async () => {
    const { tokenAprovacao } = await criarTarefa(banco, regras, vermelha(), 'teste');
    await processarEventoNexus(banco, regras, { tipo: 'botao', numero: NUMERO_BRENO, botao_id: `recusar:${tokenAprovacao}` });
    const r = await enviarAvisosPendentes(banco, async () => {}, SEGREDO);
    expect(r).toEqual({ enviados: 0, descartados: 1, falhas: 0 });
  });

  it('falha no envio tenta de novo e desiste depois de 5', async () => {
    await banco.query(`insert into avisos (tipo, conteudo) values ('texto', '{"texto":"oi"}')`);
    const falhar = async () => {
      throw new Error('Nexus fora do ar');
    };
    for (let i = 0; i < 5; i++) {
      await enviarAvisosPendentes(banco, falhar, SEGREDO);
      await banco.query(`update avisos set proxima_tentativa_em = now()`);
    }
    const r = await banco.query(`select status, tentativas from avisos`);
    expect(r.rows[0]).toEqual({ status: 'falhou', tentativas: 5 });
  });

  it('lembrete sai uma vez só', async () => {
    await criarTarefa(banco, regras, vermelha(), 'teste');
    expect(await criarLembretesDeAprovacao(banco, 15)).toBe(0);
    await banco.query(`update aprovacoes set criado_em = now() - interval '20 minutes'`);
    expect(await criarLembretesDeAprovacao(banco, 15)).toBe(1);
    expect(await criarLembretesDeAprovacao(banco, 15)).toBe(0);
  });
});

describe('"PARA TUDO" pelo WhatsApp', () => {
  it('do número do Breno para tudo e avisa', async () => {
    await criarTarefa(banco, regras, { ...vermelha(), acao: 'teste_eco', resumo: undefined }, 'teste');
    const r = await processarEventoNexus(banco, regras, { tipo: 'texto', numero: NUMERO_BRENO, texto: ' para tudo ' });
    expect(r).toEqual({ tipo: 'emergencia', canceladas: 1 });
    expect((await lerEmergencia(banco)).parado).toBe(true);
    const av = await banco.query(`select tipo from avisos where tipo = 'emergencia'`);
    expect(av.rowCount).toBe(1);
  });

  it('de outro número é ignorado', async () => {
    const r = await processarEventoNexus(banco, regras, { tipo: 'texto', numero: '5511988887777', texto: 'PARA TUDO' });
    expect(r).toEqual({ tipo: 'ignorado', motivo: 'número não autorizado' });
    expect((await lerEmergencia(banco)).parado).toBe(false);
  });

  it('evento malformado é ignorado', async () => {
    expect(await processarEventoNexus(banco, regras, { tipo: 'botao', numero: NUMERO_BRENO, botao_id: 'apagar:x' })).toEqual({
      tipo: 'ignorado',
      motivo: 'evento inválido',
    });
  });
});
