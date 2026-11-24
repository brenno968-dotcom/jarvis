import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buscarTarefa, criarTarefa, pegarProxima, type Banco, type Regras } from '@jarvis/core';
import { executarTarefa, type DepsExecutor } from '../apps/worker/src/executor.ts';
import { adaptadorTeste } from '../apps/worker/src/adaptadores/teste.ts';
import { RegistroAdaptadores } from '../apps/worker/src/registro.ts';
import { bancoLimpo, criarEmpresa, regrasTeste } from './ajuda.ts';

// Item 792: LoopGuard no executor. Precisa de Postgres de teste (como os demais testes de fila).
let banco: Banco;
let empresa: string;
let negocio: string;

beforeEach(async () => {
  banco = await bancoLimpo();
  empresa = await criarEmpresa(banco);
  negocio = (
    await banco.query(`insert into negocios (empresa_id, nome, modelo_negocio, orcamento) values ($1, 'N', 'produto_digital', '{}') returning id`, [empresa])
  ).rows[0].id as string;
});
afterEach(async () => banco.end());

const deps = (regras: Regras): DepsExecutor => ({
  banco,
  regras,
  registro: new RegistroAdaptadores().registrar(adaptadorTeste),
  segredos: { obter: async () => 'x' } as unknown as DepsExecutor['segredos'],
  workerId: 'w1',
});

async function rodar(d: DepsExecutor, chave: string, params: Record<string, unknown>) {
  await criarTarefa(banco, d.regras, { empresaId: empresa, negocioId: negocio, agente: 'jarvis_infra', acao: 'teste_eco', plataforma: 'teste', parametros: params, idempotencyKey: chave }, 'teste');
  const t = (await pegarProxima(banco, 'w1'))!;
  const status = await executarTarefa(d, t);
  return { status, tarefa: (await buscarTarefa(banco, t.id))! };
}
const auditoriaLoop = async () => (await banco.query(`select detalhes from auditoria where acao = 'loop_guard' order by id`)).rows.map((r) => r.detalhes as { padrao: string });

describe('LoopGuard no executor', () => {
  it('mesma ação mais vezes que o limite no mesmo negócio: bloqueia, falha como LOOP_DETECTADO e audita', async () => {
    const d = deps(regrasTeste((t) => t.replace('executor_max_mesma_acao: 20', 'executor_max_mesma_acao: 2')));
    expect((await rodar(d, 'a', { n: 1 })).status).toBe('concluida');
    expect((await rodar(d, 'b', { n: 2 })).status).toBe('concluida');
    const r = await rodar(d, 'c', { n: 3 });
    expect(r.status).toBe('falhou');
    expect(JSON.stringify(r.tarefa.erro)).toMatch(/LOOP_DETECTADO/);
    expect(JSON.stringify(r.tarefa.erro)).toMatch(/2 vezes/);
    expect(await auditoriaLoop()).toEqual([{ padrao: 'mesma_tool', tool: 'teste/teste_eco', motivo: expect.any(String) }]);
  });

  it('rodadas sem progresso (mesma saída): conclui a atual, audita e trava as seguintes', async () => {
    const d = deps(regrasTeste());
    // 1ª traz novidade; 2ª, 3ª e 4ª repetem a mesma saída → dispara ao fim da 4ª
    for (const k of ['a', 'b', 'c', 'd']) expect((await rodar(d, k, { igual: true })).status).toBe('concluida');
    expect((await auditoriaLoop()).map((x) => x.padrao)).toEqual(['sem_progresso']);
    const r = await rodar(d, 'e', { igual: true });
    expect(r.status).toBe('falhou');
    expect(JSON.stringify(r.tarefa.erro)).toMatch(/sem progresso/);
  });

  it('desligado em regras (loop_guard.ativo: false), nada é bloqueado', async () => {
    const d = deps(regrasTeste((t) => t.replace('ativo: true', 'ativo: false').replace('executor_max_mesma_acao: 20', 'executor_max_mesma_acao: 1')));
    for (const k of ['a', 'b', 'c']) expect((await rodar(d, k, { n: k })).status).toBe('concluida');
    expect(await auditoriaLoop()).toEqual([]);
  });
});
