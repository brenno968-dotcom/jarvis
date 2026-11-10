// Adaptador Vercel (seção 19.1). Fala só com a REST API oficial: https://api.vercel.com
// ⚠️ Escrito pela documentação e testado com respostas simuladas. CONFERIR num projeto de teste
//    antes de usar em produção (ver docs/STATUS.md, Fase 1).
import { requisitarJson, type Adaptador, type ContextoExecucao, type Resultado } from '@jarvis/core';
import { z } from 'zod';
import { esperaReal, nomeSegredo, protegido, type Esperar } from './comum.ts';

const API = 'https://api.vercel.com';
export const TOKEN_VERCEL = 'JARVIS_CORE_VERCEL_TOKEN';

const paramsVariavel = z.object({
  projeto: z.string().min(1),
  equipe_id: z.string().optional(),
  /** Nome da variável na Vercel. */
  variavel: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  /** Nome do segredo na Dory que guarda o valor. O valor nunca vem nos parâmetros. */
  segredo: nomeSegredo,
  redeploy: z.boolean().default(true),
});

const paramsRedeploy = z.object({
  projeto: z.string().min(1),
  equipe_id: z.string().optional(),
});

interface Deployment {
  uid?: string;
  id?: string;
  url?: string;
  readyState?: string;
  state?: string;
}

export interface OpcoesVercel {
  fetchImpl?: typeof fetch;
  esperar?: Esperar;
  intervaloMs?: number;
  limiteMs?: number;
}

export function criarAdaptadorVercel(o: OpcoesVercel = {}): Adaptador {
  const esperar = o.esperar ?? esperaReal;
  const intervalo = o.intervaloMs ?? 5_000;
  const limite = o.limiteMs ?? 10 * 60_000;

  const qs = (equipe?: string, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams({ ...extra, ...(equipe ? { teamId: equipe } : {}) });
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  async function token(ctx: ContextoExecucao) {
    return ctx.obterSegredo(TOKEN_VERCEL);
  }

  async function ultimoDeploy(tk: string, projeto: string, alvo: 'production' | 'preview', equipe?: string) {
    const r = await requisitarJson<{ deployments: Deployment[] }>(
      `${API}/v6/deployments${qs(equipe, { projectId: projeto, target: alvo, state: 'READY', limit: '1' })}`,
      { token: tk, fetchImpl: o.fetchImpl },
    );
    return r.deployments?.[0];
  }

  async function redeploy(ctx: ContextoExecucao, projeto: string, alvo: 'production' | 'preview', equipe?: string): Promise<Resultado> {
    const tk = await token(ctx);
    const base = await ultimoDeploy(tk, projeto, alvo, equipe);
    const baseId = base?.uid ?? base?.id;
    if (!baseId) {
      return { ok: false, erro: { tipo: 'definitivo', codigo: 'SEM_DEPLOY_BASE', mensagem: `nenhum deploy pronto em ${alvo} para refazer` } };
    }
    const novo = await requisitarJson<Deployment>(`${API}/v13/deployments${qs(equipe, { forceNew: '1' })}`, {
      metodo: 'POST',
      token: tk,
      fetchImpl: o.fetchImpl,
      corpo: { name: projeto, deploymentId: baseId, ...(alvo === 'production' ? { target: 'production' } : {}) },
    });
    const id = novo.id ?? novo.uid;
    if (!id) return { ok: false, erro: { tipo: 'temporario', codigo: 'SEM_ID', mensagem: 'Vercel não devolveu o id do deploy' } };

    // Aguarda READY (seção 19.1).
    const inicio = Date.now();
    for (;;) {
      const d = await requisitarJson<Deployment>(`${API}/v13/deployments/${encodeURIComponent(id)}${qs(equipe)}`, {
        token: tk,
        fetchImpl: o.fetchImpl,
      });
      const estado = d.readyState ?? d.state;
      if (estado === 'READY') return { ok: true, dados: { deployment_id: id, url: d.url ?? novo.url, alvo }, mensagem: 'redeploy pronto' };
      if (estado === 'ERROR' || estado === 'CANCELED') {
        return { ok: false, erro: { tipo: 'definitivo', codigo: `DEPLOY_${estado}`, mensagem: `deploy ${id} terminou em ${estado}` } };
      }
      if (Date.now() - inicio > limite) {
        return { ok: false, erro: { tipo: 'temporario', codigo: 'DEPLOY_DEMOROU', mensagem: `deploy ${id} não ficou pronto a tempo` } };
      }
      await esperar(intervalo);
    }
  }

  async function aplicarVariavel(ctx: ContextoExecucao, bruto: Record<string, unknown>, alvos: ('production' | 'preview')[]) {
    const p = paramsVariavel.parse(bruto);
    const tk = await token(ctx);
    const valor = await ctx.obterSegredo(p.segredo);
    await requisitarJson(`${API}/v10/projects/${encodeURIComponent(p.projeto)}/env${qs(p.equipe_id, { upsert: 'true' })}`, {
      metodo: 'POST',
      token: tk,
      fetchImpl: o.fetchImpl,
      corpo: { key: p.variavel, value: valor, type: 'sensitive', target: alvos },
    });
    await ctx.registrarAuditoria('vercel_variavel_aplicada', { projeto: p.projeto, variavel: p.variavel, segredo: p.segredo, alvos });
    if (!p.redeploy) return { ok: true, dados: { variavel: p.variavel, alvos }, mensagem: 'variável aplicada (sem redeploy)' };
    // Variável só vale depois de novo deploy.
    const alvoRedeploy = alvos.includes('production') ? 'production' : 'preview';
    const r = await redeploy(ctx, p.projeto, alvoRedeploy, p.equipe_id);
    if (!r.ok) return r;
    return { ok: true, dados: { variavel: p.variavel, alvos, ...(r.dados as object) }, mensagem: 'variável aplicada e redeploy pronto' };
  }

  return {
    plataforma: 'vercel',
    temApi: true,
    acoesSuportadas: ['criar_variavel_ambiente_teste', 'aplicar_variavel_producao', 'redeploy_preview', 'redeploy_producao'],

    async verificarConexao(ctx) {
      return protegido(async () => {
        await requisitarJson(`${API}/v2/user`, { token: await token(ctx), fetchImpl: o.fetchImpl });
        return { ok: true, mensagem: 'token da Vercel válido' };
      });
    },

    async executar(acao, params, ctx) {
      return protegido(async () => {
        switch (acao) {
          case 'criar_variavel_ambiente_teste':
            return aplicarVariavel(ctx, params, ['preview']);
          case 'aplicar_variavel_producao':
            return aplicarVariavel(ctx, params, ['production', 'preview']);
          case 'redeploy_preview': {
            const p = paramsRedeploy.parse(params);
            return redeploy(ctx, p.projeto, 'preview', p.equipe_id);
          }
          case 'redeploy_producao': {
            const p = paramsRedeploy.parse(params);
            return redeploy(ctx, p.projeto, 'production', p.equipe_id);
          }
          default:
            return { ok: false, erro: { tipo: 'definitivo', codigo: 'ACAO_NAO_SUPORTADA', mensagem: acao } };
        }
      });
    },
  };
}
