import type { Resultado } from './tipos.ts';

export interface MetaSegredo {
  empresaId: string;
  negocioId?: string | null;
  plataforma: string;
  bitwardenProjeto: string;
  destinos?: string[];
}

export interface ContextoExecucao {
  empresaId: string;
  negocioId?: string | null;
  tarefaId: string;
  idempotencyKey: string;
  /** Lê da Dory e registra o valor no redator. Nunca logar o retorno. */
  obterSegredo(nome: string): Promise<string>;
  /** Fase 1 (Bitwarden). Na Fase 0 lança erro "não implementado". */
  salvarSegredo(nome: string, valor: string, meta: MetaSegredo): Promise<void>;
  registrarAuditoria(acao: string, detalhes?: Record<string, unknown>): Promise<void>;
  /** Fase 2 (navegador ao vivo). Na Fase 0 só registra o pedido. */
  pedirHumano(motivo: string, linkAoVivo?: string): Promise<void>;
}

export interface Adaptador {
  plataforma: string;
  temApi: boolean;
  acoesSuportadas: string[];
  verificarConexao(ctx: ContextoExecucao): Promise<Resultado>;
  executar(acao: string, params: Record<string, unknown>, ctx: ContextoExecucao): Promise<Resultado>;
}
