# Jarvis — Relatório de passagem (STATUS)

> Atualizado em 10/11/2026, ao fim da sessão feita na conversa do claude.ai (Projeto NEXUS).
> Quem continuar: leia `CLAUDE.md`, `docs/JARVIS.md` e este arquivo inteiro antes de mexer em qualquer coisa.

## 000. Atualização de 10/11/2026 (quarta sessão): programação concluída

**Situação:** toda a parte de programação que dá para fazer sem as plataformas reais está feita. **109 testes passando**, lint e tipagem limpos, painel compilando, worker subindo de verdade com todas as rotinas. O que sobra é configuração (do Breno), integração e validação no real (próxima IA), e a Fase 8 (receitas em telas reais).

### O que entrou nesta sessão
1. **Rotinas do worker ligadas** (`apps/worker/src/agendadas.ts`, tabela `rotinas`, só um worker por janela): vigia de orçamento (1 h), otimização de campanhas (6 h), leitura das métricas da Meta (diária, usa a conta de anúncios do kit), reposição de estoque (diária, negócios físicos ativos), lembrete de renovação de contas (diário) e **relatório diário no WhatsApp** (seções 12.7 e 27). O teste diário das chaves continua.
2. **Kit base** (`packages/core/src/kit.ts`, tabela `kit_base`): cadastro do que já existe (Meta, conta de anúncios, Hotmart, domínio, e-mail, números). O plano proposto pelo Claude (`jarvis_propor_plano`) tira as etapas que o kit cobre e registra o que foi reaproveitado.
3. **Inventário de contas**: conta criada por receita entra em `contas` (com e-mail e plano), e a rotina avisa antes da renovação.
4. **OAuth 2.1 do conector MCP** (para o claude.ai): metadados em `/.well-known/oauth-authorization-server` e `/.well-known/oauth-protected-resource`, registro dinâmico (`/api/oauth/registrar`, só redirect do Claude ou localhost), autorização com o login do Breno (`/oauth/autorizar`), token com PKCE S256 e renovação com rotação (`/api/oauth/token`). O `/api/mcp` aceita o token fixo (Claude Code) ou o OAuth. **"PARA TUDO" revoga os tokens do conector.**
5. **Confirmação dupla** (seção 22): ações em `aprovacao.confirmacao_dupla` do `regras.yaml` (apagar, alterar banco de produção, revogar chave, comprar estoque, aumentar orçamento) ou com `valor_brl` acima do teto por compra precisam do "Aprovar" no WhatsApp **e** da confirmação no painel. Recusar em qualquer um basta.
6. **Saúde para o Pulso** (`/api/saude`, Bearer `JARVIS_CORE_PULSO_TOKEN`): workers, fila, tarefas presas, chaves, aprovações com mais de 1 h, avisos não entregues, último aviso do Gmail, rotinas.
7. **Navegador na nuvem** (`navegador/browserbase.ts`): sessão com `solveCaptchas: false`, link ao vivo e liberação no fim (testado com Chromium local via CDP; ⚠️ conferir a API real).
8. **Aviso instantâneo do Gmail**: renovação diária do `users.watch` e rota `/api/gmail/push?token=…` (guarda só historyId e hora).
9. **Worker completo** (`main.ts`): registra Vercel, Supabase, Meta, oferta (com chave da IA), adaptadores por receita (com Browserbase) e Gmail, tudo opcional conforme a configuração, avisando no log o que ficou desligado.
10. **Painel**: tela `/negocios` (plano, etapas, vendas, receitas, custos, resultado, anúncios do mês, opt-ins, estoque baixo); aviso de confirmação dupla nas aprovações; volta para a página certa depois do login.
11. `.env.exemplo` com **todos os nomes** de variáveis (sem valores).

### Revisão da especificação: o que NÃO é programável daqui (fica para a integração)
- Revogar os tokens das plataformas (Vercel, Supabase, GitHub) no "PARA TUDO": cada uma tem um jeito (ou nenhum) por API; decidir por plataforma.
- Gerar a chave nova na rotação: depende da plataforma (API ou receita). A reaplicação e o teste já existem.
- Passo 1 do robô verificador (seção 28.6): workflow no repositório do **Nexus**, não neste.
- Publicar produto (Hotmart) e criar campanha (Meta): ações vermelhas que só fazem sentido com as contas reais.
- Fornecedores, frete, marketplaces e nota fiscal: adaptadores das plataformas escolhidas.
- Fase 8: gravar as receitas de criação do zero nas telas reais.

