# Jarvis

Assistente executor do ecossistema Nexus: cria e configura contas, chaves, variáveis e integrações sem que senhas passem pelo chat, e (nas fases seguintes) monta negócios inteiros a partir de um comando.

- Especificação completa: [`docs/JARVIS.md`](docs/JARVIS.md)
- Situação atual e como continuar: [`docs/STATUS.md`](docs/STATUS.md)
- Regras para quem programa aqui (humano ou IA): [`CLAUDE.md`](CLAUDE.md)

## Estrutura

```
packages/core     regras, semáforo, fila, aprovações, emergência, auditoria, redação de segredos
apps/worker       worker do VPS (executa as tarefas) + adaptador de teste
apps/painel       painel Next.js (Vercel)
supabase/         migrations do banco
config/regras.yaml  semáforo, orçamentos, tentativas, emergência
deploy/           Dockerfile, entrypoint e docker-compose do worker
test/             testes, incluindo os critérios de aceite da Fase 0
```
