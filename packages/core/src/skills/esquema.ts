// Item 793 (skills): formato agentskills.io (https://agentskills.io/specification).
// Uma skill é uma pasta `skills/<nome>/` com `SKILL.md` = frontmatter YAML + corpo em Markdown.
// Campos da especificação: name, description (obrigatórios), license, compatibility, metadata, allowed-tools.
// `allowed-tools` da especificação é só informativo aqui: NUNCA concede ferramenta. Quem manda é `ferramentas_permitidas`,
// que ainda passa pela interseção com a allowlist/semáforo (ver sessao.ts). Campos extras do Jarvis: ferramentas_permitidas,
// finalidade, risco, origem, fonte.
import { parse } from 'yaml';
import { z } from 'zod';
import { DEGRAUS } from '../maestro/escada.ts';

export const LIMITE_SKILL_MD = 100_000;
export const LIMITE_CORPO = 40_000;

/** Kebab-case da especificação: 1-64, minúsculas/números/hífen, sem hífen no começo/fim nem `--`. */
export const nomeSkill = z
  .string()
  .min(1, 'name vazio')
  .max(64, 'name passa de 64 caracteres')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'name: minúsculas, números e hífen simples (sem começar/terminar com hífen nem "--")');

const nomeFerramenta = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'ferramenta: letras, números, _ e - (até 64)');
const valorMetadata = z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v));

export const NIVEIS_RISCO = ['verde', 'amarelo', 'vermelho'] as const;
export type NivelRiscoSkill = (typeof NIVEIS_RISCO)[number];
export const ORIGENS_SKILL = ['interna', 'externa'] as const;

export const esquemaFrontmatter = z.object({
  name: nomeSkill,
  description: z.string().trim().min(1, 'description vazia').max(1024, 'description passa de 1024 caracteres'),
  license: z.string().trim().min(1).max(200).optional(),
  compatibility: z.string().trim().min(1).max(500).optional(),
  metadata: z.record(z.string(), valorMetadata).optional(),
  /** Da especificação. Só informativo: não dá permissão nenhuma. */
  'allowed-tools': z.string().max(1000).optional(),
  /** Tools (nomes da API: `pedidos_listar`, `mcp__servidor__tool`) que a skill pode usar. Só reduz; nunca amplia. */
  ferramentas_permitidas: z.array(nomeFerramenta).max(40).default([]),
  /** Degrau mínimo da escada de modelos para a skill (a escada ainda barra Opus sem `permitir_opus`). */
  finalidade: z.enum(DEGRAUS).optional(),
  /** Teto de risco (semáforo) das tools da skill. Padrão verde = só leitura/rascunho. */
  risco: z.enum(NIVEIS_RISCO).default('verde'),
  origem: z.enum(ORIGENS_SKILL).default('interna'),
  /** De onde veio (skill importada). */
  fonte: z.string().max(500).optional(),
});

export type FrontmatterSkill = z.infer<typeof esquemaFrontmatter>;

export class ErroSkill extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ErroSkill';
  }
}

export const textoDoZod = (e: z.ZodError): string => e.issues.map((i) => `${i.path.join('.') || 'frontmatter'}: ${i.message}`).join('; ');

/** Separa frontmatter e corpo de um SKILL.md. Lança ErroSkill se o formato não bate. */
export function separarSkillMd(texto: string): { bruto: Record<string, unknown>; corpo: string } {
  if (texto.length > LIMITE_SKILL_MD) throw new ErroSkill(`SKILL.md grande demais (${texto.length} caracteres; limite ${LIMITE_SKILL_MD})`);
  const t = texto.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(t);
  if (!m) throw new ErroSkill('SKILL.md precisa começar com frontmatter YAML entre linhas "---"');
  let bruto: unknown;
  try {
    // schema core: sem tags customizadas nem datas implícitas; poucos aliases (contra bomba de YAML)
    bruto = parse(m[1] ?? '', { schema: 'core', maxAliasCount: 10 });
  } catch (e) {
    throw new ErroSkill(`frontmatter YAML inválido: ${String((e as Error)?.message ?? e).split('\n')[0]}`);
  }
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) throw new ErroSkill('frontmatter precisa ser um mapa YAML (name, description...)');
  const corpo = (m[2] ?? '').trim();
  if (corpo.length > LIMITE_CORPO) throw new ErroSkill(`corpo grande demais (${corpo.length} caracteres; limite ${LIMITE_CORPO}): mova detalhes para references/`);
  return { bruto: bruto as Record<string, unknown>, corpo };
}

/** Valida o frontmatter com o zod. `pasta` (se vier) precisa ser igual a `name` (regra da especificação). */
export function validarFrontmatter(bruto: unknown, pasta?: string): FrontmatterSkill {
  const r = esquemaFrontmatter.safeParse(bruto);
  if (!r.success) throw new ErroSkill(textoDoZod(r.error));
  if (pasta !== undefined && r.data.name !== pasta) throw new ErroSkill(`name "${r.data.name}" precisa ser igual ao nome da pasta "${pasta}"`);
  return r.data;
}
