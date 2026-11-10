import { validarPedidoAutorizacao } from '@jarvis/core';
import { obterBanco } from '../../../lib/servidor';
import { autorizarOAuth } from '../../acoes';

export const dynamic = 'force-dynamic';

type Parametros = Record<string, string | undefined>;

export default async function Autorizar({ searchParams }: { searchParams: Promise<Parametros> }) {
  const p = await searchParams;
  const erro = await validarPedidoAutorizacao(obterBanco(), {
    clientId: p.client_id ?? '',
    redirectUri: p.redirect_uri ?? '',
    codeChallenge: p.code_challenge ?? '',
    metodo: p.code_challenge_method ?? '',
    responseType: p.response_type ?? '',
  });
  return (
    <main style={{ maxWidth: 520 }}>
      <h1>Jarvis</h1>
      <h2>Autorizar conector</h2>
      {erro ? (
        <p className="cartao" style={{ color: 'var(--vermelho)' }}>Pedido inválido: {erro}.</p>
      ) : (
        <form action={autorizarOAuth} className="cartao">
          <p>
            O <strong>Claude</strong> quer usar o Jarvis em seu nome: ver o estado, listar e consultar tarefas, criar tarefas e propor planos.
            Ações vermelhas continuam precisando do seu OK, e nenhum segredo é mostrado.
          </p>
          {['client_id', 'redirect_uri', 'code_challenge', 'state'].map((k) => (
            <input key={k} type="hidden" name={k} value={p[k] ?? ''} />
          ))}
          <div className="linha">
            <button type="submit" name="decisao" value="autorizar">
              Autorizar
            </button>
            <button type="submit" name="decisao" value="negar" className="perigo">
              Negar
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
