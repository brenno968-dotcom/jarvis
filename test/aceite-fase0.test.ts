// Critérios de aceite da Fase 0 (docs/JARVIS.md, seção 25) que dá para provar sem plataformas reais.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  buscarTarefa,
  criarTarefa,
  definirDestinoLog,
  devolverTravadasVencidas,
  pararTudo,
  pegarProxima,
  ProvedorMemoria,
  retomar,
  type Banco,
} from '@jarvis/core';
import {
  adaptadorTeste,
  ciclo,
  contadorEfeitosTeste,
  NOME_SEGREDO_TESTE,
  RegistroAdaptadores,
  type OpcoesWorker,
} from '@jarvis/worker';
import { bancoLimpo, criarEmpresa, RAIZ, regrasTeste, URL_TESTE } from './ajuda.ts';

const regras = regrasTeste();
const VALOR_SECRETO = 'sk_teste_9f8e7d6c5b4a_NAO_PODE_VAZAR';
let banco: Banco;
let empresa: string;
let logs: string[];

function opcoes(workerId: string, extra: Partial<OpcoesWorker> = {}): OpcoesWorker {
  return {
    banco,
    regras,
    registro: new RegistroAdaptadores().registrar(adaptadorTeste),
    segredos: new ProvedorMemoria({ [NOME_SEGREDO_TESTE]: VALOR_SECRETO }),
    workerId,
    heartbeatMs: 50,
    ...extra,
  };
}

const tarefa = (acao: string, chave: string) => ({
  empresaId: empresa,
  agente: 'jarvis_infra',
  acao,
  plataforma: 'teste',
  idempotencyKey: chave,
});

beforeEach(async () => {
  banco = await bancoLimpo();
  empresa = await criarEmpresa(banco);
  logs = [];
  definirDestinoLog((l) => logs.push(l));
  contadorEfeitosTeste.valor = 0;
});
afterEach(async () => {
  definirDestinoLog((l) => process.stdout.write(l + '\n'));
  await banco.end();
});

