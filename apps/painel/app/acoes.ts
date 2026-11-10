'use server';

import { randomUUID } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import {
  criarTarefa,
  emitirCodigo,
  pararTudo,
  responderAprovacaoPeloPainel,
  retomar,
  revisarRascunho,
  validarPedidoAutorizacao,
} from '@jarvis/core';
import { exigirSessao } from '../lib/auth';
import { emailAutorizado, modoLogin } from '../lib/modo';
import { COOKIE, senhaConfere, valorDaSessao } from '../lib/sessao';
import { clienteSupabaseServidor } from '../lib/supabase';
import { obterBanco, obterRegras } from '../lib/servidor';

/** Só caminhos internos (evita redirecionar para site de fora). */
function destinoSeguro(v: string): string {
  return v.startsWith('/') && !v.startsWith('//') ? v : '/';
}

export async function entrar(form: FormData): Promise<void> {
  if (modoLogin() === 'supabase') {
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    // Só manda o link para e-mail autorizado; a resposta é a mesma nos dois casos (não revela quem é autorizado).
    if (emailAutorizado(email)) {
      const sb = await clienteSupabaseServidor();
      const origem = (await headers()).get('origin') ?? '';
      const voltar = encodeURIComponent(destinoSeguro(String(form.get('voltar') ?? '')));
      await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: `${origem}/auth/callback?voltar=${voltar}` } });
    }
    redirect('/entrar?enviado=1');
  }
  const senha = String(form.get('senha') ?? '');
  if (!(await senhaConfere(senha))) redirect('/entrar?erro=1');
  const valor = await valorDaSessao();
  const c = await cookies();
  c.set(COOKIE, valor!, { httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 12 });
  redirect(destinoSeguro(String(form.get('voltar') ?? '')));
}

export async function sair(): Promise<void> {
  if (modoLogin() === 'supabase') {
    await (await clienteSupabaseServidor()).auth.signOut();
  } else {
    (await cookies()).delete(COOKIE);
  }
  redirect('/entrar');
}

export async function criarTarefaTeste(form: FormData): Promise<void> {
  const quem = await exigirSessao();
  const banco = obterBanco();
  await banco.query(
    `insert into empresas (nome) select 'Jarvis (testes)'
      where not exists (select 1 from empresas where nome = 'Jarvis (testes)')`,
  );
  const empresa = await banco.query<{ id: string }>(
    `select id from empresas where nome = 'Jarvis (testes)' order by criado_em limit 1`,
  );
  const texto = String(form.get('texto') ?? '').slice(0, 200);
  const empresaId = empresa.rows[0]!.id;
  await criarTarefa(
    banco,
    obterRegras(),
    {
      empresaId,
      agente: 'jarvis_infra',
      acao: 'teste_eco',
      plataforma: 'teste',
      parametros: { texto },
      idempotencyKey: `painel:teste_eco:${randomUUID()}`,
    },
    `painel:${quem}`,
  );
  revalidatePath('/');
}

export async function acionarParaTudo(): Promise<void> {
  const quem = await exigirSessao();
  await pararTudo(obterBanco(), `painel:${quem}`);
  revalidatePath('/');
}

export async function acionarRetomar(): Promise<void> {
  const quem = await exigirSessao();
  await retomar(obterBanco(), `painel:${quem}`);
  revalidatePath('/');
}

export async function responder(form: FormData): Promise<void> {
  const quem = await exigirSessao();
  const id = String(form.get('id') ?? '');
  const resposta = form.get('resposta') === 'aprovar' ? 'aprovar' : 'recusar';
  await responderAprovacaoPeloPainel(obterBanco(), id, resposta, quem);
  revalidatePath('/');
}

export async function revisar(form: FormData): Promise<void> {
  const quem = await exigirSessao();
  const id = String(form.get('id') ?? '');
  const decisao = form.get('decisao') === 'aprovar' ? 'aprovar' : 'recusar';
  await revisarRascunho(obterBanco(), id, decisao, quem);
  revalidatePath('/');
}

/** "Autorizar" do OAuth do conector MCP: gera o código e volta para o Claude. */
export async function autorizarOAuth(form: FormData): Promise<void> {
  const quem = await exigirSessao();
  const g = (k: string) => String(form.get(k) ?? '');
  const banco = obterBanco();
  const erro = await validarPedidoAutorizacao(banco, {
    clientId: g('client_id'),
    redirectUri: g('redirect_uri'),
    codeChallenge: g('code_challenge'),
    metodo: 'S256',
    responseType: 'code',
  });
  if (erro) redirect('/');
  const volta = new URL(g('redirect_uri'));
  if (g('state')) volta.searchParams.set('state', g('state'));
  if (form.get('decisao') !== 'autorizar') {
    volta.searchParams.set('error', 'access_denied');
    redirect(volta.toString());
  }
  const codigo = await emitirCodigo(banco, { clientId: g('client_id'), redirectUri: g('redirect_uri'), codeChallenge: g('code_challenge'), usuario: quem });
  volta.searchParams.set('code', codigo);
  redirect(volta.toString());
}
