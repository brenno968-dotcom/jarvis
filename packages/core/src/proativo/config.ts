// Item 829: configuração do agente proativo (`proativo` em config/regras.yaml). Desligado por padrão.
import { z } from 'zod';

const hora = z.number().int().min(0).max(23);

export const esquemaProativo = z.object({
  ligado: z.boolean().default(false),
  /** Intervalo entre rodadas, em horas. */
  intervalo_h: z.number().positive().default(5),
  /** Janela de silêncio: não roda e não avisa. `inicio_h` > `fim_h` atravessa a meia-noite; iguais = sem silêncio. */
  silencio: z
    .object({
      ativo: z.boolean().default(true),
      inicio_h: hora.default(22),
      fim_h: hora.default(7),
      fuso: z.string().min(1).default('America/Sao_Paulo'),
    })
    .default({}),
  /** Máximo de propostas criadas por rodada (soma de todas as empresas). */
  max_propostas: z.number().int().min(0).default(3),
  /** Não repropõe o mesmo (título + ação) se já houve um nos últimos N dias (qualquer desfecho) ou se ainda está ativo. */
  dias_dedup: z.number().int().min(1).default(7),
  /** Validade do pedido de aprovação de cada proposta. */
  expira_em_horas: z.number().positive().default(24),
  /** Teto do gasto do próprio agente no mês (llm_chamadas, finalidade `proativo`). Acima disso não roda. */
  teto_custo_mensal_brl: z.number().nonnegative().default(50),
  /** Limites do contexto enviado ao cérebro. */
  contexto: z
    .object({
      max_chars: z.number().int().positive().default(12_000),
      itens_por_secao: z.number().int().positive().default(8),
      chars_por_item: z.number().int().positive().default(300),
    })
    .default({}),
});
export type ConfigProativo = z.infer<typeof esquemaProativo>;

export const FINALIDADE_PROATIVO = 'proativo';

/** Hora cheia (0-23) no fuso dado. */
export function horaNoFuso(agora: Date, fuso: string): number {
  const p = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: fuso }).formatToParts(agora);
  return Number(p.find((x) => x.type === 'hour')?.value ?? 0);
}

/** A hora está na janela de silêncio? */
export function emSilencio(cfg: ConfigProativo, agora: Date = new Date()): boolean {
  const s = cfg.silencio;
  if (!s.ativo || s.inicio_h === s.fim_h) return false;
  const h = horaNoFuso(agora, s.fuso);
  return s.inicio_h > s.fim_h ? h >= s.inicio_h || h < s.fim_h : h >= s.inicio_h && h < s.fim_h;
}