### Ordem sugerida para a próxima IA
1. Subir o pacote, conferir o CI (instala o Chromium) e rodar `npm test`.
2. Ligar a Fase 0 no real (seção 8 deste arquivo) e configurar as variáveis do `.env.exemplo` aos poucos.
3. Validar no real, em paralelo: Vercel, Supabase, Bitwarden, OAuth no claude.ai, Browserbase, Gmail, Meta (só ler/pausar), Asaas/Hotmart (webhooks).
4. Lado do Nexus (`docs/INTEGRACAO-NEXUS.md`).
5. Integrações das Fases 4 a 8.

## 00. Atualização de 10/11/2026 (terceira sessão): parte de programação das Fases 4 a 7

**Situação:** Fases 0 a 3 como descrito na seção 0, mais a **lógica das Fases 4 a 7**. **94 testes passando**, lint e tipagem limpos, painel compilando (rotas novas testadas com o painel rodando). Fase 8 não começada (é quase só receita de navegador em tela real). **Nada das Fases 4 a 7 foi validado nas plataformas reais.**

| Fase | O que foi feito (programação) | Falta (integração/validação) |
|---|---|---|
| 4 Oferta | Agente de oferta (adaptador `oferta`: `produzir_produto`, `produzir_pagina_venda`, `produzir_anuncios`, todos verdes); rascunhos com versão; filtro de promessas proibidas (bloqueio/aviso, entende acentos); revisão do Breno no painel (rascunho com bloqueio não pode ser aprovado); garantia mínima de 7 dias exigida; gerador de HTML da página de venda (escapado, só links https) | Geração de imagem/vídeo; `publicar_produto` (vermelho) na Hotmart usando o rascunho aprovado; chave da IA (ou o Claude via MCP) |
| 5 Tráfego | Métricas derivadas (CTR, CPC, CPL, CPA, ROAS); regras de decisão (esperar/manter/pausar/sugerir aumento — aumento nunca automático); vigia de orçamento (aviso único aos 80% no mês, pausa ao estourar); otimizador; adaptador Meta **só ler métricas e pausar** | Criar campanha/anúncio (vermelho); aprovação do app na Meta; conferir versão da Graph API e nomes das ações (`purchase`, `lead`…); agendar leitura diária |
| 6 Vendas | Opt-in com prova (texto aceito + origem), descadastro imediato, `podeContatar`; normalizadores de pagamento Asaas e Hotmart; venda idempotente + aviso "venda feita" + resultado do negócio; estorno; rota `/api/pagamentos/<origem>/<negocio>` com token | Lado do Nexus (seção 3 de `docs/INTEGRACAO-NEXUS.md`); conferir eventos/cabeçalhos reais do Asaas e da Hotmart; BTG |
| 7 Físico | Estoque com histórico; pedido que baixa tudo-ou-nada (sem estoque negativo, sem duplicar); devolução que repõe; margem real; quanto repor; reposição gera `comprar_estoque` vermelho com custo estimado; comparação de fretes | Melhor Envio/Correios, marketplaces, emissor de nota fiscal, fornecedores; agendar a verificação de reposição |

**Arquivos novos:** `packages/core/src/{oferta,trafego,vendas,fisico}/**`, `apps/worker/src/adaptadores/{oferta,meta-ads}.ts`, rota `apps/painel/app/api/pagamentos/[origem]/[negocio]`, revisão de rascunhos no painel, migration `0006`, testes `test/fases4a7.test.ts`.

**Ações novas no semáforo (verde):** `produzir_produto`, `produzir_pagina_venda`, `produzir_anuncios`, `ler_metricas_campanha`, `pausar_campanha` (pausar protege o dinheiro), `cotar_fretes`. Continuam vermelhas: `publicar_produto`, `publicar_campanha`, `aumentar_orcamento`, `comprar_estoque`, `primeiro_contato_cliente`.

