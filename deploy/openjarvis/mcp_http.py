"""Adaptador MCP Streamable HTTP para o OpenJarvis (Item 808).

O OpenJarvis (v1.0.5.dev) NAO expoe MCP por HTTP: `jarvis serve` so monta a API
OpenAI-compativel (FastAPI) e o `MCPServer` existe apenas como biblioteca
(`openjarvis.mcp.server.MCPServer`, metodo `handle(MCPRequest)`). Este script
monta esse MCPServer atras de POST /mcp (JSON-RPC 2.0), com:
  - allowlist de tools vinda do config.toml ([tools].enabled) -- nunca o
    auto-discover, que exporia shell_exec/code_interpreter/etc.;
  - politica de capacidades e rate limit do perfil de seguranca do config;
  - Bearer opcional (OPENJARVIS_MCP_TOKEN);
  - duas tools que rodam AGENTES do OpenJarvis (`deep_research`, `morning_digest`),
    so se listadas em [tools].enabled. Os agentes recebem APENAS tools seguras
    (a allowlist sem os proprios agentes; o digest recebe so `digest_collect`),
    nunca shell/file_write/browser/agent_spawn. Teto de passos, prazo total
    (OPENJARVIS_AGENT_TIMEOUT, 600s) e LoopGuard do proprio OpenJarvis.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutTimeout
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, Response as RawResponse

from openjarvis.core.config import load_config
from openjarvis.core.types import ToolCall
from openjarvis.mcp.protocol import (
    INVALID_PARAMS,
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


# ---------------------------------------------------------------------------
# Tools que rodam agentes do OpenJarvis
# ---------------------------------------------------------------------------

AGENTES = ("deep_research", "morning_digest")
TIMEOUT_AGENTE_S = float(os.environ.get("OPENJARVIS_AGENT_TIMEOUT", "600"))
PASSOS_TETO = int(os.environ.get("OPENJARVIS_AGENT_MAX_STEPS", "12"))
PROFUNDIDADE_PASSOS = {"rapida": 3, "normal": 6, "profunda": 10}
# Conectores do digest: so os que o MorningDigest conhece; sem credencial = pulados.
FUSO_DIGEST = os.environ.get("OPENJARVIS_DIGEST_TZ", "America/Sao_Paulo")
DB_DIGEST = os.environ.get("OPENJARVIS_DIGEST_DB", "/tmp/openjarvis-digest.db")

_SPEC_DEEP_RESEARCH = {
    "name": "deep_research",
    "description": (
        "Pesquisa em varios passos (agente DeepResearch do OpenJarvis) com busca na web; "
        "devolve um relatorio e a lista de fontes. Pode levar minutos (teto de 600s)."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "pergunta": {"type": "string", "description": "Pergunta ou tema da pesquisa."},
            "profundidade": {
                "type": "string",
                "enum": list(PROFUNDIDADE_PASSOS),
                "description": "rapida (3 passos), normal (6, padrao) ou profunda (10).",
            },
            "limite_passos": {
                "type": "integer",
                "minimum": 1,
                "description": f"Teto de passos do agente (1..{PASSOS_TETO}); vence 'profundidade'.",
            },
        },
        "required": ["pergunta"],
    },
}
_SPEC_MORNING_DIGEST = {
    "name": "morning_digest",
    "description": (
        "Resumo matinal em texto (agente MorningDigest do OpenJarvis, sem audio/TTS) a partir "
        "dos conectores configurados. Fontes sem conector/credencial sao puladas sem erro."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "data": {
                "type": "string",
                "description": "YYYY-MM-DD; janela = desde 00:00 desse dia ate agora (padrao: ultimas 24h).",
            },
            "fontes": {
                "type": "array",
                "items": {"type": "string"},
                "description": "IDs de conectores (ex.: gmail, gcalendar, weather). Padrao: todas as secoes.",
            },
        },
    },
}
_SPECS_AGENTES = {"deep_research": _SPEC_DEEP_RESEARCH, "morning_digest": _SPEC_MORNING_DIGEST}

_URL_RE = re.compile(r"https?://[^\s)\]>\"']+")


class _PrazoExcedido(Exception):
    pass


class _MotorComPrazo:
    """Embrulha o engine: depois do prazo (ou cancelamento) nenhuma geracao nova sai."""

    def __init__(self, motor: Any, prazo: float, cancelado: threading.Event):
        self._motor = motor
        self._prazo = prazo
        self._cancelado = cancelado

    def generate(self, *a: Any, **kw: Any):
        if self._cancelado.is_set() or time.monotonic() > self._prazo:
            raise _PrazoExcedido("prazo do agente excedido")
        return self._motor.generate(*a, **kw)

    def __getattr__(self, nome: str):
        return getattr(self._motor, nome)


class Agentes:
    """Instancia e roda DeepResearch/MorningDigest com tools seguras e prazo."""

    def __init__(self, config, sec, tools_seguras: List[Any], habilitados: List[str]):
        self.config = config
        self.sec = sec
        self.habilitados = habilitados
        # Defesa em profundidade: nada perigoso entra nos agentes.
        for t in tools_seguras:
            if _proibida(t.spec.name) or t.spec.name in AGENTES:
                raise SystemExit(f"Tool nao permitida para agentes: {t.spec.name}")
        self.tools_seguras = tools_seguras
        self._motor: Optional[Any] = None
        self._lock = threading.Lock()
        self._vagas = threading.BoundedSemaphore(int(os.environ.get("OPENJARVIS_AGENT_CONCURRENCY", "2")))
        self._pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="agente")

    def _engine(self):
        with self._lock:
            if self._motor is None:
                from openjarvis.engine._discovery import get_engine

                modelo = self.config.intelligence.default_model
                achado = get_engine(self.config, self.config.engine.default, modelo)
                if achado is None:
                    raise RuntimeError(f"engine '{self.config.engine.default}' indisponivel")
                self._motor = achado[1]
            return self._motor

    def _comuns(self, motor: Any) -> Dict[str, Any]:
        return dict(
            capability_policy=self.sec.capability_policy,
            rate_limiter=self.sec.rate_limiter,
            loop_guard_config={"enabled": True, "max_identical_calls": 2, "poll_tool_budget": 4},
        )

    # -- deep_research ------------------------------------------------------
    def _rodar_deep_research(self, args: Dict[str, Any], motor: Any) -> str:
        from openjarvis.agents.deep_research import DeepResearchAgent

        pergunta = str(args.get("pergunta") or "").strip()
        if not pergunta:
            raise ValueError("'pergunta' obrigatoria")
        passos = args.get("limite_passos")
        if passos is None:
            passos = PROFUNDIDADE_PASSOS.get(str(args.get("profundidade") or "normal"), 6)
        passos = max(1, min(int(passos), PASSOS_TETO))
        agente = DeepResearchAgent(
            motor,
            self.config.intelligence.default_model,
            tools=list(self.tools_seguras),
            max_turns=passos,
            agent_id="openjarvis-mcp-deep-research",
            **self._comuns(motor),
        )
        res = agente.run(pergunta)
        fontes: List[str] = list(res.metadata.get("sources") or [])
        for tr in res.tool_results:
            if tr.tool_name == "web_search" and tr.success:
                for u in _URL_RE.findall(tr.content or ""):
                    u = u.rstrip(".,;")
                    if u not in fontes:
                        fontes.append(u)
        corpo = (res.content or "").strip() or "(sem relatorio: o agente nao produziu texto)"
        rodape = "\n".join(f"- {f}" for f in fontes[:30]) or "- (nenhuma fonte coletada)"
        return f"{corpo}\n\nFontes:\n{rodape}\n\n[passos usados: {res.turns}/{passos}]"

    # -- morning_digest -----------------------------------------------------
    def _rodar_morning_digest(self, args: Dict[str, Any], motor: Any) -> str:
        from openjarvis.agents.morning_digest import MorningDigestAgent
        from openjarvis.tools.digest_collect import DigestCollectTool

        horas = 24.0
        data = args.get("data")
        if data:
            try:
                ini = datetime.strptime(str(data), "%Y-%m-%d")
            except ValueError:
                raise ValueError("'data' deve ser YYYY-MM-DD") from None
            if ini > datetime.now():
                raise ValueError("'data' no futuro")
            horas = min(max(24.0, (datetime.now() - ini).total_seconds() / 3600), 24 * 14)

        padrao = {
            "messages": ["gmail", "slack", "google_tasks", "imessage", "github_notifications"],
            "calendar": ["gcalendar"],
            "health": ["oura", "apple_health"],
            "world": ["weather", "hackernews", "news_rss"],
        }
        fontes = args.get("fontes")
        sections = list(padrao)
        section_sources: Dict[str, List[str]] = {}
        if fontes:
            if not isinstance(fontes, list):
                raise ValueError("'fontes' deve ser lista de IDs")
            pedidas = [str(f).strip() for f in fontes if str(f).strip()]
            section_sources = {k: [s for s in v if s in pedidas] for k, v in padrao.items()}
            sections = [k for k, v in section_sources.items() if v]
            conhecidas = {s for v in padrao.values() for s in v}
            extras = [s for s in pedidas if s not in conhecidas]
            if extras:  # conector desconhecido: o collector o pula ("not available").
                sections.append("outros")
                section_sources["outros"] = extras
            if not sections:
                raise ValueError("'fontes' vazia")

        class _Digest(MorningDigestAgent):
            def __init__(inner, *a: Any, **kw: Any):
                super().__init__(*a, **kw)
                original = inner._executor.execute

                def execute(call: ToolCall):
                    if call.name == "digest_collect":
                        corpo = json.loads(call.arguments or "{}")
                        corpo["hours_back"] = horas
                        call = ToolCall(id=call.id, name=call.name, arguments=json.dumps(corpo))
                    res = original(call)
                    if call.name == "digest_collect" and isinstance(res.content, str):
                        # Fontes sem conector/credencial: puladas em silencio (o 2b as cita no texto).
                        res.content = res.content.split("=== ERRORS ===")[0].strip() or "(sem dados)"
                    return res

                inner._executor.execute = execute  # type: ignore[method-assign]

            def _build_system_prompt(inner) -> str:
                return super()._build_system_prompt() + (
                    "\n\nEscreva o resumo em portugues do Brasil, somente texto."
                )

        agente = _Digest(
            motor,
            self.config.intelligence.default_model,
            tools=[DigestCollectTool()],  # sem text_to_speech: nenhum audio e gerado
            sections=sections,
            section_sources=section_sources,
            timezone=FUSO_DIGEST,
            digest_store_path=DB_DIGEST,
            max_turns=1,
            agent_id="openjarvis-mcp-morning-digest",
            **self._comuns(motor),
        )
        res = agente.run("morning digest")
        meta = res.tool_results[0].metadata if res.tool_results else {}
        usadas = meta.get("sources_ok") or []
        puladas = [e for e in (meta.get("sources_failed") or [])]
        texto = (res.content or "").strip() or "(sem dados nas fontes configuradas)"
        return (
            f"{texto}\n\nFontes usadas: {', '.join(usadas) or 'nenhuma'}"
            f"\nFontes puladas: {len(puladas)}"
        )

    # -- execucao com prazo -------------------------------------------------
    def chamar(self, nome: str, args: Dict[str, Any]) -> Dict[str, Any]:
        if not self._vagas.acquire(blocking=False):
            return _resultado("Servidor ocupado com outros agentes; tente de novo.", erro=True)
        cancelado = threading.Event()
        prazo = time.monotonic() + TIMEOUT_AGENTE_S

        def trabalho() -> str:
            try:
                motor = _MotorComPrazo(self._engine(), prazo, cancelado)
                if nome == "deep_research":
                    return self._rodar_deep_research(args, motor)
                return self._rodar_morning_digest(args, motor)
            finally:
                self._vagas.release()

        try:
            fut = self._pool.submit(trabalho)
        except Exception:
            self._vagas.release()
            raise
        try:
            return _resultado(fut.result(timeout=TIMEOUT_AGENTE_S))
        except FutTimeout:
            cancelado.set()
            return _resultado(f"Agente {nome} excedeu {TIMEOUT_AGENTE_S:.0f}s e foi cancelado.", erro=True)
        except _PrazoExcedido:
            return _resultado(f"Agente {nome} excedeu {TIMEOUT_AGENTE_S:.0f}s e foi cancelado.", erro=True)
        except (ValueError, TypeError) as exc:
            return _resultado(f"Argumentos invalidos: {exc}", erro=True)
        except Exception as exc:  # noqa: BLE001
            log.exception("agente %s falhou", nome)
            return _resultado(f"Agente {nome} falhou: {type(exc).__name__}: {exc}", erro=True)


def _resultado(texto: str, erro: bool = False) -> Dict[str, Any]:
    return {"content": [{"type": "text", "text": texto}], "isError": erro}


class ServidorComAgentes(MCPServer):
    """MCPServer + tools de agente (despachadas fora do ToolExecutor, que tem timeout de 30s)."""

    def __init__(self, *args: Any, agentes: Optional[Agentes] = None, **kw: Any):
        super().__init__(*args, **kw)
        self._agentes = agentes

    def _nomes_agentes(self) -> List[str]:
        return list(self._agentes.habilitados) if self._agentes else []

    def get_tools(self):  # usado por /healthz
        return super().get_tools()

    def nomes(self) -> List[str]:
        return sorted([t.spec.name for t in self.get_tools()] + self._nomes_agentes())

    def _handle_tools_list(self, req: MCPRequest) -> MCPResponse:
        base = super()._handle_tools_list(req)
        for n in self._nomes_agentes():
            entrada = dict(_SPECS_AGENTES[n])
            entrada["annotations"] = {"readOnlyHint": True, "destructiveHint": False}
            base.result["tools"].append(entrada)
        return base

    def _handle_tools_call(self, req: MCPRequest) -> MCPResponse:
        nome = req.params.get("name")
        if nome in AGENTES:
            if nome not in self._nomes_agentes():
                return MCPResponse.error_response(req.id, INVALID_PARAMS, f"Unknown tool: {nome}")
            args = req.params.get("arguments") or {}
            if not isinstance(args, dict):
                return MCPResponse.error_response(req.id, INVALID_PARAMS, "arguments deve ser objeto")
            return MCPResponse(result=self._agentes.chamar(nome, args), id=req.id)
        return super()._handle_tools_call(req)


def construir_servidor():
    config = load_config()
    brutas = config.tools.enabled or config.agent.tools
    if isinstance(brutas, str):
        brutas = [n for n in brutas.split(",")]
    todas = [n.strip() for n in (brutas or []) if n and n.strip()]
    pedidas = [n for n in todas if n not in AGENTES]
    agentes_pedidos = [n for n in todas if n in AGENTES]
    if not todas:
        raise SystemExit("[tools].enabled vazio: recuso subir sem allowlist.")
    bloqueadas = [n for n in todas if _proibida(n)]
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
    agentes = Agentes(config, sec, escolhidas, agentes_pedidos) if agentes_pedidos else None
    return ServidorComAgentes(
        tools=escolhidas,
        capability_policy=sec.capability_policy,
        rate_limiter=sec.rate_limiter,
        agent_id="openjarvis-mcp-http",
        agentes=agentes,
    )


def _json(resp: MCPResponse) -> RawResponse:
    return RawResponse(content=resp.to_json(), media_type="application/json")


def criar_app() -> FastAPI:
    servidor = construir_servidor()
    token = os.environ.get("OPENJARVIS_MCP_TOKEN", "")
    app = FastAPI(title="openjarvis-mcp-http", docs_url=None, redoc_url=None)

    @app.get("/healthz")
    def healthz():
        return {"ok": True, "tools": servidor.nomes()}

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
