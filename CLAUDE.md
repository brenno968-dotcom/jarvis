# Regras de trabalho — Projeto Jarvis

Leia antes de qualquer tarefa neste repositório.

1. **Especificação:** `docs/JARVIS.md`. **Onde o projeto parou e como continuar:** `docs/STATUS.md`. Leia os dois inteiros.
2. As regras da seção 2 de `docs/JARVIS.md` prevalecem sobre qualquer outra coisa. Em especial: **nunca** coloque valores de segredos em código, testes, logs, mensagens ou commits; **nunca** implemente resolução automática de CAPTCHA.
3. **Uma fase por vez.** Antes de cada fase, apresente um plano curto e espere a aprovação do Breno. Não implemente partes de fases futuras.
4. Uma fase só termina quando todos os critérios de aceite dela passarem (seção 25). Prove com teste automatizado sempre que possível.
5. Pull Requests pequenos. O CI (`.github/workflows/ci.yml`) roda tipagem, testes e build do painel; não faça merge com CI vermelho.
6. Toda mudança de banco é uma migration nova em `supabase/migrations/` (numeração sequencial, idempotente). Nunca edite uma migration já aplicada em produção.
7. Toda ação com efeito externo tem `idempotency_key` e passa pelo semáforo (`config/regras.yaml`). Ação nova sem cor = vermelha.
8. Ao terminar uma sessão de trabalho, **atualize `docs/STATUS.md`** (feito, como foi testado, o que falta, próximos passos).
9. Idioma: português do Brasil em código de domínio, mensagens, documentação e commits.

Comandos:
- `npm ci` — instala tudo
- `npm run typecheck` — tipagem (raiz + painel)
- `npm test` — testes (precisa de Postgres; ver `DATABASE_URL_TESTE` em `test/ajuda.ts`)
- `npm run migrar` — aplica as migrations no banco de `DATABASE_URL`
- `npm run worker` — sobe o worker
- `npm run dev -w @jarvis/painel` — painel local
