#!/bin/sh
# Sobe o worker. Com a Dory configurada, os segredos entram pelo `bws run`
# (só os da conta de máquina do Jarvis) e nunca ficam em arquivo.
set -eu
WORKER="/app/node_modules/.bin/tsx /app/apps/worker/src/main.ts"

if [ -n "${BWS_ACCESS_TOKEN_FILE:-}" ] && [ -r "$BWS_ACCESS_TOKEN_FILE" ]; then
  if ! command -v bws >/dev/null 2>&1; then
    echo '{"nivel":"erro","mensagem":"BWS_ACCESS_TOKEN_FILE definido, mas o bws não está instalado na imagem"}'
    exit 1
  fi
  BWS_ACCESS_TOKEN="$(cat "$BWS_ACCESS_TOKEN_FILE")"
  export BWS_ACCESS_TOKEN
  exec bws run -- $WORKER
fi

echo '{"nivel":"aviso","mensagem":"sem Dory (BWS_ACCESS_TOKEN_FILE): usando só variáveis de ambiente do container"}'
exec $WORKER
