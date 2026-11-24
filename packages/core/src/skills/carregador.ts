// Item 793 (skills): carregador de `skills/<nome>/SKILL.md`.
// - Catálogo = só metadados (name, description e campos do Jarvis). O corpo só é lido em `carregarSkill`.
// - Texto suspeito no scanner de injeção (item 815) NÃO carrega: vale para o SKILL.md inteiro (inclusive a description,
//   que vai para o prompt) no catálogo e de novo na carga, e para cada recurso lido.
// - Recursos (references/, assets/, scripts/) só são lidos como TEXTO. Nada aqui executa nada: este módulo não importa
//   nenhum módulo de processos e um teste garante isso.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { escanearInjecao } from '../seguranca/injecao.ts';
import { ErroSkill, LIMITE_SKILL_MD, nomeSkill, separarSkillMd, validarFrontmatter, type FrontmatterSkill } from './esquema.ts';

export const PASTAS_RECURSO = ['references', 'assets', 'scripts'] as const;
export const LIMITE_RECURSO = 32_768;
const MAX_RECURSOS_LISTADOS = 50;
const PADRAO_RECURSO = /^(?:references|assets|scripts)\/[A-Za-z0-9][A-Za-z0-9._\-/]*$/;

export interface SkillMeta {
  nome: string;
  descricao: string;
  origem: FrontmatterSkill['origem'];
  risco: FrontmatterSkill['risco'];
  finalidade?: FrontmatterSkill['finalidade'];
  ferramentas: string[];
  licenca?: string;
  compatibilidade?: string;
  fonte?: string;
  metadata: Record<string, string>;
  diretorio: string;
  /** Arquivos auxiliares (caminhos relativos). Só leitura como texto. */
  recursos: string[];
}

export interface SkillCarregada extends SkillMeta {
  corpo: string;
}

export interface RejeicaoSkill {
  pasta: string;
  motivo: string;
}

export interface CatalogoSkills {
  diretorio: string;
  skills: SkillMeta[];
  rejeitadas: RejeicaoSkill[];
}

/** Pasta das skills: JARVIS_SKILLS, ou `skills/` a partir do diretório atual (raiz do repositório ou apps/*). */
export function resolverDiretorioSkills(env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): string {
  const candidatos = [env.JARVIS_SKILLS, join(cwd, 'skills'), join(cwd, '../../skills')].filter((c): c is string => Boolean(c));
  return resolve(candidatos.find((c) => existsSync(c)) ?? candidatos[0] ?? join(cwd, 'skills'));
}

function lerTextoRegular(caminho: string, limite: number): string {
  const st = lstatSync(caminho);
  if (st.isSymbolicLink() || !st.isFile()) throw new ErroSkill('não é um arquivo comum (link simbólico ou pasta)');
  if (st.size > limite) throw new ErroSkill(`arquivo grande demais (${st.size} bytes; limite ${limite})`);
  const buf = readFileSync(caminho);
  if (buf.includes(0)) throw new ErroSkill('arquivo binário (só texto é lido)');
  return buf.toString('utf8');
}

function listarRecursos(dir: string): string[] {
  const achados: string[] = [];
  for (const pasta of PASTAS_RECURSO) {
    const base = join(dir, pasta);
    let st;
    try {
      st = lstatSync(base);
    } catch {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const andar = (rel: string, nivel: number) => {
      for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (achados.length >= MAX_RECURSOS_LISTADOS) return;
        const r = `${rel}/${e.name}`;
        if (e.isSymbolicLink()) continue;
        if (e.isFile() && PADRAO_RECURSO.test(r)) achados.push(r);
        else if (e.isDirectory() && nivel < 2) andar(r, nivel + 1);
      }
    };
    andar(pasta, 0);
  }
  return achados;
}

export interface SkillValidada {
  meta: SkillMeta;
  corpo: string;
}

/** Valida o texto de um SKILL.md: formato, zod, nome = pasta e scanner de injeção no texto inteiro. */
export function validarTextoSkill(pasta: string, texto: string, diretorio: string, recursos: string[] = []): SkillValidada {
  const { bruto, corpo } = separarSkillMd(texto);
  const fm = validarFrontmatter(bruto, pasta);
  const scan = escanearInjecao(texto);
  if (scan.nivel !== 'limpo') throw new ErroSkill(`texto ${scan.nivel} no scanner de injeção (${scan.motivos.join('; ')})`);
  return {
    corpo,
    meta: {
      nome: fm.name,
      descricao: fm.description.replace(/\s+/g, ' ').trim(),
      origem: fm.origem,
      risco: fm.risco,
      finalidade: fm.finalidade,
      ferramentas: [...new Set(fm.ferramentas_permitidas)],
      licenca: fm.license,
      compatibilidade: fm.compatibility,
      fonte: fm.fonte,
      metadata: fm.metadata ?? {},
      diretorio,
      recursos,
    },
  };
}

