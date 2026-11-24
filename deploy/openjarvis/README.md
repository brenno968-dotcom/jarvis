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

Tools expostas: calculator, think, web_search, file_read (so /data/workspace), memory_search, memory_retrieve.
Memoria: ~55 MB de RSS medidos no Mac apos chamadas (limite 256m). Sem porta publica.
