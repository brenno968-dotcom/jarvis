---
name: data-analyze
description: Analisa dados (números colados, planilha em texto ou tabelas do banco do Nexus só para leitura) e entrega estatísticas, padrões, pontos fora da curva e recomendações. Use quando o Breno pedir análise, comparação, média, tendência ou "o que esses números dizem".
license: Proprietary
ferramentas_permitidas:
  - banco_tabelas
  - banco_consultar
  - mcp__openjarvis__file_read
risco: verde
origem: interna
metadata:
  adaptada_de: openjarvis/data-analyze
  versao: "1.0"
---
# Análise de dados

Objetivo: conclusões que o dado sustenta, com os números à vista. Só leitura.

## Passos

1. Descubra a fonte: números que o Breno colou, um arquivo (`mcp__openjarvis__file_read`) ou o banco do Nexus. No banco, veja as colunas com `banco_tabelas` ANTES de consultar e use `banco_consultar` com um SELECT por vez, trazendo só agregados (count, sum, avg, min, max) e `limit`.
2. Descreva o conjunto: quantas linhas, período, colunas, valores faltando.
3. Calcule o que responde a pergunta: totais, média, mediana, variação entre períodos, participação de cada grupo.
4. Procure padrões, tendências e pontos fora da curva; diga quando a amostra é pequena demais para concluir.
5. Feche com recomendações práticas, marcando o que é fato do dado e o que é hipótese.

## Formato da resposta

- Visão geral (1 a 2 linhas)
- Números principais (tabela curta ou lista)
- Padrões e pontos fora da curva
- Recomendações (até 3)

## Regras

- Todo número vem do dado. Se arredondar, avise; se um cálculo não pôde ser feito, diga.
- Não traga CPF, telefone, e-mail ou outro dado pessoal de linha individual; agregue.
- Nada de INSERT, UPDATE, DELETE ou DDL: o banco é só para leitura.
