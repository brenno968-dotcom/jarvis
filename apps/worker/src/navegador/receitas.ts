// Motor de receitas (seção 20): passo a passo gravado por plataforma, reaproveitado a cada execução.
import { log, type ContextoExecucao, type Resultado } from '@jarvis/core';
import { z } from 'zod';
import { detectarCaptcha } from './captcha.ts';
import { aguardarCodigo, type ClienteGmail } from './gmail.ts';
import type { PaginaNavegador } from './pagina.ts';

const nomeSegredo = z.string().regex(/^[A-Z0-9_]+$/);
const origemValor = z.union([
  z.object({ texto: z.string() }),
  z.object({ parametro: z.string() }),
  z.object({ segredo: nomeSegredo }),
]);

export const esquemaPasso = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('abrir'), url: z.string().url() }),
  z.object({ tipo: z.literal('preencher'), seletor: z.string(), valor: origemValor }),
  z.object({ tipo: z.literal('clicar'), seletor: z.string() }),
  z.object({ tipo: z.literal('esperar'), seletor: z.string().optional(), texto: z.string().optional() }),
  z.object({
    tipo: z.literal('codigo_email'),
    remetente: z.string().email(),
    padrao: z.string().default('\\b\\d{6}\\b'),
    seletor: z.string(),
  }),
  z.object({
    tipo: z.literal('capturar'),
    seletor: z.string(),
    /** Guarda direto na Dory com este nome (ex.: a chave de API gerada). */
    salvar_como_segredo: nomeSegredo.optional(),
    /** Ou devolve como dado (nunca use para coisa sensível). */
    dado: z.string().optional(),
  }),
  z.object({ tipo: z.literal('conferir'), texto: z.string() }),
]);

export const esquemaReceita = z.object({
  plataforma: z.string(),
  acao: z.string(),
  passos: z.array(esquemaPasso).min(1),
  /** Seletores extras a mascarar nas capturas. */
  sensiveis: z.array(z.string()).default([]),
});

export type Passo = z.infer<typeof esquemaPasso>;
export type Receita = z.infer<typeof esquemaReceita>;

export interface DepsReceita {
  gmail?: ClienteGmail;
  timeoutPassoMs?: number;
  esperar?: (ms: number) => Promise<void>;
  gmailIntervaloMs?: number;
  gmailLimiteMs?: number;
  /**
   * Navegador na nuvem com visualização ao vivo: link para o Breno e espera até ele resolver.
   * Sem isso (ex.: navegador local), CAPTCHA vira tarefa "aguardando_humano".
   */
  aoVivo?: { link: string; limiteMs: number; intervaloMs: number };
  /** Metadados para salvar segredos capturados na Dory. */
  metaSegredo?: { bitwardenProjeto: string; plataforma: string; destinos?: string[] };
  agora?: () => number;
}

function precisaHumano(codigo: string, mensagem: string): Resultado {
  return { ok: false, erro: { tipo: 'precisa_humano', codigo, mensagem } };
}

async function valorDe(o: z.infer<typeof origemValor>, params: Record<string, unknown>, ctx: ContextoExecucao): Promise<string> {
  if ('texto' in o) return o.texto;
  if ('segredo' in o) return ctx.obterSegredo(o.segredo);
  const v = params[o.parametro];
  if (typeof v !== 'string' || !v) throw new Error(`parâmetro "${o.parametro}" ausente`);
  return v;
}

/** CAPTCHA na tela: pede o Breno e, se houver navegador ao vivo, espera ele resolver. */
async function tratarCaptcha(p: PaginaNavegador, ctx: ContextoExecucao, d: DepsReceita, onde: string): Promise<Resultado | null> {
  if (!(await detectarCaptcha(p))) return null;
  await ctx.pedirHumano(`Verificação humana (CAPTCHA) em ${onde}`, d.aoVivo?.link);
  if (!d.aoVivo) return precisaHumano('CAPTCHA', `CAPTCHA em ${onde}: precisa do Breno`);
  const esperar = d.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const agora = d.agora ?? Date.now;
  const fim = agora() + d.aoVivo.limiteMs;
  while (agora() < fim) {
    await esperar(d.aoVivo.intervaloMs);
    if (!(await detectarCaptcha(p))) {
      await ctx.registrarAuditoria('captcha_resolvido_pelo_breno', { onde });
      return null;
    }
  }
  return precisaHumano('CAPTCHA_SEM_RESPOSTA', `CAPTCHA em ${onde} não foi resolvido a tempo (sessão guardada)`);
}

