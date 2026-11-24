// Item 852: busca HTTP segura (proteção SSRF) para a ferramenta `web_abrir`.
// - só http/https, só portas 80/443, sem usuário/senha na URL;
// - o nome é resolvido e TODOS os endereços precisam ser públicos (loopback, privados, link-local, metadata
//   169.254.169.254, CGNAT, multicast, reservados e IPv6 locais são recusados), a cada passo, inclusive nos redirects;
// - a conexão é feita no endereço JÁ validado (sem segunda resolução: não há troca de DNS entre validar e conectar);
// - no máximo 3 redirects, 10 s no total, 2 MB, só os tipos de conteúdo da lista; sem cookies, sem credenciais.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { redator } from '../redacao.ts';

export const USER_AGENT_WEB = 'JarvisBot/1.0';
export const MAX_REDIRECTS = 3;
export const TIMEOUT_WEB_MS = 10_000;
export const MAX_BYTES_WEB = 2 * 1024 * 1024;
export const PORTAS_PERMITIDAS = ['80', '443'] as const;
export const TIPOS_PERMITIDOS = ['text/html', 'text/plain', 'application/json'] as const;
const MAX_URL = 2048;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export class ErroWeb extends Error {
  constructor(
    public readonly codigo: 'URL_INVALIDA' | 'PROTOCOLO' | 'PORTA' | 'DESTINO_BLOQUEADO' | 'DNS' | 'REDIRECTS' | 'TIMEOUT' | 'TAMANHO' | 'TIPO' | 'HTTP' | 'REDE',
    mensagem: string,
  ) {
    super(mensagem);
    this.name = 'ErroWeb';
  }
}

// ---------- endereços ----------

function octetos(ip: string): number[] | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.some((x) => !(x >= 0 && x <= 255)) ? null : n;
}

function ipv4Bloqueado(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // "esta rede", privada, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local (inclui metadata 169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF e documentação
  if (a === 192 && b === 88 && c === 99) return true; // relay 6to4
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a === 198 && b === 51 && c === 100) return true; // documentação
  if (a === 203 && b === 0 && c === 113) return true; // documentação
  return a >= 224; // multicast, reservado, broadcast
}

