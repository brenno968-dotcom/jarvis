// Proteção contra vazamento de segredos (seção 2, regras 1 e 3).
// Todo valor lido da Dory é registrado aqui; qualquer texto que vá para log,
// banco ou mensagem passa por `redigir`, que troca o valor pelo NOME do segredo.

const TAMANHO_MINIMO = 4;

export class Redator {
  private valores = new Map<string, string>(); // valor -> nome

  registrar(nome: string, valor: string): void {
    if (typeof valor !== 'string' || valor.length < TAMANHO_MINIMO) return;
    this.valores.set(valor, nome);
  }

  esquecer(nome: string): void {
    for (const [valor, n] of this.valores) if (n === nome) this.valores.delete(valor);
  }

  limpar(): void {
    this.valores.clear();
  }

  redigir(texto: string): string {
    if (!texto || this.valores.size === 0) return texto;
    let saida = texto;
    // Valores maiores primeiro, para não deixar pedaço de um segredo que contém outro.
    const ordenados = [...this.valores.entries()].sort((a, b) => b[0].length - a[0].length);
    for (const [valor, nome] of ordenados) {
      if (saida.includes(valor)) saida = saida.split(valor).join(`[segredo:${nome}]`);
    }
    return saida;
  }

  /** Redige qualquer valor serializável (objetos, listas, erros). */
  redigirValor<T>(valor: T): T {
    if (valor === null || valor === undefined) return valor;
    if (typeof valor === 'string') return this.redigir(valor) as unknown as T;
    if (valor instanceof Error) {
      return { nome: valor.name, mensagem: this.redigir(valor.message) } as unknown as T;
    }
    if (Array.isArray(valor)) return valor.map((v) => this.redigirValor(v)) as unknown as T;
    if (typeof valor === 'object' && !(valor instanceof Date)) {
      const saida: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(valor as Record<string, unknown>)) saida[k] = this.redigirValor(v);
      return saida as T;
    }
    return valor;
  }
}

/** Instância única do processo. */
export const redator = new Redator();
