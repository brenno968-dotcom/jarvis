# Projeto Jarvis — Especificação completa (versão unificada)

> Documento único, juntando a Parte 1 (visão, regras e arquitetura) e a Parte 2 (especificação técnica), sem repetições.
> Versão de 10/11/2026. Repositório do projeto: `brenno968-dotcom/jarvis` (GitHub, privado).
> Construção autorizada pelo Breno, **uma fase por vez, começando pela Fase 0, sempre com plano aprovado antes de implementar**.

---

## 0. Instruções para a IA que vai construir

1. Leia este documento inteiro antes de qualquer coisa.
2. As **regras da seção 2** prevalecem sobre qualquer detalhe técnico deste documento. Em caso de conflito, siga a seção 2 e avise.
3. Os padrões técnicos são **recomendados**. Se algo conflitar com convenções já usadas no ecossistema Nexus (repositório `brenno968-dotcom/robo-whatsapp`), proponha a adaptação e explique antes de implementar.
4. Construa **uma fase por vez**, começando pela Fase 0 (seção 25). Não implemente partes de fases futuras antecipadamente.
5. Antes de cada fase, apresente um **plano curto** (arquivos, tabelas, dependências, o que roda na Vercel e o que roda no VPS, como vai testar cada critério de aceite) e **espere a aprovação do Breno**.
6. Cada fase só termina quando **todos os critérios de aceite** daquela fase passarem.
7. Entregue em **Pull Requests pequenos**, com tipagem, lint e testes rodando no GitHub Actions a cada PR.
8. Onde houver partes independentes dentro de uma fase, use **subagentes em paralelo**.
9. **Nunca** coloque valores de segredos em código, testes, exemplos, logs ou mensagens. Use sempre o nome do segredo.
10. Considere que Supabase, Vercel e VPS do Jarvis podem ainda não existir: deixe tudo pronto para conectar, com testes usando Postgres local, e liste no fim de cada fase o que o Breno precisa criar ou configurar.

---

# PARTE A — VISÃO, REGRAS E ARQUITETURA

## 1. Objetivo

O Jarvis é o assistente executor do ecossistema Nexus. Ele recebe ordens (do Claude ou do Breno), cria e configura contas, chaves, variáveis, integrações e negócios inteiros, **sem que senhas ou chaves passem pelo Claude ou pelo chat**.

Meta final: com um único comando ("crie uma renda extra vendendo X para Y"), o sistema planeja, monta e deixa rodando um negócio completo (digital ou físico), pedindo ao Breno só o que for indispensável.

## 2. Princípios (regras que nunca mudam)

1. **Segredos nunca passam pelo Claude.** O Claude só conhece os nomes dos segredos (ex.: `ASAAS_API_KEY`), nunca os valores.
2. **Sem copiar e colar.** Valores vão da plataforma direto para o cofre via API. Nada passa pela área de transferência nem por arquivo `.env` solto.
3. **Logs nunca registram valores**, só o nome do segredo, a ação e a data.
4. **API primeiro, navegador só quando não houver API.**
5. **CAPTCHA é sempre humano.** O Jarvis manda um link do navegador ao vivo para o celular do Breno, ele resolve e o Jarvis continua. Nenhuma forma de resolver CAPTCHA automaticamente pode ser usada, nem recursos de "CAPTCHA solving" de serviços de terceiros.
6. **O Breno só dá OK** no que for irreversível, envolver dinheiro ou falar com cliente. O resto é automático (semáforo, seção 6).
7. **WhatsApp só com opt-in.** Nenhuma mensagem para quem não pediu para receber (política da Meta). Prospecção fria acontece por anúncio (a pessoa inicia a conversa) ou por e-mail com descadastro fácil; o WhatsApp entra só depois do "sim".
8. **Permissão mínima.** Cada peça do ecossistema tem sua própria chave, só com o que precisa.
9. **Separado do Nexus de produção.** Um problema no Jarvis nunca pode derrubar ou expor os lojistas do Nexus.
10. **Nunca inventar** dados, números, depoimentos, resultados ou métricas.

## 3. Lugar do Jarvis no ecossistema

- **Carteiro:** entrega código (aplica pacotes e dá git push).
- **Jarvis:** entrega infraestrutura e contas (as "mãos do lado de fora").
- **Dory:** guarda e fornece os segredos (valores no Bitwarden Secrets Manager).
- **Pulso:** monitora a saúde de tudo, inclusive do Jarvis e dos servidores.
- **Vigia:** audita o código e as permissões de todos, inclusive do Jarvis e das receitas.
- **Marcapasso:** corrige automaticamente; quando a correção é de infraestrutura (ex.: chave expirada), pede ao Jarvis, seguindo o semáforo.

Fluxo típico: Breno pede uma funcionalidade → Claude escreve o código → Carteiro aplica → Jarvis cria conta, chave e variável → Pulso confirma que funciona → Vigia audita na rodada seguinte.

O Claude (claude.ai e Claude Code) aciona o Jarvis por um **conector MCP próprio do Jarvis** (seção 29, item proposto para a Fase 1).

## 4. Infraestrutura (onde cada parte roda)

**Repositório:** `brenno968-dotcom/jarvis`, separado do repositório do Nexus. O mesmo repositório publica as partes abaixo.

**Parte 1 — Vercel (projeto separado do Nexus):**
- Painel do Jarvis (tarefas, negócios, aprovações).
- Recebimento de webhooks (Gmail, Meta, plataformas de pagamento etc.).
- Chamadas curtas de API.
- Não roda processos longos nem navegador.
- Região das funções: São Paulo (`gru1`).

**Parte 2 — VPS (Hostinger):**
- Motor de tarefas e trabalhadores (tarefas longas, esperas, verificações periódicas).
- Maestro e agentes.
- Leitura do Gmail.
- Container Docker próprio, com limite de memória, usuário próprio e sem acesso aos arquivos dos outros serviços.
- Hoje o VPS é KVM 1 (1 vCPU, 4 GB) e também roda o WhatsApp por QR Code (Evolution), o servidor do DJEN e possivelmente o Vigia. Cada serviço em container isolado com limite de memória, para que um estouro não derrube o WhatsApp dos clientes.
- Recomendação futura: Hostinger KVM 4 no data center de São Paulo (ou VPS dedicado ao Jarvis).

**Parte 3 — Navegador na nuvem:**
- Serviço de navegador remoto com visualização ao vivo e "assumir o controle" (Browserbase ou Steel).
- É por ele que o link do CAPTCHA chega ao celular do Breno.
- O recurso de resolução automática de CAPTCHA fica **desligado**.

**Banco de dados:** projeto Supabase próprio do Jarvis, região São Paulo, separado do Nexus.

**Comunicação Vercel ↔ VPS:** só pelo banco (seção 18). A Vercel grava a tarefa, o VPS lê, executa e grava o resultado. Nenhuma porta aberta no VPS para receber ordens de fora.

