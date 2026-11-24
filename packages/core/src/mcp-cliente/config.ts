// Item 793: servidores MCP externos que o Jarvis consome (config/mcp-servidores.yaml).
// A allowlist de tools é obrigatória: tool que não está na lista nunca é exposta nem chamada.
// O nível de risco de cada tool NÃO fica neste arquivo: vem do semáforo do regras.yaml, pela ação
// `mcp_<servidor>_<tool>` (ver `acaoDaTool`). Tool sem entrada no semáforo é vermelha (seção 6).
// URL e token vêm do ambiente (url_env / token_env); nada de segredo no arquivo.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { classificarAcao, type Regras } from '../regras.ts';
import type { NivelSemaforo } from '../tipos.ts';

const nomeServidor = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'servidor: minúsculas, números e hífen (sem "_")');
const nomeTool = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'tool: letras, números, _ e - (até 40)');
const nomeEnv = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'nome de variável de ambiente em MAIÚSCULAS');

export const esquemaServidoresMcp = z.object({
  versao: z.literal(1),
  servidores: z.record(
    nomeServidor,
    z.object({
      ativo: z.boolean().default(false),
      descricao: z.string().default(''),
      url_env: nomeEnv,
      token_env: nomeEnv.optional(),
      timeout_ms: z.number().int().min(1000).max(300_000).default(30_000),
      /** Allowlist obrigatória e não vazia. */
      tools: z.array(nomeTool).min(1, 'a allowlist de tools é obrigatória'),
      /** Timeout por tool (ms), para as lentas (ex.: deep_research 600000). Sem entrada, vale `timeout_ms`. */
      timeouts_ms: z.record(nomeTool, z.number().int().min(1000).max(900_000)).default({}),
    }).superRefine((s, ctx) => {
      for (const t of Object.keys(s.timeouts_ms)) {
        if (!s.tools.includes(t)) ctx.addIssue({ code: 'custom', path: ['timeouts_ms', t], message: 'timeout para tool que não está na allowlist' });
      }
    }),
  ),
});

export type ConfigServidoresMcp = z.infer<typeof esquemaServidoresMcp>;

export interface ServidorMcpResolvido {
  nome: string;
  descricao: string;
  url: string;
  token?: string;
  timeoutMs: number;
  tools: string[];
  /** Timeout específico por tool (ms). */
  timeoutsPorTool?: Record<string, number>;
}

export class ConfigMcpInvalida extends Error {
  constructor(public readonly problemas: string[]) {
    super(`Config de servidores MCP inválida:\n- ${problemas.join('\n- ')}`);
    this.name = 'ConfigMcpInvalida';
  }
}

export function lerConfigMcpDeTexto(texto: string): ConfigServidoresMcp {
  let bruto: unknown;
  try {
    bruto = parse(texto);
  } catch (e) {
    throw new ConfigMcpInvalida([`YAML ilegível: ${(e as Error).message}`]);
  }
  const r = esquemaServidoresMcp.safeParse(bruto);
  if (!r.success) throw new ConfigMcpInvalida(r.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`));
  return r.data;
}

export function carregarConfigMcp(caminho = process.env.JARVIS_MCP_SERVIDORES ?? 'config/mcp-servidores.yaml'): ConfigServidoresMcp {
  return lerConfigMcpDeTexto(readFileSync(caminho, 'utf8'));
}

/** Só os servidores ativos e com URL no ambiente; sem URL, o servidor fica de fora (não é erro). */
export function resolverServidoresMcp(config: ConfigServidoresMcp, env: Record<string, string | undefined> = process.env): ServidorMcpResolvido[] {
  const saida: ServidorMcpResolvido[] = [];
  for (const [nome, s] of Object.entries(config.servidores)) {
    if (!s.ativo) continue;
    const url = env[s.url_env]?.trim();
    if (!url) continue;
    const token = s.token_env ? env[s.token_env]?.trim() || undefined : undefined;
    saida.push({ nome, descricao: s.descricao, url, ...(token ? { token } : {}), timeoutMs: s.timeout_ms, tools: [...new Set(s.tools)], timeoutsPorTool: { ...s.timeouts_ms } });
  }
  return saida;
}

/** Timeout da tool: o específico (`timeouts_ms`) ou o do servidor. */
export function timeoutDaTool(s: Pick<ServidorMcpResolvido, 'timeoutMs' | 'timeoutsPorTool'>, tool: string): number {
  return s.timeoutsPorTool?.[tool] ?? s.timeoutMs;
}

/** Nome da ação no semáforo do regras.yaml: mcp_<servidor>_<tool>, minúscula com "_". */
export function acaoDaTool(servidor: string, tool: string): string {
  return `mcp_${servidor}_${tool}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
}

export function nivelDaTool(regras: Regras, servidor: string, tool: string): NivelSemaforo {
  return classificarAcao(regras, acaoDaTool(servidor, tool));
}

/** Nome da tool na API da Anthropic: mcp__<servidor>__<tool> (máx. 64, [a-zA-Z0-9_-]). */
export function nomeNaApi(servidor: string, tool: string): string {
  return `mcp__${servidor}__${tool}`;
}

export function separarNomeNaApi(nome: string): { servidor: string; tool: string } | null {
  const m = /^mcp__([a-z0-9]+(?:-[a-z0-9]+)*)__(.+)$/.exec(nome);
  return m ? { servidor: m[1]!, tool: m[2]! } : null;
}
