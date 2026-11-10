import { redator } from './redacao.ts';

export type NivelLog = 'debug' | 'info' | 'aviso' | 'erro';

export type DestinoLog = (linha: string) => void;

let destino: DestinoLog = (linha) => process.stdout.write(linha + '\n');

/** Troca o destino dos logs (usado nos testes para capturar tudo). */
export function definirDestinoLog(novo: DestinoLog): void {
  destino = novo;
}

/** Log em JSON, uma linha por evento, sempre redigido. */
export function log(nivel: NivelLog, mensagem: string, dados?: Record<string, unknown>): void {
  const linha = JSON.stringify({
    quando: new Date().toISOString(),
    nivel,
    mensagem: redator.redigir(mensagem),
    ...(dados ? { dados: redator.redigirValor(dados) } : {}),
  });
  destino(redator.redigir(linha));
}