## 5. Arquitetura em 7 camadas

Cada camada só conversa com a vizinha, para que trocar uma peça não quebre as outras.

**Camada 1 — Maestro (cérebro)**
- Recebe o comando e escolhe um modelo de negócio (seção 8).
- Pesquisa mercado, público, preço e concorrência.
- Gera o plano em formato de dados (seção 15.1), salvo com versão.
- Faz as checagens de viabilidade e riscos (seção 11) antes de executar.
- Acompanha a execução até o fim.

**Camada 2 — Motor de tarefas**
- Fila de tarefas com etapas; retoma de onde parou; não duplica nada ao repetir (idempotência); espera aprovações e CAPTCHA sem travar o resto.

**Camada 3 — Agentes especialistas** (todos recebem tarefas e devolvem o resultado padrão da seção 15.3)
- **Jarvis-infra:** contas, chaves, variáveis, redeploy, domínio, e-mail, números de WhatsApp, integrações.
- **Oferta:** no digital, cria o produto (livro, curso, materiais); no físico, fotos, descrições e páginas de venda. Também cria criativos de anúncio.
- **Tráfego:** pesquisa de público, criativos, campanhas no Meta Ads e acompanhamento dentro do orçamento.
- **Vendas:** reaproveita os módulos do Nexus (atendimento WhatsApp e e-mail, contratos no Autentique, cobrança e conferência de pagamento).
- **Fornecedores** (físico): pesquisa e compara fornecedores, amostras, pedidos de compra.
- **Logística** (físico): frete, etiquetas, rastreio, trocas e devoluções.
- **Fiscal:** emissão de nota a cada venda e organização para o contador.

**Camada 4 — Adaptadores por plataforma**
- Cada plataforma é um módulo isolado com funções padronizadas (seção 19). Trocar uma plataforma (ex.: Hotmart por Kiwify) = trocar só o adaptador.
- API primeiro; navegador só como alternativa, usando receitas gravadas.
- Previstos: Vercel, Supabase, GitHub, Bitwarden Secrets Manager, Gmail, Hostinger (domínio e e-mail), Meta (Business, Ads, WhatsApp Cloud API), Hotmart, Asaas, BTG, Autentique, provedor de e-mail transacional, loja virtual (Nuvemshop/Shopify), marketplaces (Mercado Livre, Shopee), frete (Melhor Envio, Correios), emissor de nota fiscal, ferramentas de IA de imagem, vídeo e voz.

**Camada 5 — Segurança e regras**
- Dory, semáforo, orçamentos e tetos, botão de emergência.
- Todas as regras num arquivo de configuração (seção 16), não espalhadas no código.

**Camada 6 — Registro de negócios**
- Cada negócio e tudo que pertence a ele: contas, números, domínios, campanhas, nomes dos segredos, custos, receitas, estoque e pedidos.
- Permite ver o lucro real de cada negócio, desligar um negócio inteiro e nunca misturar recursos entre negócios ou empresas.
- Cada negócio pode virar uma empresa dentro do Nexus (multiempresa), reaproveitando os módulos existentes.

**Camada 7 — Observação**
- Pulso, auditoria (sem valores), gravações das sessões de navegador com campos sensíveis mascarados, relatório diário no WhatsApp (seção 27).

## 6. Semáforo de autonomia e orçamentos

- 🟢 **Faz sozinho:** criar variável em ambiente de teste, redeploy de preview, ler logs, testar chaves, consultas em modo leitura.
- 🟡 **Faz e avisa:** redeploy em produção, criar segredo novo, ajustes dentro do orçamento já aprovado.
- 🔴 **Pede OK antes:** criar conta, apagar qualquer coisa, mudanças no banco de produção (estrutura ou dados), qualquer pagamento ou gasto (número, domínio, plano, estoque, aumento de orçamento), primeiro contato com cliente, publicar produto ou campanha, revogar chave.

Regras:
- Ação que não aparece em nenhuma cor é tratada como 🔴.
- Para ações 🔴, o Jarvis mostra antes o plano exato (simulação) e só executa após o OK.
- Aprovações chegam no WhatsApp do Breno com botões "Aprovar / Recusar" (seção 22).
- **Orçamento por negócio:** o Breno aprova um teto (ex.: "até R$ 500/mês em anúncio") uma vez; gastos dentro do teto não pedem OK a cada vez. Compra de estoque sempre pede OK, com teto por negócio.
- A configuração exata fica em `config/regras.yaml` (seção 16).

## 7. Dory, segredos e acessos

- Valores no **Bitwarden Secrets Manager**.
- Uma **conta de máquina por peça** (Jarvis, Carteiro, Pulso, Vigia, Marcapasso), cada uma só com os projetos de segredos que usa. O plano gratuito permite até 3 contas de máquina; com o ecossistema completo, é preciso plano pago.
- Permissões:
  - **Jarvis:** escreve segredos novos; lê só os de infraestrutura.
  - **Pulso:** só leitura, para testar as chaves.
  - **Carteiro:** só o acesso ao GitHub.
  - **Vigia e Marcapasso:** leitura ampla; escrita só com aprovação.
- Cada segredo marcado com a empresa e o negócio dono. O Jarvis nunca usa a chave de uma empresa em outra.
- O token de cada conta de máquina fica só no servidor onde a peça roda.
- Kit de recuperação do cofre (códigos e backup) guardado fora do computador.
- Sincronização para Vercel e Supabase: o Jarvis aplica via API a partir do Bitwarden (Infisical é alternativa com sincronização nativa).
- Tokens das plataformas sempre com escopo mínimo: Vercel (token do Jarvis), Supabase (um token pessoal por projeto, só com as permissões necessárias), GitHub (token restrito aos repositórios necessários).
- Consulta ao banco de produção do Nexus: servidor MCP do Supabase restrito a um projeto (`project_ref`) e em modo só leitura. Mudanças de estrutura passam por branch ou ambiente de teste e pelo OK do Breno.

## 8. Modelos de negócio

O Maestro monta o plano a partir de um modelo. Cada modelo é um roteiro reutilizável (etapas, plataformas, riscos, custos típicos). Novo tipo de negócio = novo roteiro, sem mexer no Maestro.

- Produto digital (curso, livro, software, template).
- Produto físico com estoque próprio.
- Produto físico sem estoque (dropshipping ou fornecedor que envia direto).
- Venda em marketplace.
- Serviço (consultoria, agência, assinatura).
- Afiliado.

## 9. Fluxos principais

**9.1 Criar conta em plataforma nova**
1. O Maestro ou o Claude pede a conta (plataforma, URL, e-mail, nome do segredo esperado).
2. 🔴 O Breno aprova no WhatsApp.
3. O Jarvis gera senha forte e grava direto na Dory.
4. Abre o navegador na nuvem com os campos preenchidos.
5. Se houver CAPTCHA, manda o link ao vivo para o celular do Breno, ele resolve, o Jarvis continua.
6. Lê o código de verificação no Gmail (seção 21) e confirma a conta.
7. Gera ou captura a chave de API e grava na Dory.
8. Registra a conta no inventário e devolve só o nome do segredo.
9. Grava o passo a passo como receita para a próxima vez.

