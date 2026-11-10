import { describe, expect, it } from 'vitest';
import { classificarAcao, esperaParaTentativa, RegrasInvalidas } from '@jarvis/core';
import { regrasTeste } from './ajuda.ts';

describe('arquivo de regras', () => {
  it('carrega o arquivo do repositório', () => {
    const r = regrasTeste();
    expect(r.navegador.resolver_captcha_automatico).toBe(false);
  });

  it('recusa CAPTCHA automático ligado', () => {
    expect(() =>
      regrasTeste((t) => t.replace('resolver_captcha_automatico: false', 'resolver_captcha_automatico: true')),
    ).toThrow(RegrasInvalidas);
  });

  it('recusa ação em duas cores', () => {
    expect(() => regrasTeste((t) => t.replace('    - redeploy_producao', '    - redeploy_producao\n    - ler_logs'))).toThrow(
      /aparece em verde e amarelo/,
    );
  });

  it('recusa YAML quebrado', () => {
    expect(() => regrasTeste(() => 'versao: [1')).toThrow(RegrasInvalidas);
  });

  it('ação desconhecida é vermelha', () => {
    const r = regrasTeste();
    expect(classificarAcao(r, 'acao_que_nao_existe')).toBe('vermelho');
    expect(classificarAcao(r, 'ler_logs')).toBe('verde');
    expect(classificarAcao(r, 'redeploy_producao')).toBe('amarelo');
    expect(classificarAcao(r, 'criar_conta')).toBe('vermelho');
  });

  it('espera exponencial respeita o máximo', () => {
    const r = regrasTeste();
    const meio = () => 0.5; // sem variação
    expect(esperaParaTentativa(r, 1, meio)).toBe(10);
    expect(esperaParaTentativa(r, 2, meio)).toBe(20);
    expect(esperaParaTentativa(r, 3, meio)).toBe(40);
    expect(esperaParaTentativa(r, 20, meio)).toBe(900);
  });
});
