// Adaptador Meta Ads (Fase 5), só o que é seguro: LER métricas e PAUSAR campanha.
// Criar campanha/anúncio (vermelho) fica para a integração real.
// ⚠️ Escrito pela documentação da Marketing API e testado com respostas simuladas.
//    A Meta muda a API com frequência: conferir a versão (JARVIS_META_API_VERSAO) e os campos.
import { gravarMetricas, requisitarJson, type Adaptador, type Banco } from '@jarvis/core';
import { z } from 'zod';
import { nomeSegredo, protegido } from './comum.ts';

export const TOKEN_META = 'JARVIS_CORE_META_ADS_TOKEN';

const paramsLer = z.object({
  conta: z.string().regex(/^act_\d+$/),
  desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  token_segredo: nomeSegredo.default(TOKEN_META),
});

const paramsPausar = z.object({
  campanha_id: z.string().uuid(),
  id_externo: z.string().regex(/^\d+$/),
  token_segredo: nomeSegredo.default(TOKEN_META),
});

interface LinhaInsight {
  campaign_id: string;
  campaign_name?: string;
  date_start: string;
  spend?: string;
  impressions?: string;
  clicks?: string;
  actions?: { action_type: string; value: string }[];
  action_values?: { action_type: string; value: string }[];
}

const somaAcoes = (lista: { action_type: string; value: string }[] | undefined, tipos: string[]) =>
  (lista ?? []).filter((a) => tipos.includes(a.action_type)).reduce((s, a) => s + Number(a.value), 0);

export function criarAdaptadorMetaAds(o: { banco: Banco; fetchImpl?: typeof fetch; versao?: string }): Adaptador {
  const versao = o.versao ?? process.env.JARVIS_META_API_VERSAO ?? 'v21.0';
  const API = `https://graph.facebook.com/${versao}`;
  return {
    plataforma: 'meta',
    temApi: true,
    acoesSuportadas: ['ler_metricas_campanha', 'pausar_campanha'],

    async verificarConexao(ctx) {
      return protegido(async () => {
        await requisitarJson(`${API}/me?fields=id`, { token: await ctx.obterSegredo(TOKEN_META), fetchImpl: o.fetchImpl });
        return { ok: true, mensagem: 'token da Meta válido' };
      });
    },

    async executar(acao, bruto, ctx) {
      return protegido(async () => {
        if (acao === 'ler_metricas_campanha') {
          const p = paramsLer.parse(bruto);
          const tk = await ctx.obterSegredo(p.token_segredo);
          const qs = new URLSearchParams({
            level: 'campaign',
            time_increment: '1',
            fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions,action_values',
            time_range: JSON.stringify({ since: p.desde, until: p.ate }),
            limit: '500',
          });
          const r = await requisitarJson<{ data: LinhaInsight[] }>(`${API}/${p.conta}/insights?${qs}`, { token: tk, fetchImpl: o.fetchImpl });
          let gravadas = 0;
          for (const l of r.data) {
            const c = await o.banco.query<{ id: string }>(
              `select id from campanhas where plataforma = 'meta' and id_externo = $1 and negocio_id = $2`,
              [l.campaign_id, ctx.negocioId],
            );
            if (!c.rows[0]) continue; // campanha que o Jarvis não conhece: ignora
            await gravarMetricas(o.banco, c.rows[0].id, l.date_start, {
              gasto_brl: Number(l.spend ?? 0),
              impressoes: Number(l.impressions ?? 0),
              cliques: Number(l.clicks ?? 0),
              leads: somaAcoes(l.actions, ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead']),
              vendas: somaAcoes(l.actions, ['purchase', 'offsite_conversion.fb_pixel_purchase']),
              receita_brl: somaAcoes(l.action_values, ['purchase', 'offsite_conversion.fb_pixel_purchase']),
            });
            gravadas++;
          }
          return { ok: true, dados: { linhas: r.data.length, gravadas }, mensagem: 'métricas atualizadas' };
        }
        if (acao === 'pausar_campanha') {
          const p = paramsPausar.parse(bruto);
          await requisitarJson(`${API}/${p.id_externo}`, {
            metodo: 'POST',
            token: await ctx.obterSegredo(p.token_segredo),
            fetchImpl: o.fetchImpl,
            corpo: { status: 'PAUSED' },
          });
          await o.banco.query(`update campanhas set status = 'pausada' where id = $1`, [p.campanha_id]);
          await ctx.registrarAuditoria('campanha_pausada', { campanha: p.campanha_id });
          return { ok: true, dados: { campanha_id: p.campanha_id }, mensagem: 'campanha pausada' };
        }
        return { ok: false, erro: { tipo: 'definitivo', codigo: 'ACAO_NAO_SUPORTADA', mensagem: acao } };
      });
    },
  };
}
