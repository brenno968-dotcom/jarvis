// Adaptador Supabase (seção 19.2): segredos das Edge Functions pela Management API.
// https://api.supabase.com — segredos valem na hora, sem redeploy.
// ⚠️ Escrito pela documentação e testado com respostas simuladas. CONFERIR num projeto de teste.
import { requisitarJson, type Adaptador, type ContextoExecucao } from '@jarvis/core';
import { z } from 'zod';
import { nomeSegredo, protegido } from './comum.ts';

const API = 'https://api.supabase.com';
export const TOKEN_SUPABASE = 'JARVIS_CORE_SUPABASE_TOKEN';

const paramsSegredo = z.object({
  projeto_ref: z.string().regex(/^[a-z0-9]{10,40}$/),
  /** Nome do segredo dentro da Edge Function (ex.: ASAAS_API_KEY). */
  nome_na_funcao: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  /** Nome do segredo na Dory. */
  segredo: nomeSegredo,
  /** Segredo da Dory com o token de gerenciamento deste projeto (um token por projeto). */
  token_segredo: nomeSegredo.default(TOKEN_SUPABASE),
});

const paramsListar = z.object({
  projeto_ref: z.string().regex(/^[a-z0-9]{10,40}$/),
  token_segredo: nomeSegredo.default(TOKEN_SUPABASE),
});

export interface OpcoesSupabase {
  fetchImpl?: typeof fetch;
}

export function criarAdaptadorSupabase(o: OpcoesSupabase = {}): Adaptador {
  async function criarSegredo(ctx: ContextoExecucao, bruto: Record<string, unknown>) {
    const p = paramsSegredo.parse(bruto);
    const tk = await ctx.obterSegredo(p.token_segredo);
    const valor = await ctx.obterSegredo(p.segredo);
    await requisitarJson(`${API}/v1/projects/${p.projeto_ref}/secrets`, {
      metodo: 'POST',
      token: tk,
      fetchImpl: o.fetchImpl,
      corpo: [{ name: p.nome_na_funcao, value: valor }],
    });
    await ctx.registrarAuditoria('supabase_segredo_aplicado', { projeto: p.projeto_ref, nome: p.nome_na_funcao, segredo: p.segredo });
    return { ok: true, dados: { projeto: p.projeto_ref, nome: p.nome_na_funcao }, mensagem: 'segredo aplicado (vale na hora)' };
  }

  return {
    plataforma: 'supabase',
    temApi: true,
    acoesSuportadas: ['criar_segredo', 'consultar_estado'],

    async verificarConexao(ctx) {
      return protegido(async () => {
        await requisitarJson(`${API}/v1/projects`, { token: await ctx.obterSegredo(TOKEN_SUPABASE), fetchImpl: o.fetchImpl });
        return { ok: true, mensagem: 'token do Supabase válido' };
      });
    },

    async executar(acao, params, ctx) {
      return protegido(async () => {
        if (acao === 'criar_segredo') return criarSegredo(ctx, params);
        if (acao === 'consultar_estado') {
          // Só os NOMES dos segredos (a API não devolve os valores; mesmo assim, descartamos qualquer valor).
          const p = paramsListar.parse(params);
          const r = await requisitarJson<{ name: string }[]>(`${API}/v1/projects/${p.projeto_ref}/secrets`, {
            token: await ctx.obterSegredo(p.token_segredo),
            fetchImpl: o.fetchImpl,
          });
          return { ok: true, dados: { nomes: r.map((s) => s.name).sort() } };
        }
        return { ok: false, erro: { tipo: 'definitivo', codigo: 'ACAO_NAO_SUPORTADA', mensagem: acao } };
      });
    },
  };
}
