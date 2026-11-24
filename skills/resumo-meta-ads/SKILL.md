---
name: resumo-meta-ads
description: >-
  Lê as métricas de campanhas de anúncios (Meta Ads) e resume o desempenho em gasto, cliques, leads, vendas, CPA e retorno (ROAS), sugerindo ajustes para o Breno decidir. Use quando ele pedir "como estão os anúncios", "resumo da campanha" ou "o que ajustar no Meta". Só leitura e sugestão: nunca altera campanha nem orçamento.
license: Proprietary
ferramentas_permitidas:
  - atlas_buscar
  - banco_tabelas
  - banco_consultar
risco: verde
origem: interna
metadata:
  autor: jarvis
  versao: "1.0"
---
# Resumo de Meta Ads

Objetivo: dizer, com números, como a campanha está e o que vale ajustar. Esta skill NÃO executa nada: pausar, escalar, trocar criativo ou mexer em orçamento só vão para a fila como proposta e pedem o "Aprovar" do Breno.

## Passos

1. Pegue as métricas: use as que o Breno colou; se não houver, procure no banco do Nexus (veja as colunas com `banco_tabelas`, depois um SELECT agregado com `banco_consultar`) e no Atlas (`atlas_buscar`: metas e decisões anteriores da campanha). Sem dado, diga que não achou e peça o período e os números.
2. Para cada campanha ou conjunto, calcule: CTR = cliques / impressões, CPC = gasto / cliques, CPL = gasto / leads, CPA = gasto / vendas, ROAS = receita / gasto.
3. Compare com a meta combinada (preço do produto, ROAS mínimo, gasto mínimo para concluir). Se o gasto ainda é pequeno para concluir, diga "esperar" em vez de sugerir mudança.
4. Classifique cada item: **manter**, **esperar mais dado**, **candidata a pausar** (gastou além do mínimo sem vender ou ROAS abaixo do mínimo) ou **candidata a escalar** (ROAS acima da meta com volume).

## Formato da resposta

- Período e gasto total.
- Tabela curta por campanha: gasto, cliques, leads, vendas, CPA, ROAS, classificação.
- Sugestões (até 3), cada uma com o número que a justifica.
- Última linha: "Sugestões apenas. Quer que eu coloque alguma na fila para o seu Aprovar?"

## Regras

- Nunca invente métrica, meta ou resultado. Sem a meta, use só comparação entre campanhas e avise.
- Sugerir aumento de orçamento é sempre decisão do Breno (ação vermelha); apenas recomende.
- IDs de conta de anúncio completos, credenciais e dados pessoais de leads ficam fora da resposta.
