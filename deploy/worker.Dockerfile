# Worker do Jarvis (VPS). Build a partir da raiz do repositório:
#   docker build -f deploy/worker.Dockerfile -t jarvis-worker:latest .
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
COPY apps/painel/package.json apps/painel/
RUN npm ci --omit=dev -w @jarvis/worker --no-audit --no-fund && npm cache clean --force

COPY packages/core packages/core
COPY apps/worker apps/worker
COPY config config
COPY deploy/entrypoint.sh /usr/local/bin/jarvis-entrypoint
RUN chmod 755 /usr/local/bin/jarvis-entrypoint

# CLI do Bitwarden Secrets Manager (bws). CONFERIR versão e URL na página de releases
# (github.com/bitwarden/sdk-sm/releases) antes do primeiro build; usar versão com mais de 14 dias.
ARG BWS_URL=""
RUN if [ -n "$BWS_URL" ]; then \
      apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates && \
      curl -fsSL "$BWS_URL" -o /tmp/bws.zip && unzip /tmp/bws.zip -d /usr/local/bin && chmod 755 /usr/local/bin/bws && \
      rm /tmp/bws.zip && apt-get purge -y curl unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*; \
    fi

RUN useradd --uid 1001 --no-create-home --shell /usr/sbin/nologin jarvis
USER 1001:1001
ENV NODE_ENV=production HOME=/tmp TSX_DISABLE_CACHE=1
ENTRYPOINT ["/usr/local/bin/jarvis-entrypoint"]
