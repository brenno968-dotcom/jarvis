# OpenJarvis (piloto, Item 808)

MCP HTTP interno com tools de leitura. O OpenJarvis nao tem endpoint MCP proprio: `mcp_http.py` monta o
`MCPServer` dele em `POST /mcp` (JSON-RPC 2.0, Streamable HTTP simples) e `GET /healthz`.
Sobe so as tools de `[tools].enabled` em `config.toml`; as perigosas (shell_exec, docker_shell_exec,
code_interpreter, file_write, apply_patch, git_commit, browser_*, agent_spawn, ...) sao recusadas na subida.
Perfil `server` (modo block, 30 rpm, capabilities default-deny). Engine `cloud`, modelo `claude-haiku-5-5`.

## Subir no VPS
1. `docker build -f deploy/openjarvis/Dockerfile -t openjarvis-mcp:latest .` (raiz do repo; pina o commit 484de90).
2. Env no VPS (via bws, nunca no compose): `OPENJARVIS_MCP_TOKEN` (aleatorio, >=32 chars) e, se for usar engine cloud, `ANTHROPIC_API_KEY`.
3. Juntar o servico `openjarvis` e a rede `jarvis-interna` ao compose do VPS (ver `deploy/docker-compose.yml`) e `docker compose up -d openjarvis`.
4. No worker: `JARVIS_CORE_OPENJARVIS_MCP_URL=http://openjarvis:8765/mcp` e o mesmo token como Bearer.
5. Teste de dentro do worker:
   `curl -s -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "Authorization: Bearer $OPENJARVIS_MCP_TOKEN" http://openjarvis:8765/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`

Tools expostas: calculator, think, web_search, file_read (so /data/workspace), memory_search, memory_retrieve, mais os agentes `deep_research` e `morning_digest` (abaixo).
Memoria: ~55 MB de RSS medidos no Mac apos chamadas (limite 256m). Sem porta publica.

## Agentes (tools `deep_research` e `morning_digest`)
Aparecem em `tools/list` so se listadas em `[tools].enabled`; tirar do config as desliga. O adaptador instancia o agente do
OpenJarvis (`DeepResearchAgent` / `MorningDigestAgent`, `ToolUsingAgent`) com o engine do config (`[engine].default` +
`[intelligence].default_model`), a politica de capacidades e o rate limit do perfil, e LoopGuard ligado (3 repeticoes bloqueiam).
Os agentes recebem SO tools seguras: `deep_research` usa a allowlist (sem os agentes); `morning_digest` usa so `digest_collect`
(sem `text_to_speech`: nao gera audio). shell/file_write/browser/agent_spawn nunca chegam neles; a subida falha se vierem.
- `deep_research(pergunta, profundidade?: rapida|normal|profunda -> 3/6/10 passos, limite_passos?)`: devolve relatorio + `Fontes:` (URLs do web_search).
- `morning_digest(data?: YYYY-MM-DD, fontes?: [ids de conectores])`: texto em pt-BR; janela = 24h (ou desde 00:00 de `data` ate agora). Fonte sem
  conector/credencial e pulada sem erro (fica fora do texto). No VPS nao ha credenciais de conectores: o resumo vem vazio ate configurar algum.
  Grava o artefato em `OPENJARVIS_DIGEST_DB`.

Envs opcionais: `OPENJARVIS_AGENT_TIMEOUT` (600 s, prazo total por chamada; passado o prazo nenhuma nova geracao sai e a tool devolve `isError`),
`OPENJARVIS_AGENT_MAX_STEPS` (teto de passos, 12), `OPENJARVIS_AGENT_CONCURRENCY` (2; excedente recebe "ocupado"),
`OPENJARVIS_DIGEST_TZ` (America/Sao_Paulo), `OPENJARVIS_DIGEST_DB` (/tmp/openjarvis-digest.db). O cliente MCP deve usar timeout >= 600 s nessas tools.
Engine `cloud` precisa de `ANTHROPIC_API_KEY`; `web_search` usa DuckDuckGo se nao houver `TAVILY_API_KEY`/outra chave.