/** Executa a receita. Qualquer travamento vira pedido de ajuda, nunca tentativa de contornar. */
export async function executarReceita(
  p: PaginaNavegador,
  receita: Receita,
  params: Record<string, unknown>,
  ctx: ContextoExecucao,
  d: DepsReceita = {},
): Promise<Resultado> {
  const r = esquemaReceita.parse(receita);
  const t = d.timeoutPassoMs ?? 30_000;
  const dados: Record<string, string> = {};
  const segredosSalvos: string[] = [];
  const inicio = (d.agora ?? Date.now)();

  for (const [i, passo] of r.passos.entries()) {
    const onde = `${r.plataforma}/${r.acao} passo ${i + 1} (${passo.tipo})`;
    const antes = await tratarCaptcha(p, ctx, d, onde);
    if (antes) return antes;
    try {
      switch (passo.tipo) {
        case 'abrir':
          await p.abrir(passo.url, t);
          break;
        case 'preencher':
          await p.preencher(passo.seletor, await valorDe(passo.valor, params, ctx), t);
          break;
        case 'clicar':
          await p.clicar(passo.seletor, t);
          break;
        case 'esperar':
          if (passo.seletor) await p.esperarSeletor(passo.seletor, t);
          if (passo.texto) await p.esperarTexto(passo.texto, t);
          break;
        case 'conferir': {
          if (!(await p.html()).includes(passo.texto)) return precisaHumano('CONFERENCIA', `texto esperado não apareceu em ${onde}`);
          break;
        }
        case 'codigo_email': {
          if (!d.gmail) return precisaHumano('SEM_GMAIL', 'leitura do Gmail não configurada');
          const res = await aguardarCodigo(
            d.gmail,
            { remetente: passo.remetente, padrao: passo.padrao, desde: inicio },
            {
              intervaloMs: d.gmailIntervaloMs ?? 4_000,
              limiteMs: d.gmailLimiteMs ?? 5 * 60_000,
              esperar: d.esperar ?? ((ms) => new Promise((s) => setTimeout(s, ms))),
              agora: d.agora,
            },
          );
          if (!res.ok) {
            return precisaHumano(
              res.motivo === 'ambiguo' ? 'CODIGO_AMBIGUO' : 'CODIGO_NAO_CHEGOU',
              res.motivo === 'ambiguo' ? 'mais de um código no e-mail: não usado' : 'código não chegou no Gmail a tempo',
            );
          }
          await p.preencher(passo.seletor, res.codigo, t); // código usado e descartado
          break;
        }
        case 'capturar': {
          const valor = await p.lerTexto(passo.seletor, t);
          if (!valor) return precisaHumano('CAPTURA_VAZIA', `nada para capturar em ${onde}`);
          if (passo.salvar_como_segredo) {
            if (!d.metaSegredo) throw new Error('receita captura segredo, mas metaSegredo não foi informado');
            await ctx.salvarSegredo(passo.salvar_como_segredo, valor, { empresaId: ctx.empresaId, negocioId: ctx.negocioId, ...d.metaSegredo });
            segredosSalvos.push(passo.salvar_como_segredo);
          } else if (passo.dado) {
            dados[passo.dado] = valor;
          }
          break;
        }
      }
    } catch (e) {
      log('aviso', 'receita travou', { onde, erro: String((e as Error)?.message ?? e).slice(0, 300) });
      const depois = await tratarCaptcha(p, ctx, d, onde);
      if (depois) return depois;
      await ctx.pedirHumano(`A receita travou em ${onde}`, d.aoVivo?.link);
      return precisaHumano('TRAVAMENTO', `a receita travou em ${onde}`);
    }
  }
  const final = await tratarCaptcha(p, ctx, d, `${r.plataforma}/${r.acao} (fim)`);
  if (final) return final;
  return { ok: true, dados: { ...dados, segredos_criados: segredosSalvos }, mensagem: `receita ${r.plataforma}/${r.acao} concluída` };
}
