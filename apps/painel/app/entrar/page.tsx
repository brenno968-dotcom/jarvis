import { modoLogin } from '../../lib/modo';
import { entrar } from '../acoes';

export const dynamic = 'force-dynamic';

export default async function Entrar({ searchParams }: { searchParams: Promise<{ erro?: string; enviado?: string; voltar?: string }> }) {
  const { erro, enviado, voltar } = await searchParams;
  const supabase = modoLogin() === 'supabase';
  return (
    <main style={{ maxWidth: 460 }}>
      <h1>Jarvis</h1>
      <h2>Entrar</h2>
      {enviado ? (
        <p className="cartao">Se o e-mail for autorizado, o link de acesso chega em instantes.</p>
      ) : (
        <form action={entrar} className="cartao linha">
          <input type="hidden" name="voltar" value={voltar ?? '/'} />
          {supabase ? (
            <input type="email" name="email" placeholder="seu e-mail" required autoFocus style={{ flex: 1 }} />
          ) : (
            <input type="password" name="senha" placeholder="senha do painel" required autoFocus style={{ flex: 1 }} />
          )}
          <button type="submit">{supabase ? 'Receber link' : 'Entrar'}</button>
        </form>
      )}
      {erro && <p style={{ color: 'var(--vermelho)' }}>Senha incorreta ou painel não configurado.</p>}
      {!supabase && <p className="vazio">Modo de desenvolvimento (senha). Em produção, use o login por e-mail.</p>}
    </main>
  );
}
