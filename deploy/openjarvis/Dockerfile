# OpenJarvis (piloto Item 808) - servidor MCP HTTP interno, so leitura.
# Build a partir da raiz do repositorio:
#   docker build -f deploy/openjarvis/Dockerfile -t openjarvis-mcp:latest .
FROM python:3.12-slim

# Commit fixado do open-jarvis/OpenJarvis (descendente da tag v1.0.5.dev1374; Apache-2.0).
# Para atualizar: trocar o SHA, rebuild e repetir o teste de tools/list.
ARG OPENJARVIS_SHA=484de900c7238442d4e049e185de6af679519192

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

# Tarball do GitHub evita instalar git na imagem. Extras: server (fastapi/uvicorn) e
# inference-cloud (anthropic/openai, para o engine cloud caso se use `jarvis serve`).
RUN pip install "openjarvis[server,inference-cloud] @ https://github.com/open-jarvis/OpenJarvis/archive/${OPENJARVIS_SHA}.tar.gz"

RUN useradd --uid 1002 --create-home --home-dir /data --shell /usr/sbin/nologin openjarvis \
 && mkdir -p /data/workspace /data/.openjarvis /etc/openjarvis \
 && chown -R 1002:1002 /data

COPY deploy/openjarvis/config.toml /etc/openjarvis/config.toml
COPY deploy/openjarvis/mcp_http.py /app/mcp_http.py

USER 1002:1002
ENV HOME=/data \
    OPENJARVIS_HOME=/data/.openjarvis \
    OPENJARVIS_CONFIG=/etc/openjarvis/config.toml \
    OPENJARVIS_MCP_HOST=0.0.0.0 \
    OPENJARVIS_MCP_PORT=8765
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/healthz',timeout=4).status==200 else 1)"

CMD ["python", "/app/mcp_http.py"]
