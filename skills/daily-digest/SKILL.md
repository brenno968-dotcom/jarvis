---
name: daily-digest
description: Monta o resumo do dia do Breno (o que foi feito, o que está pendente, prazos e saúde dos sistemas) a partir do Quadro, do Atlas e do Pulso. Use quando ele pedir "resumo do dia", "como está tudo hoje" ou "o que tenho pendente".
license: Proprietary
ferramentas_permitidas:
  - pedidos_listar
  - atlas_buscar
  - sistema_saude
  - mcp__openjarvis__memory_search
  - mcp__openjarvis__morning_digest
risco: verde
origem: interna
metadata:
  adaptada_de: openjarvis/daily-digest
  versao: "1.0"
---
# Resumo do dia

Objetivo: um resumo curto e útil do dia, só com dado que você conseguiu ler. Nada é executado, criado ou alterado.

## Passos

1. Junte o que existe, uma busca por vez e sem repetir a mesma chamada:
   - `pedidos_listar`: itens abertos, em andamento e concluídos há pouco no Quadro.
   - `atlas_buscar`: decisões e pendências recentes (termo: a data de hoje ou "pendência").
   - `sistema_saude`: se algo do Pulso (Vigia, Marcapasso, WhatsApp, servidor) está com problema.
   - Se a ferramenta `mcp__openjarvis__morning_digest` ou `mcp__openjarvis__memory_search` estiver disponível, use no máximo uma vez para complementar.
2. Separe em quatro grupos: **Feito**, **Pendente**, **Prazos próximos** e **Atenção** (problemas de sistema, aprovações esperando).
3. Escreva no formato abaixo, em português do Brasil, no máximo 10 linhas.

## Formato da resposta

- Feito: itens concluídos (número do item e uma frase).
- Pendente: o que espera o Breno decidir ou aprovar vem primeiro.
- Prazos: só os que aparecem nos dados, com a data.
- Atenção: problemas de sistema, ou "tudo certo".

## Regras

- Se uma fonte não respondeu, diga qual e siga com as outras. Nunca invente item, número ou prazo.
- Dados sensíveis que aparecerem num resultado (CPF, telefone completo, credenciais) ficam fora do resumo.
- Fim da resposta: uma linha com o próximo passo sugerido (só sugestão; ações vão para a fila e pedem o "Aprovar").
