// Item 416 (parte 2): o Jarvis usa as ferramentas do Nexus pelo conector MCP (/api/mcp), assinando cada pedido
// (x-jarvis-timestamp + x-jarvis-assinatura, o mesmo segredo dos avisos). O Nexus marca a chamada como "Jarvis".
// Só passam as ferramentas da lista abaixo: ler Quadro, Atlas, saúde e banco (só leitura); gravar só no Quadro e no Atlas.
import { assinar } from './assinatura.ts';
import { redator } from './redacao.ts';

export interface FerramentaIa {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Ferramentas do Nexus que a conversa pode usar (o resto do conector fica de fora). */
export const FERRAMENTAS_NEXUS_PERMITIDAS = [
  'pedidos_buscar_parecidos',
  'pedidos_listar',
  'pedidos_ver',
  'pedidos_criar',
  'pedidos_atualizar',
  'atlas_buscar',
  'atlas_gravar',
  'sistema_saude',
  'banco_tabelas',
  'banco_consultar',
] as const;

export interface ClienteNexusMcp {
  ferramentas(): Promise<FerramentaIa[]>;
  chamar(nome: string, args: Record<string, unknown>, timeoutMs?: number): Promise<string>;
}

/** Endereço do conector: JARVIS_CORE_NEXUS_MCP_URL ou a origem de JARVIS_CORE_NEXUS_AVISOS_URL + /api/mcp. */
export function urlDoMcp(env: { JARVIS_CORE_NEXUS_MCP_URL?: string; JARVIS_CORE_NEXUS_AVISOS_URL?: string }): string | null {
  if (env.JARVIS_CORE_NEXUS_MCP_URL) return env.JARVIS_CORE_NEXUS_MCP_URL;
  if (!env.JARVIS_CORE_NEXUS_AVISOS_URL) return null;
  try {
    return `${new URL(env.JARVIS_CORE_NEXUS_AVISOS_URL).origin}/api/mcp`;
  } catch {
    return null;
  }
}

const LIMITE_RESPOSTA = 6000;

export function criarClienteNexusMcp(o: { url: string; segredo: string; fetchImpl?: typeof fetch; agora?: () => number }): ClienteNexusMcp {
  const f = o.fetchImpl ?? fetch;
  let id = 0;
  let cache: FerramentaIa[] | null = null;
  async function rpc(metodo: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const corpo = JSON.stringify({ jsonrpc: '2.0', id: ++id, method: metodo, params });
    const ts = Math.floor((o.agora?.() ?? Date.now()) / 1000);
    let resp: Response;
    try {
      resp = await f(o.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-jarvis-timestamp': String(ts), 'x-jarvis-assinatura': assinar(o.segredo, ts, corpo) },
        body: corpo,
        signal: AbortSignal.timeout(Math.max(500, timeoutMs)),
      });
    } catch (e) {
      throw new Error(redator.redigir(`o Nexus não respondeu (${(e as Error)?.message ?? e})`));
    }
    const texto = await resp.text();
    if (!resp.ok) throw new Error(redator.redigir(`o Nexus recusou (HTTP ${resp.status}): ${texto.slice(0, 200)}`));
    const j = JSON.parse(texto) as { result?: Record<string, unknown>; error?: { message?: string } };
    if (j.error) throw new Error(redator.redigir(`o Nexus devolveu erro: ${j.error.message ?? 'sem detalhe'}`));
    return j.result ?? {};
  }
  return {
    async ferramentas() {
      if (cache) return cache;
      const r = await rpc('tools/list', {}, 8000);
      const lista = (r.tools as { name: string; description?: string; inputSchema?: Record<string, unknown> }[] | undefined) ?? [];
      cache = lista
        .filter((t) => (FERRAMENTAS_NEXUS_PERMITIDAS as readonly string[]).includes(t.name))
        .map((t) => ({ name: t.name, description: (t.description ?? '').slice(0, 900), input_schema: t.inputSchema ?? { type: 'object', properties: {} } }));
      return cache;
    },
    async chamar(nome, args, timeoutMs = 10_000) {
      if (!(FERRAMENTAS_NEXUS_PERMITIDAS as readonly string[]).includes(nome)) return `Ferramenta "${nome}" não é permitida na conversa.`;
      try {
        const r = await rpc('tools/call', { name: nome, arguments: args }, timeoutMs);
        const partes = (r.content as { type: string; text?: string }[] | undefined) ?? [];
        const txt = partes.filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n') || JSON.stringify(r);
        return redator.redigir(txt).slice(0, LIMITE_RESPOSTA);
      } catch (e) {
        return `Erro ao usar ${nome}: ${(e as Error).message}`;
      }
    },
  };
}
