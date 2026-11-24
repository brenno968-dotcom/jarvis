"""Adaptador MCP Streamable HTTP para o OpenJarvis (Item 808).

O OpenJarvis (v1.0.5.dev) NAO expoe MCP por HTTP: `jarvis serve` so monta a API
OpenAI-compativel (FastAPI) e o `MCPServer` existe apenas como biblioteca
(`openjarvis.mcp.server.MCPServer`, metodo `handle(MCPRequest)`). Este script
monta esse MCPServer atras de POST /mcp (JSON-RPC 2.0), com:
  - allowlist de tools vinda do config.toml ([tools].enabled) -- nunca o
    auto-discover, que exporia shell_exec/code_interpreter/etc.;
  - politica de capacidades e rate limit do perfil de seguranca do config;
  - Bearer opcional (OPENJARVIS_MCP_TOKEN).
"""

from __future__ import annotations

import hmac
import logging
import os
import sys

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, Response as RawResponse

from openjarvis.core.config import load_config
from openjarvis.mcp.protocol import (
    INVALID_REQUEST,
    PARSE_ERROR,
    MCPRequest,
    MCPResponse,
)
from openjarvis.mcp.server import MCPServer
from openjarvis.security import setup_security
from openjarvis.tools._paths import validate_allowed_dirs

log = logging.getLogger("openjarvis.mcp_http")

# Tools que NUNCA sobem por este adaptador, mesmo que alguem as liste no config.
PROIBIDAS = frozenset(
    {
        "shell_exec", "docker_shell_exec", "code_interpreter",
        "code_interpreter_docker", "repl", "file_write", "apply_patch",
        "git_commit", "agent_spawn", "agent_kill", "agent_send",
        "channel_send", "http_request", "db_query", "knowledge_sql",
        "image_generate", "text_to_speech", "execute_pending_actions",
        "queue_action", "skill_manage", "user_profile_manage",
    }
)


def _proibida(nome: str) -> bool:
    return nome in PROIBIDAS or nome.startswith("browser_")


def construir_servidor():
    config = load_config()
    brutas = config.tools.enabled or config.agent.tools
    if isinstance(brutas, str):
        brutas = [n for n in brutas.split(",")]
    pedidas = [n.strip() for n in (brutas or []) if n and n.strip()]
    if not pedidas:
        raise SystemExit("[tools].enabled vazio: recuso subir sem allowlist.")
    bloqueadas = [n for n in pedidas if _proibida(n)]
    if bloqueadas:
        raise SystemExit(f"Tools proibidas no config: {bloqueadas}")

    sec = setup_security(config, engine=object())
    base = MCPServer(
        capability_policy=sec.capability_policy,
        rate_limiter=sec.rate_limiter,
        agent_id="openjarvis-mcp-http",
        allowed_dirs=validate_allowed_dirs(config.security.allowed_dirs),
    )
    por_nome = {t.spec.name: t for t in base.get_tools()}
    ausentes = [n for n in pedidas if n not in por_nome]
    if ausentes:
        log.warning("Tools pedidas e indisponiveis (dependencia faltando?): %s", ausentes)
    escolhidas = [por_nome[n] for n in pedidas if n in por_nome]
    return MCPServer(
        tools=escolhidas,
        capability_policy=sec.capability_policy,
        rate_limiter=sec.rate_limiter,
        agent_id="openjarvis-mcp-http",
    )


def _json(resp: MCPResponse) -> RawResponse:
    return RawResponse(content=resp.to_json(), media_type="application/json")


def criar_app() -> FastAPI:
    servidor = construir_servidor()
    token = os.environ.get("OPENJARVIS_MCP_TOKEN", "")
    app = FastAPI(title="openjarvis-mcp-http", docs_url=None, redoc_url=None)

    @app.get("/healthz")
    def healthz():
        return {"ok": True, "tools": sorted(t.spec.name for t in servidor.get_tools())}

    @app.post("/mcp")
    async def mcp(request: Request):
        if token:
            enviado = request.headers.get("authorization", "")
            if not hmac.compare_digest(enviado, f"Bearer {token}"):
                return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            corpo = await request.json()
        except Exception:
            return _json(MCPResponse.error_response(None, PARSE_ERROR, "JSON invalido"))
        if not isinstance(corpo, dict) or "method" not in corpo:
            return _json(
                MCPResponse.error_response(
                    None, INVALID_REQUEST, "Requisicao JSON-RPC invalida"
                )
            )
        # Notificacoes (sem id), ex.: notifications/initialized -> 202 sem corpo.
        if "id" not in corpo:
            return Response(status_code=202)
        req = MCPRequest(
            method=corpo["method"], params=corpo.get("params") or {}, id=corpo["id"]
        )
        # tools/call pode bloquear (rede, LLM): sai da thread do event loop.
        from starlette.concurrency import run_in_threadpool

        resp = await run_in_threadpool(servidor.handle, req)
        return _json(resp)

    return app


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    host = os.environ.get("OPENJARVIS_MCP_HOST", "127.0.0.1")
    port = int(os.environ.get("OPENJARVIS_MCP_PORT", "8765"))
    uvicorn.run(criar_app(), host=host, port=port, log_level="info")
    sys.exit(0)
