import type { Banco } from './banco.ts';
import { emTransacao } from './banco.ts';
import { registrarAuditoria } from './auditoria.ts';
import { enfileirarAviso } from './avisos.ts';
import { redator } from './redacao.ts';

/**
 * Pedido do Pulso do Nexus (item 177 do Quadro): um problema que o Nexus não corrige sozinho.
 * Contrato: docs/INTEGRACAO-NEXUS.md, seção 4. Chega assinado (mesmo HMAC dos outros caminhos).
 * Hoje o Jarvis registra na auditoria e avisa o Breno pelo WhatsApp (pedido_humano), com o link da tela
 * onde se corrige. Resolver sozinho (criar conta, trocar número) depende dos adaptadores da Fase 1.
 * Mesmo serviço + mesma classe dentro de 6 horas = um aviso só (não enche o WhatsApp).
 */
export interface PedidoNexus {
  componente: string;
  escopo: string;
  classe: 'breno' | 'desconhecida';
  texto: string;
  link?: string;
}

export const JANELA_REPETIDO_HORAS = 6;

/** Confere o corpo. Nada de campo estranho: o texto vai limpo e cortado. */
export function lerPedidoNexus(bruto: unknown): PedidoNexus | null {
  if (!bruto || typeof bruto !== 'object') return null;
  const o = bruto as Record<string, unknown>;
  const componente = typeof o.componente === 'string' ? o.componente.trim().slice(0, 60) : '';
  if (!/^[a-z0-9_.-]+$/i.test(componente)) return null;
  if (o.classe !== 'breno' && o.classe !== 'desconhecida') return null;
  const texto = typeof o.texto === 'string' ? o.texto.trim().slice(0, 500) : '';
  if (!texto) return null;
  const escopo = typeof o.escopo === 'string' ? o.escopo.trim().slice(0, 80) : '';
  // link: só caminho do Nexus (começa com "/"), sem "//" (não vira link para outro site)
  const link = typeof o.link === 'string' && /^\/(?!\/)[\w\-/?=&.%]*$/.test(o.link) ? o.link.slice(0, 200) : undefined;
  return { componente, escopo, classe: o.classe, texto, ...(link ? { link } : {}) };
}

export type ResultadoPedidoNexus = { registrado: true; avisado: boolean } | { registrado: false; motivo: string };

/** Registra o pedido e, se não houver um igual nas últimas 6 h, avisa o Breno. */
export async function registrarPedidoNexus(banco: Banco, p: PedidoNexus, urlNexus?: string): Promise<ResultadoPedidoNexus> {
  const texto = String(redator.redigirValor(p.texto));
  return emTransacao(banco, async (c) => {
    const ja = await c.query(
      `select 1 from auditoria
        where acao = 'pedido_nexus' and detalhes->>'componente' = $1 and detalhes->>'escopo' = $2 and detalhes->>'classe' = $3
          and coalesce((detalhes->>'avisado')::boolean, false)
          and quando > now() - make_interval(hours => $4) limit 1`,
      [p.componente, p.escopo, p.classe, JANELA_REPETIDO_HORAS],
    );
    const avisar = (ja.rowCount ?? 0) === 0;
    if (avisar) {
      const base = urlNexus?.replace(/\/+$/, '');
      const titulo = p.classe === 'breno' ? 'O Pulso do Nexus precisa de você' : 'O Pulso do Nexus achou um problema que não sabe corrigir';
      await enfileirarAviso(c, {
        tipo: 'pedido_humano',
        conteudo: {
          texto: `${titulo} (${p.componente}${p.escopo ? ` · ${p.escopo}` : ''}):\n${texto}`,
          ...(p.link && base ? { link: `${base}${p.link}` } : {}),
        },
      });
    }
    await registrarAuditoria(c, {
      quem: 'nexus:pulso',
      acao: 'pedido_nexus',
      detalhes: { componente: p.componente, escopo: p.escopo, classe: p.classe, texto, link: p.link ?? null, avisado: avisar },
    });
    return { registrado: true, avisado: avisar };
  });
}
