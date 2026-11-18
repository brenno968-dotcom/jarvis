#!/bin/sh
# Sobe o painel. Os segredos entram pelo `bws run` (Dory) e nunca ficam em arquivo.
# `iniciar`: o painel usa o papel do banco do painel; se a Dory tiver JARVIS_CORE_DB_PAINEL_URL, ela vira o DATABASE_URL.
set -eu

if [ "${1:-}" = "iniciar" ]; then
  if [ -n "${JARVIS_CORE_DB_PAINEL_URL:-}" ]; then DATABASE_URL="$JARVIS_CORE_DB_PAINEL_URL"; export DATABASE_URL; fi
  cd /app/apps/painel
  exec /app/node_modules/.bin/next start -H 0.0.0.0 -p 3100
fi

if [ -n "${BWS_ACCESS_TOKEN_FILE:-}" ] && [ -r "$BWS_ACCESS_TOKEN_FILE" ]; then
  BWS_ACCESS_TOKEN="$(cat "$BWS_ACCESS_TOKEN_FILE")"
  export BWS_ACCESS_TOKEN
  exec bws run -- /usr/local/bin/jarvis-painel-entrypoint iniciar
fi

echo '{"nivel":"aviso","mensagem":"sem Dory (BWS_ACCESS_TOKEN_FILE): usando só variáveis de ambiente do container"}'
exec /usr/local/bin/jarvis-painel-entrypoint iniciar
