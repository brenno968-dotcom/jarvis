import type { PaginaNavegador } from './pagina.ts';

/**
 * Só DETECTA CAPTCHA/verificação humana para pedir ajuda ao Breno.
 * Resolver CAPTCHA automaticamente é proibido (seção 2, regra 5) e não existe neste código.
 */
const SINAIS_HTML: RegExp[] = [
  /<iframe[^>]+src="[^"]*(recaptcha|hcaptcha|challenges\.cloudflare\.com|arkoselabs|funcaptcha)/i,
  /class="[^"]*\b(g-recaptcha|h-captcha|cf-turnstile)\b/i,
  /data-sitekey=/i,
  /n[ãa]o sou um rob[ôo]/i,
  /i['’]?m not a robot/i,
  /verify (that )?you are (a )?human/i,
  /confirme que voc[eê] [ée] (um )?humano/i,
];

export async function detectarCaptcha(p: PaginaNavegador): Promise<boolean> {
  const html = await p.html();
  return SINAIS_HTML.some((r) => r.test(html));
}
