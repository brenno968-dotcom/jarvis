import type { Page } from 'playwright-core';

/** O que o motor de receitas precisa de um navegador. Playwright em produção; falso nos testes. */
export interface PaginaNavegador {
  abrir(url: string, timeoutMs: number): Promise<void>;
  preencher(seletor: string, valor: string, timeoutMs: number): Promise<void>;
  clicar(seletor: string, timeoutMs: number): Promise<void>;
  esperarSeletor(seletor: string, timeoutMs: number): Promise<void>;
  esperarTexto(texto: string, timeoutMs: number): Promise<void>;
  lerTexto(seletor: string, timeoutMs: number): Promise<string>;
  html(): Promise<string>;
  url(): string;
  /** Captura com os campos sensíveis cobertos (seção 20, item 5). */
  capturarTela(seletoresSensiveis: string[]): Promise<Buffer>;
}

/** Campos que sempre são mascarados nas capturas. */
export const SENSIVEIS_PADRAO = ['input[type=password]', 'input[autocomplete*=one-time-code]', '[data-sensivel]'];

export class PaginaPlaywright implements PaginaNavegador {
  constructor(private readonly p: Page) {}
  async abrir(url: string, timeoutMs: number) {
    await this.p.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
  }
  async preencher(seletor: string, valor: string, timeoutMs: number) {
    await this.p.locator(seletor).first().fill(valor, { timeout: timeoutMs });
  }
  async clicar(seletor: string, timeoutMs: number) {
    await this.p.locator(seletor).first().click({ timeout: timeoutMs });
  }
  async esperarSeletor(seletor: string, timeoutMs: number) {
    await this.p.locator(seletor).first().waitFor({ state: 'visible', timeout: timeoutMs });
  }
  async esperarTexto(texto: string, timeoutMs: number) {
    await this.p.getByText(texto, { exact: false }).first().waitFor({ state: 'visible', timeout: timeoutMs });
  }
  async lerTexto(seletor: string, timeoutMs: number) {
    const l = this.p.locator(seletor).first();
    await l.waitFor({ state: 'attached', timeout: timeoutMs });
    const tag = await l.evaluate((e) => e.tagName.toLowerCase());
    return tag === 'input' || tag === 'textarea' ? l.inputValue() : ((await l.textContent()) ?? '').trim();
  }
  async html() {
    return this.p.content();
  }
  url() {
    return this.p.url();
  }
  async capturarTela(seletoresSensiveis: string[]) {
    return this.p.screenshot({
      fullPage: true,
      mask: [...SENSIVEIS_PADRAO, ...seletoresSensiveis].map((s) => this.p.locator(s)),
    });
  }
}