**9.2 Criar ou atualizar variável e publicar**
1. Valor gravado na Dory.
2. Variável criada ou atualizada por API (Vercel/Supabase).
3. Redeploy por API (Vercel).
4. Pulso confirma que a aplicação subiu e que a chave funciona.

Preferência: quando a plataforma permite a ação por API com token (Vercel, Supabase), não usar navegador nem código por e-mail.

**9.3 Negócio completo com um comando**
1. Breno: "crie uma renda extra vendendo X para Y".
2. Maestro pesquisa e envia o plano com orçamento, viabilidade e riscos. 🔴 Breno aprova.
3. Agente de oferta produz o produto (ou, no físico, escolhe fornecedor e monta as páginas). 🔴 Breno revisa antes de publicar.
4. Jarvis monta a estrutura: conta na plataforma de venda, domínio ou subdomínio, e-mail, número de WhatsApp, Meta Business, app, variáveis, integrações. Usa o kit base quando existir; quando não existir, faz do zero (mais lento, com mais etapas do Breno).
5. Agente de tráfego cria criativos e sobe a campanha dentro do orçamento aprovado.
6. Captação com opt-in (anúncio → conversa iniciada pela pessoa, ou e-mail com descadastro → WhatsApp após o "sim").
7. Vendas (módulos do Nexus): atendimento automático, contrato no Autentique, cobrança, conferência de pagamento (Asaas, BTG, Hotmart etc.).
8. No físico: nota fiscal, etiqueta, envio, rastreio.
9. Jarvis avisa o Breno: "venda feita, tudo certo".

## 10. Kit base

Estrutura montada uma vez e reaproveitada por todos os negócios:
- Meta Business verificado, com conta de anúncios.
- Conta na plataforma de venda (ex.: Hotmart).
- Domínio principal (cada negócio usa um subdomínio).
- Provedor de e-mail.
- Alguns números de WhatsApp já aprovados.

Com o kit base, um negócio novo sai em horas e quase sem etapas do Breno. Sem ele, o Jarvis faz do zero, ciente de que contas novas na Meta costumam ter limite de gasto baixo, revisão mais rígida e mais risco de bloqueio.

## 11. Checagens do Maestro em todo plano

Qualquer item reprovado bloqueia o plano.

- **Custo x retorno:** custos estimados (anúncio, número, domínio, IA, ferramentas, frete, taxas, imposto, devoluções) e quantas vendas para empatar. Plano que não fecha a conta não sai do papel.
- **Regras das plataformas:** política de anúncios da Meta, opt-in do WhatsApp, regras da plataforma de venda, aprovação de modelos de mensagem.
- **Consumidor e LGPD:** garantia, direito de arrependimento, política de privacidade, descadastro fácil.
- **Regulação do produto** (físico): categorias que exigem registro ou certificação (cosméticos, suplementos, alimentos, eletrônicos, brinquedos).
- **Fiscal:** CNPJ e emissão de nota funcionando antes de vender (no físico, obrigatório antes de entrar no ar).
- **Etapas no mundo real** (físico): quem recebe, confere, embala e posta (pessoa, fornecedor enviando direto ou fulfillment de marketplace).
- **Limites do atendimento por IA:** não promete resultado, não inventa condição, escala para o Breno o que sair da regra.
- **Dinheiro antes da venda** (físico com estoque): sugerir começar pequeno ou sem estoque para validar demanda.

## 12. Funcionalidades de apoio

1. **Receitas por plataforma:** passo a passo gravado na primeira execução e reutilizado; revisado pelo Vigia; atualizado quando a plataforma muda.
2. **Detecção de travamento:** se o navegador travar, preservar a sessão, avisar o Breno para assumir e retomar depois.
3. **Inventário de contas e custos:** plataforma, e-mail, empresa/negócio, plano (grátis ou pago), limites, datas de renovação; lembrete de assinar planos pagos.
4. **Teste diário das chaves (Pulso):** falhou → Marcapasso pede ao Jarvis para renovar, seguindo o semáforo.
5. **Rotação de chaves com um comando:** gera nova, grava na Dory, redeploy, confirma, só então revoga a antiga.
6. **Botão de emergência ("PARA TUDO"):** suspende Jarvis, Carteiro e Marcapasso e revoga os tokens deles; acessível pelo WhatsApp.
7. **Relatório diário no WhatsApp:** o que cada peça fez, o que espera OK, o que falhou e as vendas do dia.
8. **Ambientes de teste:** sandbox do Asaas, branch do Supabase, preview da Vercel, modo teste da Meta. Nada vai para produção sem passar pelo teste.

---

# PARTE B — ESPECIFICAÇÃO TÉCNICA

## 13. Stack recomendada

- **Linguagem:** TypeScript em tudo (Vercel e VPS), para reaproveitar tipos entre as partes.
- **Vercel:** Next.js (App Router), mesmo padrão do Nexus. Só painel, webhooks e chamadas curtas.
- **VPS:** Node.js LTS rodando o trabalhador (worker) em Docker.
- **Banco:** Supabase (Postgres) em projeto próprio do Jarvis.
- **Fila de tarefas:**
  - Opção A (recomendada para começar): fila no próprio Postgres, com `pg-boss` ou tabela própria usando `FOR UPDATE SKIP LOCKED` (seção 18). Não exige serviço extra e combina com "Vercel e VPS conversam só pelo banco".
  - Opção B: Trigger.dev ou Inngest, se a fila própria ficar complexa demais.
- **Validação de dados:** Zod para planos, tarefas, regras e respostas de APIs.
- **Navegador:** Playwright conectado a um navegador na nuvem (Browserbase ou Steel) via CDP. Opcional: Stagehand para ações guiadas por IA.
- **Segredos:** Bitwarden Secrets Manager (CLI `bws` e SDK), com injeção por `bws run` no VPS.
- **IA dos agentes:** API da Anthropic (Claude), com as instruções da seção 24.

## 14. Convenções

**Nomes de segredos:** `EMPRESA_NEGOCIO_PLATAFORMA_TIPO`, tudo em maiúsculas.
- `NEXUSDRIVE_COBRANCA_ASAAS_API_KEY`
- `JARVIS_CORE_VERCEL_TOKEN`
- `PRIME_LIMPANOME_ASAAS_WEBHOOK_SECRET`
- Recursos do próprio Jarvis usam `JARVIS_CORE_`.

**Projetos no Bitwarden Secrets Manager:** um por empresa (`nexus-drive`, `prime`, `breno`, `jarvis-core` etc.), para que cada conta de máquina receba só o que precisa.

**Identificadores:** UUID em todas as tabelas. Toda tabela operacional tem `empresa_id` e, quando aplicável, `negocio_id`.

