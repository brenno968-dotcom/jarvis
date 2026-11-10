// Kit base (seção 10): o que já existe e pode ser reaproveitado por todo negócio novo.
import type { Consultavel } from './banco.ts';
import type { PlanoValidado } from './maestro/plano.ts';

export type RecursoKit = 'meta_business' | 'conta_anuncios' | 'hotmart' | 'dominio' | 'email' | 'whatsapp_numero';

export async function registrarRecursoKit(
  db: Consultavel,
  p: { empresaId: string; recurso: RecursoKit; identificador: string; contaId?: string },
): Promise<void> {
  await db.query(
    `insert into kit_base (empresa_id, recurso, identificador, conta_id) values ($1, $2, $3, $4)
     on conflict (empresa_id, recurso, identificador) do update set ativo = true`,
    [p.empresaId, p.recurso, p.identificador, p.contaId ?? null],
  );
}

export async function kitDaEmpresa(db: Consultavel, empresaId: string): Promise<Partial<Record<RecursoKit, string>>> {
  const r = await db.query<{ recurso: RecursoKit; identificador: string }>(
    `select recurso, identificador from kit_base where empresa_id = $1 and ativo order by criado_em`,
    [empresaId],
  );
  const kit: Partial<Record<RecursoKit, string>> = {};
  for (const l of r.rows) kit[l.recurso] ??= l.identificador;
  return kit;
}

/** Qual recurso do kit cobre uma etapa (acao + plataforma). */
export function recursoDaEtapa(acao: string, plataforma?: string): RecursoKit | null {
  if (acao === 'criar_conta' && plataforma === 'hotmart') return 'hotmart';
  if (acao === 'criar_conta' && (plataforma === 'meta' || plataforma === 'meta_business')) return 'meta_business';
  if (acao === 'criar_conta_anuncios') return 'conta_anuncios';
  if (acao === 'configurar_dominio') return 'dominio';
  if (acao === 'configurar_email') return 'email';
  if (acao === 'configurar_whatsapp') return 'whatsapp_numero';
  return null;
}

/**
 * Troca as etapas que o kit já cobre por "reaproveitar": a etapa sai do plano, quem dependia dela
 * deixa de esperar, e o plano registra o que foi reaproveitado (com o identificador).
 */
export function aplicarKitBase(v: PlanoValidado, kit: Partial<Record<RecursoKit, string>>): PlanoValidado & { reaproveitado: { etapa: string; recurso: RecursoKit; identificador: string }[] } {
  const reaproveitado: { etapa: string; recurso: RecursoKit; identificador: string }[] = [];
  const removidas = new Set<string>();
  for (const e of v.plano.etapas) {
    const r = recursoDaEtapa(e.acao, e.plataforma);
    if (r && kit[r]) {
      removidas.add(e.etapa_id);
      reaproveitado.push({ etapa: e.etapa_id, recurso: r, identificador: kit[r]! });
    }
  }
  const etapas = v.plano.etapas
    .filter((e) => !removidas.has(e.etapa_id))
    .map((e) => ({ ...e, depende_de: e.depende_de.filter((d) => !removidas.has(d)) })) as PlanoValidado['plano']['etapas'];
  const custo = Math.round(etapas.reduce((s, e) => s + e.custo_estimado_brl, 0) * 100) / 100;
  return { ...v, plano: { ...v.plano, etapas }, custo_estimado_brl: custo, reaproveitado };
}

/** Inventário de contas (seção 12.3). */
export async function registrarConta(
  db: Consultavel,
  c: { empresaId: string; negocioId?: string | null; plataforma: string; email?: string; idExterno?: string; plano?: string; renovacaoEm?: string },
): Promise<string> {
  const r = await db.query<{ id: string }>(
    `insert into contas (empresa_id, negocio_id, plataforma, email_usado, id_externo, plano, renovacao_em)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [c.empresaId, c.negocioId ?? null, c.plataforma, c.email ?? null, c.idExterno ?? null, c.plano ?? 'gratis', c.renovacaoEm ?? null],
  );
  return r.rows[0]!.id;
}