**Ainda não ligados no loop do worker** (as funções existem e estão testadas; falta decidir a frequência): `vigiarOrcamentos`, `otimizarCampanhas`, `verificarReposicao`, leitura diária das métricas da Meta.

## 0. Atualização de 10/11/2026 (segunda sessão): Fases 0 a 3 programadas offline

**Situação geral:** Fase 0 completa (incluindo as pendências), Fase 1 programada, Fase 2 programada sem o navegador na nuvem, núcleo da Fase 3 (Maestro) programado. **76 testes passando** (Postgres 16 real, Chromium real contra site local, APIs externas simuladas), lint e tipagem limpos, painel compilando. **Nada foi validado nas plataformas reais.** Fases 4 a 8 não foram começadas: dependem quase só de plataformas reais.

| Fase | O que foi feito | Validado em | Falta no real |
|---|---|---|---|
| 0 | Base + login Supabase Auth + aprovação/“PARA TUDO” pelo WhatsApp (lado Jarvis) + ESLint | Postgres real; painel e worker rodando juntos | Supabase/Vercel/VPS/Dory; lado do Nexus (`docs/INTEGRACAO-NEXUS.md`) |
| 1 | Vercel, Supabase, Dory (Bitwarden), reaplicação de segredo, teste diário das chaves, conector MCP | APIs simuladas | Endpoints num projeto de teste; SDK Bitwarden; OAuth do MCP no claude.ai; revogação de tokens |
| 2 | Motor de receitas, detector de CAPTCHA (só detecta), travamento → pedido de ajuda, Gmail (consulta, extração, cliente HTTP), adaptador por receita, máscara nas capturas | Chromium real + site local; Gmail simulado | Navegador na nuvem com link ao vivo; OAuth do Gmail; receitas reais; robô verificador do Nexus |
| 3 | Modelos de negócio (6 roteiros), plano validado (semáforo, ciclo, orçamento, empate, checagens), orquestrador (etapas em ordem, vermelha com OK próprio, travar/concluir), cérebro Anthropic, ferramenta MCP `jarvis_propor_plano` | Postgres real; IA simulada | Chave da Anthropic; testar com planos reais |

### Novidades por arquivo
- **Fase 0:** `eslint.config.js`; `apps/painel/lib/{modo,auth,supabase}.ts`, `middleware.ts`, `app/auth/callback`; `packages/core/src/{assinatura,avisos,whatsapp}.ts`; rota `app/api/aprovacoes/whatsapp`; migration `0003`; `docs/INTEGRACAO-NEXUS.md`.
- **Fase 1:** `packages/core/src/{http,cofre,segredos-ref,mcp}.ts`; `apps/worker/src/adaptadores/{comum,vercel,supabase}.ts`; `apps/worker/src/chaves.ts`; rota `app/api/mcp`.
- **Fase 2:** `apps/worker/src/navegador/{pagina,captcha,gmail,receitas,adaptador-receitas}.ts`; migration `0004`; CI instala o Chromium.
- **Fase 3:** `packages/core/src/maestro/{modelos,plano,orquestrador,cerebro}.ts`; migration `0005`; worker com `maestro: true`.

### Decisões tomadas nesta sessão (revisar com o Breno)
1. **Token de aprovação derivado** (HMAC do id com `JARVIS_CORE_APROVACAO_SEGREDO`): nunca é guardado; o worker recalcula para enviar.
2. **Ações novas no semáforo:** `aplicar_variavel_producao` e `reaplicar_segredo` (amarelo); `consultar_estado` (verde).
3. **Aprovar o plano NÃO aprova as etapas vermelhas**: cada etapa vermelha pede o próprio OK (fiel à seção 18). Se o Breno quiser que o OK do plano já valha para as etapas listadas, é uma mudança de regra a decidir.
4. **CAPTCHA não conta como falha de receita** (só travamentos de verdade contam para as 3 falhas seguidas).
5. **Conector MCP:** só leitura, criar tarefa e propor plano. Não aprova nada e não mexe na emergência. Recusa parâmetros com cara de segredo.
6. **O próprio Claude pode ser o “cérebro”** do Maestro pela ferramenta `jarvis_propor_plano` (dispensa chave da Anthropic no servidor); o `criarCerebroAnthropic` existe para quando o Jarvis planejar sozinho.

