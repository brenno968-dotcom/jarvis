// Dory: onde os VALORES dos segredos ficam guardados (Bitwarden Secrets Manager).
// O banco do Jarvis guarda só a referência (segredos_ref).
import { redator } from './redacao.ts';

export interface Cofre {
  /** Cria o segredo no projeto (empresa) e devolve o id do Bitwarden. */
  criar(nome: string, valor: string, projetoId: string): Promise<{ id: string }>;
  /** Troca o valor de um segredo existente. */
  atualizar(id: string, nome: string, valor: string): Promise<void>;
}

/** Só para testes. */
export class CofreMemoria implements Cofre {
  readonly itens = new Map<string, { nome: string; valor: string; projeto: string }>();
  private seq = 0;
  async criar(nome: string, valor: string, projetoId: string) {
    const id = `bw-${++this.seq}`;
    this.itens.set(id, { nome, valor, projeto: projetoId });
    redator.registrar(nome, valor);
    return { id };
  }
  async atualizar(id: string, nome: string, valor: string) {
    const i = this.itens.get(id);
    if (!i) throw new Error(`segredo ${id} não existe no cofre`);
    i.valor = valor;
    redator.registrar(nome, valor);
  }
}

/**
 * Bitwarden Secrets Manager pela SDK oficial para Node (@bitwarden/sdk-napi).
 * ⚠️ NÃO TESTADO AQUI (sem conta). Conferir a assinatura dos métodos na versão instalada
 *    antes de usar: login por token de conta de máquina e `secrets().create/update`.
 * A SDK é carregada sob demanda para não pesar onde não é usada.
 */
export class CofreBitwarden implements Cofre {
  private cliente: unknown;
  constructor(
    private readonly tokenContaMaquina: string,
    private readonly organizacaoId: string,
  ) {}

  private async sdk(): Promise<{
    secrets(): {
      create(org: string, key: string, value: string, note: string, projects: string[]): Promise<{ id: string }>;
      get(id: string): Promise<{ id: string; key: string; note: string; projectId?: string }>;
      update(org: string, id: string, key: string, value: string, note: string, projects: string[]): Promise<unknown>;
    };
  }> {
    if (!this.cliente) {
      const nomeModulo = '@bitwarden/sdk-napi';
      const mod = (await import(/* webpackIgnore: true */ nomeModulo)) as {
        BitwardenClient: new () => { auth(): { loginAccessToken(t: string, estado?: string): Promise<void> } };
      };
      const c = new mod.BitwardenClient();
      await c.auth().loginAccessToken(this.tokenContaMaquina);
      this.cliente = c;
    }
    return this.cliente as never;
  }

  async criar(nome: string, valor: string, projetoId: string) {
    redator.registrar(nome, valor);
    const s = await (await this.sdk()).secrets().create(this.organizacaoId, nome, valor, 'criado pelo Jarvis', [projetoId]);
    return { id: s.id };
  }

  async atualizar(id: string, nome: string, valor: string) {
    redator.registrar(nome, valor);
    const api = (await this.sdk()).secrets();
    const atual = await api.get(id);
    await api.update(this.organizacaoId, id, nome, valor, atual.note, atual.projectId ? [atual.projectId] : []);
  }
}
