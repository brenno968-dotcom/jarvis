// Chunker da memória semântica (item 790): divide por parágrafo, agrupa até o tamanho máximo
// e repete o fim do trecho anterior no começo do próximo (sobreposição), sem cortar palavras.
export interface OpcoesChunker {
  /** Tamanho máximo de cada trecho, em caracteres (inclui a sobreposição). Padrão 1000. */
  tamanhoMax?: number;
  /** Quantos caracteres do fim do trecho anterior se repetem no próximo. Padrão 150. */
  sobreposicao?: number;
}

function cortarLongo(texto: string, n: number): string[] {
  const partes: string[] = [];
  let resto = texto.trim();
  while (resto.length > n) {
    let corte = Math.max(resto.lastIndexOf(' ', n), resto.lastIndexOf('\n', n));
    if (corte < n / 2) corte = n;
    partes.push(resto.slice(0, corte).trim());
    resto = resto.slice(corte).trim();
  }
  if (resto) partes.push(resto);
  return partes;
}

function cauda(texto: string, n: number): string {
  if (n <= 0 || texto.length <= n) return n <= 0 ? '' : texto;
  const t = texto.slice(-n);
  const i = t.search(/\s/);
  return (i >= 0 ? t.slice(i) : t).trim();
}

export function dividirEmTrechos(texto: string, o: OpcoesChunker = {}): string[] {
  const max = o.tamanhoMax ?? 1000;
  const sobreposicao = o.sobreposicao ?? 150;
  if (!Number.isInteger(max) || max < 100) throw new Error('tamanhoMax deve ser inteiro >= 100');
  if (!Number.isInteger(sobreposicao) || sobreposicao < 0 || sobreposicao > max / 2) {
    throw new Error('sobreposicao deve ser inteiro entre 0 e tamanhoMax/2');
  }
  const util = max - sobreposicao - 1; // espaço do conteúdo novo; o resto é a sobreposição
  const paragrafos = texto
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const pecas = paragrafos.flatMap((p) => (p.length <= util ? [p] : cortarLongo(p, util)));

  const brutos: string[] = [];
  let atual = '';
  for (const p of pecas) {
    if (!atual) atual = p;
    else if (atual.length + 2 + p.length <= util) atual += `\n\n${p}`;
    else {
      brutos.push(atual);
      atual = p;
    }
  }
  if (atual) brutos.push(atual);

  return brutos.map((b, i) => {
    if (i === 0) return b;
    const c = cauda(brutos[i - 1]!, sobreposicao);
    return c ? `${c}\n${b}` : b;
  });
}
