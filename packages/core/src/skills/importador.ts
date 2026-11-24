// Item 793 (skills): importador de skills de terceiros (`npm run skills:importar -- <url-github-ou-pasta>`).
// Nada entra em `skills/` sem passar por TODAS as checagens, e o que entra chega NEUTRO:
//   - frontmatter validado (zod, nome kebab-case, description) e texto limpo no scanner de injeção (todos os arquivos de texto);
//   - marcada `origem: externa`; `ferramentas_permitidas` VAZIA, `risco` verde e sem `finalidade` (o que o terceiro declarou é
//     descartado) até o Breno editar o SKILL.md na mão; `allowed-tools` da especificação também é descartado;
//   - `scripts/` NÃO é copiado (com `comScripts` vai como texto inerte, sem permissão de execução, e o Jarvis nunca executa);
//   - link simbólico, caminho com `..`, arquivo binário/grande demais ou pasta já existente = recusa (nunca sobrescreve).
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { escanearInjecao } from '../seguranca/injecao.ts';
import { carregarSkill } from './carregador.ts';
import { ErroSkill, esquemaFrontmatter, nomeSkill, separarSkillMd, textoDoZod } from './esquema.ts';

export const LIMITE_ARQUIVOS = 60;
export const LIMITE_ARQUIVO_BYTES = 256 * 1024;
export const LIMITE_TOTAL_BYTES = 1024 * 1024;
const PROFUNDIDADE_MAX = 3;
const CAMPOS_DO_JARVIS = ['ferramentas_permitidas', 'finalidade', 'risco', 'origem', 'fonte', 'allowed-tools'] as const;
const IGNORADAS = new Set(['.git', '.github', 'node_modules', '.DS_Store']);

export interface ArquivoOrigem {
  /** Caminho relativo à raiz da skill, com `/`. */
  caminho: string;
  conteudo: Buffer;
}

export interface ResultadoImportacao {
  ok: boolean;
  nome?: string;
  diretorio?: string;
  copiados: string[];
  ignorados: string[];
  /** Motivos da recusa (vazio se ok). */
  recusas: string[];
  avisos: string[];
}

export interface OpcoesImportar {
  /** Pasta `skills/` de destino. */
  destino: string;
  /** Copia scripts/ como TEXTO inerte (padrão: não copia). Nunca são executados. */
  comScripts?: boolean;
  fetchImpl?: typeof fetch;
}

const recusa = (motivo: string): ResultadoImportacao => ({ ok: false, copiados: [], ignorados: [], recusas: [motivo], avisos: [] });

function caminhoSeguro(c: string): boolean {
  return !!c && !c.startsWith('/') && !c.includes('\\') && c.split('/').every((p) => p !== '' && p !== '.' && p !== '..');
}

const ehTexto = (b: Buffer) => !b.includes(0);

/**
 * Parte pura (sem rede): valida os arquivos de uma skill de terceiro e a instala em `destino/<name>`.
 * `fonte` (URL ou pasta de origem) vai para o frontmatter.
 */