**Idempotência:** toda ação com efeito externo tem uma `idempotency_key` única (ex.: `criar_conta:hotmart:negocio_123`). Repetir a ação com a mesma chave nunca cria nada em dobro.

**Datas:** sempre `timestamptz` em UTC no banco; exibição no fuso de Brasília no painel e no WhatsApp.

## 15. Modelos de dados (JSON)

### 15.1 Plano do Maestro

```json
{
  "plano_id": "uuid",
  "versao": 1,
  "negocio_id": "uuid",
  "modelo_negocio": "produto_digital",
  "objetivo": "Vender e-book de gestão para donos de lojas de veículos",
  "status": "aguardando_aprovacao",
  "orcamento": {
    "teto_total_brl": 1500,
    "teto_mensal_anuncios_brl": 500,
    "teto_por_compra_brl": 200
  },
  "viabilidade": {
    "custo_estimado_brl": 1200,
    "preco_venda_brl": 97,
    "vendas_para_empatar": 13,
    "riscos": ["Conta de anúncios nova tem limite de gasto baixo"],
    "checagens": {
      "politicas_plataforma": "ok",
      "opt_in_whatsapp": "ok",
      "lgpd_consumidor": "ok",
      "fiscal": "pendente_contador",
      "regulacao_produto": "nao_aplicavel"
    }
  },
  "etapas": [
    {
      "etapa_id": "e1",
      "titulo": "Criar conta na Hotmart",
      "agente": "jarvis_infra",
      "acao": "criar_conta",
      "plataforma": "hotmart",
      "nivel_semaforo": "vermelho",
      "depende_de": [],
      "custo_estimado_brl": 0,
      "parametros": { "email": "brenno.968+cadastros@gmail.com" }
    }
  ]
}
```

### 15.2 Tarefa e estados

```json
{
  "tarefa_id": "uuid",
  "plano_id": "uuid",
  "etapa_id": "e1",
  "empresa_id": "uuid",
  "negocio_id": "uuid",
  "agente": "jarvis_infra",
  "acao": "criar_conta",
  "plataforma": "hotmart",
  "parametros": {},
  "idempotency_key": "criar_conta:hotmart:negocio_uuid",
  "nivel_semaforo": "vermelho",
  "status": "pendente",
  "tentativas": 0,
  "max_tentativas": 5,
  "proxima_tentativa_em": null,
  "travada_por": null,
  "travada_ate": null,
  "resultado": null,
  "erro": null
}
```

Estados e transições:

```
pendente ──► aguardando_aprovacao ──► aprovada ──► executando
pendente ──► executando                         (verde/amarelo)
executando ──► aguardando_humano                (CAPTCHA, travamento)
executando ──► aguardando_externo               (código de e-mail, verificação da Meta, revisão de anúncio)
aguardando_humano / aguardando_externo ──► executando
executando ──► concluida
executando ──► erro_temporario ──► pendente     (nova tentativa com espera)
executando ──► falhou                           (erro definitivo ou tentativas esgotadas)
aguardando_aprovacao ──► recusada
qualquer estado ──► cancelada                   (botão de emergência ou cancelamento do Breno)
```

### 15.3 Resultado padrão de agente e adaptador

```json
{
  "ok": true,
  "dados": { "conta_id_externo": "123", "segredos_criados": ["NEXUSDRIVE_LIVRO_HOTMART_API_KEY"] },
  "custo_real_brl": 0,
  "evidencias": ["sessao_navegador:abc123"],
  "mensagem": "Conta criada e chave salva."
}
```

Em caso de erro:

```json
{
  "ok": false,
  "erro": {
    "tipo": "temporario",
    "codigo": "RATE_LIMIT",
    "mensagem": "Limite de requisições atingido",
    "tentar_novamente_em_segundos": 60
  }
}
```

Tipos de erro: `temporario`, `definitivo`, `precisa_humano`, `precisa_aprovacao`, `bloqueado_por_regra`.

## 16. Arquivo de regras (`config/regras.yaml`)

```yaml
versao: 1

semaforo:
  verde:
    - criar_variavel_ambiente_teste
    - redeploy_preview
    - ler_logs
    - testar_chave
    - consultar_banco_leitura
    - verificar_nexus
  amarelo:
    - redeploy_producao
    - criar_segredo
    - ajustar_campanha_dentro_orcamento
    - abrir_sessao_nexus
  vermelho:
    - criar_conta
    - apagar_qualquer_coisa
    - alterar_banco_producao
    - qualquer_pagamento
    - comprar_estoque
    - aumentar_orcamento
    - primeiro_contato_cliente
    - publicar_produto
    - publicar_campanha
    - revogar_chave

orcamento_padrao:
  teto_por_compra_brl: 200
  teto_mensal_por_negocio_brl: 500
  compra_estoque_sempre_pede_ok: true

aprovacao:
  canal: whatsapp
  numeros_autorizados: ["<numero_do_breno>"]
  expira_em_minutos: 60
  lembrete_apos_minutos: 15

gmail:
  intervalo_verificacao_segundos: 4
  tempo_maximo_espera_minutos: 5
  alias_cadastros: "brenno.968+cadastros@gmail.com"

navegador:
  provedor: browserbase
  resolver_captcha_automatico: false   # NUNCA mudar para true
  tempo_maximo_espera_humano_minutos: 30

tentativas:
  max_padrao: 5
  espera_inicial_segundos: 10
  multiplicador: 2
  espera_maxima_segundos: 900

emergencia:
  comando_whatsapp: "PARA TUDO"
  revogar_tokens: [jarvis, carteiro, marcapasso]
```

Regras de implementação:
- O arquivo é validado com Zod ao iniciar; se estiver inválido, o worker não sobe.
- Ação que não aparece em nenhuma cor é tratada como vermelha.
- `resolver_captcha_automatico` é verificado no código; se estiver `true`, o worker recusa iniciar.
- Mudanças no arquivo são versionadas no Git e registradas na auditoria.

## 17. Banco de dados (Supabase)

