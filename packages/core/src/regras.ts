import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { NivelSemaforo } from './tipos.ts';

const nomeAcao = z.string().regex(/^[a-z0-9_]+$/, 'ação deve ser minúscula com _');

export const esquemaRegras = z
  .object({
    versao: z.literal(1),
    semaforo: z.object({
      verde: z.array(nomeAcao).default([]),
      amarelo: z.array(nomeAcao).default([]),
      vermelho: z.array(nomeAcao).min(1),
    }),
    orcamento_padrao: z.object({
      teto_por_compra_brl: z.number().nonnegative(),
      teto_mensal_por_negocio_brl: z.number().nonnegative(),
      compra_estoque_sempre_pede_ok: z.boolean(),
    }),
    aprovacao: z.object({
      canal: z.literal('whatsapp'),
      confirmacao_dupla: z.array(nomeAcao).default([]),
      numeros_autorizados: z.array(z.string().min(1)).min(1),
      expira_em_minutos: z.number().int().positive(),
      lembrete_apos_minutos: z.number().int().positive(),
    }),
    gmail: z.object({
      intervalo_verificacao_segundos: z.number().int().positive(),
      tempo_maximo_espera_minutos: z.number().int().positive(),
      alias_cadastros: z.string().email(),
    }),
    navegador: z.object({
      provedor: z.enum(['browserbase', 'steel']),
      resolver_captcha_automatico: z.boolean(),
      tempo_maximo_espera_humano_minutos: z.number().int().positive(),
    }),
    tentativas: z.object({
      max_padrao: z.number().int().positive(),
      espera_inicial_segundos: z.number().positive(),
      multiplicador: z.number().min(1),
      espera_maxima_segundos: z.number().positive(),
    }),
    emergencia: z.object({
      comando_whatsapp: z.string().min(1),
      revogar_tokens: z.array(z.string()),
    }),
  })
  .superRefine((r, ctx) => {
    // Regra da seção 2: CAPTCHA é sempre humano. Não existe exceção.
    if (r.navegador.resolver_captcha_automatico !== false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['navegador', 'resolver_captcha_automatico'],
        message: 'resolver_captcha_automatico precisa ser false (CAPTCHA é sempre humano)',
      });
    }
    // Uma ação não pode estar em duas cores.
    const vistas = new Map<string, string>();
    for (const cor of ['verde', 'amarelo', 'vermelho'] as const) {
      for (const acao of r.semaforo[cor]) {
        const anterior = vistas.get(acao);
        if (anterior && anterior !== cor) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['semaforo', cor],
            message: `ação "${acao}" aparece em ${anterior} e ${cor}`,
          });
        }
        vistas.set(acao, cor);
      }
    }
    if (r.tentativas.espera_maxima_segundos < r.tentativas.espera_inicial_segundos) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tentativas'],
        message: 'espera_maxima_segundos menor que espera_inicial_segundos',
      });
    }
  });

export type Regras = z.infer<typeof esquemaRegras>;

export class RegrasInvalidas extends Error {
  constructor(public readonly problemas: string[]) {
    super(`Arquivo de regras inválido:\n- ${problemas.join('\n- ')}`);
    this.name = 'RegrasInvalidas';
  }
}

/** Valida um objeto de regras. Lança RegrasInvalidas se houver qualquer problema. */
export function validarRegras(bruto: unknown): Regras {
  const r = esquemaRegras.safeParse(bruto);
  if (!r.success) {
    throw new RegrasInvalidas(r.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`));
  }
  return r.data;
}

export function lerRegrasDeTexto(texto: string): Regras {
  let bruto: unknown;
  try {
    bruto = parse(texto);
  } catch (e) {
    throw new RegrasInvalidas([`YAML ilegível: ${(e as Error).message}`]);
  }
  return validarRegras(bruto);
}

export function carregarRegras(caminho = process.env.JARVIS_REGRAS ?? 'config/regras.yaml'): Regras {
  return lerRegrasDeTexto(readFileSync(caminho, 'utf8'));
}

/** Seção 6: ação que não aparece em nenhuma cor é vermelha. */
export function classificarAcao(regras: Regras, acao: string): NivelSemaforo {
  if (regras.semaforo.verde.includes(acao)) return 'verde';
  if (regras.semaforo.amarelo.includes(acao)) return 'amarelo';
  return 'vermelho';
}

/** Espera exponencial com variação aleatória (±20%), limitada ao máximo. */
export function esperaParaTentativa(regras: Regras, tentativa: number, aleatorio = Math.random): number {
  const { espera_inicial_segundos: ini, multiplicador: mult, espera_maxima_segundos: max } = regras.tentativas;
  const base = Math.min(max, ini * Math.pow(mult, Math.max(0, tentativa - 1)));
  const variacao = base * 0.2 * (aleatorio() * 2 - 1);
  return Math.max(1, Math.min(max, Math.round(base + variacao)));
}

/** Seção 22: ação irreversível/de valor alto, ou com valor acima do teto por compra, pede também o painel. */
export function exigeConfirmacaoNoPainel(regras: Regras, acao: string, parametros: Record<string, unknown> = {}): boolean {
  if (regras.aprovacao.confirmacao_dupla.includes(acao)) return true;
  const valor = Number(parametros.valor_brl ?? parametros.custo_brl ?? NaN);
  return Number.isFinite(valor) && valor > regras.orcamento_padrao.teto_por_compra_brl;
}
