import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lerPedidoNexus, registrarPedidoNexus, type Banco } from '@jarvis/core';
import { bancoLimpo } from './ajuda.ts';

/* Item 177: pedido do Pulso do Nexus → auditoria + aviso ao Breno (um por serviço a cada 6 h). */
describe('lerPedidoNexus', () => {
  it('aceita o pedido completo e limpa o link', () => {
    expect(lerPedidoNexus({ componente: 'whatsapp', escopo: 'drive', classe: 'breno', texto: ' Falta o token ', link: '/conexoes?voltar=/pulso' }))
      .toEqual({ componente: 'whatsapp', escopo: 'drive', classe: 'breno', texto: 'Falta o token', link: '/conexoes?voltar=/pulso' });
  });
  it('recusa classe estranha, texto vazio e componente com espaço', () => {
    expect(lerPedidoNexus({ componente: 'whatsapp', classe: 'automatica', texto: 'x' })).toBeNull();
    expect(lerPedidoNexus({ componente: 'whatsapp', classe: 'breno', texto: '  ' })).toBeNull();
    expect(lerPedidoNexus({ componente: 'what sapp', classe: 'breno', texto: 'x' })).toBeNull();
    expect(lerPedidoNexus(null)).toBeNull();
  });
  it('link para outro site não passa', () => {
    expect(lerPedidoNexus({ componente: 'x', classe: 'breno', texto: 'y', link: '//golpe.com' })?.link).toBeUndefined();
    expect(lerPedidoNexus({ componente: 'x', classe: 'breno', texto: 'y', link: 'https://golpe.com' })?.link).toBeUndefined();
  });
});

describe('registrarPedidoNexus', () => {
  let banco: Banco;
  beforeEach(async () => { banco = await bancoLimpo(); });
  afterEach(async () => { await banco.end(); });

  it('primeiro pedido avisa; o mesmo de novo em 6 h só registra', async () => {
    const p = { componente: 'whatsapp', escopo: 'drive', classe: 'breno' as const, texto: 'Falta o token do WhatsApp oficial', link: '/conexoes' };
    expect(await registrarPedidoNexus(banco, p, 'https://nexus.teste/')).toEqual({ registrado: true, avisado: true });
    expect(await registrarPedidoNexus(banco, p, 'https://nexus.teste/')).toEqual({ registrado: true, avisado: false });
    const av = await banco.query<{ tipo: string; conteudo: { texto: string; link?: string } }>(`select tipo, conteudo from avisos`);
    expect(av.rows).toHaveLength(1);
    expect(av.rows[0]!.tipo).toBe('pedido_humano');
    expect(av.rows[0]!.conteudo.texto).toContain('precisa de você (whatsapp · drive)');
    expect(av.rows[0]!.conteudo.link).toBe('https://nexus.teste/conexoes');
    const au = await banco.query(`select 1 from auditoria where acao = 'pedido_nexus'`);
    expect(au.rowCount).toBe(2);
  });
  it('outro serviço avisa à parte', async () => {
    await registrarPedidoNexus(banco, { componente: 'a', escopo: '', classe: 'desconhecida', texto: 'x' });
    expect(await registrarPedidoNexus(banco, { componente: 'b', escopo: '', classe: 'desconhecida', texto: 'x' })).toEqual({ registrado: true, avisado: true });
  });
});