```sql
-- Empresas e negócios
create table empresas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  nexus_empresa_id text,              -- referência à empresa no Nexus
  criado_em timestamptz not null default now()
);

create table negocios (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  nome text not null,
  modelo_negocio text not null check (modelo_negocio in
    ('produto_digital','fisico_estoque','fisico_sem_estoque','marketplace','servico','afiliado')),
  status text not null default 'planejamento' check (status in
    ('planejamento','montagem','ativo','pausado','encerrado')),
  orcamento jsonb not null default '{}',
  criado_em timestamptz not null default now()
);

-- Contas criadas em plataformas (inventário)
create table contas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  negocio_id uuid references negocios(id),
  plataforma text not null,
  email_usado text,
  id_externo text,
  plano text,                         -- gratis, pago, nome do plano
  limites jsonb default '{}',
  renovacao_em date,
  status text not null default 'ativa',
  criado_em timestamptz not null default now()
);

-- Referências de segredos (NUNCA o valor)
create table segredos_ref (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id),
  negocio_id uuid references negocios(id),
  nome text not null unique,          -- ex.: NEXUSDRIVE_COBRANCA_ASAAS_API_KEY
  bitwarden_secret_id text not null,
  bitwarden_projeto text not null,
  plataforma text not null,
  destinos jsonb default '[]',        -- onde está aplicado: vercel:projeto:ambiente, supabase:projeto
  criado_em timestamptz not null default now(),
  rotacionado_em timestamptz,
  ultimo_teste_em timestamptz,
  ultimo_teste_ok boolean
);

-- Planos do Maestro
create table planos (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid references negocios(id),
  versao int not null default 1,
  conteudo jsonb not null,            -- JSON da seção 15.1
  status text not null default 'aguardando_aprovacao',
  criado_em timestamptz not null default now()
);

-- Fila de tarefas
create table tarefas (
  id uuid primary key default gen_random_uuid(),
  plano_id uuid references planos(id),
  etapa_id text,
  empresa_id uuid not null references empresas(id),
  negocio_id uuid references negocios(id),
  agente text not null,
  acao text not null,
  plataforma text,
  parametros jsonb not null default '{}',
  idempotency_key text not null unique,
  nivel_semaforo text not null check (nivel_semaforo in ('verde','amarelo','vermelho')),
  status text not null default 'pendente',
  tentativas int not null default 0,
  max_tentativas int not null default 5,
  proxima_tentativa_em timestamptz default now(),
  travada_por text,
  travada_ate timestamptz,
  resultado jsonb,
  erro jsonb,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index tarefas_fila_idx on tarefas (status, proxima_tentativa_em);

-- Aprovações
create table aprovacoes (
  id uuid primary key default gen_random_uuid(),
  tarefa_id uuid references tarefas(id),
  plano_id uuid references planos(id),
  resumo text not null,               -- o que será feito, em linguagem simples
  token_hash text not null,           -- hash do token de uso único
  status text not null default 'pendente' check (status in
    ('pendente','aprovada','recusada','expirada')),
  respondido_por text,
  expira_em timestamptz not null,
  respondido_em timestamptz,
  criado_em timestamptz not null default now()
);

-- Receitas de navegador
create table receitas (
  id uuid primary key default gen_random_uuid(),
  plataforma text not null,
  acao text not null,
  versao int not null default 1,
  passos jsonb not null,
  ultima_execucao_ok timestamptz,
  falhas_seguidas int not null default 0,
  aprovada_pelo_vigia boolean not null default false,
  unique (plataforma, acao, versao)
);

-- Auditoria (sem valores de segredos)
create table auditoria (
  id bigint generated always as identity primary key,
  quando timestamptz not null default now(),
  quem text not null,                 -- jarvis, maestro, breno, carteiro...
  acao text not null,
  empresa_id uuid,
  negocio_id uuid,
  tarefa_id uuid,
  detalhes jsonb default '{}'
);

-- Financeiro por negócio
create table movimentos (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id),
  tipo text not null check (tipo in ('custo','receita')),
  categoria text not null,            -- anuncio, plataforma, frete, imposto, venda...
  valor_brl numeric(12,2) not null,
  origem text,                        -- asaas, btg, hotmart...
  id_externo text,
  ocorrido_em timestamptz not null default now()
);

-- Físico
create table estoque (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id),
  sku text not null,
  descricao text,
  quantidade int not null default 0,
  custo_unitario_brl numeric(12,2),
  unique (negocio_id, sku)
);

create table pedidos (
  id uuid primary key default gen_random_uuid(),
  negocio_id uuid not null references negocios(id),
  canal text,
  id_externo text,
  status text not null,
  valor_brl numeric(12,2),
  nota_fiscal_id text,
  rastreio text,
  criado_em timestamptz not null default now()
);
```

Segurança no banco:
- RLS ativo em todas as tabelas.
- O painel (Vercel) acessa só com o login do Breno; políticas permitindo leitura e aprovação apenas para o usuário dele.
- O worker do VPS usa um papel próprio de banco, com permissão só nas tabelas que usa. A chave `service_role` nunca vai para o navegador.
- `auditoria` é só de inserção: sem `update` nem `delete` para nenhum papel da aplicação.

## 18. Fila e comunicação Vercel ↔ VPS

Fluxo:
1. Vercel (painel, webhook ou comando) insere a tarefa em `tarefas`.
2. O worker no VPS pega a próxima tarefa disponível, executa e grava o resultado.
3. O painel lê o estado (pode usar Supabase Realtime).

Pegar tarefa sem duas máquinas pegarem a mesma:

```sql
update tarefas
set status = 'executando',
    travada_por = $1,                         -- id do worker
    travada_ate = now() + interval '5 minutes',
    tentativas = tentativas + 1,
    atualizado_em = now()
where id = (
  select id from tarefas
  where status = 'pendente'
    and proxima_tentativa_em <= now()
  order by criado_em
  for update skip locked
  limit 1
)
returning *;
```

Regras:
- O worker renova `travada_ate` a cada minuto enquanto executa (heartbeat).
- Uma rotina a cada minuto devolve para `pendente` as tarefas em `executando` com `travada_ate` vencido (worker caiu).
- Tarefas `vermelho` só são pegas se houver aprovação `aprovada` vinculada.
- O worker não abre nenhuma porta de entrada; só faz conexões de saída (banco, APIs, navegador na nuvem).
- Espera entre tentativas: exponencial (seção 16, `tentativas`), com variação aleatória; tentativas esgotadas → `falhou` e aviso ao Breno.

## 19. Contrato dos adaptadores

```ts
export interface ContextoExecucao {
  empresaId: string;
  negocioId?: string;
  tarefaId: string;
  idempotencyKey: string;
  obterSegredo(nome: string): Promise<string>;      // lê da Dory, nunca loga
  salvarSegredo(nome: string, valor: string, meta: MetaSegredo): Promise<void>;
  registrarAuditoria(acao: string, detalhes?: object): Promise<void>;
  pedirHumano(motivo: string, linkAoVivo?: string): Promise<void>;
}

export interface Resultado<T = unknown> {
  ok: boolean;
  dados?: T;
  custoRealBrl?: number;
  evidencias?: string[];
  mensagem?: string;
  erro?: {
    tipo: 'temporario' | 'definitivo' | 'precisa_humano' | 'precisa_aprovacao' | 'bloqueado_por_regra';
    codigo: string;
    mensagem: string;
    tentarNovamenteEmSegundos?: number;
  };
}

export interface Adaptador {
  plataforma: string;
  temApi: boolean;
  acoesSuportadas: string[];
  verificarConexao(ctx: ContextoExecucao): Promise<Resultado>;
  executar(acao: string, params: object, ctx: ContextoExecucao): Promise<Resultado>;
}
```