### Limitações conhecidas novas
- Etapas cujo agente ainda não existe (oferta, tráfego, fornecedores, logística, fiscal, e as ações `configurar_dominio`, `configurar_whatsapp` etc.) **vão falhar com SEM_ADAPTADOR** e travar o plano até as fases 4 a 7 criarem esses adaptadores. Isso é esperado.
- A retomada de uma receita depois de o Breno resolver o CAPTCHA só funciona com navegador na nuvem (sessão viva). Com navegador local, a tarefa fica em `aguardando_humano`.
- `npm audit` não foi revisado; rodar antes de publicar.

## 1. Resumo em uma frase

**Toda a programação possível sem as plataformas reais está feita (Fases 0 a 7 + rotinas, kit base, OAuth, saúde)** — ver seções 000, 00 e 0. **Falta ligar nos serviços reais** (Supabase, Vercel, VPS, Dory, navegador na nuvem, Gmail) e validar os critérios de aceite lá, começando pela Fase 0. As seções 3 a 5 abaixo descrevem a primeira sessão (Fase 0).

## 2. Onde e como foi feito

- Feito numa conversa do claude.ai, num computador temporário (Ubuntu 24.04, Node 22, Postgres 16 instalado localmente só para os testes).
- Sem acesso a GitHub, Supabase, Vercel, VPS, Bitwarden ou qualquer conta do Breno. **Nenhum segredo real foi usado ou visto.**
- Fonte de verdade seguida: `docs/JARVIS.md` (especificação unificada, Partes 1 e 2).
- O código foi entregue ao Breno num `.zip` para ser colocado no repositório `brenno968-dotcom/jarvis`.

## 3. A divisão em 15 partes (Fase 0) e a situação de cada uma

Feitas em sequência nesta sessão (a conversa do claude.ai não tem subagentes). Servem também como divisão de trabalho para revisões e ajustes em paralelo no Claude Code.

| # | Parte | Arquivos principais | Situação |
|---|---|---|---|
| 1 | Estrutura do monorepo (npm workspaces, TS estrito) | `package.json`, `tsconfig*.json`, `vitest.config.ts`, `.gitignore`, `.env.exemplo` | ✅ feito |
| 2 | Banco: migrations (tabelas, RLS, auditoria imutável, papéis) | `supabase/migrations/0001_fundacao.sql`, `0002_papel_painel.sql` | ✅ feito e testado local; ⏳ aplicar no Supabase |
| 3 | Contratos (Plano, Tarefa, Resultado, erros) | `packages/core/src/tipos.ts`, `adaptador.ts` | ✅ feito |
| 4 | Regras (YAML + Zod + semáforo + espera exponencial) | `config/regras.yaml`, `packages/core/src/regras.ts` | ✅ feito e testado |
| 5 | Redação de segredos + log JSON | `redacao.ts`, `log.ts` | ✅ feito e testado |
| 6 | Provedor de segredos (ambiente via `bws run` / memória p/ testes) | `segredos.ts` | ✅ feito; ⏳ testar com `bws run` real |
| 7 | Fila (pegar sem duplicar, heartbeat, travas vencidas, concluir, falha/espera) | `fila.ts`, `banco.ts` | ✅ feito e testado |
| 8 | Aprovações (token de uso único com hash, número autorizado, expiração, painel) | `aprovacoes.ts` | ✅ feito e testado; ⏳ envio pelo WhatsApp (ver 7.3) |
| 9 | Emergência ("PARA TUDO" / retomar) | `emergencia.ts` | ✅ feito e testado; ⏳ revogação de tokens (Fase 1) |
| 10 | Auditoria (só inclusão, sempre redigida) | `auditoria.ts` + gatilhos na migration | ✅ feito e testado |
| 11 | Executor + idempotência (`efeitos`) + adaptador de teste | `apps/worker/src/executor.ts`, `adaptadores/teste.ts`, `efeitos.ts` | ✅ feito e testado |
| 12 | Worker (loop, suspensão, SIGTERM, batimento em `workers`) | `apps/worker/src/worker.ts`, `main.ts`, `workers.ts` | ✅ feito e testado (inclusive rodando de verdade) |
| 13 | Painel Next.js 15 (tarefas, workers, emergência, aprovações, tarefa de teste) | `apps/painel/**` | ✅ compila e foi testado com o worker real; ⚠️ login provisório (ver 7.1) |
| 14 | Deploy: Dockerfile, entrypoint com `bws run`, compose, CI | `deploy/**`, `.github/workflows/ci.yml` | ✅ escrito; ⏳ não testado (sem Docker/GitHub aqui) |
| 15 | Testes de aceite + documentação | `test/**`, `CLAUDE.md`, `README.md`, `docs/**` | ✅ feito |

