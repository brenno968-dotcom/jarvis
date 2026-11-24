# Painel do Jarvis no VPS (item 369 do Nexus: sai da Vercel). Build a partir da raiz do repositório:
#   docker build -f deploy/painel.Dockerfile -t jarvis-painel:latest \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=... --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... .
# Só valores PÚBLICOS entram no build. Os segredos ficam em /opt/jarvis/painel.env (600, igual ao worker.env) e entram
# no container na hora de subir (--env-file). Quem faz tudo isso: deploy/instalar-painel.sh.
FROM node:22-slim

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
COPY skills skills

ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=""
ENV NEXT_TELEMETRY_DISABLED=1
RUN NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
    NODE_OPTIONS=--max-old-space-size=1536 npm run build -w @jarvis/painel

RUN useradd --uid 1001 --no-create-home --shell /usr/sbin/nologin jarvis && chown -R 1001:1001 /app/apps/painel/.next
USER 1001:1001
WORKDIR /app/apps/painel
ENV NODE_ENV=production HOME=/tmp NODE_OPTIONS=--max-old-space-size=512 JARVIS_REGRAS=/app/config/regras.yaml JARVIS_SKILLS=/app/skills
EXPOSE 3100
CMD ["/app/node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3100"]