Regras:
- Um adaptador por pasta (ex.: `adaptadores/vercel`, `adaptadores/hotmart`).
- Todo adaptador implementa `verificarConexao`, usada pelo Pulso no teste diário.
- Antes de executar, o adaptador consulta se já existe resultado para a `idempotencyKey`; se existir, devolve o resultado salvo.
- O adaptador nunca devolve valores de segredos em `dados` ou `mensagem`.
- Quando não houver API, o adaptador usa a receita da tabela `receitas` via navegador.

### 19.1 Adaptador Vercel (Fase 1)
- Criar ou atualizar variável: `POST https://api.vercel.com/v10/projects/{idOrName}/env?upsert=true`, com `type: "sensitive"` para segredos e `target` com os ambientes.
- Mudança de variável só vale após novo deploy; o adaptador sempre dispara o redeploy e aguarda o status `READY`.
- Token com escopo mínimo, guardado como `JARVIS_CORE_VERCEL_TOKEN`.

### 19.2 Adaptador Supabase (Fase 1)
- Segredos de Edge Functions pela Management API ou CLI (`supabase secrets set`). Não exigem redeploy.
- Um token pessoal por projeto, com escopo de projeto e só as permissões necessárias.
- Consultas ao banco de produção via MCP do Supabase com `project_ref` e `read_only=true`.

### 19.3 Adaptador Bitwarden (Dory)
- Criar e atualizar segredos via SDK ou `bws`, sempre no projeto da empresa correta.
- No VPS, o worker sobe com `bws run -- node worker.js`, recebendo só o token da conta de máquina do Jarvis (`BWS_ACCESS_TOKEN`).
- Todo segredo criado gera um registro em `segredos_ref`.

## 20. Navegador e CAPTCHA (Fase 2)

1. O worker cria uma sessão no navegador na nuvem e recebe o endereço de conexão (CDP) e o link de visualização ao vivo.
2. Playwright conecta e executa os passos da receita.
3. Ao detectar CAPTCHA, verificação humana ou travamento (passo sem avançar, elemento não encontrado, tempo esgotado):
   - a tarefa vai para `aguardando_humano`;
   - o Breno recebe no WhatsApp: "Cadastro na plataforma X precisa de você" + link ao vivo;
   - o worker espera (até `tempo_maximo_espera_humano_minutos`) e verifica a cada poucos segundos se a página avançou;
   - ao avançar, retoma a receita; se o tempo acabar, deixa a sessão salva e avisa.
4. Campos de senha são preenchidos lendo da Dory na hora; nunca aparecem em log.
5. Capturas de tela usam a opção `mask` do Playwright sobre campos sensíveis.
6. Contextos persistentes (cookies) ficam no provedor de navegador, guardados só por referência (id), nunca exportados para o banco.
7. Em toda execução bem-sucedida, a receita é atualizada (`ultima_execucao_ok`). Três falhas seguidas → receita marcada para revisão e Breno avisado.

## 21. Gmail (Fase 2)

Acesso: OAuth com escopo `https://www.googleapis.com/auth/gmail.readonly`. O refresh token fica na Dory como `JARVIS_CORE_GMAIL_REFRESH_TOKEN`.

Atenção: numa conta Gmail pessoal, o app OAuth em modo de teste exige renovar o acesso a cada 7 dias; publicar o app com escopo de leitura de e-mail exige verificação do Google, que pode levar semanas. Decidir antes da Fase 2 (seção 29).

Busca do código (fase inicial, por intervalo):
- Alias de cadastros: `brenno.968+cadastros@gmail.com`.
- Consulta: `from:(remetente@plataforma.com) after:<unix_timestamp_do_inicio_da_acao>`.
- Verifica a cada `intervalo_verificacao_segundos` enquanto a tarefa espera, até `tempo_maximo_espera_minutos` (depois avisa o Breno).
- Extrai o código com expressão regular específica da plataforma (definida na receita), ex.: `\b\d{6}\b`.
- Valida: remetente esperado, recebido depois do início, formato correto, um único código encontrado.
- Código usado é descartado da memória imediatamente.
- E-mail com código sem tarefa correspondente → alerta ao Breno (possível tentativa de invasão), nunca usado.

Fase posterior (aviso instantâneo):
- `users.watch` publicando num tópico do Google Cloud Pub/Sub; o webhook da Vercel recebe o aviso e grava um evento para o worker.
- Renovar o `watch` diariamente (a assinatura dura no máximo 7 dias e para sem erro).
- O Pulso alerta se a renovação falhar ou se não chegar nenhum aviso em 24 horas.

## 22. Aprovações pelo WhatsApp

- Usa o número do Nexus que já fala com o Breno (ele mesmo é o destinatário, então o opt-in existe).
- Mensagem com resumo em linguagem simples e botões "Aprovar" e "Recusar".
- Cada botão carrega um token de uso único; no banco fica só o hash (`aprovacoes.token_hash`).
- Só aceita resposta vinda de `numeros_autorizados`.
- Aprovação expira em `expira_em_minutos`; lembrete em `lembrete_apos_minutos`.
- Ações de valor alto ou irreversíveis (apagar dados, pagamentos acima do teto) exigem confirmação também pelo painel com login.
- Comando "PARA TUDO" vindo do número do Breno aciona o botão de emergência.

## 23. Instalação no VPS

Docker Compose (trecho do Jarvis):

```yaml
services:
  jarvis-worker:
    image: jarvis-worker:latest
    container_name: jarvis-worker
    restart: unless-stopped
    user: "1001:1001"            # usuário sem privilégios
    read_only: true
    tmpfs:
      - /tmp
    mem_limit: 768m
    cpus: "0.5"
    environment:
      - BWS_ACCESS_TOKEN_FILE=/run/secrets/bws_token
    secrets:
      - bws_token
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

secrets:
  bws_token:
    file: /opt/jarvis/secrets/bws_token   # permissão 600, dono 1001
```

Regras do servidor:
- WhatsApp, Vigia e Jarvis em containers separados, cada um com seu limite de memória. No KVM 1 (4 GB), manter pelo menos ~1 GB livre para o sistema.
- O navegador fica no serviço na nuvem, não no VPS (enquanto o VPS for o KVM 1).
- Firewall (ufw): bloquear tudo de entrada, liberar só SSH (só com chave) e as portas que o WhatsApp realmente precisa. O Jarvis não precisa de porta de entrada.
- SSH sem senha, só com chave; login de root desativado.
- Atualizações de segurança automáticas do sistema.
- O Pulso monitora memória, CPU, disco e se cada container está de pé.

## 24. Instruções-base dos agentes

Comum a todos:
- Nunca pedir, exibir ou repetir valores de segredos; usar só nomes.
- Nunca resolver ou tentar contornar CAPTCHA.
- Nunca enviar mensagem de WhatsApp para quem não deu opt-in.
- Nunca inventar dados, números, depoimentos ou resultados.
- Toda ação passa pelo semáforo; na dúvida, tratar como vermelha.
- Responder no formato padrão de resultado (seção 15.3).

