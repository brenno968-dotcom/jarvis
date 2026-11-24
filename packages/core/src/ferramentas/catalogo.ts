// Item 852: catálogo das ferramentas LOCAIS da conversa (painel e WhatsApp passam por `responderConversa`).
// São só leitura e verdes no semáforo (config/regras.yaml). Entram junto das ferramentas do Nexus e dos MCP externos;
// as skills as liberam por `ferramentas_permitidas` (o escopo só reduz) e o LoopGuard/taint/telemetria valem como nas demais.
import type { Consultavel } from '../banco.ts';
import type { FerramentaIa } from '../nexus-mcp.ts';
import type { AoDetectarInjecao } from '../seguranca/taint.ts';
import { ferramentaMetaMetricas, executarMetaMetricas, type DepsMetaMetricas, type EventoMetaMetricas } from './meta-metricas.ts';
import { NOME_META_METRICAS, NOME_WEB_ABRIR } from './nomes.ts';
import type { OpcoesBuscaSegura } from './ssrf.ts';
import { executarWebAbrir, ferramentaWebAbrir, type EventoWebAbrir } from './web-abrir.ts';

export type EventoFerramentaLocal =
  | ({ ferramenta: typeof NOME_META_METRICAS } & EventoMetaMetricas)
  | ({ ferramenta: typeof NOME_WEB_ABRIR } & EventoWebAbrir);

export interface OpcoesFerramentasLocais {
  banco: Consultavel;
  /** Auditoria de cada injeção detectada no resultado do web_abrir (`auditoriaDeInjecao`). */
  aoDetectarInjecao?: AoDetectarInjecao;
  /** Telemetria de uso (só nome, desfecho e host/fonte; nunca URL completa, conteúdo ou token). Falha aqui nunca derruba a conversa. */
  aoUsar?: (e: EventoFerramentaLocal) => void | Promise<void>;
  /** Só para testes. */
  meta?: Partial<Omit<DepsMetaMetricas, 'banco'>>;
  web?: OpcoesBuscaSegura;
}

export interface FerramentasLocais {
  ferramentas: FerramentaIa[];
  /** Devolve null se o nome não for de uma ferramenta local. Nunca lança. */
  executar(nome: string, args: Record<string, unknown>): Promise<string> | null;
}

export function criarFerramentasLocais(o: OpcoesFerramentasLocais): FerramentasLocais {
  const avisar = (e: EventoFerramentaLocal) => {
    try {
      void Promise.resolve(o.aoUsar?.(e)).catch(() => undefined);
    } catch {
      /* telemetria não derruba a conversa */
    }
  };
  return {
    ferramentas: [ferramentaMetaMetricas, ferramentaWebAbrir],
    executar(nome, args) {
      if (nome === NOME_META_METRICAS) return executarMetaMetricas(args, { banco: o.banco, ...o.meta }, (e) => avisar({ ferramenta: NOME_META_METRICAS, ...e }));
      if (nome === NOME_WEB_ABRIR) return executarWebAbrir(args, { ...o.web, aoDetectarInjecao: o.aoDetectarInjecao }, (e) => avisar({ ferramenta: NOME_WEB_ABRIR, ...e }));
      return null;
    },
  };
}