function lerSkillDaPasta(base: string, pasta: string): SkillValidada {
  if (!nomeSkill.safeParse(pasta).success) throw new ErroSkill(`nome de pasta "${pasta}" não é kebab-case válido`);
  const diretorio = join(base, pasta);
  const st = lstatSync(diretorio);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ErroSkill('a skill precisa ser uma pasta comum (sem link simbólico)');
  const arquivo = join(diretorio, 'SKILL.md');
  if (!existsSync(arquivo)) throw new ErroSkill('falta o SKILL.md');
  return validarTextoSkill(pasta, lerTextoRegular(arquivo, LIMITE_SKILL_MD), diretorio, listarRecursos(diretorio));
}

/** Lê só os metadados de cada skill. Uma skill inválida/suspeita vai para `rejeitadas` e não derruba as outras. */
export function carregarCatalogo(diretorio: string): CatalogoSkills {
  const base = resolve(diretorio);
  const catalogo: CatalogoSkills = { diretorio: base, skills: [], rejeitadas: [] };
  if (!existsSync(base)) return catalogo;
  for (const e of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || (!e.isDirectory() && !e.isSymbolicLink())) continue;
    try {
      catalogo.skills.push(lerSkillDaPasta(base, e.name).meta);
    } catch (err) {
      catalogo.rejeitadas.push({ pasta: e.name, motivo: err instanceof ErroSkill ? err.message : `erro ao ler: ${String((err as Error)?.message ?? err).slice(0, 200)}` });
    }
  }
  return catalogo;
}

/** Carga completa (com o corpo). Relê e revalida do disco: o arquivo pode ter mudado desde o catálogo. */
export function carregarSkill(diretorio: string, nome: string): SkillCarregada {
  const v = lerSkillDaPasta(resolve(diretorio), nome);
  return { ...v.meta, corpo: v.corpo };
}

/** Lê um recurso da skill COMO TEXTO (nunca executa). Só references/, assets/ e scripts/, sem `..` nem link simbólico. */
export function lerRecurso(diretorio: string, nome: string, recurso: string): string {
  const s = lerSkillDaPasta(resolve(diretorio), nome);
  if (!PADRAO_RECURSO.test(recurso) || recurso.split('/').some((p) => p === '..' || p === '.' || p === '')) {
    throw new ErroSkill('recurso inválido: use references/..., assets/... ou scripts/... (caminho relativo, sem "..")');
  }
  const alvo = join(s.meta.diretorio, recurso);
  let real: string;
  try {
    real = realpathSync(alvo);
  } catch {
    throw new ErroSkill(`recurso "${recurso}" não existe`);
  }
  const raiz = realpathSync(s.meta.diretorio) + sep;
  if (!real.startsWith(raiz)) throw new ErroSkill('recurso fora da pasta da skill');
  const texto = lerTextoRegular(alvo, LIMITE_RECURSO);
  const scan = escanearInjecao(texto);
  if (scan.nivel !== 'limpo') throw new ErroSkill(`recurso ${scan.nivel} no scanner de injeção (${scan.motivos.join('; ')})`);
  return texto;
}

/** Catálogo com cache curto por processo (padrão 60 s): a conversa não relê o disco a cada mensagem. Nunca lança. */
export function criarProvedorSkills(o: { diretorio?: string; ttlMs?: number; agora?: () => number; aoRejeitar?: (r: RejeicaoSkill) => void } = {}): { obter(): CatalogoSkills } {
  const agora = o.agora ?? Date.now;
  let cache: { em: number; catalogo: CatalogoSkills } | null = null;
  return {
    obter() {
      if (cache && agora() - cache.em < (o.ttlMs ?? 60_000)) return cache.catalogo;
      const diretorio = o.diretorio ?? resolverDiretorioSkills();
      let catalogo: CatalogoSkills;
      try {
        catalogo = carregarCatalogo(diretorio);
      } catch {
        catalogo = { diretorio, skills: [], rejeitadas: [] };
      }
      for (const r of catalogo.rejeitadas) {
        try {
          o.aoRejeitar?.(r);
        } catch {
          /* log não derruba a conversa */
        }
      }
      cache = { em: agora(), catalogo };
      return catalogo;
    },
  };
}