Maestro:
- Transformar o comando em plano no formato da seção 15.1.
- Escolher o modelo de negócio (seção 8) e justificar.
- Pesquisar mercado, preço e concorrência antes de propor.
- Preencher a viabilidade com custos realistas e o ponto de empate.
- Rodar todas as checagens da seção 11; qualquer item reprovado bloqueia o plano.
- Preferir o kit base quando existir; quando não existir, planejar do zero e avisar que vai levar mais tempo.
- Sugerir começar pequeno (validar demanda antes de gastar).

Oferta:
- Conteúdo original, sem copiar materiais de terceiros.
- Não prometer resultados garantidos.
- Tudo como rascunho até o Breno aprovar.

Tráfego:
- Respeitar as políticas de anúncios da Meta.
- Nunca passar do orçamento aprovado; ao atingir 80% do teto, avisar.
- Mudanças só dentro das regras amarelas; aumentos de orçamento são vermelhos.

Vendas (módulos do Nexus):
- Não prometer resultado nem inventar condições.
- Seguir as regras de preço e desconto do negócio; fora da regra → encaminhar ao Breno.
- Respeitar descadastro imediatamente.

## 25. Fases e critérios de aceite

Cada fase entrega algo útil sozinha. Produto físico vem depois do digital funcionando de ponta a ponta.

**Fase 0 — Fundação:** repositório, projeto Vercel e Supabase próprios, container no VPS com limite de memória, motor de tarefas, registro de negócios, arquivo de regras, auditoria, botão de emergência, contas de máquina na Dory, CI no GitHub Actions.
- [ ] Tabelas da seção 17 criadas com RLS ativo.
- [ ] Worker em container, com limite de memória, usuário sem privilégios e sem porta de entrada.
- [ ] Tarefa de teste inserida pelo painel é executada pelo worker e o resultado aparece no painel.
- [ ] Derrubar o worker no meio de uma tarefa → ela volta para a fila e termina sem duplicar.
- [ ] Arquivo de regras validado na inicialização; com `resolver_captcha_automatico: true`, o worker recusa subir.
- [ ] Busca em todos os logs pelo valor de um segredo de teste não encontra nada.
- [ ] Comando "PARA TUDO" suspende o worker e marca as tarefas como canceladas.

**Fase 1 — Jarvis por API** (Vercel, Supabase, Bitwarden, GitHub, testes diários das chaves; conector MCP, se aprovado):
- [ ] Criar variável na Vercel por nome, com redeploy automático, e confirmar que a aplicação lê o novo valor.
- [ ] Repetir a mesma tarefa não cria variável duplicada.
- [ ] Criar segredo no Supabase e confirmar uso imediato numa Edge Function.
- [ ] Teste diário das chaves roda e registra `ultimo_teste_ok`.
- [ ] Rotação de uma chave de teste funciona de ponta a ponta.

**Fase 2 — Navegador e Gmail** (navegador na nuvem, link ao vivo para CAPTCHA, Gmail, receitas, criação de contas com OK; adoção do robô verificador da seção 28):
- [ ] Conta criada numa plataforma de teste com aprovação pelo WhatsApp.
- [ ] CAPTCHA gera link ao vivo no celular; após resolver, a tarefa continua sozinha.
- [ ] Código de verificação lido do Gmail e aplicado; código não solicitado gera alerta e não é usado.
- [ ] Capturas de tela não mostram campos de senha.
- [ ] Receita reaproveitada numa segunda execução.

**Fase 3 — Maestro:** modelos de negócio, planos em dados, checagens da seção 11, aprovação e acompanhamento.
**Fase 4 — Oferta (digital):** produto digital e criativos, com revisão do Breno.
**Fase 5 — Tráfego:** primeiro só leitura e relatórios das campanhas; depois criação dentro do orçamento aprovado.
**Fase 6 — Vendas:** módulos do Nexus ligados ao Maestro, fluxos de opt-in, contrato, pagamento, aviso de venda.
**Fase 7 — Produto físico:** agentes de fornecedores, logística e fiscal; adaptadores de loja, marketplace, frete e nota fiscal.
**Fase 8 — Do zero completo:** Meta Business, conta de anúncios e números sem kit base.

Para as Fases 3 a 8, a IA construtora define a lista detalhada de critérios antes de começar cada fase, com base nas seções correspondentes deste documento, e o Breno aprova. **Marco obrigatório da Fase 6:** um negócio digital de teste rodando de ponta a ponta a partir de um único comando.

A partir da Fase 5, dividir cada fase em blocos independentes (adaptadores) para construção em paralelo.

## 26. Manual de emergência

**Chave vazou ou suspeita de vazamento:**
1. "PARA TUDO" se houver dúvida sobre o alcance.
2. Revogar a chave na plataforma.
3. Rotacionar (nova chave → Dory → redeploy → teste).
4. Ver na auditoria o que foi feito com a chave.
5. Se for token de conta de máquina do Bitwarden, revogar e criar novo.

**VPS caiu:** tarefas ficam na fila, nada se perde; ao voltar, a rotina de travas vencidas devolve as tarefas. O Pulso avisa; se não voltar, reiniciar pelo painel da Hostinger.

**Meta bloqueou conta ou número:** pausar todas as tarefas do negócio afetado; não criar conta nova para contornar o bloqueio; seguir a contestação da Meta; revisar a causa (opt-in, política de anúncio) antes de retomar.

**Gmail parou de avisar:** renovar o `watch` manualmente; enquanto isso, o modo por intervalo continua funcionando.

**Receita quebrou (site mudou):** tarefa vai para `aguardando_humano`; o Breno pode concluir pelo link ao vivo; receita marcada para revisão; nova versão aprovada pelo Vigia.

**Gasto inesperado:** tráfego pausa as campanhas do negócio ao passar do teto; o Breno recebe relatório do que foi gasto e onde.

## 27. Observação (o que o Pulso monitora)

- Worker: de pé, última tarefa executada, tarefas presas.
- Fila: quantidade por estado, tempo médio de espera, tarefas falhadas.
- Chaves: resultado do teste diário de cada uma.
- Gmail: renovação do `watch`, últimos avisos recebidos.
- VPS: memória, CPU, disco, containers.
- Orçamentos: gasto por negócio contra o teto.
- Aprovações pendentes há mais de 1 hora.
- Relatório diário no WhatsApp com tudo isso resumido.

## 28. Robô verificador — acesso do Claude aos sistemas Nexus

### 28.1 O problema que resolve
O Claude (que constrói e mantém o Nexus) não consegue entrar nas telas dos sistemas (Nexus Hub, Drive, Copiloto, Judge…) para conferir algo, porque nunca digita nem vê senha. Hoje ele precisa pedir ao Breno para logar. Exemplo real (09/11/2026): conferir se o modelo `alerta_interno` apareceu em Hub › Modelos.

