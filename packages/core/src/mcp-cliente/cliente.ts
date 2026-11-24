// Item 793: cliente MCP por Streamable HTTP (JSON-RPC 2.0), implementado com fetch (sem o SDK oficial,
// que traz express/hono e outras dependências de servidor que o core não usa).
// Sequência: initialize -> notifications/initialized -> tools/list | tools/call. O header Mcp-Session-Id
// devolvido no initialize é repetido nos pedidos seguintes. A resposta pode vir como JSON ou como SSE.
import { redator } from '../redacao.ts';

export const VERSAO_PROTOCOLO_MCP = '2025-03-26';

export class ErroMcp extends Error {
  constructor(
    mensagem: string,
    /** temporario: vale tentar de novo (rede, 5xx, 429, timeout); definitivo: não adianta. */
    public readonly tipo: 'temporario' | 'definitivo',
    public readonly status?: number,
  ) {
    super(mensagem);
    this.name = 'ErroMcp';
  }
}

export interface ToolMcp {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ResultadoToolMcp {
  /** Texto das partes `text` do resultado (outras partes viram um marcador). */
  texto: string;
  /** O servidor marcou o resultado como erro de ferramenta (isError). */
  erro: boolean;
}

export interface OpcoesClienteMcp {
  url: string;
  /** Token Bearer opcional (o valor vem do ambiente; nunca do repositório). */
  token?: string;
  /** Timeout padrão de cada pedido, em ms (padrão 15 s). */
  timeoutMs?: number;
  /** Tentativas extras (rede/5xx/429) para initialize e tools/list (padrão 2). tools/call nunca repete: pode ter efeito. */
  novasTentativas?: number;
  /** Espera base entre tentativas, em ms (padrão 200, dobra a cada vez). */
  esperaMs?: number;
  fetchImpl?: typeof fetch;
  nomeCliente?: string;
  versaoCliente?: string;
}

export interface ClienteMcp {
  iniciar(): Promise<void>;
  listarTools(): Promise<ToolMcp[]>;
  chamarTool(nome: string, args: Record<string, unknown>, timeoutMs?: number): Promise<ResultadoToolMcp>;
  encerrar(): Promise<void>;
}

type Mensagem = { jsonrpc?: string; id?: number | string | null; result?: Record<string, unknown>; error?: { code?: number; message?: string } };

/** Extrai as mensagens JSON-RPC de um texto SSE (eventos separados por linha em branco; linhas `data:`). */
export function lerEventosSse(texto: string): Mensagem[] {
  const saida: Mensagem[] = [];
  for (const bloco of texto.split(/\r?\n\r?\n/)) {
    const dados = bloco
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!dados.trim()) continue;
    try {
      saida.push(JSON.parse(dados) as Mensagem);
    } catch {
      /* evento que não é JSON (ex.: ping): ignora */
    }
  }
  return saida;
}

