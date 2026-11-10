// Conector MCP do Jarvis (proposto na seção 29): o Claude manda pedidos pela conversa.
// Só leitura + criar tarefa. Nenhuma ferramenta devolve valor de segredo, aprova algo ou mexe na emergência:
// aprovar continua sendo do Breno (WhatsApp/painel), e o semáforo vale para tudo que o Claude pedir.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Banco } from './banco.ts';
import { lerEmergencia } from './emergencia.ts';
import { buscarTarefa, criarTarefa } from './fila.ts';
import { classificarAcao, type Regras } from './regras.ts';
import { salvarPlano } from './maestro/orquestrador.ts';
import { validarPlano } from './maestro/plano.ts';
import { aplicarKitBase, kitDaEmpresa } from './kit.ts';

export const VERSAO_PROTOCOLO_PADRAO = '2025-06-18';

interface Ferramenta {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const FERRAMENTAS: Ferramenta[] = [
  {
    name: 'jarvis_estado',
    description: 'Situação geral do Jarvis: emergência, workers, tarefas por status e aprovações pendentes.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'jarvis_listar_tarefas',
    description: 'Lista as últimas tarefas (opcionalmente filtrando por status).',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, limite: { type: 'integer', minimum: 1, maximum: 50 } },
      additionalProperties: false,
    },
  },
  {
    name: 'jarvis_consultar_tarefa',
    description: 'Detalhes de uma tarefa pelo id (status, resultado, erro).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'jarvis_criar_tarefa',
    description:
      'Cria uma tarefa para o Jarvis executar. O nível (verde/amarelo/vermelho) vem das regras; vermelha só roda depois do OK do Breno. ' +
      'NUNCA coloque senha, token ou valor de segredo em "parametros": use só o NOME do segredo da Dory.',
    inputSchema: {
      type: 'object',
      properties: {
        acao: { type: 'string' },
        plataforma: { type: 'string' },
        parametros: { type: 'object' },
        resumo: { type: 'string', description: 'Explicação simples para o Breno (obrigatória em ação vermelha).' },
        empresa_id: { type: 'string' },
        chave: { type: 'string', description: 'Chave de idempotência (opcional).' },
      },
      required: ['acao', 'plataforma', 'empresa_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'jarvis_propor_plano',
    description:
      'Propõe um plano de negócio (formato da seção 15.1 de docs/JARVIS.md: modelo_negocio, objetivo, justificativa_modelo, orcamento, viabilidade com checagens, etapas). ' +
      'O Jarvis valida (semáforo, orçamento, ponto de empate, checagens). Se passar, grava e manda o pedido de aprovação ao Breno; se não, devolve os bloqueios.',
    inputSchema: {
      type: 'object',
      properties: { empresa_id: { type: 'string' }, nome_negocio: { type: 'string' }, plano: { type: 'object' } },
      required: ['empresa_id', 'nome_negocio', 'plano'],
      additionalProperties: false,
    },
  },
];

const CHAVES_SUSPEITAS = /(senha|password|passwd|secret|token|api[_-]?key|valor)/i;

function temChaveSuspeita(o: unknown): string | null {
  if (!o || typeof o !== 'object') return null;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (CHAVES_SUSPEITAS.test(k) && k !== 'segredo' && k !== 'token_segredo') return k;
    const dentro = temChaveSuspeita(v);
    if (dentro) return dentro;
  }
  return null;
}

const argsCriar = z.object({
  acao: z.string().regex(/^[a-z0-9_]+$/),
  plataforma: z.string().regex(/^[a-z0-9_]+$/),
  parametros: z.record(z.unknown()).default({}),
  resumo: z.string().max(500).optional(),
  empresa_id: z.string().uuid(),
  chave: z.string().max(200).optional(),
});

