import { ErroHttp, type Resultado } from '@jarvis/core';
import { z } from 'zod';

/** Executa e converte ErroHttp/erros de validação no Resultado padrão (seção 15.3). */
export async function protegido(fn: () => Promise<Resultado>): Promise<Resultado> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ErroHttp) return { ok: false, erro: e.erro };
    if (e instanceof z.ZodError) {
      return {
        ok: false,
        erro: {
          tipo: 'definitivo',
          codigo: 'PARAMETROS_INVALIDOS',
          mensagem: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        },
      };
    }
    throw e;
  }
}

export const nomeSegredo = z.string().regex(/^[A-Z0-9_]+$/, 'nome de segredo em MAIÚSCULAS com _');

/** Espera configurável (os testes trocam por espera zero). */
export type Esperar = (ms: number) => Promise<void>;
export const esperaReal: Esperar = (ms) => new Promise((r) => setTimeout(r, ms));
