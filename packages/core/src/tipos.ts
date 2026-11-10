// Contratos da seção 15 de docs/JARVIS.md.

export type NivelSemaforo = 'verde' | 'amarelo' | 'vermelho';

export type StatusTarefa =
  | 'pendente'
  | 'aguardando_aprovacao'
  | 'aprovada'
  | 'executando'
  | 'aguardando_humano'
  | 'aguardando_externo'
  | 'erro_temporario'
  | 'concluida'
  | 'falhou'
  | 'recusada'
  | 'cancelada';

export const STATUS_FINAIS: readonly StatusTarefa[] = ['concluida', 'falhou', 'recusada', 'cancelada'];

export type TipoErro =
  | 'temporario'
  | 'definitivo'
  | 'precisa_humano'
  | 'precisa_aprovacao'
  | 'bloqueado_por_regra';

export interface ErroResultado {
  tipo: TipoErro;
  codigo: string;
  mensagem: string;
  tentarNovamenteEmSegundos?: number;
}

export interface Resultado<T = unknown> {
  ok: boolean;
  dados?: T;
  custoRealBrl?: number;
  evidencias?: string[];
  mensagem?: string;
  erro?: ErroResultado;
}

export interface Tarefa {
  id: string;
  plano_id: string | null;
  etapa_id: string | null;
  empresa_id: string;
  negocio_id: string | null;
  agente: string;
  acao: string;
  plataforma: string | null;
  parametros: Record<string, unknown>;
  idempotency_key: string;
  nivel_semaforo: NivelSemaforo;
  status: StatusTarefa;
  tentativas: number;
  max_tentativas: number;
  proxima_tentativa_em: Date | null;
  travada_por: string | null;
  travada_ate: Date | null;
  resultado: unknown;
  erro: unknown;
  criado_em: Date;
  atualizado_em: Date;
}

export interface NovaTarefa {
  empresaId: string;
  negocioId?: string | null;
  planoId?: string | null;
  etapaId?: string | null;
  agente: string;
  acao: string;
  plataforma?: string | null;
  parametros?: Record<string, unknown>;
  idempotencyKey: string;
  maxTentativas?: number;
  /** Texto simples para a aprovação (obrigatório quando a ação for vermelha). */
  resumo?: string;
}