## 4. Critérios de aceite da Fase 0 (seção 25)

| Critério | Situação | Como foi provado |
|---|---|---|
| Repositório próprio; projeto Vercel e Supabase próprios | ⏳ falta | Repositório existe; Vercel e Supabase precisam ser criados pelo Breno |
| Tabelas da seção 17 criadas com RLS ativo | ✅ local / ⏳ Supabase | Migration roda 2× sem erro; teste "API pública não lê nem escreve nada" |
| Worker em container, limite de memória, sem privilégios, sem porta | ⏳ falta | Dockerfile/compose prontos (usuário 1001, `read_only`, 768 MB, sem `ports`); não buildado aqui |
| Tarefa criada pelo painel é executada e o resultado aparece no painel | ✅ local | Teste automatizado + teste manual: painel real (`next start`) + worker real (`tsx main.ts`) |
| Worker cai no meio → volta para a fila e termina sem duplicar | ✅ | Teste "worker cai no meio…" (efeito externo contado 1 vez) |
| Regras validadas; com CAPTCHA automático `true` o worker recusa subir | ✅ | Teste roda o `main.ts` de verdade e confere saída 1 |
| Valor de segredo de teste não aparece em nenhum log | ✅ | Teste procura o valor em logs, `tarefas`, `auditoria`, `efeitos` |
| "PARA TUDO" suspende o worker e cancela as tarefas | ✅ (sem revogar tokens) | Teste de emergência; revogação de tokens entra na Fase 1 |

## 5. O que existe hoje, em linguagem simples

- **Fila de tarefas no banco**: quem pede grava uma tarefa; o worker pega uma por vez, sem que dois workers peguem a mesma; se o worker cair, a tarefa volta sozinha depois de 5 minutos.
- **Semáforo**: a cor vem sempre do `config/regras.yaml`; ação desconhecida é vermelha; vermelha nasce esperando aprovação e só roda depois do "Aprovar".
- **Aprovação**: token de uso único (só o hash fica no banco), só vale do número autorizado, expira em 60 min; também pode ser respondida pelo painel.
- **Emergência**: "PARA TUDO" (pelo painel; WhatsApp depois) cancela tudo em aberto e deixa os workers parados até "Retomar".
- **Segredos**: lidos do ambiente (o `bws run` da Dory injeta); qualquer valor lido é trocado por `[segredo:NOME]` em log, banco e auditoria.
- **Auditoria**: tudo que acontece fica registrado; o banco recusa alterar ou apagar.
- **Painel**: mostra emergência, aprovações pendentes, workers, últimas 50 tarefas e cria tarefa de teste.

## 6. Decisões que tomei (não estavam explícitas na especificação)

1. **Tabelas a mais**: `controle` (estado da emergência), `efeitos` (resultado por `idempotency_key`, usado pela idempotência da seção 19), `workers` (batimento lido pelo Pulso). Coluna `lembrete_enviado_em` em `aprovacoes`; `check` dos status em `tarefas`; formato do nome em `segredos_ref`.
2. **Nível do semáforo calculado no servidor** a partir das regras; quem pede não escolhe a cor.
3. **Ação vermelha exige `resumo`** (texto simples para a aprovação); sem ele, a criação é recusada.
4. **Status `aprovada` também é pegável** pela fila (transição da seção 15.2).
5. **Trava vencida com tentativas esgotadas → `falhou`**, em vez de voltar para a fila para sempre.
6. **Aprovação vencida → tarefa `recusada`** (rotina do worker).
7. **Ações de teste** (`teste_eco`, `teste_usar_segredo`, `teste_efeito`, `teste_vermelho`) adicionadas ao `regras.yaml` e um adaptador `teste` que não fala com nada real.
8. **Papéis do banco**: `jarvis_worker` e `jarvis_painel` (permissão mínima, com política RLS própria). `anon`/`authenticated` sem nenhum acesso.
9. **Worker roda TypeScript com `tsx`** também em produção (sem etapa de build). Pode trocar por build com `tsc` depois, se preferir.
10. **Versões**: Node 22, TypeScript 5, Zod 3, Next 15, React 19, pg 8, Vitest 2 (todas maduras).

