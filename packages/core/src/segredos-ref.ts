import type { Banco } from './banco.ts';
import { emTransacao } from './banco.ts';
import { registrarAuditoria } from './auditoria.ts';
import type { MetaSegredo } from './adaptador.ts';
import type { Cofre } from './cofre.ts';
import { criarTarefa } from './fila.ts';
import { redator } from './redacao.ts';
import type { Regras } from './regras.ts';
import { validarNomeSegredo } from './segredos.ts';

/**
 * Guarda (ou troca) o valor na Dory e mantém a referência em segredos_ref.
 * O valor nunca vai para o banco do Jarvis nem para log.
 */
export async function salvarSegredoNaDory(
  banco: Banco,
  cofre: Cofre,
  nome: string,
  valor: string,
  meta: MetaSegredo,
  quem: string,
): Promise<{ criado: boolean }> {
  validarNomeSegredo(nome);
  if (!valor) throw new Error('valor vazio');
  redator.registrar(nome, valor);
  const existente = await banco.query<{ bitwarden_secret_id: string }>(
    `select bitwarden_secret_id from segredos_ref where nome = $1`,
    [nome],
  );
  if (existente.rows[0]) {
    await cofre.atualizar(existente.rows[0].bitwarden_secret_id, nome, valor);
    await emTransacao(banco, async (c) => {
      await c.query(`update segredos_ref set rotacionado_em = now(), ultimo_teste_ok = null where nome = $1`, [nome]);
      await registrarAuditoria(c, { quem, acao: 'segredo_atualizado', empresaId: meta.empresaId, detalhes: { nome } });
    });
    return { criado: false };
  }
  const { id } = await cofre.criar(nome, valor, meta.bitwardenProjeto);
  await emTransacao(banco, async (c) => {
    await c.query(
      `insert into segredos_ref (empresa_id, negocio_id, nome, bitwarden_secret_id, bitwarden_projeto, plataforma, destinos)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [meta.empresaId, meta.negocioId ?? null, nome, id, meta.bitwardenProjeto, meta.plataforma, JSON.stringify(meta.destinos ?? [])],
    );
    await registrarAuditoria(c, { quem, acao: 'segredo_criado', empresaId: meta.empresaId, detalhes: { nome, plataforma: meta.plataforma } });
  });
  return { criado: true };
}

/**
 * Destinos de um segredo (segredos_ref.destinos):
 *   "vercel:<projeto>:<producao|preview>:<VARIAVEL>"   ex.: vercel:nexus-drive:producao:ASAAS_API_KEY
 *   "supabase:<projeto_ref>:<NOME_NA_FUNCAO>"           ex.: supabase:abcdefghijklmnop:ASAAS_API_KEY
 */
export function tarefaParaDestino(nome: string, destino: string): { acao: string; plataforma: string; parametros: Record<string, unknown> } | null {
  const partes = destino.split(':');
  if (partes[0] === 'vercel' && partes.length === 4) {
    const [, projeto, alvo, variavel] = partes as [string, string, string, string];
    return {
      acao: alvo === 'producao' ? 'aplicar_variavel_producao' : 'criar_variavel_ambiente_teste',
      plataforma: 'vercel',
      parametros: { projeto, variavel, segredo: nome, redeploy: true },
    };
  }
  if (partes[0] === 'supabase' && partes.length === 3) {
    const [, ref, nomeNaFuncao] = partes as [string, string, string];
    return { acao: 'criar_segredo', plataforma: 'supabase', parametros: { projeto_ref: ref, nome_na_funcao: nomeNaFuncao, segredo: nome } };
  }
  return null;
}

/**
 * Reaplica um segredo em todos os destinos (passo da rotação, seção 12 item 5):
 * cria uma tarefa por destino, com chave que muda a cada rotação.
 */
export async function reaplicarSegredo(
  banco: Banco,
  regras: Regras,
  nome: string,
  quem: string,
): Promise<{ criadas: number; ignorados: string[] }> {
  const r = await banco.query<{ empresa_id: string; negocio_id: string | null; destinos: string[]; rotacionado_em: Date | null; criado_em: Date }>(
    `select empresa_id, negocio_id, destinos, rotacionado_em, criado_em from segredos_ref where nome = $1`,
    [nome],
  );
  const ref = r.rows[0];
  if (!ref) throw new Error(`segredo ${nome} não está em segredos_ref`);
  const versao = (ref.rotacionado_em ?? ref.criado_em).getTime();
  const ignorados: string[] = [];
  let criadas = 0;
  for (const destino of ref.destinos ?? []) {
    const t = tarefaParaDestino(nome, destino);
    if (!t) {
      ignorados.push(destino);
      continue;
    }
    const { jaExistia } = await criarTarefa(
      banco,
      regras,
      {
        empresaId: ref.empresa_id,
        negocioId: ref.negocio_id,
        agente: 'jarvis_infra',
        ...t,
        idempotencyKey: `reaplicar:${nome}:${destino}:${versao}`,
        resumo: `Aplicar o segredo ${nome} em ${destino}`,
      },
      quem,
    );
    if (!jaExistia) criadas++;
  }
  return { criadas, ignorados };
}
