import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  criarProvedorVoyage,
  dividirEmTrechos,
  hashDoTrecho,
  lembrar,
  provedorEmbeddingsDoAmbiente,
  recordar,
  tratarMensagemMcp,
  type Banco,
  type ProvedorEmbeddings,
} from '@jarvis/core';
import { bancoLimpo, criarEmpresa, regrasTeste, temPgvector } from './ajuda.ts';

function bancoFalso(linhas: unknown[] = [{ inserido: true }]) {
  const query = vi.fn(async () => ({ rows: linhas }));
  return { banco: { query } as unknown as Banco, query };
}

const vetor = (x: number) => Array.from({ length: 1024 }, (_, i) => (i === 0 ? x : 0));

describe('chunker', () => {
  it('texto curto vira um trecho só', () => {
    expect(dividirEmTrechos('Olá mundo.')).toEqual(['Olá mundo.']);
  });

  it('agrupa parágrafos e respeita o tamanho máximo, com sobreposição', () => {
    const paragrafos = Array.from({ length: 12 }, (_, i) => `Parágrafo ${i} ${'palavra '.repeat(20)}`.trim());
    const trechos = dividirEmTrechos(paragrafos.join('\n\n'), { tamanhoMax: 400, sobreposicao: 60 });
    expect(trechos.length).toBeGreaterThan(2);
    for (const t of trechos) expect(t.length).toBeLessThanOrEqual(400);
    // o começo do trecho seguinte repete o fim do anterior
    const fimAnterior = trechos[0]!.slice(-30).trim();
    expect(trechos[1]!.slice(0, 80)).toContain(fimAnterior.split(/\s+/).slice(-2).join(' '));
  });

  it('quebra parágrafo gigante sem cortar palavras', () => {
    const texto = 'abcdefghi '.repeat(300).trim();
    const trechos = dividirEmTrechos(texto, { tamanhoMax: 300, sobreposicao: 0 });
    expect(trechos.length).toBeGreaterThan(5);
    for (const t of trechos) {
      expect(t.length).toBeLessThanOrEqual(300);
      expect(t.split(/\s+/).every((p) => p === 'abcdefghi')).toBe(true);
    }
  });

  it('ignora texto vazio e valida opções', () => {
    expect(dividirEmTrechos('  \n\n  ')).toEqual([]);
    expect(() => dividirEmTrechos('x', { tamanhoMax: 50 })).toThrow();
    expect(() => dividirEmTrechos('x', { tamanhoMax: 200, sobreposicao: 150 })).toThrow();
  });
});

