// Adaptador do agente de oferta: produz rascunhos (verde). Não publica nada.
import { gerarRascunho, type Adaptador, type Banco, type Cerebro, type TipoRascunho } from '@jarvis/core';
import { z } from 'zod';
import { protegido } from './comum.ts';

const acoes: Record<string, TipoRascunho> = {
  produzir_produto: 'produto',
  produzir_pagina_venda: 'pagina_venda',
  produzir_anuncios: 'anuncios',
};

const params = z.object({ briefing: z.string().min(10).max(4000) });

export function criarAdaptadorOferta(o: { banco: Banco; cerebro: Cerebro }): Adaptador {
  return {
    plataforma: 'oferta',
    temApi: true,
    acoesSuportadas: Object.keys(acoes),
    async verificarConexao() {
      return { ok: true, mensagem: 'agente de oferta disponível' };
    },
    async executar(acao, bruto, ctx) {
      return protegido(async () => {
        const tipo = acoes[acao];
        if (!tipo) return { ok: false, erro: { tipo: 'definitivo', codigo: 'ACAO_NAO_SUPORTADA', mensagem: acao } };
        if (!ctx.negocioId) return { ok: false, erro: { tipo: 'definitivo', codigo: 'SEM_NEGOCIO', mensagem: 'rascunho precisa de um negócio' } };
        const p = params.parse(bruto);
        const r = await gerarRascunho(o.banco, o.cerebro, {
          negocioId: ctx.negocioId,
          tarefaId: ctx.tarefaId,
          tipo,
          briefing: p.briefing,
          quem: 'agente:oferta',
        });
        if (r.bloqueado) {
          return { ok: false, erro: { tipo: 'precisa_humano', codigo: 'PROMESSA_PROIBIDA', mensagem: 'rascunho com promessa proibida: revisar briefing' } };
        }
        return { ok: true, dados: { rascunho_id: r.id, versao: r.versao, pontos_de_atencao: r.problemas.length }, mensagem: 'rascunho pronto para revisão' };
      });
    },
  };
}
