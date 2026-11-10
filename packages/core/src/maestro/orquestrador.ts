import type { Banco } from '../banco.ts';
import { emTransacao } from '../banco.ts';
import { criarAprovacao } from '../aprovacoes.ts';
import { registrarAuditoria } from '../auditoria.ts';
import { enfileirarAviso } from '../avisos.ts';
import { criarTarefa } from '../fila.ts';
import type { Regras } from '../regras.ts';
import { resumoDoPlano, type PlanoValidado } from './plano.ts';

/** Grava negócio + plano e pede a aprovação do Breno (o plano inteiro é sempre vermelho). */
export async function salvarPlano(
  banco: Banco,
  regras: Regras,
  p: { empresaId: string; nomeNegocio: string; validado: PlanoValidado; quem: string },
): Promise<{ negocioId: string; planoId: string; token: string }> {
  if (p.validado.bloqueios.length) throw new Error(`plano bloqueado: ${p.validado.bloqueios.join('; ')}`);
  return emTransacao(banco, async (c) => {
    const n = await c.query<{ id: string }>(
      `insert into negocios (empresa_id, nome, modelo_negocio, orcamento) values ($1, $2, $3, $4) returning id`,
      [p.empresaId, p.nomeNegocio, p.validado.plano.modelo_negocio, JSON.stringify(p.validado.plano.orcamento)],
    );
    const negocioId = n.rows[0]!.id;
    const pl = await c.query<{ id: string }>(
      `insert into planos (negocio_id, conteudo) values ($1, $2) returning id`,
      [negocioId, JSON.stringify({
        ...p.validado.plano,
        viabilidade_calculada: p.validado.viabilidade,
        custo_estimado_brl: p.validado.custo_estimado_brl,
        pendencias: p.validado.pendencias,
        reaproveitado: (p.validado as { reaproveitado?: unknown }).reaproveitado ?? [],
      })],
    );
    const planoId = pl.rows[0]!.id;
    const ap = await criarAprovacao(c, regras, { planoId, resumo: resumoDoPlano(p.validado) });
    await enfileirarAviso(c, { tipo: 'pedido_aprovacao', aprovacaoId: ap.id });
    await registrarAuditoria(c, { quem: p.quem, acao: 'plano_criado', empresaId: p.empresaId, negocioId, detalhes: { plano_id: planoId } });
    return { negocioId, planoId, token: ap.token };
  });
}

interface LinhaPlano {
  id: string;
  versao: number;
  negocio_id: string;
  empresa_id: string;
  conteudo: PlanoValidado['plano'];
}

/**
 * Anda com os planos aprovados: cria a tarefa de cada etapa cujas dependências já terminaram.
 * Etapa vermelha ganha a própria aprovação (o semáforo vale etapa por etapa).
 * Tudo concluído → plano concluído e negócio ativo. Algo falhou/recusado → plano travado e o Breno é avisado.
 */
export async function avancarPlanos(banco: Banco, regras: Regras, quem = 'maestro'): Promise<{ criadas: number }> {
  const planos = await banco.query<LinhaPlano>(
    `select p.id, p.versao, p.negocio_id, n.empresa_id, p.conteudo
       from planos p join negocios n on n.id = p.negocio_id where p.status = 'aprovado'`,
  );
  let criadas = 0;
  for (const pl of planos.rows) {
    const t = await banco.query<{ etapa_id: string; status: string }>(`select etapa_id, status from tarefas where plano_id = $1`, [pl.id]);
    const porEtapa = new Map(t.rows.map((r) => [r.etapa_id, r.status]));
    const ruins = t.rows.filter((r) => ['falhou', 'recusada', 'cancelada'].includes(r.status));
    if (ruins.length) {
      await emTransacao(banco, async (c) => {
        const up = await c.query(`update planos set status = 'travado' where id = $1 and status = 'aprovado'`, [pl.id]);
        if (up.rowCount) {
          await enfileirarAviso(c, {
            tipo: 'texto',
            conteudo: { texto: `O plano "${pl.conteudo.objetivo}" travou: etapa(s) ${ruins.map((r) => r.etapa_id).join(', ')} não deram certo.` },
          });
          await registrarAuditoria(c, { quem, acao: 'plano_travado', negocioId: pl.negocio_id, detalhes: { plano_id: pl.id } });
        }
      });
      continue;
    }
    const etapas = pl.conteudo.etapas;
    if (etapas.every((e) => porEtapa.get(e.etapa_id) === 'concluida')) {
      await emTransacao(banco, async (c) => {
        await c.query(`update planos set status = 'concluido' where id = $1`, [pl.id]);
        await c.query(`update negocios set status = 'ativo' where id = $1`, [pl.negocio_id]);
        await enfileirarAviso(c, { tipo: 'texto', conteudo: { texto: `Plano concluído: "${pl.conteudo.objetivo}". Negócio ativo.` } });
        await registrarAuditoria(c, { quem, acao: 'plano_concluido', negocioId: pl.negocio_id, detalhes: { plano_id: pl.id } });
      });
      continue;
    }
    for (const e of etapas) {
      if (porEtapa.has(e.etapa_id)) continue;
      if (!e.depende_de.every((d) => porEtapa.get(d) === 'concluida')) continue;
      const r = await criarTarefa(
        banco,
        regras,
        {
          empresaId: pl.empresa_id,
          negocioId: pl.negocio_id,
          planoId: pl.id,
          etapaId: e.etapa_id,
          agente: e.agente,
          acao: e.acao,
          plataforma: e.plataforma ?? e.agente,
          parametros: e.parametros,
          idempotencyKey: `plano:${pl.id}:v${pl.versao}:${e.etapa_id}`,
          resumo: `${e.titulo} (plano: ${pl.conteudo.objetivo})`,
        },
        quem,
      );
      if (!r.jaExistia) criadas++;
    }
  }
  return { criadas };
}
