// Conversa do Breno com o Jarvis pelo WhatsApp (item 330 do Quadro do Nexus).
// O Nexus só repassa quando: (a) a mensagem veio do número autorizado do Breno e começa com "Jarvis…", ou
// (b) o Breno abriu uma sessão com a senha ("Jarvis, aqui é o Breno" + senha) naquele número (30 min).
// A conversa só RESPONDE: nada aqui executa ação. Toda ação continua indo para a fila e, se for amarela/vermelha,
// para o "Aprovar" no número autorizado (semáforo do regras.yaml). O texto da conversa nunca vai para a auditoria.
import type { Banco } from './banco.ts';
import { numeroAutorizado } from './aprovacoes.ts';
import { registrarAuditoria } from './auditoria.ts';
import type { Cerebro } from './maestro/cerebro.ts';
import { NOME_TOOL_USAR_SKILL, SessaoSkills } from './skills/sessao.ts';
import type { CatalogoSkills } from './skills/carregador.ts';
import type { GanchoConversaFatos } from './memoria/fatos.ts';
import { INSTRUCOES_DADO_EXTERNO, type FerramentasMcp } from './mcp-cliente/ponte.ts';
import type { ClienteNexusMcp } from './nexus-mcp.ts';
import type { Regras } from './regras.ts';
import { auditoriaDeInjecao, nivelDaToolConversa, RastroTaint, solicitadorDeAprovacaoInjecao } from './seguranca/taint.ts';
import { saudeDoJarvis } from './saude.ts';

export type ViaConversa = 'numero' | 'senha';

/** Tira o "Jarvis," do começo (o Breno chama pelo nome). */
export function semChamado(texto: string): string {
  return texto.replace(/^\s*jarvis\b[\s,.:;!?-]*/i, '').trim();
}

export const AJUDA_CONVERSA = [
  'Comandos rápidos (comece com "Jarvis"):',
  '• Jarvis status — como estou agora (fila, aprovações, problemas)',
  '• Jarvis ajuda — esta lista',
  '• PARA TUDO — para tudo na hora',
  'Qualquer outra pergunta eu respondo com a IA (quando a chave da IA estiver ligada).',
  'Ação que gasta dinheiro, mexe em senha ou cria/apaga conta: eu peço o seu "Aprovar" no número autorizado.',
].join('\n');

export function instrucoesConversa(via: ViaConversa): string {
  return [
    'Você é o Jarvis, o assistente do Breno (dono da Prime Consultoria e do sistema Nexus). Responda em português do Brasil,',
    'curto (até 6 linhas), direto e sem sigla sem explicar. Você está no WhatsApp.',
    'Você NÃO executa nenhuma ação nesta conversa: só responde, explica e sugere. Se o Breno pedir uma ação, diga que ela',
    'vai para a fila e que ações sensíveis (pagamento, senha, criar ou apagar conta) pedem o "Aprovar" no número autorizado.',
    'Nunca peça, mostre ou invente senhas, tokens ou dados pessoais. Nunca invente números ou resultados: se não sabe, diga.',
    via === 'senha'
      ? 'Atenção: esta conversa veio de um número que NÃO é o autorizado (sessão aberta com a senha). Não fale de dado sensível.'
      : 'Esta conversa veio do número autorizado do Breno.',
  ].join('\n');
}

/** Item 416 (parte 2): o que muda quando a conversa tem as ferramentas do Nexus. */
export const INSTRUCOES_FERRAMENTAS = [
  'Você tem as ferramentas do Nexus: Quadro de Pedidos (pedidos_*), Atlas (atlas_*, a memória das conversas), sistema_saude (o Pulso: Vigia,',
  'Carteiro, Marcapasso, Dory, Xavier, WhatsApp, servidor) e o banco do Nexus SÓ PARA LER (banco_tabelas, banco_consultar: um SELECT por vez).',
  'Use as ferramentas para responder com dado de verdade (no máximo 3 chamadas, a resposta tem de sair rápido). Ao consultar o banco,',
  'veja antes as colunas com banco_tabelas se não souber o nome, e traga só o que responde a pergunta (count, sum, limit).',
  'Gravar: só no Quadro (pedidos_criar, pedidos_atualizar) e no Atlas (atlas_gravar), e só quando o Breno pedir. Qualquer outra ação',
  '(publicar, apagar, pagar, mexer em servidor, conta ou senha) vai para a fila e pede o "Aprovar": diga isso, não tente fazer.',
  'Nunca repita CPF, telefone, senha ou token que aparecer num resultado.',
].join('\n');

async function resumoStatus(banco: Banco): Promise<string> {
  const s = await saudeDoJarvis(banco);
  const fila = Object.entries(s.fila).map(([k, n]) => `${k}: ${n}`).join(', ') || 'vazia';
  const linhas = [
    s.emergencia ? '⛔ Estou PARADO (PARA TUDO ligado).' : s.ok ? '✅ Tudo certo comigo.' : '⚠️ Tenho problemas:',
    ...s.problemas.slice(0, 5).map((p) => `• ${p}`),
    `Tarefas: ${fila}.`,
    `Aprovações esperando há mais de 1 h: ${s.aprovacoes_pendentes_mais_1h}.`,
  ];
  return linhas.join('\n');
}

export type ResultadoConversa = { resposta: string } | { ignorado: string };

