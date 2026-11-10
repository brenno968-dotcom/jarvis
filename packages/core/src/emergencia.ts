import type { Banco } from './banco.ts';
import { emTransacao } from './banco.ts';
import { registrarAuditoria } from './auditoria.ts';
import { enfileirarAviso } from './avisos.ts';

export interface EstadoEmergencia {
  parado: boolean;
  motivo?: string;
  por?: string;
  em?: string;
}

export async function lerEmergencia(banco: Pick<Banco, 'query'>): Promise<EstadoEmergencia> {
  const r = await banco.query(`select valor from controle where chave = 'emergencia'`);
  return (r.rows[0]?.valor as EstadoEmergencia | undefined) ?? { parado: false };
}

/**
 * "PARA TUDO" (seção 12, item 6): suspende os workers e cancela as tarefas em aberto.
 * A revogação dos tokens (Jarvis, Carteiro, Marcapasso) é da Fase 1, quando os
 * adaptadores de Vercel/GitHub/Bitwarden existirem.
 */
export async function pararTudo(banco: Banco, por: string, motivo = 'PARA TUDO'): Promise<number> {
  return emTransacao(banco, async (c) => {
    const estado: EstadoEmergencia = { parado: true, motivo, por, em: new Date().toISOString() };
    await c.query(
      `insert into controle (chave, valor, atualizado_em) values ('emergencia', $1, now())
       on conflict (chave) do update set valor = excluded.valor, atualizado_em = now()`,
      [JSON.stringify(estado)],
    );
    const r = await c.query(
      `update tarefas set status = 'cancelada', travada_por = null, travada_ate = null,
              erro = jsonb_build_object('tipo','bloqueado_por_regra','codigo','EMERGENCIA','mensagem',$1::text)
        where status not in ('concluida','falhou','recusada','cancelada')`,
      [motivo],
    );
    await c.query(
      `update aprovacoes set status = 'expirada', respondido_em = now() where status = 'pendente'`,
    );
    // Corta o acesso do conector MCP (o Claude deixa de conseguir mandar pedidos até reautorizar).
    await c.query(`update oauth_tokens set revogado_em = now() where revogado_em is null`);
    await registrarAuditoria(c, { quem: por, acao: 'emergencia_parar', detalhes: { motivo, canceladas: r.rowCount } });
    await enfileirarAviso(c, {
      tipo: 'emergencia',
      conteudo: { texto: `PARA TUDO acionado (${por}). ${r.rowCount ?? 0} tarefa(s) cancelada(s). Workers parados até você retomar.` },
    });
    return r.rowCount ?? 0;
  });
}

/** Retomar exige ação explícita do Breno; tarefas canceladas não voltam sozinhas. */
export async function retomar(banco: Banco, por: string): Promise<void> {
  await emTransacao(banco, async (c) => {
    await c.query(
      `update controle set valor = $1, atualizado_em = now() where chave = 'emergencia'`,
      [JSON.stringify({ parado: false, por, em: new Date().toISOString() })],
    );
    await registrarAuditoria(c, { quem: por, acao: 'emergencia_retomar' });
  });
}
