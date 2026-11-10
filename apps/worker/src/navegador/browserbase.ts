// Navegador na nuvem com visualização ao vivo (seção 20), pelo Browserbase.
// ⚠️ Escrito pela documentação e NÃO testado com a conta real: conferir endpoints e campos
//    (criação da sessão, link de "debug"/visualização ao vivo e encerramento) antes de usar.
//    O recurso de resolver CAPTCHA automaticamente do provedor NÃO é ligado aqui.
import { requisitarJson } from '@jarvis/core';
import { chromium } from 'playwright-core';
import { PaginaPlaywright } from './pagina.ts';
import type { SessaoNavegador } from './adaptador-receitas.ts';

const API = 'https://api.browserbase.com/v1';

export function criarAbridorBrowserbase(o: { chave: string; projeto: string; fetchImpl?: typeof fetch }): () => Promise<SessaoNavegador> {
  const cab = { 'x-bb-api-key': o.chave };
  return async () => {
    const s = await requisitarJson<{ id: string; connectUrl: string }>(`${API}/sessions`, {
      metodo: 'POST',
      cabecalhos: cab,
      corpo: { projectId: o.projeto, browserSettings: { solveCaptchas: false } },
      fetchImpl: o.fetchImpl,
    });
    const debug = await requisitarJson<{ debuggerFullscreenUrl?: string }>(`${API}/sessions/${s.id}/debug`, {
      cabecalhos: cab,
      fetchImpl: o.fetchImpl,
    });
    const navegador = await chromium.connectOverCDP(s.connectUrl);
    const contexto = navegador.contexts()[0] ?? (await navegador.newContext());
    const pagina = contexto.pages()[0] ?? (await contexto.newPage());
    return {
      pagina: new PaginaPlaywright(pagina),
      linkAoVivo: debug.debuggerFullscreenUrl,
      fechar: async () => {
        await navegador.close().catch(() => {});
        await requisitarJson(`${API}/sessions/${s.id}`, {
          metodo: 'POST',
          cabecalhos: cab,
          corpo: { projectId: o.projeto, status: 'REQUEST_RELEASE' },
          fetchImpl: o.fetchImpl,
        }).catch(() => {});
      },
    };
  };
}