### 28.2 O que já está coberto e o que falta
- **Já coberto (seções 19, 19.3 e 20):** navegador na nuvem com Playwright, senha lida da Dory na hora (sem log), máscara nas capturas, receitas reaproveitáveis, auditoria.
- **Falta:**
  1. Um **usuário próprio** para o robô nos sistemas Nexus (nunca o usuário do Breno).
  2. As **ações de verificação** (conferir tela, conferir dado, testar fluxo) como habilidade do Jarvis.
  3. A **passagem da sessão ao Claude**: o robô entra e entrega ao Claude uma sessão já logada, sem senha passar pelo Claude.

### 28.3 Como funciona
1. O Claude pede: "confere a tela X na empresa Y" (ou "abre a tela X e me passa").
2. O Jarvis cria a tarefa `verificar_nexus` (ou `abrir_sessao_nexus`).
3. O worker abre o navegador, lê `NEXUS<EMPRESA>_ROBO_LOGIN` e `NEXUS<EMPRESA>_ROBO_SENHA` da Dory, entra no sistema e:
   - **verificar_nexus:** executa a receita de conferência e devolve o resultado padrão (seção 15.3), com evidências (capturas com CPF, telefone e campos sensíveis mascarados) e um resumo em português;
   - **abrir_sessao_nexus:** devolve ao Claude só o endereço da sessão já logada (CDP/visualização). O Claude opera a tela; a senha nunca aparece para ele.
4. Tudo entra na `auditoria` do Jarvis e no registro de acessos LGPD do Nexus (`lgpd_acessos`), com o motivo.

### 28.4 Usuário do robô (um por empresa/sistema)
- Nome: "Robô Nexus (programador)". E-mail próprio (alias do Breno, ex.: `brenno.968+robo@gmail.com`).
- **Permissão limitada:** ver telas, conferir e testar. Sem mexer em dinheiro, sem busca aprofundada, sem apagar, sem trocar configuração de segurança.
- Senha gerada e guardada só na Dory; troca periódica pela Dory.
- Sem verificação por SMS (o robô não recebe código); compensado pelo acesso limitado, troca periódica da senha e auditoria. Se o sistema exigir código por e-mail, usa a leitura do Gmail (seção 21).

### 28.5 Regras
- **Mudanças no sistema continuam por pacote/PR + Vigia.** O robô confere e opera telas; não altera código nem banco de produção fora do fluxo do Vigia.
- Semáforo: `verificar_nexus` é verde; `abrir_sessao_nexus` é amarelo; qualquer ação em tela que envie mensagem a cliente, mexa em dinheiro, apague dados ou mude configuração é vermelha (seção 22).
- Nunca usar o login do Breno. Nunca exportar cookies para o banco.
- Capturas e relatórios sem CPF, telefone completo, senha ou token.

### 28.6 Ordem de construção
1. **Antes do Jarvis (peça pequena, no repositório do Nexus):** workflow no GitHub Actions do Nexus que lê a senha do robô no cofre, roda Playwright num navegador invisível, executa a conferência e publica o resultado (resumo da execução + aviso no Pulso), no formato da seção 15.3.
2. **Na Fase 2 do Jarvis:** o Jarvis adota essa peça; a conferência passa a rodar no VPS com sessão aberta e ganha a passagem de sessão ao Claude.
3. **Depois:** conferência automática das telas principais após cada publicação (inclusive em modo celular).

### 28.7 Critérios de aceite
- [ ] Usuário do robô criado com permissão limitada; tentativa de ação proibida é recusada pelo próprio Nexus.
- [ ] "Confere Hub › Modelos" devolve o estado certo sem nenhuma senha em log, relatório ou conversa.
- [ ] Capturas com CPF e telefone mascarados.
- [ ] Cada entrada do robô aparece na auditoria e em `lgpd_acessos`.
- [ ] Senha do robô trocada pela Dory e a conferência continua funcionando.
- [ ] Após a adoção pelo Jarvis: mesma conferência pelo VPS em menos de 30 segundos.

## 29. Decisões pendentes (do Breno)

- **VPS:** continuar no KVM 1 atual (isolado) ou migrar para KVM 4 em São Paulo / VPS dedicado.
- **Motor de tarefas:** fila no Postgres (recomendado) ou Trigger.dev/Inngest.
- **Navegador na nuvem:** Browserbase ou Steel.
- **Cofre:** só Bitwarden ou Bitwarden + Infisical para sincronização.
- **Planos pagos:** Bitwarden (contas de máquina), Supabase (backup).
- **Gmail:** app OAuth em modo de teste (renovação a cada 7 dias) ou passar pela verificação do Google.
- **Proposto:** conector MCP do Jarvis para o Claude (claude.ai e Claude Code) mandar pedidos direto da conversa, junto com a Fase 1.
- **Nexus:** ajustar o módulo de Prospecção de lojas para captação com opt-in antes de usar em escala.
- **Fiscal:** CNPJ e emissão de nota para os negócios de renda extra, com o contador.

## 30. Referências para consulta

Vercel
- Variáveis de ambiente (painel, CLI e REST API): https://vercel.com/kb/guide/how-to-add-environment-variables-to-vercel

Supabase
- Tokens de acesso com escopo: https://supabase.com/docs/guides/platform/access-tokens
- Segredos das Edge Functions: https://supabase.com/docs/guides/functions/secrets
- Servidor MCP oficial (escopo por projeto e modo leitura): https://github.com/supabase/mcp

Segredos
- Bitwarden Secrets Manager: https://bitwarden.com/go/secrets-manager
- Infisical, sincronização com Vercel: https://infisical.com/docs/integrations/secret-syncs/vercel
- Infisical, integração com Supabase: https://infisical.com/docs/integrations/cloud/supabase

Gmail
- `users.watch` (aviso instantâneo via Pub/Sub): https://developers.google.com/gmail/api/v1/reference/users/watch
- Guia prático de push do Gmail e renovação: https://cli.nylas.com/guides/gmail-push-notifications

WhatsApp
- Política de opt-in da Meta: https://developers.facebook.com/docs/whatsapp/overview/getting-opt-in

Agentes sem acesso a credenciais (padrões de mercado)
- Composio, autenticação gerenciada: https://docs.composio.dev/docs/authentication
- Arcade, onde ficam os tokens: https://www.arcade.dev/blog/where-are-my-tokens-stored

Navegador com controle humano
- Browserbase, Stagehand e transferência para humano: https://github.com/browserbase/bell-stack
- Detecção de travamento e passagem para humano: https://dev.to/instachime/routing-autonomous-browser-agent-handshakes-stagehand-playwright-to-human-closers-before-20g0

Outros
- Playwright: https://playwright.dev
- Trigger.dev: https://trigger.dev
- Inngest: https://www.inngest.com
- Browserbase: https://www.browserbase.com
- Steel: https://steel.dev

---

Fim da especificação.
