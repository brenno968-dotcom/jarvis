#!/usr/bin/env bash
# Painel do Jarvis no VPS (item 369 do Nexus). Roda como root no VPS. Instala e também ATUALIZA (rodar de novo = publicar).
#   curl -fsSL https://raw.githubusercontent.com/brenno968-dotcom/jarvis/main/deploy/instalar-painel.sh \
#     | SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON=<chave anon, pública> EMAILS=<e-mail do Breno> bash
# (as 3 variáveis só são pedidas na PRIMEIRA vez; depois ficam em /opt/jarvis/painel.env)
#
# Segredos: mesmo padrão do worker (arquivo 600 em /opt/jarvis). Na primeira vez o painel.env é montado assim:
#   - copiados do worker.env: segredo das aprovações, segredo do Nexus, números autorizados, URL de avisos, chave da IA;
#   - gerados AQUI (nunca saem do VPS): segredo do cookie e a senha nova do papel jarvis_painel_login do banco;
#   - o banco recebe só o VERIFICADOR SCRAM da senha (um resumo, não a senha): o script mostra e o Claude aplica.
set -euo pipefail
DOMINIO=${DOMINIO:-jarvis.nexus-hub.api.br}
SRC=/opt/jarvis/src
WENV=/opt/jarvis/worker.env
PENV=/opt/jarvis/painel.env
CADDY=${CADDY:-evolution-caddy-1}
CADDYFILE=${CADDYFILE:-/opt/evolution/Caddyfile}
erro() { echo "ERRO: $*" >&2; exit 1; }
valor() { grep -m1 "^$1=" "$2" | cut -d= -f2- || true; }

[ "$(id -u)" = 0 ] || erro "rode como root"
[ -r "$WENV" ] || erro "não achei $WENV (env do worker)"
docker ps --format '{{.Names}}' | grep -qx "$CADDY" || erro "não achei o Caddy ($CADDY)"
if pgrep -f 'next build' >/dev/null; then erro "tem um 'next build' rodando (publicação do Nexus?). Espere terminar e rode de novo."; fi

echo "== 1. Código"
if [ -d "$SRC/.git" ]; then git -C "$SRC" fetch -q --depth 1 origin main && git -C "$SRC" reset -q --hard origin/main
else mkdir -p /opt/jarvis && git clone -q --depth 1 https://github.com/brenno968-dotcom/jarvis "$SRC"; fi
echo "   versão $(git -C "$SRC" rev-parse --short HEAD)"

