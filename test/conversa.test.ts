import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processarEventoNexus, semChamado, type Banco, type Cerebro } from '@jarvis/core';
import { bancoLimpo, NUMERO_BRENO, regrasTeste } from './ajuda.ts';

// Item 330: o Breno conversa com o Jarvis pelo WhatsApp (via número autorizado ou sessão com senha aberta no Nexus).
const regras = regrasTeste();
let banco: Banco;
beforeEach(async () => {
  banco = await bancoLimpo();
});
afterEach(async () => {
  await banco.end();
});

const cerebroFalso = (resposta: string, visto: string[] = []): Cerebro => ({
  async pensar(sistema, mensagens) {
    visto.push(sistema, mensagens[0]!.content);
    return resposta;
  },
});

describe('conversa pelo WhatsApp', () => {
  it('tira o "Jarvis," do começo', () => {
    expect(semChamado('Jarvis, como vai?')).toBe('como vai?');
    expect(semChamado('jarvis status')).toBe('status');
  });

  it('número autorizado: responde com a IA, sem o "Jarvis" na pergunta, e não grava o texto na auditoria', async () => {
    const visto: string[] = [];
    const r = await processarEventoNexus(banco, regras, { tipo: 'conversa', numero: NUMERO_BRENO, texto: 'Jarvis, quanto vendemos hoje?', via: 'numero' }, { cerebro: cerebroFalso('Ainda não tenho esse número.', visto) });
    expect(r).toEqual({ tipo: 'conversa', resposta: 'Ainda não tenho esse número.' });
    expect(visto[1]).toBe('quanto vendemos hoje?');
    const a = await banco.query<{ detalhes: unknown }>(`select detalhes from auditoria where acao = 'conversa_whatsapp'`);
    expect(JSON.stringify(a.rows)).not.toContain('vendemos');
  });

  it('via número de quem não é autorizado: ignora', async () => {
    const r = await processarEventoNexus(banco, regras, { tipo: 'conversa', numero: '5511900000000', texto: 'Jarvis oi', via: 'numero' }, { cerebro: cerebroFalso('x') });
    expect(r).toEqual({ tipo: 'ignorado', motivo: 'número não autorizado' });
  });

  it('via senha (outro número): responde e avisa a IA que não é o número autorizado', async () => {
    const visto: string[] = [];
    const r = await processarEventoNexus(banco, regras, { tipo: 'conversa', numero: '5511900000000', texto: 'Jarvis, oi', via: 'senha' }, { cerebro: cerebroFalso('Oi!', visto) });
    expect(r).toEqual({ tipo: 'conversa', resposta: 'Oi!' });
    expect(visto[0]).toContain('NÃO é o autorizado');
  });

  it('sem a chave da IA: entende "ajuda" e "status" e explica o resto', async () => {
    const ajuda = await processarEventoNexus(banco, regras, { tipo: 'conversa', numero: NUMERO_BRENO, texto: 'Jarvis ajuda', via: 'numero' });
    expect(ajuda.tipo === 'conversa' && ajuda.resposta).toContain('Jarvis status');
    const status = await processarEventoNexus(banco, regras, { tipo: 'conversa', numero: NUMERO_BRENO, texto: 'Jarvis status', via: 'numero' });
    expect(status.tipo === 'conversa' && status.resposta).toMatch(/Tarefas:/);
    const outra = await processarEventoNexus(banco, regras, { tipo: 'conversa', numero: NUMERO_BRENO, texto: 'Jarvis, me conta uma piada', via: 'numero' });
    expect(outra.tipo === 'conversa' && outra.resposta).toContain('IA ainda não está ligada');
  });
});

describe('teste de aviso', () => {
  it('manda "teste ok" e devolve para quem foi', async () => {
    const enviados: string[] = [];
    const r = await processarEventoNexus(banco, regras, { tipo: 'teste' }, {
      avisarAgora: async (m) => {
        enviados.push(m.texto);
        return { numeros: [NUMERO_BRENO], emails: [] };
      },
    });
    expect(r).toEqual({ tipo: 'teste', enviado: true, numeros: [NUMERO_BRENO], emails: [] });
    expect(enviados[0]).toContain('teste ok');
  });

  it('sem o endereço dos avisos: diz o que falta', async () => {
    const r = await processarEventoNexus(banco, regras, { tipo: 'teste' });
    expect(r.tipo === 'teste' && r.erro).toContain('JARVIS_CORE_NEXUS_AVISOS_URL');
  });
});