const dormir = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function criarClienteMcp(o: OpcoesClienteMcp): ClienteMcp {
  const f = o.fetchImpl ?? fetch;
  const timeoutPadrao = o.timeoutMs ?? 15_000;
  const novasTentativas = o.novasTentativas ?? 2;
  const esperaBase = o.esperaMs ?? 200;
  let id = 0;
  let sessao: string | null = null;
  let iniciado = false;

  function cabecalhos(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(sessao ? { 'mcp-session-id': sessao } : {}),
      ...(iniciado ? { 'mcp-protocol-version': VERSAO_PROTOCOLO_MCP } : {}),
    };
  }

  /** Lê o corpo (JSON ou SSE) e devolve a mensagem que responde ao `idEsperado`. */
  async function lerResposta(resp: Response, idEsperado: number): Promise<Mensagem> {
    const tipo = (resp.headers.get('content-type') ?? '').toLowerCase();
    const texto = await resp.text();
    let mensagens: Mensagem[];
    if (tipo.includes('text/event-stream')) {
      mensagens = lerEventosSse(texto);
    } else {
      try {
        const j = JSON.parse(texto) as Mensagem | Mensagem[];
        mensagens = Array.isArray(j) ? j : [j];
      } catch {
        throw new ErroMcp(redator.redigir(`resposta MCP ilegível: ${texto.slice(0, 200)}`), 'definitivo', resp.status);
      }
    }
    const m = mensagens.find((x) => x.id === idEsperado);
    if (!m) throw new ErroMcp('o servidor MCP não respondeu a esse pedido', 'definitivo', resp.status);
    return m;
  }

  async function enviar(corpo: Record<string, unknown>, timeoutMs: number): Promise<Response> {
    let resp: Response;
    try {
      resp = await f(o.url, { method: 'POST', headers: cabecalhos(), body: JSON.stringify(corpo), signal: AbortSignal.timeout(Math.max(100, timeoutMs)) });
    } catch (e) {
      const nome = (e as Error)?.name;
      const msg = nome === 'TimeoutError' || nome === 'AbortError' ? `tempo esgotado (${timeoutMs} ms)` : `falha de rede: ${(e as Error)?.message ?? e}`;
      throw new ErroMcp(redator.redigir(msg), 'temporario');
    }
    if (!resp.ok) {
      const detalhe = (await resp.text().catch(() => '')).slice(0, 200);
      const temporario = resp.status >= 500 || resp.status === 429 || resp.status === 408;
      throw new ErroMcp(redator.redigir(`HTTP ${resp.status}${detalhe ? `: ${detalhe}` : ''}`), temporario ? 'temporario' : 'definitivo', resp.status);
    }
    return resp;
  }

  async function rpcUnico(metodo: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const meuId = ++id;
    const resp = await enviar({ jsonrpc: '2.0', id: meuId, method: metodo, params }, timeoutMs);
    if (metodo === 'initialize') sessao = resp.headers.get('mcp-session-id') ?? sessao;
    const m = await lerResposta(resp, meuId);
    if (m.error) throw new ErroMcp(redator.redigir(`o servidor MCP devolveu erro: ${m.error.message ?? 'sem detalhe'}`), 'definitivo');
    return m.result ?? {};
  }

  async function comTentativas<T>(fn: () => Promise<T>, tentativas: number): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i >= tentativas || !(e instanceof ErroMcp) || e.tipo !== 'temporario') throw e;
        await dormir(esperaBase * 2 ** i);
      }
    }
  }

  async function iniciar(): Promise<void> {
    if (iniciado) return;
    sessao = null;
    await comTentativas(
      () =>
        rpcUnico(
          'initialize',
          { protocolVersion: VERSAO_PROTOCOLO_MCP, capabilities: {}, clientInfo: { name: o.nomeCliente ?? 'jarvis', version: o.versaoCliente ?? '0.1.0' } },
          timeoutPadrao,
        ),
      novasTentativas,
    );
    iniciado = true;
    // notificação: sem id, o servidor responde 202 sem corpo
    await comTentativas(async () => {
      const resp = await enviar({ jsonrpc: '2.0', method: 'notifications/initialized' }, timeoutPadrao);
      await resp.text().catch(() => '');
    }, novasTentativas);
  }

  /** Sessão expirada (404 com sessão aberta): reinicia uma vez e repete. */
  async function comSessao<T>(fn: () => Promise<T>, tentativas: number): Promise<T> {
    await iniciar();
    try {
      return await comTentativas(fn, tentativas);
    } catch (e) {
      if (e instanceof ErroMcp && e.status === 404 && sessao) {
        iniciado = false;
        await iniciar();
        return comTentativas(fn, tentativas);
      }
      throw e;
    }
  }

  return {
    iniciar,
    async listarTools() {
      const todas: ToolMcp[] = [];
      let cursor: string | undefined;
      for (let pagina = 0; pagina < 10; pagina++) {
        const r = await comSessao(() => rpcUnico('tools/list', cursor ? { cursor } : {}, timeoutPadrao), novasTentativas);
        todas.push(...((r.tools as ToolMcp[] | undefined) ?? []));
        cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
        if (!cursor) break;
      }
      return todas;
    },
    async chamarTool(nome, args, timeoutMs) {
      const r = await comSessao(() => rpcUnico('tools/call', { name: nome, arguments: args }, timeoutMs ?? timeoutPadrao), 0);
      const partes = (r.content as { type?: string; text?: string }[] | undefined) ?? [];
      const texto = partes.map((p) => (p.type === 'text' ? (p.text ?? '') : `[conteúdo ${p.type ?? 'desconhecido'} omitido]`)).join('\n');
      return { texto: texto || (r.structuredContent !== undefined ? JSON.stringify(r.structuredContent) : ''), erro: r.isError === true };
    },
    async encerrar() {
      if (!iniciado || !sessao) {
        iniciado = false;
        return;
      }
      try {
        await f(o.url, { method: 'DELETE', headers: cabecalhos(), signal: AbortSignal.timeout(2000) });
      } catch {
        /* melhor esforço */
      }
      iniciado = false;
      sessao = null;
    },
  };
}
