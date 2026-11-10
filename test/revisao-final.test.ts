import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import {
  buscarTarefa,
  criarTarefa,
  enviarAvisosPendentes,
  exigeConfirmacaoNoPainel,
  pegarProxima,
  processarEventoNexus,
  responderAprovacaoPeloPainel,
  saudeDoJarvis,
  type Banco,
  type MensagemParaBreno,
} from '@jarvis/core';
import { criarAbridorBrowserbase, criarClienteGmail } from '@jarvis/worker';
import { bancoLimpo, criarEmpresa, NUMERO_BRENO, regrasTeste } from './ajuda.ts';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';

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

describe('confirmação dupla (seção 22)', () => {
  it('quais ações pedem o painel também', () => {
    expect(exigeConfirmacaoNoPainel(regras, 'apagar_qualquer_coisa')).toBe(true);
    expect(exigeConfirmacaoNoPainel(regras, 'criar_conta')).toBe(false);
    expect(exigeConfirmacaoNoPainel(regras, 'qualquer_pagamento', { valor_brl: 150 })).toBe(false);
    expect(exigeConfirmacaoNoPainel(regras, 'qualquer_pagamento', { valor_brl: 350 })).toBe(true);
  });

  it('só roda depois do WhatsApp E do painel; recusar em qualquer um basta', async () => {
    const { tarefa } = await criarTarefa(
      banco,
      regras,
      { empresaId: empresa, agente: 'jarvis_infra', acao: 'revogar_chave', plataforma: 'teste', idempotencyKey: 'r1', resumo: 'Revogar a chave antiga da Vercel' },
      't',
    );
    const msgs: MensagemParaBreno[] = [];
    await enviarAvisosPendentes(banco, async (m) => void msgs.push(m), SEGREDO);
    expect(msgs[0]!.texto).toContain('confirme também no painel');
    const ap = await banco.query(`select id from aprovacoes where tarefa_id = $1`, [tarefa.id]);

    expect(await responderAprovacaoPeloPainel(banco, ap.rows[0].id, 'aprovar', 'breno')).toBe('falta_whatsapp');
    const botao = msgs[0]!.botoes!.find((b) => b.titulo === 'Aprovar')!.id;
    expect(await processarEventoNexus(banco, regras, { tipo: 'botao', numero: NUMERO_BRENO, botao_id: botao })).toEqual({
      tipo: 'aprovacao',
      resultado: 'falta_painel',
    });
    expect(await pegarProxima(banco, 'w1')).toBeNull(); // ainda não
    expect(await responderAprovacaoPeloPainel(banco, ap.rows[0].id, 'aprovar', 'breno')).toBe('aprovada');
    expect((await pegarProxima(banco, 'w1'))?.id).toBe(tarefa.id);

    const { tarefa: t2 } = await criarTarefa(
      banco,
      regras,
      { empresaId: empresa, agente: 'jarvis_infra', acao: 'revogar_chave', plataforma: 'teste', idempotencyKey: 'r2', resumo: 'Outra revogação' },
      't',
    );
    const ap2 = await banco.query(`select id from aprovacoes where tarefa_id = $1`, [t2.id]);
    expect(await responderAprovacaoPeloPainel(banco, ap2.rows[0].id, 'recusar', 'breno')).toBe('recusada');
    expect((await buscarTarefa(banco, t2.id))?.status).toBe('recusada');
  });
});

describe('saúde para o Pulso', () => {
  it('sem worker = problema; com worker e nada errado = ok', async () => {
    let s = await saudeDoJarvis(banco);
    expect(s.ok).toBe(false);
    expect(s.problemas).toContain('nenhum worker deu sinal');
    await banco.query(`insert into workers (id) values ('w1')`);
    s = await saudeDoJarvis(banco);
    expect(s).toMatchObject({ ok: true, emergencia: false, tarefas_presas: 0 });
    await banco.query(`insert into aprovacoes (resumo, token_hash, expira_em, criado_em) values ('x', 'h', now() + interval '1 day', now() - interval '2 hours')`);
    s = await saudeDoJarvis(banco);
    expect(s.problemas).toContain('1 aprovação(ões) esperando há mais de 1 h');
  });
});

describe('navegador na nuvem (Browserbase simulado com Chromium local via CDP)', () => {
  it('cria a sessão sem resolver CAPTCHA, entrega o link ao vivo e libera no fim', async () => {
    const porta = 9300 + Math.floor(Math.random() * 500);
    const local = await chromium.launch({ args: [`--remote-debugging-port=${porta}`] });
    const chamadas: { url: string; corpo: unknown }[] = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      chamadas.push({ url, corpo: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/sessions')) return new Response(JSON.stringify({ id: 's1', connectUrl: `http://127.0.0.1:${porta}` }));
      if (url.endsWith('/debug')) return new Response(JSON.stringify({ debuggerFullscreenUrl: 'https://ao-vivo.exemplo/s1' }));
      return new Response('{}');
    }) as unknown as typeof fetch;
    try {
      const abrir = criarAbridorBrowserbase({ chave: 'bb_falsa', projeto: 'proj', fetchImpl: f });
      const sessao = await abrir();
      expect(sessao.linkAoVivo).toBe('https://ao-vivo.exemplo/s1');
      expect(chamadas[0]!.corpo).toMatchObject({ projectId: 'proj', browserSettings: { solveCaptchas: false } });
      await sessao.pagina.abrir('data:text/html,<p id="x">funciona</p>', 5000);
      expect(await sessao.pagina.lerTexto('#x', 2000)).toBe('funciona');
      await sessao.fechar();
      expect(chamadas.at(-1)!.corpo).toMatchObject({ status: 'REQUEST_RELEASE' });
    } finally {
      await local.close();
    }
  });
});

describe('Gmail — aviso instantâneo', () => {
  it('renova o watch no tópico do Pub/Sub', async () => {
    let corpo: unknown;
    const f = (async (url: string, init: RequestInit = {}) => {
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }));
      corpo = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ historyId: '123', expiration: String(Date.now() + 6 * 86400000) }));
    }) as unknown as typeof fetch;
    const c = criarClienteGmail({ clientId: 'i', clientSecret: 's', refreshToken: 'r', fetchImpl: f });
    const r = await c.renovarWatch!('projects/p/topics/gmail');
    expect(r.historyId).toBe('123');
    expect(corpo).toEqual({ topicName: 'projects/p/topics/gmail', labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' });
  });
});
