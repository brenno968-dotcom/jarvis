import { log, type Adaptador, type ContextoExecucao, type Resultado } from '@jarvis/core';

/**
 * Adaptador de teste da Fase 0. Não fala com nenhuma plataforma real.
 * Serve para provar a fila, a idempotência, a redação de segredos e o painel.
 */
export const contadorEfeitosTeste = { valor: 0 };

export const NOME_SEGREDO_TESTE = 'JARVIS_CORE_TESTE_SEGREDO';

export const adaptadorTeste: Adaptador = {
  plataforma: 'teste',
  temApi: true,
  acoesSuportadas: ['teste_eco', 'teste_usar_segredo', 'teste_efeito', 'teste_vermelho'],

  async verificarConexao(): Promise<Resultado> {
    return { ok: true, mensagem: 'adaptador de teste sempre conectado' };
  },

  async executar(acao: string, params: Record<string, unknown>, ctx: ContextoExecucao): Promise<Resultado> {
    switch (acao) {
      case 'teste_eco':
      case 'teste_vermelho':
        return { ok: true, dados: { eco: params }, mensagem: 'eco executado' };

      case 'teste_usar_segredo': {
        const valor = await ctx.obterSegredo(NOME_SEGREDO_TESTE);
        // De propósito: tenta vazar o valor em log, auditoria e resultado.
        // O redator tem que trocar tudo por [segredo:NOME].
        log('info', `usando o segredo ${valor}`, { valor });
        await ctx.registrarAuditoria('teste_segredo_usado', { valor });
        return { ok: true, dados: { conferido: valor.length > 0, eco: valor }, mensagem: `segredo ${valor} usado` };
      }

      case 'teste_efeito':
        contadorEfeitosTeste.valor += 1;
        return { ok: true, dados: { efeito: contadorEfeitosTeste.valor }, mensagem: 'efeito externo simulado' };

      default:
        return {
          ok: false,
          erro: { tipo: 'definitivo', codigo: 'ACAO_NAO_SUPORTADA', mensagem: `ação ${acao} não suportada` },
        };
    }
  },
};