describe('embeddings Voyage', () => {
  it('chama a API com a chave, o tipo certo e devolve na ordem do índice', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: unknown) =>
      new Response(JSON.stringify({ data: [{ index: 1, embedding: vetor(2) }, { index: 0, embedding: vetor(1) }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const p = criarProvedorVoyage({ chave: 'chave-teste-voyage', fetchImpl });
    const r = await p.embutir(['a', 'b'], 'consulta');
    expect(r[0]![0]).toBe(1);
    expect(r[1]![0]).toBe(2);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.voyageai.com/v1/embeddings');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer chave-teste-voyage');
    expect(JSON.parse(init.body as string)).toMatchObject({ input: ['a', 'b'], model: 'voyage-3.5', input_type: 'query', output_dimension: 1024 });
  });

  it('sem a env não há provedor', () => {
    expect(provedorEmbeddingsDoAmbiente({})).toBeUndefined();
    expect(provedorEmbeddingsDoAmbiente({ VOYAGE_API_KEY: 'x-chave' })).toBeDefined();
  });
});

describe('lembrar / recordar (banco simulado)', () => {
  it('sem provedor grava sem embedding, com hash do conteúdo', async () => {
    const { banco, query } = bancoFalso();
    const r = await lembrar(banco, { texto: 'Decisão: usar Voyage.', origem: 'conversa', referencia: 'c1' }, { provedor: null });
    expect(r).toEqual({ trechos: 1, inseridos: 1, ja_existiam: 0, com_embedding: false });
    const params = (query.mock.calls[0] as unknown as [string, unknown[]])[1];
    expect(params[2]).toBe('conversa');
    expect(params[3]).toBe('c1');
    expect(params[5]).toBe(hashDoTrecho('Decisão: usar Voyage.'));
    expect(params[7]).toBeNull();
  });

  it('conflito (mesmo conteúdo) conta como já existente', async () => {
    const { banco } = bancoFalso([]);
    const r = await lembrar(banco, { texto: 'repetido', origem: 'documento' }, { provedor: null });
    expect(r).toMatchObject({ inseridos: 0, ja_existiam: 1 });
  });

  it('com provedor grava o vetor; se o provedor falhar, cai para full-text sem quebrar', async () => {
    const bom: ProvedorEmbeddings = { modelo: 'm', dimensao: 1024, embutir: async (t) => t.map(() => vetor(1)) };
    const a = bancoFalso();
    expect(await lembrar(a.banco, { texto: 'oi', origem: 'outro' }, { provedor: bom })).toMatchObject({ com_embedding: true });
    expect(String((a.query.mock.calls[0] as unknown as [string, unknown[]])[1][7]).startsWith('[1,0,0')).toBe(true);

    const ruim: ProvedorEmbeddings = { modelo: 'm', dimensao: 1024, embutir: async () => { throw new Error('fora do ar'); } };
    const b = bancoFalso();
    expect(await lembrar(b.banco, { texto: 'oi', origem: 'outro' }, { provedor: ruim })).toMatchObject({ com_embedding: false });
  });

  it('recordar sem chave chama memoria_buscar com embedding nulo e os filtros', async () => {
    const { banco, query } = bancoFalso([{ id: 'x', texto: 't', score: 0.03 }]);
    const r = await recordar(banco, '  quanto custa?  ', { empresaId: 'e1', origem: 'gmail' }, 5, { provedor: null });
    expect(r).toHaveLength(1);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('memoria_buscar(');
    expect(params).toEqual(['quanto custa?', null, 'e1', null, 'gmail', 5]);
  });

  it('recordar com provedor manda o vetor da consulta', async () => {
    const p: ProvedorEmbeddings = { modelo: 'm', dimensao: 1024, embutir: vi.fn(async (t: string[]) => t.map(() => vetor(3))) };
    const { banco, query } = bancoFalso([]);
    await recordar(banco, 'algo', {}, 10, { provedor: p });
    expect(p.embutir).toHaveBeenCalledWith(['algo'], 'consulta');
    expect(String((query.mock.calls[0] as unknown as [string, unknown[]])[1][1]).startsWith('[3,0')).toBe(true);
    await expect(recordar(banco, '   ')).rejects.toThrow('consulta vazia');
  });
});

describe('MCP da memória (banco simulado)', () => {
  it('validação com zod e recusa de segredo nos metadados', async () => {
    const { banco } = bancoFalso();
    const regras = regrasTeste();
    const chamar = (name: string, args: Record<string, unknown>) =>
      tratarMensagemMcp(banco, regras, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) as Promise<{
        result: { isError?: boolean; content: { text: string }[] };
      }>;
    const ruim = await chamar('jarvis_memoria_gravar', { texto: 'x', origem: 'inexistente' });
    expect(ruim.result.isError).toBe(true);
    const segredo = await chamar('jarvis_memoria_gravar', { texto: 'x', origem: 'outro', metadados: { senha: '123' } });
    expect(segredo.result.content[0]!.text).toContain('parece um segredo');
    const vazia = await chamar('jarvis_memoria_buscar', { consulta: '' });
    expect(vazia.result.isError).toBe(true);
  });
});

describe('memória no Postgres (precisa de pgvector)', async () => {
  const comVector = await temPgvector();
  let banco: Banco;
  let empresa: string;
  beforeAll(async () => {
    if (!comVector) return;
    banco = await bancoLimpo();
    empresa = await criarEmpresa(banco);
  });
  afterAll(async () => {
    if (comVector) await banco.end();
  });

  it.skipIf(!comVector)('grava de forma idempotente e busca por full-text e por vetor (RRF)', async () => {
    const prov: ProvedorEmbeddings = {
      modelo: 'falso',
      dimensao: 1024,
      embutir: async (t) => t.map((x) => (x.includes('gato') ? vetor(1) : [...vetor(0).slice(0, 1023), 1])),
    };
    const e = { empresaId: empresa, origem: 'documento' as const, referencia: 'doc1' };
    const a = await lembrar(banco, { ...e, texto: 'O gato dorme no sofá da sala.' }, { provedor: prov });
    const b = await lembrar(banco, { ...e, texto: 'O gato dorme no sofá da sala.' }, { provedor: prov });
    expect(a.inseridos).toBe(1);
    expect(b).toMatchObject({ inseridos: 0, ja_existiam: 1 });
    await lembrar(banco, { ...e, texto: 'A fatura do cartão vence na sexta-feira.' }, { provedor: prov });
    await lembrar(banco, { ...e, referencia: 'sem-vetor', texto: 'Reunião sobre orçamento da campanha.' }, { provedor: null });

    const porTexto = await recordar(banco, 'fatura cartão', { empresaId: empresa }, 5, { provedor: null });
    expect(porTexto[0]!.texto).toContain('fatura');
    const porVetor = await recordar(banco, 'felino', { empresaId: empresa }, 5, { provedor: { ...prov, embutir: async (t) => t.map(() => vetor(1)) } });
    expect(porVetor[0]!.texto).toContain('gato');
    const outraEmpresa = await recordar(banco, 'gato', { empresaId: '00000000-0000-0000-0000-000000000001' }, 5, { provedor: null });
    expect(outraEmpresa).toHaveLength(0);
  });
});
