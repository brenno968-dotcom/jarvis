// Gera o HTML da página de venda a partir do rascunho aprovado (sem script, tudo escapado).
import type { z } from 'zod';
import type { esquemas } from './rascunhos.ts';

type Pagina = z.infer<(typeof esquemas)['pagina_venda']>;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function gerarHtmlPaginaVenda(p: Pagina, o: { linkCompra: string; linkPrivacidade: string }): string {
  const url = (u: string) => {
    const x = new URL(u);
    if (x.protocol !== 'https:') throw new Error('links da página precisam ser https');
    return esc(x.toString());
  };
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.titulo)}</title>
<style>:root{color-scheme:light dark}body{font:17px/1.6 system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px}
h1{line-height:1.2}a.comprar{display:inline-block;padding:14px 22px;background:#1d6b3f;color:#fff;text-decoration:none;border-radius:6px}
small{opacity:.75}</style></head><body>
<h1>${esc(p.titulo)}</h1><p>${esc(p.subtitulo)}</p>
<h2>Para quem é</h2><ul>${p.para_quem.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<h2>O que você recebe</h2><ul>${p.o_que_recebe.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
${p.perguntas.length ? `<h2>Perguntas</h2>${p.perguntas.map((q) => `<h3>${esc(q.pergunta)}</h3><p>${esc(q.resposta)}</p>`).join('')}` : ''}
<p><strong>${brl(p.preco_brl)}</strong></p>
<p><a class="comprar" href="${url(o.linkCompra)}" rel="noopener">${esc(p.chamada)}</a></p>
<p><small>Garantia de ${p.garantia_dias} dias: se não gostar, devolvemos o valor. <a href="${url(o.linkPrivacidade)}">Política de privacidade</a>.</small></p>
</body></html>`;
}
