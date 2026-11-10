import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  buscarTarefa,
  criarTarefa,
  devolverTravadasVencidas,
  expirarAprovacoesVencidas,
  pegarProxima,
  registrarFalha,
  renovarTrava,
  responderAprovacao,
  responderAprovacaoPeloPainel,
  type Banco,
} from '@jarvis/core';
import { bancoLimpo, criarEmpresa, NUMERO_BRENO, regrasTeste, URL_TESTE } from './ajuda.ts';

let banco: Banco;
let empresa: string;
const regras = regrasTeste();

beforeEach(async () => {
  banco = await bancoLimpo();
  empresa = await criarEmpresa(banco);
});
afterEach(async () => banco.end());

const verde = (chave: string) => ({
  empresaId: empresa,
  agente: 'jarvis_infra',
  acao: 'teste_eco',
  plataforma: 'teste',
  idempotencyKey: chave,
});

describe('fila', () => {
  it('nível vem das regras, não de quem pede', async () => {
    const { tarefa } = await criarTarefa(banco, regras, verde('k1'), 'teste');
    expect(tarefa.nivel_semaforo).toBe('verde');
    expect(tarefa.status).toBe('pendente');
  });

  it('mesma chave não duplica', async () => {
    const a = await criarTarefa(banco, regras, verde('k1'), 'teste');
    const b = await criarTarefa(banco, regras, verde('k1'), 'teste');
    expect(b.jaExistia).toBe(true);
    expect(b.tarefa.id).toBe(a.tarefa.id);
    const n = await banco.query('select count(*)::int as n from tarefas');
    expect(n.rows[0].n).toBe(1);
  });

  it('dois workers nunca pegam a mesma tarefa', async () => {
    for (let i = 0; i < 30; i++) await criarTarefa(banco, regras, verde(`k${i}`), 'teste');
    const outro = new pg.Pool({ connectionString: URL_TESTE });
    const pegas: string[] = [];
    const pegar = async (db: Banco, id: string) => {
      for (;;) {
        const t = await pegarProxima(db, id);
        if (!t) return;
        pegas.push(t.id);
      }
    };
    await Promise.all([pegar(banco, 'w1'), pegar(outro, 'w2'), pegar(banco, 'w3'), pegar(outro, 'w4')]);
    await outro.end();
    expect(pegas.length).toBe(30);
    expect(new Set(pegas).size).toBe(30);
  });

  it('heartbeat só renova para o dono da trava', async () => {
    await criarTarefa(banco, regras, verde('k1'), 'teste');
    const t = (await pegarProxima(banco, 'w1'))!;
    expect(await renovarTrava(banco, t.id, 'w1')).toBe(true);
    expect(await renovarTrava(banco, t.id, 'intruso')).toBe(false);
  });

  it('erro temporário volta para a fila com espera; tentativas esgotadas = falhou', async () => {
    const { tarefa } = await criarTarefa(banco, regras, { ...verde('k1'), maxTentativas: 2 }, 'teste');
    let t = (await pegarProxima(banco, 'w1'))!;
    const s1 = await registrarFalha(banco, regras, t, 'w1', { tipo: 'temporario', codigo: 'X', mensagem: 'x' });
    expect(s1).toBe('pendente');
    expect(await pegarProxima(banco, 'w1')).toBeNull(); // ainda esperando
    await banco.query(`update tarefas set proxima_tentativa_em = now() where id = $1`, [tarefa.id]);
    t = (await pegarProxima(banco, 'w1'))!;
    expect(t.tentativas).toBe(2);
    const s2 = await registrarFalha(banco, regras, t, 'w1', { tipo: 'temporario', codigo: 'X', mensagem: 'x' });
    expect(s2).toBe('falhou');
  });

  it('precisa_humano vai para aguardando_humano', async () => {
    await criarTarefa(banco, regras, verde('k1'), 'teste');
    const t = (await pegarProxima(banco, 'w1'))!;
    const s = await registrarFalha(banco, regras, t, 'w1', { tipo: 'precisa_humano', codigo: 'CAPTCHA', mensagem: 'c' });
    expect(s).toBe('aguardando_humano');
  });
});