echo "== 2. Configuração ($PENV)"
if [ ! -f "$PENV" ]; then
  [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_ANON:-}" ] && [ -n "${EMAILS:-}" ] || erro "primeira vez: passe SUPABASE_URL, SUPABASE_ANON e EMAILS"
  SENHA_DB=$(openssl rand -hex 24)
  DB_PAINEL=$(WURL="$(valor DATABASE_URL "$WENV")" SENHA="$SENHA_DB" python3 -c '
import os, urllib.parse as u
p = u.urlsplit(os.environ["WURL"])
usuario = u.unquote(p.username).replace("jarvis_worker_login", "jarvis_painel_login")
if "jarvis_painel_login" not in usuario: raise SystemExit("DATABASE_URL do worker não usa jarvis_worker_login")
host = p.hostname + (":%d" % p.port if p.port else "")
print(u.urlunsplit((p.scheme, "%s:%s@%s" % (u.quote(usuario, safe="."), os.environ["SENHA"], host), p.path, p.query, "")))')
  umask 077
  {
    echo "# Painel do Jarvis (item 369) — montado por deploy/instalar-painel.sh em $(date -Is). Permissão 600."
    echo "DATABASE_URL=$DB_PAINEL"
    echo "NEXT_PUBLIC_SUPABASE_URL=$SUPABASE_URL"
    echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=$SUPABASE_ANON"
    echo "JARVIS_PAINEL_AUTH=supabase"
    echo "JARVIS_PAINEL_EMAILS=$EMAILS"
    echo "JARVIS_PAINEL_SEGREDO_COOKIE=$(openssl rand -hex 32)"
    echo "JARVIS_PAINEL_URL=https://$DOMINIO"
    echo "JARVIS_NEXUS_URL=https://nexus-hub.api.br"
    for n in JARVIS_CORE_APROVACAO_SEGREDO JARVIS_CORE_NEXUS_WEBHOOK_SEGREDO JARVIS_NUMEROS_AUTORIZADOS JARVIS_CORE_NEXUS_AVISOS_URL JARVIS_CORE_ANTHROPIC_API_KEY; do
      v=$(valor "$n" "$WENV"); [ -n "$v" ] && echo "$n=$v" || echo "   (o worker.env não tem $n)" >&2
    done
  } > "$PENV"
  chmod 600 "$PENV"
  VERIF=$(SENHA="$SENHA_DB" python3 -c '
import os, hashlib, hmac, base64
s = os.urandom(16); i = 4096; senha = os.environ["SENHA"].encode()
k = hashlib.pbkdf2_hmac("sha256", senha, s, i)
ck = hmac.new(k, b"Client Key", "sha256").digest(); sk = hmac.new(k, b"Server Key", "sha256").digest()
b = lambda x: base64.b64encode(x).decode()
print("SCRAM-SHA-256$%d:%s$%s:%s" % (i, b(s), b(hashlib.sha256(ck).digest()), b(sk)))')
  unset SENHA_DB
  echo "   VERIFICADOR do banco (não é a senha; o Claude aplica no papel jarvis_painel_login):"
  echo "   $VERIF"
else
  echo "   já existe (mantido)"
fi
PUB_URL=$(valor NEXT_PUBLIC_SUPABASE_URL "$PENV"); PUB_ANON=$(valor NEXT_PUBLIC_SUPABASE_ANON_KEY "$PENV")

echo "== 3. Imagem (3 a 5 min)"
docker build -q -f "$SRC/deploy/painel.Dockerfile" -t jarvis-painel:latest \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$PUB_URL" --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY="$PUB_ANON" "$SRC" >/dev/null

echo "== 4. Container na rede do Caddy"
REDE=$(docker inspect "$CADDY" -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')
[ -n "$REDE" ] || erro "não achei a rede do Caddy"
docker rm -f jarvis-painel >/dev/null 2>&1 || true
docker run -d --name jarvis-painel --restart unless-stopped --network "$REDE" --memory 768m --cpus 1 \
  --env-file "$PENV" --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  jarvis-painel:latest >/dev/null

echo "== 5. Domínio no Caddy ($DOMINIO)"
if ! grep -q '>>> Jarvis' "$CADDYFILE"; then
  cp -a "$CADDYFILE" "$CADDYFILE.bak-$(date +%Y%m%d%H%M)"
  printf '\n# >>> Jarvis (item 369) — painel do Jarvis (container jarvis-painel)\n%s {\n\tencode zstd gzip\n\treverse_proxy jarvis-painel:3100\n}\n# <<< Jarvis\n' "$DOMINIO" >> "$CADDYFILE"
fi
docker exec "$CADDY" caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 || erro "Caddy inválido: restaure $CADDYFILE.bak-* e rode 'docker exec $CADDY caddy reload --config /etc/caddy/Caddyfile'"
docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile >/dev/null

echo "== 6. Conferência"
for i in $(seq 1 30); do
  if docker exec "$CADDY" wget -qO- http://jarvis-painel:3100/entrar >/dev/null 2>&1; then echo "   painel respondendo (rede interna)"; break; fi
  sleep 2; [ "$i" = 30 ] && { docker logs --tail 30 jarvis-painel; erro "painel não respondeu em 60 s"; }
done
if curl -fsS -o /dev/null --max-time 20 "https://$DOMINIO/entrar"; then echo "   https://$DOMINIO OK"
else echo "   AVISO: https://$DOMINIO ainda não responde (DNS propagando? o Caddy pega o certificado sozinho quando o DNS chegar)"; fi
docker stats --no-stream --format '   memória: {{.MemUsage}}' jarvis-painel
echo "PRONTO."
