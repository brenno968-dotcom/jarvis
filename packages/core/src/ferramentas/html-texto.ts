// Item 852: HTML -> texto limpo, sem dependência. Descarta script, estilo, <head> (menos o título), elementos
// escondidos (hidden, aria-hidden, display:none, visibility:hidden), comentários e tags; quebra linha nos blocos.
const PULAR = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed', 'canvas', 'head', 'select', 'datalist']);
const VAZIOS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCOS = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul', 'br', 'tbody', 'thead']);

const ENTIDADES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', deg: '°', euro: '€', pound: '£', middot: '·', bull: '•',
  aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', ccedil: 'ç', eacute: 'é', ecirc: 'ê', iacute: 'í', oacute: 'ó', ocirc: 'ô', otilde: 'õ', uacute: 'ú',
  Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã', Ccedil: 'Ç', Eacute: 'É', Ecirc: 'Ê', Iacute: 'Í', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Uacute: 'Ú',
};

export function decodificarEntidades(t: string): string {
  return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1]!.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return ENTIDADES[e] ?? ENTIDADES[e.toLowerCase()] ?? m;
  });
}

function escondido(attrs: string): boolean {
  if (/(^|\s)hidden(\s|=|$)/i.test(attrs)) return true;
  if (/aria-hidden\s*=\s*["']?true/i.test(attrs)) return true;
  const estilo = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  const css = (estilo?.[1] ?? estilo?.[2] ?? '').replace(/\s+/g, '').toLowerCase();
  return /display:none|visibility:hidden|font-size:0(?:px|pt|em|rem|%)?(?:;|$)|opacity:0(?:\.0*)?(?:;|$)/.test(css);
}

const TAG = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<[!?][^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

export interface TextoDeHtml {
  titulo: string;
  texto: string;
}

export function htmlParaTexto(html: string): TextoDeHtml {
  let saida = '';
  let titulo = '';
  let pulando: { tag: string; nivel: number } | null = null;
  let dentroTitulo = false;
  let ultimo = 0;
  const juntar = (t: string) => {
    saida += t;
  };
  let m: RegExpExecArray | null;
  TAG.lastIndex = 0;
  while ((m = TAG.exec(html))) {
    const trecho = html.slice(ultimo, m.index);
    ultimo = TAG.lastIndex;
    if (!pulando && trecho) {
      if (dentroTitulo) titulo += trecho;
      else juntar(trecho);
    }
    if (!m[2]) continue; // comentário, doctype, CDATA
    const fecha = m[1] === '/';
    const nome = m[2].toLowerCase();
    const attrs = m[3] ?? '';
    const autoFecha = /\/\s*$/.test(attrs) || VAZIOS.has(nome);
    if (pulando) {
      if (nome === pulando.tag && !autoFecha) {
        pulando.nivel += fecha ? -1 : 1;
        if (pulando.nivel === 0) pulando = null;
      }
      continue;
    }
    if (nome === 'title') {
      dentroTitulo = !fecha;
      continue;
    }
    if (!fecha && (nome === 'script' || nome === 'style') && !autoFecha) {
      // texto cru: vai direto até o fechamento (o JavaScript/CSS pode ter "<" e ">" soltos)
      const fim = new RegExp(`</${nome}\\s*>`, 'i').exec(html.slice(TAG.lastIndex));
      ultimo = TAG.lastIndex = fim ? TAG.lastIndex + fim.index + fim[0].length : html.length;
      continue;
    }
    if (!fecha && (PULAR.has(nome) || escondido(attrs)) && !autoFecha) {
      // <head> traz o <title>: o título já foi lido acima se vier antes; aqui só pula o resto
      if (nome === 'head') {
        const fimHead = /<\/head\s*>/i.exec(html.slice(TAG.lastIndex));
        const cabeca = fimHead ? html.slice(TAG.lastIndex, TAG.lastIndex + fimHead.index) : html.slice(TAG.lastIndex);
        const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(cabeca);
        if (t && !titulo) titulo = t[1]!;
      }
      pulando = { tag: nome, nivel: 1 };
      continue;
    }
    if (nome === 'li' && !fecha) {
      juntar('\n- ');
      continue;
    }
    if (nome === 'br') juntar('\n');
    else if (nome === 'td' || nome === 'th') juntar(fecha ? ' | ' : '');
    else if (BLOCOS.has(nome)) juntar('\n');
  }
  if (!pulando) {
    const resto = html.slice(ultimo);
    // resto sem tag fechada (HTML truncado): remove um "<" solto para não deixar marcação
    const limpo = resto.replace(/<[^>]*$/, '');
    if (dentroTitulo) titulo += limpo;
    else juntar(limpo);
  }
  const arrumar = (t: string) =>
    decodificarEntidades(t)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\f\v\r]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  return { titulo: arrumar(titulo).replace(/\s+/g, ' ').slice(0, 300), texto: arrumar(saida) };
}
