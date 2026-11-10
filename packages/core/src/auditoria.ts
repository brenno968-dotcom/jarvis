import type { Consultavel } from './banco.ts';
import { redator } from './redacao.ts';

export interface EventoAuditoria {
  quem: string;
  acao: string;
  empresaId?: string | null;
  negocioId?: string | null;
  tarefaId?: string | null;
  detalhes?: Record<string, unknown>;
}

/** Auditoria é só de inclusão (o banco bloqueia update/delete). Detalhes sempre redigidos. */
export async function registrarAuditoria(db: Consultavel, e: EventoAuditoria): Promise<void> {
  await db.query(
    `insert into auditoria (quem, acao, empresa_id, negocio_id, tarefa_id, detalhes)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      e.quem,
      e.acao,
      e.empresaId ?? null,
      e.negocioId ?? null,
      e.tarefaId ?? null,
      JSON.stringify(redator.redigirValor(e.detalhes ?? {})),
    ],
  );
}
