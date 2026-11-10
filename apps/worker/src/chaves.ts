import { emTransacao, enfileirarAviso, log, registrarAuditoria, type Resultado } from '@jarvis/core';
import type { DepsExecutor } from './executor.ts';

const UM_DIA_MS = 24 * 60 * 60 * 1000;

/** Teste das chaves (seção 12, item 4): verificarConexao de cada adaptador, uma vez por dia. */
export async function testarChaves(d: DepsExecutor): Promise<Record<string, boolean>> {
  const resultados: Record<string, boolean> = {};
  for (const a of d.registro.todos()) {
    let r: Resultado;
    try {
      r = await a.verificarConexao({
        empresaId: '',
        tarefaId: '',
        idempotencyKey: `teste_chaves:${a.plataforma}`,
        obterSegredo: (n) => d.segredos.obter(n),
        salvarSegredo: async () => {
          throw new Error('não disponível no teste de chaves');
        },
        registrarAuditoria: async () => {},
        pedirHumano: async () => {},
      });
    } catch (e) {
      r = { ok: false, erro: { tipo: 'definitivo', codigo: 'EXCECAO', mensagem: String((e as Error)?.message ?? e) } };
    }
    resultados[a.plataforma] = r.ok;
    await emTransacao(d.banco, async (c) => {
      await c.query(`update segredos_ref set ultimo_teste_em = now(), ultimo_teste_ok = $2 where plataforma = $1`, [a.plataforma, r.ok]);
      if (!r.ok) {
        await enfileirarAviso(c, {
          tipo: 'texto',
          conteudo: { texto: `Teste diário: a conexão com ${a.plataforma} falhou (${r.erro?.codigo ?? 'erro'}). Verificar a chave.` },
        });
      }
    });
  }
  await registrarAuditoria(d.banco, { quem: `worker:${d.workerId}`, acao: 'teste_chaves', detalhes: resultados });
  log('info', 'teste diário das chaves', resultados);
  return resultados;
}

/** Roda o teste se o último foi há mais de 24 h (marca na auditoria). */
export async function testarChavesSeVencido(d: DepsExecutor, agora = Date.now()): Promise<boolean> {
  const r = await d.banco.query<{ ultimo: Date | null }>(
    `select max(quando) as ultimo from auditoria where acao = 'teste_chaves'`,
  );
  const ultimo = r.rows[0]?.ultimo?.getTime() ?? 0;
  if (agora - ultimo < UM_DIA_MS) return false;
  await testarChaves(d);
  return true;
}
