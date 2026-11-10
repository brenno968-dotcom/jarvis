// O que o Pulso monitora no Jarvis (seção 27). Só números e estados, nada sensível.
import type { Consultavel } from './banco.ts';

export interface SaudeJarvis {
  ok: boolean;
  problemas: string[];
  emergencia: boolean;
  workers: { id: string; estado: string; segundos_sem_sinal: number }[];
  fila: Record<string, number>;
  tarefas_presas: number;
  espera_media_segundos: number | null;
  chaves: { plataforma: string; ok: boolean | null; ultimo_teste: string | null }[];
  aprovacoes_pendentes_mais_1h: number;
  avisos_falhando: number;
  gmail_ultimo_aviso: string | null;
  rotinas: { nome: string; ultima_execucao: string | null }[];
}

export async function saudeDoJarvis(db: Consultavel): Promise<SaudeJarvis> {
  const [em, workers, fila, presas, espera, chaves, aprov, avisos, gmail, rotinas] = await Promise.all([
    db.query<{ parado: boolean }>(`select coalesce((valor->>'parado')::boolean, false) as parado from controle where chave = 'emergencia'`),
    db.query<{ id: string; estado: string; s: number }>(
      `select id, estado, extract(epoch from now() - ultimo_sinal)::int as s from workers order by ultimo_sinal desc limit 10`,
    ),
    db.query<{ status: string; n: number }>(`select status, count(*)::int as n from tarefas group by status`),
    db.query<{ n: number }>(`select count(*)::int as n from tarefas where status = 'executando' and travada_ate < now()`),
    db.query<{ s: number | null }>(
      `select extract(epoch from avg(now() - criado_em))::int as s from tarefas where status = 'pendente' and coalesce(proxima_tentativa_em, now()) <= now()`,
    ),
    db.query<{ plataforma: string; ok: boolean | null; t: Date | null }>(
      `select plataforma, bool_and(ultimo_teste_ok) as ok, max(ultimo_teste_em) as t from segredos_ref group by plataforma order by plataforma`,
    ),
    db.query<{ n: number }>(`select count(*)::int as n from aprovacoes where status = 'pendente' and criado_em < now() - interval '1 hour'`),
    db.query<{ n: number }>(`select count(*)::int as n from avisos where status = 'falhou' and criado_em > now() - interval '24 hours'`),
    db.query<{ t: Date | null }>(`select max(recebido_em) as t from gmail_eventos`),
    db.query<{ nome: string; t: Date | null }>(`select nome, ultima_execucao as t from rotinas order by nome`),
  ]);

  const problemas: string[] = [];
  const emergencia = Boolean(em.rows[0]?.parado);
  if (emergencia) problemas.push('emergência ligada');
  const w = workers.rows.map((x) => ({ id: x.id, estado: x.estado, segundos_sem_sinal: x.s }));
  if (!w.length) problemas.push('nenhum worker deu sinal');
  else if (w.every((x) => x.segundos_sem_sinal > 600)) problemas.push('nenhum worker com sinal nos últimos 10 minutos');
  if (presas.rows[0]!.n) problemas.push(`${presas.rows[0]!.n} tarefa(s) presa(s)`);
  const chavesRuins = chaves.rows.filter((c) => c.ok === false).map((c) => c.plataforma);
  if (chavesRuins.length) problemas.push(`chave com falha: ${chavesRuins.join(', ')}`);
  if (aprov.rows[0]!.n) problemas.push(`${aprov.rows[0]!.n} aprovação(ões) esperando há mais de 1 h`);
  if (avisos.rows[0]!.n) problemas.push(`${avisos.rows[0]!.n} aviso(s) ao Breno não entregues nas últimas 24 h`);

  return {
    ok: problemas.length === 0,
    problemas,
    emergencia,
    workers: w,
    fila: Object.fromEntries(fila.rows.map((r) => [r.status, r.n])),
    tarefas_presas: presas.rows[0]!.n,
    espera_media_segundos: espera.rows[0]?.s ?? null,
    chaves: chaves.rows.map((c) => ({ plataforma: c.plataforma, ok: c.ok, ultimo_teste: c.t?.toISOString() ?? null })),
    aprovacoes_pendentes_mais_1h: aprov.rows[0]!.n,
    avisos_falhando: avisos.rows[0]!.n,
    gmail_ultimo_aviso: gmail.rows[0]?.t?.toISOString() ?? null,
    rotinas: rotinas.rows.map((r) => ({ nome: r.nome, ultima_execucao: r.t?.toISOString() ?? null })),
  };
}