describe('aprovações', () => {
  const vermelha = () => ({
    empresaId: empresa,
    agente: 'jarvis_infra',
    acao: 'teste_vermelho',
    plataforma: 'teste',
    idempotencyKey: 'v1',
    resumo: 'Teste de ação vermelha',
  });

  it('vermelha sem resumo é recusada na criação', async () => {
    const { resumo, ...sem } = vermelha();
    void resumo;
    await expect(criarTarefa(banco, regras, sem, 'teste')).rejects.toThrow(/resumo/);
  });

  it('vermelha só é pega depois de aprovada', async () => {
    const { tarefa, tokenAprovacao } = await criarTarefa(banco, regras, vermelha(), 'teste');
    expect(tarefa.status).toBe('aguardando_aprovacao');
    expect(tokenAprovacao).toBeTruthy();
    expect(await pegarProxima(banco, 'w1')).toBeNull();

    expect(await responderAprovacao(banco, regras, tokenAprovacao!, 'aprovar', '+55 11 90000-0000')).toBe(
      'numero_nao_autorizado',
    );
    expect(await responderAprovacao(banco, regras, 'token-falso', 'aprovar', NUMERO_BRENO)).toBe('token_invalido');
    expect(await responderAprovacao(banco, regras, tokenAprovacao!, 'aprovar', NUMERO_BRENO)).toBe('aprovada');
    expect(await responderAprovacao(banco, regras, tokenAprovacao!, 'recusar', NUMERO_BRENO)).toBe('ja_respondida');

    const t = await pegarProxima(banco, 'w1');
    expect(t?.id).toBe(tarefa.id);
  });

  it('token não fica salvo em claro', async () => {
    const { tokenAprovacao } = await criarTarefa(banco, regras, vermelha(), 'teste');
    const r = await banco.query(`select count(*)::int as n from aprovacoes where token_hash = $1`, [tokenAprovacao]);
    expect(r.rows[0].n).toBe(0);
  });

  it('recusada não executa', async () => {
    const { tarefa, tokenAprovacao } = await criarTarefa(banco, regras, vermelha(), 'teste');
    expect(await responderAprovacao(banco, regras, tokenAprovacao!, 'recusar', NUMERO_BRENO)).toBe('recusada');
    expect((await buscarTarefa(banco, tarefa.id))?.status).toBe('recusada');
    expect(await pegarProxima(banco, 'w1')).toBeNull();
  });

  it('aprovação vencida expira e a tarefa é recusada', async () => {
    const { tarefa, tokenAprovacao } = await criarTarefa(banco, regras, vermelha(), 'teste');
    await banco.query(`update aprovacoes set expira_em = now() - interval '1 minute'`);
    expect(await responderAprovacao(banco, regras, tokenAprovacao!, 'aprovar', NUMERO_BRENO)).toBe('expirada');
    await expirarAprovacoesVencidas(banco);
    const { tarefa: t2 } = await criarTarefa(banco, regras, { ...vermelha(), idempotencyKey: 'v2' }, 'teste');
    await banco.query(`update aprovacoes set expira_em = now() - interval '1 minute' where tarefa_id = $1`, [t2.id]);
    await expirarAprovacoesVencidas(banco);
    expect((await buscarTarefa(banco, t2.id))?.status).toBe('recusada');
    void tarefa;
  });

  it('aprovação pelo painel libera a tarefa e não pode ser repetida', async () => {
    const { tarefa } = await criarTarefa(banco, regras, vermelha(), 'teste');
    const ap = await banco.query(`select id from aprovacoes where tarefa_id = $1`, [tarefa.id]);
    expect(await responderAprovacaoPeloPainel(banco, ap.rows[0].id, 'aprovar', 'breno')).toBe('aprovada');
    expect(await responderAprovacaoPeloPainel(banco, ap.rows[0].id, 'recusar', 'breno')).toBe('ja_respondida');
    expect((await pegarProxima(banco, 'w1'))?.id).toBe(tarefa.id);
  });

  it('trava vencida devolve a tarefa', async () => {
    await criarTarefa(banco, regras, verde('k1'), 'teste');
    const t = (await pegarProxima(banco, 'w1'))!;
    await banco.query(`update tarefas set travada_ate = now() - interval '1 second' where id = $1`, [t.id]);
    expect(await devolverTravadasVencidas(banco)).toBe(1);
    expect((await buscarTarefa(banco, t.id))?.status).toBe('pendente');
  });
});
