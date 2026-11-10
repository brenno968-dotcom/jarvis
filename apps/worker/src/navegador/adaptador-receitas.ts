import { enfileirarAviso, registrarConta, type Adaptador, type Banco, type ContextoExecucao, type Resultado } from '@jarvis/core';
import { esquemaReceita, executarReceita, type DepsReceita } from './receitas.ts';
import type { PaginaNavegador } from './pagina.ts';

export interface SessaoNavegador {
  pagina: PaginaNavegador;
  /** Link de visualização ao vivo (navegador na nuvem), se houver. */
  linkAoVivo?: string;
  fechar(): Promise<void>;
}

/**
 * Adaptador para plataformas sem API: executa a receita aprovada pelo Vigia da tabela `receitas`.
 * Três falhas seguidas → receita marcada para revisão e o Breno avisado (seção 20, item 7).
 */
export function criarAdaptadorPorReceita(o: {
  plataforma: string;
  acoes: string[];
  banco: Banco;
  abrirSessao: () => Promise<SessaoNavegador>;
  deps?: Omit<DepsReceita, 'aoVivo'> & { esperaHumanoMs?: number; intervaloHumanoMs?: number };
  /** Testes/Fase 2: aceitar receita ainda não aprovada pelo Vigia. */
  aceitarSemVigia?: boolean;
}): Adaptador {
  return {
    plataforma: o.plataforma,
    temApi: false,
    acoesSuportadas: o.acoes,

    async verificarConexao(): Promise<Resultado> {
      const r = await o.banco.query(`select count(*)::int as n from receitas where plataforma = $1`, [o.plataforma]);
      return r.rows[0].n > 0
        ? { ok: true, mensagem: 'receitas disponíveis' }
        : { ok: false, erro: { tipo: 'definitivo', codigo: 'SEM_RECEITA', mensagem: 'nenhuma receita cadastrada' } };
    },

    async executar(acao: string, params: Record<string, unknown>, ctx: ContextoExecucao): Promise<Resultado> {
      const linha = await o.banco.query<{ id: string; passos: unknown; versao: number }>(
        `select id, passos, versao from receitas
          where plataforma = $1 and acao = $2 and ($3 or aprovada_pelo_vigia)
          order by versao desc limit 1`,
        [o.plataforma, acao, Boolean(o.aceitarSemVigia)],
      );
      const rec = linha.rows[0];
      if (!rec) {
        return { ok: false, erro: { tipo: 'precisa_humano', codigo: 'SEM_RECEITA', mensagem: `sem receita aprovada para ${o.plataforma}/${acao}` } };
      }
      const receita = esquemaReceita.parse({ plataforma: o.plataforma, acao, ...(rec.passos as object) });
      const sessao = await o.abrirSessao();
      try {
        const r = await executarReceita(sessao.pagina, receita, params, ctx, {
          ...o.deps,
          ...(sessao.linkAoVivo
            ? { aoVivo: { link: sessao.linkAoVivo, limiteMs: o.deps?.esperaHumanoMs ?? 30 * 60_000, intervaloMs: o.deps?.intervaloHumanoMs ?? 3_000 } }
            : {}),
        });
        if (r.ok) {
          await o.banco.query(`update receitas set ultima_execucao_ok = now(), falhas_seguidas = 0 where id = $1`, [rec.id]);
          if (acao === 'criar_conta') {
            // Inventário de contas (seção 12.3).
            await registrarConta(o.banco, {
              empresaId: ctx.empresaId,
              negocioId: ctx.negocioId,
              plataforma: o.plataforma,
              email: typeof params.email === 'string' ? params.email : undefined,
            });
          }
        } else if (r.erro?.codigo !== 'CAPTCHA' && r.erro?.codigo !== 'CAPTCHA_SEM_RESPOSTA') {
          const f = await o.banco.query<{ falhas_seguidas: number }>(
            `update receitas set falhas_seguidas = falhas_seguidas + 1 where id = $1 returning falhas_seguidas`,
            [rec.id],
          );
          if (f.rows[0]!.falhas_seguidas === 3) {
            await enfileirarAviso(o.banco, {
              tipo: 'texto',
              conteudo: { texto: `A receita ${o.plataforma}/${acao} falhou 3 vezes seguidas: precisa de revisão (o site pode ter mudado).` },
            });
          }
        }
        return r;
      } finally {
        await sessao.fechar().catch(() => {});
      }
    },
  };
}