export function instalarSkillExterna(arquivos: ArquivoOrigem[], fonte: string, o: OpcoesImportar): ResultadoImportacao {
  const avisos: string[] = [];
  const ignorados: string[] = [];
  if (arquivos.length > LIMITE_ARQUIVOS) return recusa(`skill com arquivos demais (${arquivos.length}; limite ${LIMITE_ARQUIVOS})`);
  if (arquivos.reduce((s, a) => s + a.conteudo.length, 0) > LIMITE_TOTAL_BYTES) return recusa(`skill grande demais (limite ${LIMITE_TOTAL_BYTES} bytes no total)`);
  for (const a of arquivos) {
    if (!caminhoSeguro(a.caminho)) return recusa(`caminho inválido na skill: "${a.caminho}"`);
    if (a.conteudo.length > LIMITE_ARQUIVO_BYTES) return recusa(`arquivo "${a.caminho}" grande demais (limite ${LIMITE_ARQUIVO_BYTES} bytes)`);
  }
  const md = arquivos.find((a) => a.caminho === 'SKILL.md');
  if (!md) return recusa('falta o SKILL.md na raiz da skill');

  // 1. formato + zod (sobre os campos da especificação; o que o terceiro disse sobre ferramentas é descartado)
  let bruto: Record<string, unknown>;
  let corpo: string;
  try {
    ({ bruto, corpo } = separarSkillMd(md.conteudo.toString('utf8')));
  } catch (e) {
    return recusa((e as Error).message);
  }
  const nome = typeof bruto.name === 'string' ? bruto.name : '';
  if (!nomeSkill.safeParse(nome).success) return recusa(`name inválido ("${nome.slice(0, 80)}"): use kebab-case (minúsculas, números e hífen)`);
  const descartados = CAMPOS_DO_JARVIS.filter((c) => c in bruto);
  if (descartados.length) avisos.push(`campos do autor descartados (sem efeito aqui): ${descartados.join(', ')}`);
  const frontmatter: Record<string, unknown> = { ...bruto };
  for (const c of CAMPOS_DO_JARVIS) delete frontmatter[c];
  Object.assign(frontmatter, { ferramentas_permitidas: [], risco: 'verde', origem: 'externa', fonte: fonte.slice(0, 500) });
  const fm = esquemaFrontmatter.safeParse(frontmatter);
  if (!fm.success) return recusa(textoDoZod(fm.error));

  // 2. seleção dos arquivos que entram (só texto; scripts/ só com a opção; o resto fica de fora)
  const instalar: ArquivoOrigem[] = [];
  for (const a of arquivos) {
    if (a.caminho === 'SKILL.md') continue;
    const topo = a.caminho.split('/')[0] ?? '';
    const dentro = a.caminho.includes('/');
    if (dentro && topo === 'scripts' && !o.comScripts) {
      ignorados.push(a.caminho);
      continue;
    }
    if (!(dentro && (topo === 'references' || topo === 'assets' || topo === 'scripts')) && !/^LICEN[CS]E(?:\.[a-z]+)?$/i.test(a.caminho)) {
      ignorados.push(a.caminho);
      continue;
    }
    if (!ehTexto(a.conteudo)) {
      ignorados.push(a.caminho);
      avisos.push(`arquivo binário ignorado: ${a.caminho}`);
      continue;
    }
    instalar.push(a);
  }
  if (ignorados.some((c) => c.startsWith('scripts/'))) avisos.push('scripts/ não foi copiado (use --com-scripts para copiar como texto; o Jarvis nunca os executa)');

  // 3. scanner de injeção em TODO texto que vai entrar
  const suspeitos: string[] = [];
  for (const a of [md, ...instalar]) {
    const r = escanearInjecao(a.conteudo.toString('utf8'));
    if (r.nivel !== 'limpo') suspeitos.push(`${a.caminho}: ${r.nivel} (${r.motivos.join('; ')})`);
  }
  if (suspeitos.length) return { ok: false, nome, copiados: [], ignorados, recusas: [`texto suspeito no scanner de injeção, nada foi importado: ${suspeitos.join(' | ')}`], avisos };

  // 4. destino (nunca sobrescreve)
  const base = resolve(o.destino);
  const dir = join(base, nome);
  if (existsSync(dir)) return { ok: false, nome, copiados: [], ignorados, recusas: [`já existe skills/${nome}: remova ou renomeie antes de importar`], avisos };

  // 5. grava SKILL.md reescrito + arquivos, revalida o que ficou no disco e desfaz tudo se falhar
  const textoMd = `---\n${stringify(fm.data, { lineWidth: 0 })}---\n\n${corpo}\n`;
  const copiados: string[] = ['SKILL.md'];
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), textoMd, { mode: 0o644 });
    for (const a of instalar) {
      const alvo = join(dir, a.caminho);
      mkdirSync(join(alvo, '..'), { recursive: true });
      writeFileSync(alvo, a.conteudo, { mode: 0o644 }); // sem bit de execução
      copiados.push(a.caminho);
    }
    const conferida = carregarSkill(base, nome);
    if (conferida.origem !== 'externa' || conferida.ferramentas.length > 0) throw new ErroSkill('a skill importada não ficou neutra (origem/ferramentas)');
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, nome, copiados: [], ignorados, recusas: [`falha ao validar o que foi gravado (desfeito): ${(e as Error).message}`], avisos };
  }
  return { ok: true, nome, diretorio: dir, copiados, ignorados, recusas: [], avisos };
}

// ---------------------------------------------------------------- origens

