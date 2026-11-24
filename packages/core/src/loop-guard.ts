// Item 792: LoopGuard. Complementa o bloqueio de "mesma tool com os mesmos argumentos" (ponte MCP) com três padrões:
//   (a) ciclo A→B→A→B (mesmas chamadas se alternando);
//   (b) a mesma tool mais de N vezes na mesma tarefa/conversa;
//   (c) N rodadas seguidas sem progresso (nenhuma tool nova e nenhum resultado novo).
// Inspirado no loop_guard do OpenJarvis (hash de chamada + janela), reescrito para o Jarvis. Puro e testável.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const esquemaLoopGuard = z.object({
  ativo: z.boolean().default(true),
  /** (b) Máximo de chamadas da mesma tool por tarefa/conversa. A chamada N+1 dispara. */
  max_chamadas_mesma_tool: z.number().int().positive().default(8),
  /** (a) Quantas vezes o par A,B precisa se repetir (2 = A,B,A,B). */
  repeticoes_ciclo: z.number().int().min(2).default(2),
  /** (c) Rodadas seguidas sem tool nova nem resultado novo. */
  rodadas_sem_progresso: z.number().int().positive().default(3),
  /** Executor do worker: tempo parado (minutos) até o escopo (plano/negócio) começar a contar do zero. */
  executor_janela_minutos: z.number().positive().default(30),
  /** Executor: limite da mesma ação por escopo (planos legítimos repetem ações; por isso é maior que o da conversa). */
  executor_max_mesma_acao: z.number().int().positive().default(20),
});
export type ConfigLoopGuard = z.infer<typeof esquemaLoopGuard>;
export const loopGuardPadrao = (): ConfigLoopGuard => esquemaLoopGuard.parse({});

export type PadraoLoop = 'ciclo' | 'mesma_tool' | 'sem_progresso';

export interface VeredictoLoop {
  padrao: PadraoLoop;
  /** Texto claro para o usuário/auditoria (sem argumentos nem resultados). */
  motivo: string;
  tool?: string;
}

function canonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonico).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonico(x)}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

export class LoopGuard {
  private readonly historico: string[] = [];
  private readonly porTool = new Map<string, number>();
  private readonly toolsVistas = new Set<string>();
  private readonly resultadosVistos = new Set<string>();
  private rodadaTemNovidade = false;
  private semProgresso = 0;
  private disparado: VeredictoLoop | null = null;

  constructor(private readonly cfg: ConfigLoopGuard = loopGuardPadrao()) {}

  /** Primeiro veredito emitido (o guard fica "travado": quem usa deve parar). */
  get veredito(): VeredictoLoop | null {
    return this.disparado;
  }

  private disparar(v: VeredictoLoop): VeredictoLoop {
    this.disparado ??= v;
    return this.disparado;
  }

  /** Chame ANTES de executar a tool. Devolve o veredito se a chamada deve ser negada (e o laço interrompido). */
  antes(tool: string, args: Record<string, unknown> = {}): VeredictoLoop | null {
    if (!this.cfg.ativo) return null;
    if (this.disparado) return this.disparado;
    const n = (this.porTool.get(tool) ?? 0) + 1;
    if (n > this.cfg.max_chamadas_mesma_tool) {
      return this.disparar({
        padrao: 'mesma_tool',
        tool,
        motivo: `a ferramenta ${tool} já foi chamada ${this.cfg.max_chamadas_mesma_tool} vezes nesta tarefa (limite)`,
      });
    }
    const assinatura = `${tool}:${hash(canonico(args))}`;
    const janela = [...this.historico, assinatura];
    const tam = this.cfg.repeticoes_ciclo * 2;
    if (janela.length >= tam) {
      const fim = janela.slice(-tam);
      const a = fim[0]!;
      const b = fim[1]!;
      if (a !== b && fim.every((s, i) => s === (i % 2 === 0 ? a : b))) {
        return this.disparar({
          padrao: 'ciclo',
          tool,
          motivo: `ciclo detectado: ${a.split(':')[0]} e ${b.split(':')[0]} se alternando ${this.cfg.repeticoes_ciclo} vezes com os mesmos argumentos`,
        });
      }
    }
    this.historico.push(assinatura);
    this.porTool.set(tool, n);
    if (!this.toolsVistas.has(tool)) {
      this.toolsVistas.add(tool);
      this.rodadaTemNovidade = true;
    }
    return null;
  }

  /** Chame DEPOIS da tool, com o resultado (ou a saída do adaptador): resultado nunca visto conta como progresso. */
  depois(tool: string, resultado: string): void {
    const h = hash(`${tool}|${resultado}`);
    if (!this.resultadosVistos.has(h)) {
      this.resultadosVistos.add(h);
      this.rodadaTemNovidade = true;
    }
  }

  /** Chame ao fim de cada rodada (um turno do modelo com suas tools). Devolve o veredito de "sem progresso". */
  fecharRodada(): VeredictoLoop | null {
    if (!this.cfg.ativo) return null;
    if (this.disparado) return this.disparado;
    this.semProgresso = this.rodadaTemNovidade ? 0 : this.semProgresso + 1;
    this.rodadaTemNovidade = false;
    if (this.semProgresso >= this.cfg.rodadas_sem_progresso) {
      return this.disparar({
        padrao: 'sem_progresso',
        motivo: `${this.semProgresso} rodadas seguidas sem progresso (nenhuma ferramenta nova nem resultado novo)`,
      });
    }
    return null;
  }
}

/**
 * LoopGuard do executor do worker: um guard por escopo (plano, senão negócio, senão a própria tarefa), na memória do
 * processo. Escopo parado por `executor_janela_minutos` recomeça do zero. Cada execução é uma "rodada".
 */
export class GuardasPorEscopo {
  private readonly mapa = new Map<string, { guard: LoopGuard; ultimo: number }>();

  constructor(
    private readonly cfg: ConfigLoopGuard = loopGuardPadrao(),
    private readonly agora: () => number = Date.now,
  ) {}

  obter(escopo: string): LoopGuard {
    const t = this.agora();
    const janelaMs = this.cfg.executor_janela_minutos * 60_000;
    for (const [k, v] of this.mapa) if (t - v.ultimo > janelaMs) this.mapa.delete(k);
    let e = this.mapa.get(escopo);
    if (!e) {
      e = { guard: new LoopGuard({ ...this.cfg, max_chamadas_mesma_tool: this.cfg.executor_max_mesma_acao }), ultimo: t };
      this.mapa.set(escopo, e);
    }
    // escopo já travado não renova a janela: tentar de novo não o mantém preso para sempre
    if (!e.guard.veredito) e.ultimo = t;
    return e.guard;
  }
}