describe('Fase 0 — critérios de aceite', () => {
  it('tarefa criada (como o painel cria) é executada pelo worker e o resultado fica salvo', async () => {
    const { tarefa: t } = await criarTarefa(banco, regras, { ...tarefa('teste_eco', 'p1'), parametros: { ola: 'mundo' } }, 'painel');
    expect(await ciclo(opcoes('w1'))).toBe('executou');
    const final = await buscarTarefa(banco, t.id);
    expect(final?.status).toBe('concluida');
    expect(final?.resultado).toMatchObject({ ok: true, dados: { eco: { ola: 'mundo' } } });
    const w = await banco.query(`select estado from workers where id = 'w1'`);
    expect(w.rows[0].estado).toBe('ativo');
  });

  it('worker cai no meio: a tarefa volta para a fila e termina sem duplicar o efeito', async () => {
    const { tarefa: t } = await criarTarefa(banco, regras, tarefa('teste_efeito', 'efeito-1'), 'painel');
    const caindo = opcoes('w1', {
      aposEfeito: async () => {
        throw new Error('worker caiu');
      },
    });
    await expect(ciclo(caindo)).rejects.toThrow('worker caiu');
    expect((await buscarTarefa(banco, t.id))?.status).toBe('executando');
    expect(contadorEfeitosTeste.valor).toBe(1);

    // Trava vence (o worker morto não renova mais).
    await banco.query(`update tarefas set travada_ate = now() - interval '1 second' where id = $1`, [t.id]);
    expect(await devolverTravadasVencidas(banco)).toBe(1);

    expect(await ciclo(opcoes('w2'))).toBe('executou');
    const final = await buscarTarefa(banco, t.id);
    expect(final?.status).toBe('concluida');
    expect(contadorEfeitosTeste.valor).toBe(1); // não repetiu o efeito externo
    const ef = await banco.query(`select count(*)::int as n from efeitos`);
    expect(ef.rows[0].n).toBe(1);
  });

  it('com resolver_captcha_automatico: true o worker recusa subir', () => {
    const pasta = mkdtempSync(join(tmpdir(), 'jarvis-'));
    const arquivo = join(pasta, 'regras.yaml');
    writeFileSync(
      arquivo,
      readFileSync(join(RAIZ, 'config/regras.yaml'), 'utf8').replace(
        'resolver_captcha_automatico: false',
        'resolver_captcha_automatico: true',
      ),
    );
    const r = spawnSync('npx', ['tsx', 'apps/worker/src/main.ts'], {
      cwd: RAIZ,
      env: { ...process.env, JARVIS_REGRAS: arquivo, DATABASE_URL: URL_TESTE },
      encoding: 'utf8',
      timeout: 30000,
    });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/recusou iniciar/);
    expect(r.stdout + r.stderr).toMatch(/resolver_captcha_automatico/);
  });

  it('o valor de um segredo não aparece em log, banco nem auditoria', async () => {
    await criarTarefa(banco, regras, tarefa('teste_usar_segredo', 's1'), 'painel');
    expect(await ciclo(opcoes('w1'))).toBe('executou');

    const tudoLogado = logs.join('\n');
    expect(tudoLogado).not.toContain(VALOR_SECRETO);
    expect(tudoLogado).toContain(`[segredo:${NOME_SEGREDO_TESTE}]`);

    for (const [tabela, coluna] of [
      ['tarefas', 'resultado'],
      ['tarefas', 'erro'],
      ['tarefas', 'parametros'],
      ['auditoria', 'detalhes'],
      ['efeitos', 'resultado'],
    ] as const) {
      const r = await banco.query(`select count(*)::int as n from ${tabela} where ${coluna}::text like $1`, [
        `%${VALOR_SECRETO}%`,
      ]);
      expect(r.rows[0].n, `${tabela}.${coluna}`).toBe(0);
    }
    const t = await banco.query(`select resultado from tarefas limit 1`);
    expect(JSON.stringify(t.rows[0].resultado)).toContain(`[segredo:${NOME_SEGREDO_TESTE}]`);
  });

  it('"PARA TUDO" suspende o worker e cancela as tarefas', async () => {
    await criarTarefa(banco, regras, tarefa('teste_eco', 'a'), 'painel');
    await criarTarefa(banco, regras, tarefa('teste_eco', 'b'), 'painel');
    const canceladas = await pararTudo(banco, 'breno');
    expect(canceladas).toBe(2);
    expect(await ciclo(opcoes('w1'))).toBe('suspenso');
    const w = await banco.query(`select estado from workers where id = 'w1'`);
    expect(w.rows[0].estado).toBe('suspenso');

    // Tarefa nova durante a emergência também não roda.
    await criarTarefa(banco, regras, tarefa('teste_eco', 'c'), 'painel');
    expect(await pegarProxima(banco, 'w1')).toBeNull();

    await retomar(banco, 'breno');
    expect(await ciclo(opcoes('w1'))).toBe('executou');
    const st = await banco.query(`select status, count(*)::int as n from tarefas group by status order by status`);
    expect(st.rows).toEqual([
      { status: 'cancelada', n: 2 },
      { status: 'concluida', n: 1 },
    ]);
  });

  it('auditoria é só de inclusão', async () => {
    await criarTarefa(banco, regras, tarefa('teste_eco', 'a'), 'painel');
    await expect(banco.query(`update auditoria set acao = 'x'`)).rejects.toThrow(/só de inclusão/);
    await expect(banco.query(`delete from auditoria`)).rejects.toThrow(/só de inclusão/);
    await expect(banco.query(`truncate auditoria`)).rejects.toThrow(/só de inclusão/);
  });

  it('API pública (anon/authenticated) não lê nem escreve nada', async () => {
    const c = new pg.Client({ connectionString: URL_TESTE });
    await c.connect();
    for (const papel of ['anon', 'authenticated']) {
      await c.query(`set role ${papel}`);
      await expect(c.query('select * from tarefas')).rejects.toThrow(/permission denied/);
      await expect(c.query(`insert into auditoria (quem, acao) values ('x','y')`)).rejects.toThrow(/permission denied/);
      await c.query('reset role');
    }
    await c.end();
  });

  it('papel do worker não consegue apagar tarefas nem alterar auditoria', async () => {
    const c = new pg.Client({ connectionString: URL_TESTE });
    await c.connect();
    await c.query('set role jarvis_worker');
    await expect(c.query('delete from tarefas')).rejects.toThrow(/permission denied/);
    await expect(c.query(`update controle set valor = '{}'`)).rejects.toThrow(/permission denied/);
    const r = await c.query('select count(*)::int as n from tarefas');
    expect(r.rows[0].n).toBe(0);
    await c.query('reset role');
    await c.end();
  });

  it('tarefa sem adaptador falha de forma definitiva, sem travar a fila', async () => {
    const { tarefa: t } = await criarTarefa(
      banco,
      regras,
      { ...tarefa('teste_eco', 'x'), plataforma: 'plataforma_inexistente' },
      'painel',
    );
    expect(await ciclo(opcoes('w1'))).toBe('executou');
    const final = await buscarTarefa(banco, t.id);
    expect(final?.status).toBe('falhou');
    expect(final?.erro).toMatchObject({ codigo: 'SEM_ADAPTADOR' });
  });
});

describe('papel do painel', () => {
  beforeEach(async () => {
    banco = await bancoLimpo();
    empresa = await criarEmpresa(banco);
  });

  it('consegue o que o painel faz e nada além', async () => {
    const c = new pg.Pool({ connectionString: URL_TESTE, max: 1 });
    const cliente = await c.connect();
    await cliente.query('set role jarvis_painel');
    const consulta = cliente.query.bind(cliente);
    const comoPainel = {
      query: consulta,
      connect: async () => ({ query: consulta, release: () => {} }),
    } as unknown as Banco;
    // cria tarefa (insert tarefas + auditoria) e aciona emergência (update controle/tarefas/aprovacoes)
    await criarTarefa(comoPainel, regras, tarefa('teste_eco', 'painel-1'), 'painel');
    await expect(cliente.query('delete from tarefas')).rejects.toThrow(/permission denied/);
    await expect(cliente.query(`delete from auditoria`)).rejects.toThrow(/permission denied|só de inclusão/);
    await expect(cliente.query(`update efeitos set resultado = '{}'`)).rejects.toThrow(/permission denied/);
    await cliente.query('reset role');
    cliente.release();
    await c.end();
  });
});
