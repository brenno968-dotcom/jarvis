import { describe, expect, it } from 'vitest';
import { assinar, criarClienteNexusMcp, lacoFerramentas, urlDoMcp, FERRAMENTAS_NEXUS_PERMITIDAS } from '@jarvis/core';

// Item 416 (parte 2): conversa do Jarvis com as ferramentas do Nexus. Sem rede: fetch falso. Dados de teste falsos.
const SEGREDO = 'segredo-de-teste-com-mais-de-32-caracteres!!';

describe('cliente MCP do Nexus', () => {
  it('endereço: variável própria ou a origem dos avisos + /api/mcp', () => {
    expect(urlDoMcp({ JARVIS_CORE_NEXUS_AVISOS_URL: 'https://nexus.teste/api/jarvis/avisos' })).toBe('https://nexus.teste/api/mcp');
    expect(urlDoMcp({ JARVIS_CORE_NEXUS_MCP_URL: 'https://x.teste/api/mcp' })).toBe('https://x.teste/api/mcp');
    expect(urlDoMcp({})).toBeNull();
  });

  it('assina o corpo, filtra as ferramentas e recusa ferramenta fora da lista', async () => {
    const vistos: { corpo: string; ts: string; ass: string }[] = [];
    const fetchFalso = (async (_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      const corpo = String(init.body);
      vistos.push({ corpo, ts: h['x-jarvis-timestamp']!, ass: h['x-jarvis-assinatura']! });
      const m = JSON.parse(corpo) as { id: number; method: string; params: { name?: string } };
      const result =
        m.method === 'tools/list'
          ? { tools: [{ name: 'pedidos_ver', description: 'ver', inputSchema: { type: 'object' } }, { name: 'perigosa_apagar', description: 'x' }] }
          : { content: [{ type: 'text', text: `ok ${m.params.name}` }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = criarClienteNexusMcp({ url: 'https://nexus.teste/api/mcp', segredo: SEGREDO, fetchImpl: fetchFalso });
    const fs = await c.ferramentas();
    expect(fs.map((f) => f.name)).toEqual(['pedidos_ver']);
    expect(await c.chamar('pedidos_ver', { numero: 1 })).toBe('ok pedidos_ver');
    expect(await c.chamar('perigosa_apagar', {})).toMatch(/não é permitida/);
    const v = vistos[1]!;
    expect(v.ass).toBe(assinar(SEGREDO, Number(v.ts), v.corpo));
    expect(FERRAMENTAS_NEXUS_PERMITIDAS).not.toContain('perigosa_apagar');
  });
});

describe('laço de ferramentas', () => {
  it('chama a ferramenta e devolve a resposta final', async () => {
    let n = 0;
    const r = await lacoFerramentas(
      async () =>
        n++ === 0
          ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'sistema_saude', input: {} }] }
          : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Tudo verde.' }] },
      'como está o sistema?',
      async (nome) => `resultado de ${nome}`,
    );
    expect(r).toBe('Tudo verde.');
  });

  it('respeita o prazo total (abaixo de 22 s)', async () => {
    let t = 0;
    const r = await lacoFerramentas(
      async () => {
        t += 15_000;
        return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'banco_consultar', input: {} }] };
      },
      'pergunta',
      async () => 'x',
      { agora: () => t },
    );
    expect(r).toMatch(/Demorei demais/);
    expect(t).toBeLessThan(22_000 + 15_000);
  });
});