## 7. Pendências e limitações conhecidas (importante)

1. **Login do painel é PROVISÓRIO**: senha única (`JARVIS_PAINEL_SENHA`) + cookie assinado (`JARVIS_PAINEL_SEGREDO_COOKIE`, mín. 32 caracteres). Falha fechado (sem as variáveis ninguém entra). **Antes de usar com dados reais, trocar pelo login do Breno via Supabase Auth** (seção 17: "o painel acessa só com o login do Breno").
2. **"PARA TUDO" ainda não revoga tokens** (Jarvis, Carteiro, Marcapasso): depende dos adaptadores da Fase 1.
3. **Aprovação pelo WhatsApp**: o token e a validação estão prontos (`criarAprovacao`, `responderAprovacao`), mas **o envio da mensagem com botões e o recebimento da resposta** dependem do número do Nexus que fala com o Breno. Falta: endpoint/webhook que receba o clique e chame `responderAprovacao`, e o envio do resumo + botões. Também falta o lembrete (`lembrete_apos_minutos`).
4. **Idempotência tem uma janela**: se o worker cair *depois* do efeito externo e *antes* de gravar em `efeitos`, a ação pode repetir. Cada adaptador real deve usar também a idempotência nativa da plataforma (ou consultar antes de criar).
5. **Docker não foi buildado** aqui. Conferir `deploy/worker.Dockerfile` e a URL/versão do `bws` (build arg `BWS_URL`, release com mais de 14 dias).
6. **Lint não configurado** (a especificação pede tipagem, lint e testes no CI). Adicionar ESLint no próximo PR.
7. **Painel na Vercel**: o `config/regras.yaml` é incluído via `outputFileTracingIncludes`; conferir no primeiro deploy (se não achar, definir `JARVIS_REGRAS`).
8. **`salvarSegredo` e `pedirHumano`** do contexto são esqueletos: o primeiro lança "Fase 1"; o segundo só registra na auditoria (link ao vivo é Fase 2).

## 8. Como continuar (passo a passo para quem pegar daqui)

### 8.1 Colocar no GitHub
1. Descompactar o `.zip` e enviar tudo para `brenno968-dotcom/jarvis` (branch nova + PR). **Não enviar** `node_modules/` nem `.next/` (o `.gitignore` já ignora).
2. Conferir que o CI ficou verde no PR (tipagem + 29 testes + build do painel). Se algo falhar só no GitHub, corrigir antes do merge.
3. Adicionar ESLint (pendência 7.6) num PR separado.

### 8.2 Supabase (projeto próprio do Jarvis, região São Paulo)
1. Criar o projeto `jarvis`.
2. Aplicar as migrations em ordem (`npm run migrar` com `DATABASE_URL` apontando para o banco, ou colar os SQL no editor).
3. Criar dois usuários de login, cada um herdando só o papel dele:
   ```sql
   create role jarvis_worker_login login password '<gerar e guardar só na Dory>' in role jarvis_worker;
   create role jarvis_painel_login login password '<gerar e guardar só na Dory>' in role jarvis_painel;
   alter role jarvis_worker_login set role jarvis_worker;
   alter role jarvis_painel_login set role jarvis_painel;
   ```
   (As senhas nunca passam pelo chat; o Breno gera e guarda direto na Dory.)
4. Guardar as duas connection strings na Dory: `JARVIS_CORE_DB_WORKER_URL` e `JARVIS_CORE_DB_PAINEL_URL`.

