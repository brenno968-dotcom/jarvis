-- Revisão final da especificação: confirmação dupla (WhatsApp + painel) e eventos do Gmail.

-- Seção 22: ações de valor alto ou irreversíveis exigem confirmação também pelo painel com login.
alter table aprovacoes add column if not exists exige_painel boolean not null default false;
alter table aprovacoes add column if not exists confirmado_whatsapp_em timestamptz;
grant update (confirmado_whatsapp_em) on aprovacoes to jarvis_painel, jarvis_worker;

-- Seção 21: avisos do Gmail (Pub/Sub). Guarda só o momento e o historyId, nunca o conteúdo.
create table if not exists gmail_eventos (
  id bigint generated always as identity primary key,
  history_id text not null,
  recebido_em timestamptz not null default now()
);
alter table gmail_eventos enable row level security;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on gmail_eventos from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then revoke all on gmail_eventos from authenticated; end if;
end $$;
grant select, insert, delete on gmail_eventos to jarvis_painel;
grant select on gmail_eventos to jarvis_worker;
drop policy if exists jarvis_painel_tudo on gmail_eventos;
create policy jarvis_painel_tudo on gmail_eventos to jarvis_painel using (true) with check (true);
drop policy if exists jarvis_worker_tudo on gmail_eventos;
create policy jarvis_worker_tudo on gmail_eventos to jarvis_worker using (true) with check (true);

-- /api/saude (painel) lê o estado para o Pulso.
grant select on avisos, rotinas to jarvis_painel;
drop policy if exists jarvis_painel_tudo on avisos;
create policy jarvis_painel_tudo on avisos to jarvis_painel using (true) with check (true);

-- O worker lê as receitas aprovadas ao iniciar (já tinha select) e registra a renovação do watch em rotinas (já tinha).