/** Lê uma pasta local (sem seguir links simbólicos: qualquer link recusa a importação). */
export function lerPastaLocal(pasta: string): ArquivoOrigem[] {
  const raiz = resolve(pasta);
  const saida: ArquivoOrigem[] = [];
  const andar = (rel: string, nivel: number) => {
    for (const e of readdirSync(join(raiz, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORADAS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const st = lstatSync(join(raiz, r));
      if (st.isSymbolicLink()) throw new ErroSkill(`link simbólico na skill: ${r}`);
      if (st.isDirectory()) {
        if (nivel >= PROFUNDIDADE_MAX) throw new ErroSkill(`pasta funda demais: ${r}`);
        andar(r, nivel + 1);
      } else if (st.isFile()) {
        if (saida.length >= LIMITE_ARQUIVOS) throw new ErroSkill(`arquivos demais (limite ${LIMITE_ARQUIVOS})`);
        if (st.size > LIMITE_ARQUIVO_BYTES) throw new ErroSkill(`arquivo grande demais: ${r}`);
        saida.push({ caminho: r, conteudo: readFileSync(join(raiz, r)) });
      }
    }
  };
  andar('', 0);
  return saida;
}

export interface AlvoGithub {
  dono: string;
  repo: string;
  ref?: string;
  caminho: string;
}

const PADRAO_GH = /^[A-Za-z0-9_.-]{1,100}$/;

/** Aceita https://github.com/<dono>/<repo>[/tree|blob/<ref>/<pasta>]. Só github.com. */
export function lerUrlGithub(url: string): AlvoGithub {
  if (/(^|\/)\.\.(\/|$)/.test(url)) throw new ErroSkill('caminho inválido na URL');
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ErroSkill('origem não é uma pasta existente nem uma URL válida');
  }
  if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw new ErroSkill('só URLs https://github.com/... são aceitas');
  const partes = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  const [dono, repoBruto, tipo, ref, ...resto] = partes;
  const repo = repoBruto?.replace(/\.git$/, '');
  if (!dono || !repo || !PADRAO_GH.test(dono) || !PADRAO_GH.test(repo)) throw new ErroSkill('URL do GitHub precisa ter dono e repositório');
  if (tipo && tipo !== 'tree' && tipo !== 'blob') throw new ErroSkill('use a URL do repositório ou de uma pasta (…/tree/<ref>/<pasta>)');
  let caminho = resto;
  if (tipo === 'blob') caminho = caminho.slice(0, -1); // aponta o SKILL.md: usa a pasta dele
  if (tipo && (!ref || !PADRAO_GH.test(ref))) throw new ErroSkill('ref (branch/tag) inválida na URL');
  if (caminho.some((p) => !/^[A-Za-z0-9._ -]+$/.test(p) || p === '.' || p === '..')) throw new ErroSkill('caminho inválido na URL');
  return { dono, repo, ref: tipo ? ref : undefined, caminho: caminho.join('/') };
}

interface ItemGithub {
  name: string;
  path: string;
  type: string;
  size?: number;
  download_url?: string | null;
}

/** Baixa a pasta de uma skill pela API de conteúdo do GitHub (só leitura, anônima). */
export async function baixarDoGithub(alvo: AlvoGithub, fetchImpl: typeof fetch = fetch): Promise<ArquivoOrigem[]> {
  const saida: ArquivoOrigem[] = [];
  const cabecalhos = { accept: 'application/vnd.github+json', 'user-agent': 'jarvis-skills-importador' };
  const pegar = async (url: string): Promise<Response> => {
    const r = await fetchImpl(url, { headers: cabecalhos, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new ErroSkill(`GitHub respondeu ${r.status} em ${new URL(url).pathname}`);
    return r;
  };
  const andar = async (rel: string, nivel: number) => {
    const caminhoApi = [alvo.caminho, rel].filter(Boolean).join('/').split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const url = `https://api.github.com/repos/${alvo.dono}/${alvo.repo}/contents${caminhoApi ? `/${caminhoApi}` : ''}${alvo.ref ? `?ref=${encodeURIComponent(alvo.ref)}` : ''}`;
    const lista = (await (await pegar(url)).json()) as ItemGithub[];
    if (!Array.isArray(lista)) throw new ErroSkill('o endereço não é uma pasta no GitHub');
    for (const it of lista) {
      if (IGNORADAS.has(it.name)) continue;
      const r = rel ? `${rel}/${it.name}` : it.name;
      if (it.type === 'dir') {
        if (nivel >= PROFUNDIDADE_MAX) throw new ErroSkill(`pasta funda demais: ${r}`);
        await andar(r, nivel + 1);
      } else if (it.type === 'file') {
        if (saida.length >= LIMITE_ARQUIVOS) throw new ErroSkill(`arquivos demais (limite ${LIMITE_ARQUIVOS})`);
        if ((it.size ?? 0) > LIMITE_ARQUIVO_BYTES) throw new ErroSkill(`arquivo grande demais: ${r}`);
        if (!it.download_url || !it.download_url.startsWith('https://raw.githubusercontent.com/')) throw new ErroSkill(`arquivo sem endereço de download confiável: ${r}`);
        saida.push({ caminho: r, conteudo: Buffer.from(await (await pegar(it.download_url)).arrayBuffer()) });
      } else {
        throw new ErroSkill(`tipo "${it.type}" não é aceito na skill (link simbólico/submódulo): ${r}`);
      }
    }
  };
  await andar('', 0);
  return saida;
}

/** Ponto de entrada: pasta local ou URL do GitHub. Nunca lança por skill ruim: devolve `ok: false` com os motivos. */
export async function importarSkill(origem: string, o: OpcoesImportar): Promise<ResultadoImportacao> {
  try {
    if (existsSync(origem)) return instalarSkillExterna(lerPastaLocal(origem), `pasta:${resolve(origem).split('/').slice(-2).join('/')}`, o);
    const alvo = lerUrlGithub(origem);
    const arquivos = await baixarDoGithub(alvo, o.fetchImpl);
    return instalarSkillExterna(arquivos, origem, o);
  } catch (e) {
    return recusa(e instanceof ErroSkill ? e.message : `não consegui obter a skill: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
  }
}