/** Expande um IPv6 em 8 grupos de 16 bits (aceita "::" e IPv4 no final). null se não for IPv6 válido. */
function grupos(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zona = s.indexOf('%');
  if (zona >= 0) s = s.slice(0, zona);
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = octetos(v4[1]!);
    if (!o) return null;
    s = `${s.slice(0, v4.index)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const partes = s.split('::');
  if (partes.length > 2) return null;
  const cabeca = partes[0] ? partes[0].split(':') : [];
  const cauda = partes.length === 2 && partes[1] ? partes[1].split(':') : [];
  let g: string[];
  if (partes.length === 2) {
    const falta = 8 - cabeca.length - cauda.length;
    if (falta < 1) return null;
    g = [...cabeca, ...Array<string>(falta).fill('0'), ...cauda];
  } else {
    g = cabeca;
  }
  if (g.length !== 8) return null;
  const n = g.map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN));
  return n.some(Number.isNaN) ? null : n;
}

function ipv6Bloqueado(g: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  // IPv4 mapeado (::ffff:a.b.c.d): vale a regra do IPv4 embutido
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return ipv4Bloqueado([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
  // só unicast global (2000::/3) é aceito; o resto (::, ::1, fe80::, fc00::, ff00::, fec0::, 64:ff9b::, ...) cai fora
  if ((g0 & 0xe000) !== 0x2000) return true;
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true; // Teredo e documentação
  if (g0 === 0x2002) return true; // 6to4 (embute IPv4 qualquer)
  if ((g0 & 0xfff0) === 0x3ff0) return true; // documentação (3fff::/20)
  return false;
}

/** true se o endereço NÃO deve ser acessado (privado, loopback, link-local, metadata, reservado...). Texto inválido também é bloqueado. */
export function ipBloqueado(ip: string): boolean {
  const limpo = ip.replace(/^\[|\]$/g, '');
  const v = isIP(limpo);
  if (v === 4) {
    const o = octetos(limpo);
    return !o || ipv4Bloqueado(o);
  }
  if (v === 6) {
    const g = grupos(limpo);
    return !g || ipv6Bloqueado(g);
  }
  return true;
}

const NOME_LOCAL = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp)$/;

// ---------- URL e DNS ----------

export function validarUrlWeb(bruta: string): URL {
  if (typeof bruta !== 'string' || !bruta.trim() || bruta.length > MAX_URL) throw new ErroWeb('URL_INVALIDA', 'URL vazia ou longa demais');
  let u: URL;
  try {
    u = new URL(bruta.trim());
  } catch {
    throw new ErroWeb('URL_INVALIDA', 'URL inválida');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ErroWeb('PROTOCOLO', 'só http e https');
  if (u.username || u.password) throw new ErroWeb('URL_INVALIDA', 'URL com usuário/senha não é aceita');
  const porta = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (!(PORTAS_PERMITIDAS as readonly string[]).includes(porta)) throw new ErroWeb('PORTA', `porta ${porta} não permitida (só 80 e 443)`);
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) throw new ErroWeb('URL_INVALIDA', 'URL sem endereço');
  if (isIP(host) === 0 && NOME_LOCAL.test(host)) throw new ErroWeb('DESTINO_BLOQUEADO', 'endereço interno não permitido');
  return u;
}

export interface EnderecoWeb {
  address: string;
  family: 4 | 6;
}

export type Resolvedor = (host: string) => Promise<string[]>;

const resolvedorPadrao: Resolvedor = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Resolve o host e exige que TODOS os endereços sejam públicos. Devolve o endereço a usar (IPv4 primeiro). */
export async function resolverPublico(host: string, resolver: Resolvedor = resolvedorPadrao): Promise<EnderecoWeb> {
  const limpo = host.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  let lista: string[];
  if (isIP(limpo)) {
    lista = [limpo];
  } else {
    try {
      lista = await resolver(limpo);
    } catch {
      throw new ErroWeb('DNS', 'não consegui resolver o endereço');
    }
  }
  if (!lista.length) throw new ErroWeb('DNS', 'o endereço não tem IP');
  if (lista.some(ipBloqueado)) throw new ErroWeb('DESTINO_BLOQUEADO', 'o endereço aponta para rede interna ou reservada');
  const escolhido = lista.find((x) => isIP(x) === 4) ?? lista[0]!;
  return { address: escolhido.replace(/^\[|\]$/g, ''), family: isIP(escolhido.replace(/^\[|\]$/g, '')) === 6 ? 6 : 4 };
}

// ---------- busca ----------

export interface RespostaHop {
  status: number;
  headers: Record<string, string | undefined>;
  corpo: AsyncIterable<Uint8Array>;
  fechar(): void;
}

/** Um único GET, na conexão fixada em `endereco` (sem nova resolução de DNS). */
export type Hop = (p: { url: URL; endereco: EnderecoWeb; signal: AbortSignal }) => Promise<RespostaHop>;

export const hopPadrao: Hop = ({ url, endereco, signal }) =>
  new Promise((resolve, reject) => {
    const modulo = url.protocol === 'https:' ? https : http;
    const req = modulo.request(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        agent: false,
        signal,
        headers: {
          'user-agent': USER_AGENT_WEB,
          accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.1',
          'accept-encoding': 'identity',
        },
        // conecta no IP já validado; o nome continua valendo para o Host e o certificado TLS
        lookup: ((_h: string, opcoes: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          if (opcoes?.all) cb(null, [{ address: endereco.address, family: endereco.family }]);
          else cb(null, endereco.address, endereco.family);
        }) as never,
      },
      (res) => {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
        resolve({ status: res.statusCode ?? 0, headers, corpo: res, fechar: () => res.destroy() });
      },
    );
    req.on('error', reject);
    req.end();
  });

export interface OpcoesBuscaSegura {
  resolver?: Resolvedor;
  hop?: Hop;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export interface RespostaWeb {
  urlFinal: string;
  status: number;
  tipo: string;
  corpo: Uint8Array;
  charset: string | null;
  redirects: number;
}

function tipoDe(contentType: string | undefined): { tipo: string; charset: string | null } {
  const [t = '', ...resto] = (contentType ?? '').split(';');
  const cs = resto.map((x) => x.trim()).find((x) => /^charset=/i.test(x));
  return { tipo: t.trim().toLowerCase(), charset: cs ? cs.slice(8).replace(/^["']|["']$/g, '').trim().toLowerCase() : null };
}

/** GET seguro com redirects manuais, validando cada destino. Nunca devolve conteúdo de destino bloqueado. */
export async function buscarUrlSegura(urlBruta: string, o: OpcoesBuscaSegura = {}): Promise<RespostaWeb> {
  const hop = o.hop ?? hopPadrao;
  const maxBytes = o.maxBytes ?? MAX_BYTES_WEB;
  const maxRedirects = o.maxRedirects ?? MAX_REDIRECTS;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? TIMEOUT_WEB_MS);
  const tempoEsgotado = () => ctl.signal.aborted;
  // mesmo que um hop ignore o sinal, a busca termina no prazo
  const aborto = new Promise<never>((_, rej) => ctl.signal.addEventListener('abort', () => rej(new ErroWeb('TIMEOUT', 'tempo esgotado')), { once: true }));
  aborto.catch(() => undefined);
  try {
    let url = validarUrlWeb(urlBruta);
    for (let passo = 0; ; passo++) {
      const endereco = await resolverPublico(url.hostname, o.resolver);
      let r: RespostaHop;
      try {
        r = await Promise.race([hop({ url, endereco, signal: ctl.signal }), aborto]);
      } catch (e) {
        throw tempoEsgotado() ? new ErroWeb('TIMEOUT', 'tempo esgotado') : new ErroWeb('REDE', redator.redigir(`falha de rede: ${(e as Error)?.message ?? e}`).slice(0, 200));
      }
      if (REDIRECTS.has(r.status)) {
        r.fechar();
        const destino = r.headers.location;
        if (!destino) throw new ErroWeb('HTTP', `redirect ${r.status} sem destino`);
        if (passo >= maxRedirects) throw new ErroWeb('REDIRECTS', `mais de ${maxRedirects} redirects`);
        try {
          url = validarUrlWeb(new URL(destino, url).toString());
        } catch (e) {
          throw e instanceof ErroWeb ? e : new ErroWeb('URL_INVALIDA', 'destino do redirect inválido');
        }
        continue;
      }
      try {
        if (r.status < 200 || r.status >= 300) throw new ErroWeb('HTTP', `a página respondeu HTTP ${r.status}`);
        const { tipo, charset } = tipoDe(r.headers['content-type']);
        if (tipo === 'application/pdf') throw new ErroWeb('TIPO', 'PDF não é suportado (sem extrator de PDF)');
        if (!(TIPOS_PERMITIDOS as readonly string[]).includes(tipo)) throw new ErroWeb('TIPO', `tipo de conteúdo não permitido: ${tipo || 'desconhecido'}`);
        const declarado = Number(r.headers['content-length']);
        if (Number.isFinite(declarado) && declarado > maxBytes) throw new ErroWeb('TAMANHO', `a página passa de ${Math.round(maxBytes / 1024 / 1024)} MB`);
        const partes: Uint8Array[] = [];
        let total = 0;
        try {
          const it = r.corpo[Symbol.asyncIterator]();
          for (;;) {
            const n = await Promise.race([it.next(), aborto]);
            if (n.done) break;
            total += n.value.byteLength;
            if (total > maxBytes) throw new ErroWeb('TAMANHO', `a página passa de ${Math.round(maxBytes / 1024 / 1024)} MB`);
            partes.push(n.value);
          }
        } catch (e) {
          if (e instanceof ErroWeb) throw e;
          throw tempoEsgotado() ? new ErroWeb('TIMEOUT', 'tempo esgotado') : new ErroWeb('REDE', 'a conexão caiu durante a leitura');
        }
        if (tempoEsgotado()) throw new ErroWeb('TIMEOUT', 'tempo esgotado');
        const corpo = new Uint8Array(total);
        let pos = 0;
        for (const p of partes) {
          corpo.set(p, pos);
          pos += p.byteLength;
        }
        return { urlFinal: url.toString(), status: r.status, tipo, corpo, charset, redirects: passo };
      } finally {
        r.fechar();
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
