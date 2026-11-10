import { redator } from './redacao.ts';

/** De onde vêm os valores dos segredos. Nunca devolva o valor para fora do processo. */
export interface ProvedorSegredos {
  obter(nome: string): Promise<string>;
}

export class SegredoAusente extends Error {
  constructor(nome: string) {
    super(`segredo ${nome} não está disponível neste ambiente`);
    this.name = 'SegredoAusente';
  }
}

const FORMATO_NOME = /^[A-Z0-9_]+$/;

export function validarNomeSegredo(nome: string): void {
  if (!FORMATO_NOME.test(nome)) throw new Error(`nome de segredo inválido: ${nome}`);
}

/**
 * Lê do ambiente do processo. No VPS o worker sobe com `bws run -- ...`,
 * que injeta os segredos da conta de máquina do Jarvis como variáveis.
 */
export class ProvedorAmbiente implements ProvedorSegredos {
  constructor(private readonly ambiente: NodeJS.ProcessEnv = process.env) {}
  async obter(nome: string): Promise<string> {
    validarNomeSegredo(nome);
    const valor = this.ambiente[nome];
    if (!valor) throw new SegredoAusente(nome);
    redator.registrar(nome, valor);
    return valor;
  }
}

/** Só para testes. */
export class ProvedorMemoria implements ProvedorSegredos {
  constructor(private readonly valores: Record<string, string>) {}
  async obter(nome: string): Promise<string> {
    validarNomeSegredo(nome);
    const valor = this.valores[nome];
    if (!valor) throw new SegredoAusente(nome);
    redator.registrar(nome, valor);
    return valor;
  }
}
