#!/usr/bin/env bash
# Painel do Jarvis no VPS (item 369 do Nexus). Roda como root no VPS. Instala e também ATUALIZA (rodar de novo = publicar).
#   curl -fsSL https://raw.githubusercontent.com/brenno968-dotcom/jarvis/main/deploy/instalar-painel.sh | bash
# O que faz: baixa o código em /opt/jarvis/src → monta a imagem (segredos da Dory só durante o build) → sobe o container
# jarvis-painel na rede do Caddy do WhatsApp (sem porta aberta para fora) → acrescenta o domínio no Caddy → confere /api/saude.
set -euo pipefail
DOMINIO=${DOMINIO:-jarvis.nexus-hub.api.br}
SRC=/opt/jarvis/src
TOKEN=/opt/jarvis/secrets/bws_token
CADDY=${CADDY:-evolution-caddy-1}
CADDYFILE=${CADDYFILE:-/opt/evolution/Caddyfile}
erro() { echo "ERRO: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || erro "rode como root"
[ -r "$TOKEN" ] || erro "falta o token da Dory em $TOKEN (o mesmo do worker)"
docker ps --format '{{.Names}}' | grep -qx "$CADDY" || erro "não achei o Caddy ($CADDY)"

echo "== 0. Nenhuma publicação do Nexus montando agora (o build do painel usa ~1,5 GB)"
if pgrep -f 'next build' >/dev/null; then erro "tem um 'next build' rodando (publicação do Nexus?). Espere terminar e rode de novo."; fi

echo "== 1. Código"
if [ -d "$SRC/.git" ]; then git -C "$SRC" fetch -q --depth 1 origin main && git -C "$SRC" reset -q --hard origin/main
else mkdir -p /opt/jarvis && git clone -q --depth 1 https://github.com/brenno968-dotcom/jarvis "$SRC"; fi
echo "   versão $(git -C "$SRC" rev-parse --short HEAD)"

echo "== 2. Imagem (segredos da Dory só durante o build)"
DOCKER_BUILDKIT=1 docker build -q -f "$SRC/deploy/painel.Dockerfile" -t jarvis-painel:latest --secret id=bws_token,src="$TOKEN" "$SRC" >/dev/null

echo "== 2b. Variáveis na Dory (só os NOMES que faltam; nenhum valor aparece)"
docker run --rm --entrypoint sh -v "$TOKEN":/run/secrets/bws_token:ro -e HOME=/tmp jarvis-painel:latest -c '
  BWS_ACCESS_TOKEN="$(cat /run/secrets/bws_token)" bws secret list -o json | node -e "
    const tem = new Set(JSON.parse(require(\"fs\").readFileSync(0, \"utf8\")).map((s) => s.key));
    const precisa = [\"NEXT_PUBLIC_SUPABASE_URL\", \"NEXT_PUBLIC_SUPABASE_ANON_KEY\", \"JARVIS_PAINEL_SEGREDO_COOKIE\",
      \"JARVIS_CORE_NEXUS_WEBHOOK_SEGREDO\", \"JARVIS_CORE_NEXUS_AVISOS_URL\", \"JARVIS_CORE_ANTHROPIC_API_KEY\",
      \"JARVIS_NUMEROS_AUTORIZADOS\", \"JARVIS_CORE_APROVACAO_SEGREDO\"];
    const banco = tem.has(\"JARVIS_CORE_DB_PAINEL_URL\") || tem.has(\"DATABASE_URL\");
    const login = tem.has(\"JARVIS_PAINEL_EMAILS\") || tem.has(\"JARVIS_PAINEL_SENHA\");
    const faltam = precisa.filter((n) => !tem.has(n));
    if (!banco) faltam.push(\"JARVIS_CORE_DB_PAINEL_URL (ou DATABASE_URL)\");
    if (!login) faltam.push(\"JARVIS_PAINEL_EMAILS (ou JARVIS_PAINEL_SENHA)\");
    console.log(faltam.length ? \"   FALTAM na Dory: \" + faltam.join(\", \") : \"   Dory completa\");
    for (const o of [\"JARVIS_MODELO_IA_CONVERSA\", \"JARVIS_CORE_MCP_TOKEN\", \"JARVIS_CORE_PULSO_TOKEN\", \"JARVIS_CORE_GMAIL_PUSH_TOKEN\", \"JARVIS_AVISO_EMAILS\", \"JARVIS_PAINEL_AUTH\"])
      if (!tem.has(o)) console.log(\"   (opcional, não tem: \" + o + \")\");
    if (tem.has(\"JARVIS_PAINEL_URL\")) console.log(\"   AVISO: a Dory tem JARVIS_PAINEL_URL: troque para https://'"$DOMINIO"' (o worker lê de lá)\");
  "' || echo "   não consegui ler a lista da Dory (seguindo)"

echo "== 3. Container na rede do Caddy"
REDE=$(docker inspect "$CADDY" -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')
[ -n "$REDE" ] || erro "não achei a rede do Caddy"
docker rm -f jarvis-painel >/dev/null 2>&1 || true
docker run -d --name jarvis-painel --restart unless-stopped --network "$REDE" \
  --memory 768m --cpus 1 \
  -v "$TOKEN":/run/secrets/bws_token:ro -e BWS_ACCESS_TOKEN_FILE=/run/secrets/bws_token \
  -e JARVIS_PAINEL_URL="https://$DOMINIO" -e JARVIS_NEXUS_URL=https://nexus-hub.api.br \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  jarvis-painel:latest >/dev/null

echo "== 4. Domínio no Caddy ($DOMINIO)"
if ! grep -q '>>> Jarvis' "$CADDYFILE"; then
  cp -a "$CADDYFILE" "$CADDYFILE.bak-$(date +%Y%m%d%H%M)"
  printf '\n# >>> Jarvis (item 369) — painel do Jarvis (container jarvis-painel)\n%s {\n\tencode zstd gzip\n\treverse_proxy jarvis-painel:3100\n}\n# <<< Jarvis\n' "$DOMINIO" >> "$CADDYFILE"
fi
docker exec "$CADDY" caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || erro "Caddy inválido: restaure $CADDYFILE.bak-* e rode 'docker exec $CADDY caddy reload --config /etc/caddy/Caddyfile'"
docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile >/dev/null

echo "== 5. Conferência"
for i in $(seq 1 30); do
  if docker exec "$CADDY" wget -qO- http://jarvis-painel:3100/api/saude >/dev/null 2>&1; then echo "   painel respondendo (rede interna)"; break; fi
  sleep 2; [ "$i" = 30 ] && { docker logs --tail 30 jarvis-painel; erro "painel não respondeu em 60 s"; }
done
if curl -fsS -o /dev/null --max-time 20 "https://$DOMINIO/api/saude"; then echo "   https://$DOMINIO OK"
else echo "   AVISO: https://$DOMINIO ainda não responde (DNS ainda propagando? o Caddy pega o certificado sozinho quando o DNS chegar)"; fi
docker stats --no-stream --format '   memória: {{.MemUsage}}' jarvis-painel
echo "PRONTO."
