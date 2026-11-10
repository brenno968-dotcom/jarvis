# Integração Jarvis ↔ Nexus (WhatsApp do Breno)

O Jarvis não fala com o WhatsApp diretamente. Ele usa o número do Nexus que já conversa com o Breno.
São duas chamadas HTTP, ambas assinadas com o mesmo segredo compartilhado.

## Segredo e assinatura

- Segredo: `JARVIS_CORE_NEXUS_WEBHOOK_SEGREDO` (mínimo 32 caracteres), guardado na Dory e configurado nos dois lados.
- Cabeçalhos em toda chamada:
  - `x-jarvis-timestamp`: segundos Unix do envio.
  - `x-jarvis-assinatura`: HMAC-SHA256 em hexadecimal de `"<timestamp>.<corpo exato>"`.
- Quem recebe recusa se a assinatura não bater ou se o timestamp tiver mais de 5 minutos de diferença.
- Implementação de referência: `packages/core/src/assinatura.ts`.

## 1. Jarvis → Nexus: mandar aviso ao Breno

- O worker faz `POST` em `JARVIS_CORE_NEXUS_AVISOS_URL` (endpoint a criar no Nexus).
- Corpo (`MensagemParaBreno`, em `packages/core/src/avisos.ts`):

```json
{
  "aviso_id": "uuid",
  "tipo": "pedido_aprovacao",
  "texto": "Jarvis precisa do seu OK:\nCriar conta na Hotmart\n\nVale até 14:30.",
  "botoes": [
    { "id": "aprovar:<token>", "titulo": "Aprovar" },
    { "id": "recusar:<token>", "titulo": "Recusar" }
  ]
}
```

- `tipo`: `pedido_aprovacao`, `lembrete_aprovacao`, `emergencia`, `pedido_humano` ou `texto`.
- `botoes` (opcional): o Nexus manda como **botões de resposta** do WhatsApp, usando `id` como identificador do botão. O id carrega o token de uso único; **o Nexus não deve guardar nem registrar esse id em log**.
- `link` (opcional): mandar como texto ou botão de link (ex.: navegador ao vivo, Fase 2).
- Destinatário: sempre o número do Breno configurado no Nexus. O Jarvis não escolhe destinatário.
- Resposta esperada: HTTP 2xx. Qualquer outra coisa = o Jarvis tenta de novo (até 5 vezes, com espera crescente).

## 2. Nexus → Jarvis: resposta do Breno

- Quando o Breno tocar num botão de um aviso do Jarvis, ou mandar uma mensagem de texto ao número, o Nexus faz `POST` em `https://<painel-do-jarvis>/api/aprovacoes/whatsapp`, assinado.
- Corpo, um destes:

```json
{ "tipo": "botao", "numero": "5562999990000", "botao_id": "aprovar:<token>" }
```

```json
{ "tipo": "texto", "numero": "5562999990000", "texto": "PARA TUDO" }
```

- `numero`: o número de quem mandou, como veio da Meta. O Jarvis confere contra `aprovacao.numeros_autorizados` do `config/regras.yaml`.
- Só repassar ao Jarvis: toques em botões cujo id começa com `aprovar:`/`recusar:` e mensagens de texto vindas do número do Breno (o Jarvis confere de novo).
- Resposta do Jarvis: `{ "ok": true, "resultado": ... }`. Webhook repetido (mesma assinatura) é ignorado.

## O que falta no Nexus

1. Endpoint que recebe o aviso do Jarvis e manda ao Breno (texto + botões de resposta).
2. No webhook da Meta do Nexus: reconhecer toques em botões `aprovar:`/`recusar:` e o texto "PARA TUDO" vindos do número do Breno, e repassar ao Jarvis.
3. Configurar o segredo compartilhado nos dois lados (pela Dory).

## 3. Vendas (Fase 6) — o que o Nexus precisa saber

O atendimento e a venda continuam nos módulos do Nexus. O lado do Jarvis já tem:

- **Opt-in** (`packages/core/src/vendas/optin.ts`): `registrarOptin` guarda o texto exato que a pessoa aceitou e a origem; `podeContatar` é a checagem obrigatória antes de qualquer primeiro contato; `revogarOptin` atende o descadastro na hora; `ehPedidoDescadastro` reconhece "sair", "parar", "não quero mais receber"…
- **Pagamentos** (`vendas/pagamentos.ts` + rota `/api/pagamentos/<asaas|hotmart>/<negocio_id>`): venda registrada uma vez só, aviso "venda feita" ao Breno, estorno descontado do resultado.

Falta combinar (próxima etapa, com o Nexus):
1. Quando um lead com opt-in chega (formulário/anúncio), quem chama `registrarOptin`: o Nexus avisa o Jarvis, ou o Jarvis grava e avisa o Nexus para começar o atendimento.
2. O Nexus nunca inicia conversa com quem não está em `contatos_optin` daquele negócio.
3. Descadastro recebido pelo Nexus → chamar o Jarvis para `revogarOptin` (ou o contrário).
4. Cobranças do Asaas criadas pelo Nexus para negócios do Jarvis: configurar o webhook do Asaas apontando para `/api/pagamentos/asaas/<negocio_id>`.
