import type { Adaptador } from '@jarvis/core';

/** Um adaptador por plataforma (seção 19). */
export class RegistroAdaptadores {
  private mapa = new Map<string, Adaptador>();

  registrar(a: Adaptador): this {
    if (this.mapa.has(a.plataforma)) throw new Error(`adaptador duplicado: ${a.plataforma}`);
    this.mapa.set(a.plataforma, a);
    return this;
  }

  obter(plataforma: string | null): Adaptador | undefined {
    return plataforma ? this.mapa.get(plataforma) : undefined;
  }

  todos(): Adaptador[] {
    return [...this.mapa.values()];
  }
}