### 8.3 Vercel (projeto próprio do Jarvis)
1. Importar `brenno968-dotcom/jarvis`, **Root Directory = `apps/painel`**, região das funções `gru1` (São Paulo).
2. Variáveis: `DATABASE_URL` = connection string do painel; `JARVIS_PAINEL_SENHA`; `JARVIS_PAINEL_SEGREDO_COOKIE`.
3. Abrir o painel, criar uma tarefa de teste (ela fica `pendente` até o worker existir).

### 8.4 VPS (container do worker)
1. `docker build -f deploy/worker.Dockerfile -t jarvis-worker:latest --build-arg BWS_URL=<url conferida> .`
2. Criar a conta de máquina do Jarvis no Bitwarden Secrets Manager (projeto `jarvis-core`), com `DATABASE_URL` (= connection string do worker) dentro.
3. Gravar o token da conta de máquina em `/opt/jarvis/secrets/bws_token` (permissão 600, dono 1001).
4. Juntar o trecho de `deploy/docker-compose.yml` ao compose do VPS e subir. Conferir memória livre (manter ~1 GB no KVM 1).
5. Conferir no painel: worker aparece em "Workers" e a tarefa de teste vira `concluida`.

### 8.5 Validar a Fase 0 no ambiente real
Repetir no ambiente real os critérios da seção 4 deste arquivo, em especial: derrubar o container no meio de uma tarefa; "PARA TUDO" pelo painel; procurar o valor de um segredo de teste nos logs do container (`docker logs`) e no banco. Marcar cada item aqui.

### 8.6 Antes da Fase 1
1. Trocar o login do painel por Supabase Auth (pendência 7.1).
2. Ligar a aprovação pelo WhatsApp (pendência 7.3).
3. Apresentar ao Breno o plano da Fase 1 e esperar aprovação.

## 9. Divisão sugerida para os próximos agentes (Claude Code)

> Atualizado: as Fases 1, 2 e 3 já têm código. O trabalho dos agentes passa a ser **validar e corrigir no real**, em paralelo:
> 1) Fase 0 no real (8.2 a 8.5); 2) lado do Nexus da integração WhatsApp; 3) Vercel real; 4) Supabase real; 5) Bitwarden SDK real;
> 6) OAuth do MCP para o claude.ai; 7) navegador na nuvem + link ao vivo; 8) Gmail OAuth; 9) primeira receita real (plataforma de teste);
> 10) robô verificador do Nexus; 11) Maestro com planos reais. Depois: Fases 4 a 8 (um agente por adaptador).


Depois que a Fase 0 estiver validada, com o plano de cada fase aprovado:

**Fase 1 — em paralelo (até 6 sessões):**
1. Adaptador Vercel (variável com `upsert`, redeploy, espera `READY`) — seção 19.1
2. Adaptador Supabase (segredos de Edge Functions, Management API) — seção 19.2
3. Adaptador Bitwarden/Dory (`salvarSegredo`, registro em `segredos_ref`) — seção 19.3
4. Adaptador GitHub (token restrito) + revogação de tokens no "PARA TUDO"
5. Teste diário das chaves (`verificarConexao` de todos + `ultimo_teste_ok`) e rotação com um comando
6. Conector MCP do Jarvis para o Claude (se o Breno aprovar)

**Fase 2 — em paralelo (até 5 sessões):** navegador na nuvem + link ao vivo; detector de CAPTCHA/travamento; leitor do Gmail; motor de receitas; adoção do robô verificador (seção 28).

**Fases 3 a 8:** cada adaptador de plataforma (Hotmart, Meta, Asaas, BTG, Autentique, Mercado Livre, frete, nota fiscal…) é um bloco independente — dá para ter 10 a 15 sessões ao mesmo tempo, sempre com o contrato da seção 19 e testes próprios.

## 10. Comandos úteis

```bash
npm ci                                   # instalar
npm run typecheck                        # tipagem (raiz + painel)
DATABASE_URL_TESTE=postgres://... npm test   # testes (Postgres 16)
DATABASE_URL=postgres://... npm run migrar   # aplicar migrations
DATABASE_URL=postgres://... npm run worker   # subir o worker
npm run dev -w @jarvis/painel            # painel local
```
