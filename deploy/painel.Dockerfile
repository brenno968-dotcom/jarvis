# Painel do Jarvis no VPS (item 369 do Nexus: sai da Vercel). Build a partir da raiz do repositório:
#   DOCKER_BUILDKIT=1 docker build -f deploy/painel.Dockerfile -t jarvis-painel:latest \
#     --secret id=bws_token,src=/opt/jarvis/secrets/bws_token .
# O build roda dentro do `bws run` (Dory): as NEXT_PUBLIC_* entram no build sem ficar em arquivo nem na imagem.
# Quem faz tudo isso: deploy/instalar-painel.sh.
FROM node:22-slim

ARG BWS_VERSAO=2.1.0
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates && \
    curl -fsSL "https://github.com/bitwarden/sdk-sm/releases/download/bws-v${BWS_VERSAO}/bws-x86_64-unknown-linux-gnu-${BWS_VERSAO}.zip" -o /tmp/bws.zip && \
    unzip /tmp/bws.zip -d /usr/local/bin && chmod 755 /usr/local/bin/bws && rm /tmp/bws.zip && \
    apt-get purge -y curl unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
COPY apps/painel/package.json apps/painel/
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund && npm cache clean --force

COPY tsconfig.base.json tsconfig.json ./
COPY packages/core packages/core
COPY apps/painel apps/painel
COPY config config
COPY deploy/painel-entrypoint.sh /usr/local/bin/jarvis-painel-entrypoint
RUN chmod 755 /usr/local/bin/jarvis-painel-entrypoint

ENV NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=1536
RUN --mount=type=secret,id=bws_token \
    BWS_ACCESS_TOKEN="$(cat /run/secrets/bws_token)" HOME=/tmp bws run -- npm run build -w @jarvis/painel

RUN useradd --uid 1001 --no-create-home --shell /usr/sbin/nologin jarvis && chown -R 1001:1001 /app/apps/painel/.next
USER 1001:1001
ENV NODE_ENV=production HOME=/tmp NODE_OPTIONS=--max-old-space-size=512 JARVIS_REGRAS=/app/config/regras.yaml
EXPOSE 3100
ENTRYPOINT ["/usr/local/bin/jarvis-painel-entrypoint"]