async function chamar(banco: Banco, regras: Regras, nome: string, args: Record<string, unknown>): Promise<unknown> {
  switch (nome) {
    case 'jarvis_estado': {
      const [em, porStatus, workers, aprov] = await Promise.all([
        lerEmergencia(banco),
        banco.query(`select status, count(*)::int as n from tarefas group by status order by status`),
        banco.query(`select id, estado, ultimo_sinal from workers order by ultimo_sinal desc limit 10`),
        banco.query(`select resumo, expira_em from aprovacoes where status = 'pendente' order by criado_em`),
      ]);
      return { emergencia: em, tarefas_por_status: porStatus.rows, workers: workers.rows, aprovacoes_pendentes: aprov.rows };
    }
    case 'jarvis_listar_tarefas': {
      const a = z.object({ status: z.string().optional(), limite: z.number().int().min(1).max(50).default(20) }).parse(args);
      const r = await banco.query(
        `select id, acao, plataforma, nivel_semaforo, status, tentativas, atualizado_em
           from tarefas where ($1::text is null or status = $1) order by criado_em desc limit $2`,
        [a.status ?? null, a.limite],
      );
      return r.rows;
    }
    case 'jarvis_consultar_tarefa': {
      const { id } = z.object({ id: z.string().uuid() }).parse(args);
      const t = await buscarTarefa(banco, id);
      if (!t) throw new Error('tarefa não encontrada');
      return t;
    }
    case 'jarvis_criar_tarefa': {
      const a = argsCriar.parse(args);
      const suspeita = temChaveSuspeita(a.parametros);
      if (suspeita) throw new Error(`parâmetro "${suspeita}" parece um segredo: use só o nome do segredo da Dory`);
      const r = await criarTarefa(
        banco,
        regras,
        {
          empresaId: a.empresa_id,
          agente: 'jarvis_infra',
          acao: a.acao,
          plataforma: a.plataforma,
          parametros: a.parametros,
          resumo: a.resumo,
          idempotencyKey: a.chave ?? `claude:${a.acao}:${randomUUID()}`,
        },
        'claude',
      );
      return {
        tarefa_id: r.tarefa.id,
        nivel: classificarAcao(regras, a.acao),
        status: r.tarefa.status,
        ja_existia: r.jaExistia,
        observacao: r.tarefa.status === 'aguardando_aprovacao' ? 'Pedido de aprovação enviado ao Breno.' : undefined,
      };
    }
    case 'jarvis_propor_plano': {
      const a = z.object({ empresa_id: z.string().uuid(), nome_negocio: z.string().min(3).max(120), plano: z.record(z.unknown()) }).parse(args);
      const suspeita = temChaveSuspeita(a.plano);
      if (suspeita) throw new Error(`o plano tem "${suspeita}", que parece um segredo: use só nomes de segredos`);
      const validado = validarPlano(a.plano, regras);
      if (validado.bloqueios.length) return { aceito: false, bloqueios: validado.bloqueios, pendencias: validado.pendencias, viabilidade: validado.viabilidade };
      // Kit base (seção 10): o que a empresa já tem não é criado de novo.
      const v = aplicarKitBase(validado, await kitDaEmpresa(banco, a.empresa_id));
      const r = await salvarPlano(banco, regras, { empresaId: a.empresa_id, nomeNegocio: a.nome_negocio, validado: v, quem: 'claude' });
      return {
        aceito: true,
        plano_id: r.planoId,
        negocio_id: r.negocioId,
        viabilidade: v.viabilidade,
        custo_estimado_brl: v.custo_estimado_brl,
        pendencias: v.pendencias,
        reaproveitado_do_kit: v.reaproveitado,
        observacao: 'Plano gravado. Pedido de aprovação enviado ao Breno.',
      };
    }
    default:
      throw new Error(`ferramenta desconhecida: ${nome}`);
  }
}

interface MensagemRpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Trata uma mensagem JSON-RPC do MCP. Devolve null para notificações (sem resposta). */
export async function tratarMensagemMcp(banco: Banco, regras: Regras, msg: MensagemRpc): Promise<unknown | null> {
  const id = msg.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const falha = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return falha(-32600, 'requisição inválida');
  if (msg.id === undefined) return null; // notificação (ex.: notifications/initialized)

  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: (msg.params?.protocolVersion as string | undefined) ?? VERSAO_PROTOCOLO_PADRAO,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'jarvis', version: '0.1.0' },
        instructions: 'Jarvis: assistente executor do ecossistema Nexus. Nunca envie valores de segredos.',
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: FERRAMENTAS });
    case 'tools/call': {
      const nome = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments as Record<string, unknown> | undefined) ?? {};
      try {
        const r = await chamar(banco, regras, nome, args);
        return ok({ content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] });
      } catch (e) {
        const texto = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : String((e as Error)?.message ?? e);
        return ok({ content: [{ type: 'text', text: `Erro: ${texto}` }], isError: true });
      }
    }
    default:
      return falha(-32601, `método não suportado: ${msg.method}`);
  }
}
