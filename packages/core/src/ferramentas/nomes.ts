// Item 852: nomes das ferramentas LOCAIS da conversa (só leitura, executadas dentro do Jarvis, não vêm do Nexus nem de MCP).
// Arquivo sem imports de propósito: taint.ts e o catálogo dependem dele sem formar ciclo.
export const NOME_META_METRICAS = 'meta_metricas';
export const NOME_WEB_ABRIR = 'web_abrir';

/** Ferramentas locais da conversa. No semáforo, a ação tem o mesmo nome da tool (verde). */
export const FERRAMENTAS_LOCAIS: ReadonlySet<string> = new Set([NOME_META_METRICAS, NOME_WEB_ABRIR]);

/** Ferramentas locais cujo resultado é conteúdo de terceiros (taint "externo"). */
export const FERRAMENTAS_LOCAIS_EXTERNAS: ReadonlySet<string> = new Set([NOME_WEB_ABRIR]);

/** Ferramentas que fazem requisição de rede para um destino escolhido pelo modelo (canal possível de vazamento). */
export const FERRAMENTAS_COM_SAIDA_DE_REDE: ReadonlySet<string> = new Set([NOME_WEB_ABRIR]);