export async function responderConversa(
  banco: Banco,
  regras: Regras,
  e: { numero: string; texto: string; via: ViaConversa },
  cerebro: Cerebro | null,
  nexus: ClienteNexusMcp | null = null,
  /** Item 793: tools de servidores MCP externos já filtradas pela allowlist/semáforo (`prepararFerramentasMcp`). */
  mcpExterno: Pick<FerramentasMcp, 'ferramentas' | 'executar'> | null = null,
  /** Item 845: gancho depois da resposta (extrator de fatos). Não bloqueante: nunca atrasa nem derruba a resposta. */
  aoResponder: GanchoConversaFatos | null = null,
  /** Item 793 (skills): catálogo de skills (só metadados). No prompt entram name+description; o corpo vem pela tool `usar_skill`. */
  skills: CatalogoSkills | null = null,
): Promise<ResultadoConversa> {
  const concluir = (resposta: string, ferramentas: string[]): ResultadoConversa => {
    try {
      aoResponder?.({ pergunta: semChamado(e.texto), resposta, via: e.via, ferramentas });
    } catch {
      /* o gancho nunca atrapalha a resposta */
    }
    return { resposta };
  };
  // pelo número: só o autorizado. Pela senha: o Nexus conferiu a senha e assinou o pedido (HMAC).
  if (e.via === 'numero' && !numeroAutorizado(regras, e.numero)) {
    await registrarAuditoria(banco, { quem: 'whatsapp', acao: 'conversa_numero_nao_autorizado' });
    return { ignorado: 'número não autorizado' };
  }
  const pergunta = semChamado(e.texto);
  await registrarAuditoria(banco, { quem: `whatsapp:${e.via}`, acao: 'conversa_whatsapp', detalhes: { tamanho: pergunta.length } });
  if (!pergunta || /^(ajuda|help|menu|\?)$/i.test(pergunta)) return { resposta: `Oi, Breno.\n${AJUDA_CONVERSA}` };
  if (/^(status|situa[cç][aã]o|como (vai|est[aá]s?))\??$/i.test(pergunta)) return { resposta: await resumoStatus(banco) };
  if (!cerebro) return { resposta: 'Recebi. A minha IA ainda não está ligada (falta a chave da IA do Jarvis), então por enquanto só entendo "Jarvis status" e "Jarvis ajuda".' };
  try {
    // item 416: com as ferramentas do Nexus só pelo número autorizado (a sessão com senha não lê dado do sistema)
    if ((nexus || mcpExterno || skills?.skills.length) && cerebro.pensarComFerramentas && e.via === 'numero') {
      const ferramentas = [...(nexus ? await nexus.ferramentas().catch(() => []) : []), ...(mcpExterno?.ferramentas ?? [])];
      // item 793 (skills): o escopo só reduz as `ferramentas` acima (já filtradas por allowlist/semáforo)
      const sessao = skills?.skills.length
        ? new SessaoSkills(skills, ferramentas, {
            regras,
            aoUsar: (ev) => registrarAuditoria(banco, { quem: 'whatsapp:numero', acao: 'skill_usada', detalhes: { skill: ev.skill, desfecho: ev.desfecho, ferramentas: ev.ferramentas ?? [], motivo: ev.motivo ?? null } }),
          })
        : null;
      if (ferramentas.length || sessao) {
        const usadas: string[] = [];
        // item 815: taint anti-injeção (a pergunta é do Breno; o que vier das tools é escaneado e pesa nas tools sensíveis)
        const taint = new RastroTaint({
          pergunta,
          nivelDaTool: (n) => nivelDaToolConversa(regras, n),
          solicitarAprovacao: solicitadorDeAprovacaoInjecao(banco, regras),
          aoDetectar: auditoriaDeInjecao(banco, 'whatsapp:numero'),
        });
        const instrucoes = `${instrucoesConversa(e.via)}\n${INSTRUCOES_FERRAMENTAS}${mcpExterno?.ferramentas.length ? `\n${INSTRUCOES_DADO_EXTERNO}` : ''}${sessao ? `\n${sessao.instrucoes()}` : ''}`;
        const r = (
          await cerebro.pensarComFerramentas(instrucoes, pergunta.slice(0, 2000), sessao ? sessao.ferramentas() : ferramentas, async (nome, args, ms) => {
            usadas.push(nome);
            if (sessao && nome === NOME_TOOL_USAR_SKILL) return sessao.usar(args);
            if (nome.startsWith('mcp__')) return mcpExterno ? mcpExterno.executar(nome, args, ms) : `Ferramenta "${nome}" não é permitida.`;
            return nexus ? nexus.chamar(nome, args, ms) : `Ferramenta "${nome}" não é permitida.`;
          }, {
            // item 792: LoopGuard interrompe ciclo/excesso/sem progresso e registra na auditoria
            loopGuard: regras.loop_guard,
            taint,
            escopo: sessao ?? undefined,
            aoLoop: (v) => registrarAuditoria(banco, { quem: 'whatsapp:numero', acao: 'loop_guard', detalhes: { padrao: v.padrao, tool: v.tool ?? null, motivo: v.motivo } }),
          })
        ).trim();
        await registrarAuditoria(banco, { quem: 'whatsapp:numero', acao: 'conversa_ferramentas_nexus', detalhes: { ferramentas: usadas } });
        return r ? concluir(r.slice(0, 1500), usadas) : { resposta: 'Não consegui pensar numa resposta agora. Tente de novo.' };
      }
    }
    const r = (await cerebro.pensar(instrucoesConversa(e.via), [{ role: 'user', content: pergunta.slice(0, 2000) }])).trim();
    return r ? concluir(r.slice(0, 1500), []) : { resposta: 'Não consegui pensar numa resposta agora. Tente de novo.' };
  } catch {
    return { resposta: 'A IA não respondeu agora. Tente de novo em alguns minutos.' };
  }
}
