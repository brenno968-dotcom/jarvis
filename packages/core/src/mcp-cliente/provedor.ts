// Item 793 (parte 2): liga a ponte MCP na conversa do painel com cache curto por processo.
// Nunca derruba a conversa: config ilegível, URL/token ausente, servidor fora do ar ou lento = segue sem MCP (só log).
import type { Consultavel } from '../banco.ts';
import { registrarAuditoria } from '../auditoria.ts';
import { log } from '../log.ts';
import { redator } from '../redacao.ts';
import type { Regras } from '../regras.ts';
import { carregarConfigMcp, resolverServidoresMcp, type ConfigServidoresMcp, type ServidorMcpResolvido } from './config.ts';
import { prepararFerramentasMcp, solicitadorDeAprovacao, type FerramentasMcp } from './ponte.ts';
import type { ClienteMcp } from './cliente.ts';

export type FerramentasDaConversa = Pick<FerramentasMcp, 'ferramentas' | 'executar'>;

export interface ProvedorMcp {
  /** Ferramentas MCP para UMA conversa, ou null (sem MCP). Nunca lança. */
  obter(): Promise<FerramentasDaConversa | null>;
  encerrar(): Promise<void>;
}

export interface OpcoesProvedorMcp {
  db: Consultavel;
  regras: Regras;
  env?: Record<string, string | undefined>;
  /** Padrão: config/mcp-servidores.yaml (ou JARVIS_MCP_SERVIDORES). */
  carregarConfig?: () => ConfigServidoresMcp;
  criarCliente?: (s: ServidorMcpResolvido) => ClienteMcp;
  /** Validade do cache quando deu certo (padrão 60 s). */
  ttlMs?: number;
  /** Validade quando falhou (padrão 15 s): evita pagar o timeout a cada mensagem. */
  ttlFalhaMs?: number;
  /** Quanto a conversa espera pela lista de tools antes de seguir sem MCP (padrão 4 s; o Nexus espera 25 s). */
  esperaMaxMs?: number;
  agora?: () => number;
}

interface Entrada {
  ate: number;
  mcp: FerramentasMcp | null;
}

export function criarProvedorMcp(o: OpcoesProvedorMcp): ProvedorMcp {
  const agora = o.agora ?? Date.now;
  const ttl = o.ttlMs ?? 60_000;
  const ttlFalha = o.ttlFalhaMs ?? 15_000;
  const espera = o.esperaMaxMs ?? 4_000;
  let entrada: Entrada | null = null;
  let emAndamento: Promise<Entrada> | null = null;

  async function montar(): Promise<Entrada> {
    let servidores: ServidorMcpResolvido[];
    try {
      servidores = resolverServidoresMcp((o.carregarConfig ?? (() => carregarConfigMcp()))(), o.env ?? process.env);
    } catch (e) {
      log('aviso', 'MCP externo desligado: config ilegível', { erro: redator.redigir(String((e as Error)?.message ?? e)).slice(0, 300) });
      return { ate: agora() + ttlFalha, mcp: null };
    }
    if (!servidores.length) return { ate: agora() + ttl, mcp: null };
    try {
      const mcp = await prepararFerramentasMcp(servidores, {
        regras: o.regras,
        criarCliente: o.criarCliente,
        solicitarAprovacao: solicitadorDeAprovacao(o.db, o.regras),
        aoUsar: (e) => registrarAuditoria(o.db, { quem: 'mcp-cliente', acao: 'mcp_tool_usada', detalhes: { ...e } }),
      });
      if (mcp.falhas.length) log('aviso', 'servidor MCP indisponível', { falhas: mcp.falhas });
      if (!mcp.ferramentas.length) {
        await mcp.encerrar();
        return { ate: agora() + ttlFalha, mcp: null };
      }
      return { ate: agora() + ttl, mcp };
    } catch (e) {
      log('aviso', 'MCP externo indisponível', { erro: redator.redigir(String((e as Error)?.message ?? e)).slice(0, 300) });
      return { ate: agora() + ttlFalha, mcp: null };
    }
  }

  function atualizar(): Promise<Entrada> {
    if (!emAndamento) {
      emAndamento = montar()
        .then((nova) => {
          const velha = entrada;
          entrada = nova;
          if (velha?.mcp) void velha.mcp.encerrar().catch(() => undefined);
          return nova;
        })
        .finally(() => {
          emAndamento = null;
        });
    }
    return emAndamento;
  }

  return {
    async obter() {
      try {
        if (!entrada || entrada.ate <= agora()) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const limite = new Promise<null>((r) => {
            timer = setTimeout(() => r(null), espera);
          });
          const nova = await Promise.race([atualizar(), limite]).finally(() => clearTimeout(timer));
          if (!nova) {
            log('aviso', 'MCP externo lento: conversa segue sem ele');
            return null;
          }
        }
        return entrada?.mcp?.paraConversa() ?? null;
      } catch (e) {
        log('aviso', 'MCP externo falhou: conversa segue sem ele', { erro: String((e as Error)?.message ?? e).slice(0, 200) });
        return null;
      }
    },
    async encerrar() {
      await entrada?.mcp?.encerrar().catch(() => undefined);
      entrada = null;
    },
  };
}
