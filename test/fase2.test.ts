import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import {
  buscarTarefa,
  CofreMemoria,
  criarTarefa,
  definirDestinoLog,
  ProvedorMemoria,
  type Banco,
} from '@jarvis/core';
import {
  ciclo,
  criarAdaptadorPorReceita,
  criarClienteGmail,
  detectarCaptcha,
  extrairCodigo,
  montarConsulta,
  PaginaPlaywright,
  RegistroAdaptadores,
  type ClienteGmail,
  type MensagemEmail,
  type PaginaNavegador,
} from '@jarvis/worker';
import { bancoLimpo, criarEmpresa, regrasTeste } from './ajuda.ts';

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';

const regras = regrasTeste();
const SENHA = 'Senha-Gerada-Pelo-Jarvis-9876!';
const CHAVE_API = 'live_chave_api_gerada_abcdef123456';
let banco: Banco;
let empresa: string;
let navegador: Browser;
let servidor: Server;
let base = '';
let logs: string[];

// Site falso de cadastro (local): cadastro → código por e-mail → painel com a chave de API.
const paginas: Record<string, string> = {
  '/cadastro': `<form onsubmit="event.preventDefault(); location.href='/verificar'">
      <input id="email" name="email"><input id="senha" type="password"><button id="criar">Criar conta</button></form>`,
  '/verificar': `<p>Digite o código enviado por e-mail</p><input id="codigo" autocomplete="one-time-code">
      <button id="confirmar" onclick="location.href='/painel'">Confirmar</button>`,
  '/painel': `<h1>Conta criada</h1><button id="gerar" onclick="document.getElementById('k').value='${CHAVE_API}'">Gerar chave</button>
      <input id="k" data-sensivel readonly>`,
  '/captcha': `<form><div class="g-recaptcha" data-sitekey="x"></div><input id="email"></form>`,
};

beforeAll(async () => {
  navegador = await chromium.launch();
  servidor = createServer((req, res) => {
    const html = paginas[req.url ?? ''];
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html ?? 'não encontrado');
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', () => r()));
  const end = servidor.address();
  base = `http://127.0.0.1:${typeof end === 'object' && end ? end.port : 0}`;
});
afterAll(async () => {
  await navegador?.close();
  servidor?.close();
});
beforeEach(async () => {
  banco = await bancoLimpo();
  empresa = await criarEmpresa(banco);
  logs = [];
  definirDestinoLog((l) => logs.push(l));
});
afterEach(async () => {
  definirDestinoLog((l) => process.stdout.write(l + '\n'));
  await banco.end();
});

function receitaCadastro() {
  return {
    passos: [
      { tipo: 'abrir', url: `${base}/cadastro` },
      { tipo: 'preencher', seletor: '#email', valor: { parametro: 'email' } },
      { tipo: 'preencher', seletor: '#senha', valor: { segredo: 'TESTE_PLATAFORMA_SENHA' } },
      { tipo: 'clicar', seletor: '#criar' },
      { tipo: 'esperar', texto: 'código enviado' },
      { tipo: 'codigo_email', remetente: 'no-reply@plataforma.test', seletor: '#codigo' },
      { tipo: 'clicar', seletor: '#confirmar' },
      { tipo: 'esperar', texto: 'Conta criada' },
      { tipo: 'clicar', seletor: '#gerar' },
      { tipo: 'capturar', seletor: '#k', salvar_como_segredo: 'TESTE_PLATAFORMA_API_KEY' },
    ],
  };
}

function gmailFalso(msgs: () => MensagemEmail[]): ClienteGmail {
  return { buscar: async () => msgs() };
}

async function gravarReceita(acao: string, passos: object, aprovada = true) {
  await banco.query(`insert into receitas (plataforma, acao, passos, aprovada_pelo_vigia) values ('plataforma_teste', $1, $2, $3)`, [
    acao,
    JSON.stringify(passos),
    aprovada,
  ]);
}

function montar(opts: { gmail?: ClienteGmail; linkAoVivo?: string; pagina?: () => Promise<PaginaNavegador> } = {}) {
  const cofre = new CofreMemoria();
  const adaptador = criarAdaptadorPorReceita({
    plataforma: 'plataforma_teste',
    acoes: ['criar_conta'],
    banco,
    abrirSessao: async () => {
      if (opts.pagina) return { pagina: await opts.pagina(), linkAoVivo: opts.linkAoVivo, fechar: async () => {} };
      const ctxNav = await navegador.newContext();
      const p = await ctxNav.newPage();
      return { pagina: new PaginaPlaywright(p), linkAoVivo: opts.linkAoVivo, fechar: () => ctxNav.close() };
    },
    deps: {
      gmail: opts.gmail,
      timeoutPassoMs: 3_000,
      gmailIntervaloMs: 1,
      gmailLimiteMs: 50,
      esperar: async () => {},
      esperaHumanoMs: 1_000,
      intervaloHumanoMs: 1,
      metaSegredo: { bitwardenProjeto: 'proj-teste', plataforma: 'plataforma_teste' },
    },
  });
  return {
    cofre,
    opcoes: {
      banco,
      regras,
      registro: new RegistroAdaptadores().registrar(adaptador),
      segredos: new ProvedorMemoria({ TESTE_PLATAFORMA_SENHA: SENHA }),
      workerId: 'w1',
      heartbeatMs: 1000,
      cofre,
    },
  };
}

async function tarefaAprovada(chave = 'conta-1') {
  const { tarefa } = await criarTarefa(
    banco,
    regras,
    {
      empresaId: empresa,
      agente: 'jarvis_infra',
      acao: 'criar_conta',
      plataforma: 'plataforma_teste',
      parametros: { email: 'brenno.968+cadastros@gmail.com' },
      idempotencyKey: chave,
      resumo: 'Criar conta na plataforma de teste',
    },
    'teste',
  );
  await banco.query(`update aprovacoes set status = 'aprovada' where tarefa_id = $1`, [tarefa.id]);
  await banco.query(`update tarefas set status = 'aprovada' where id = $1`, [tarefa.id]);
  return tarefa;
}

describe('Fase 2 — Gmail', () => {
  const agora = Date.now();
  const msg = (remetente: string, corpo: string, recebidaEm = agora + 1000): MensagemEmail => ({
    id: Math.random().toString(),
    remetente,
    assunto: 'Seu código',
    corpo,
    recebidaEm,
  });
  const crit = { remetente: 'no-reply@plataforma.test', padrao: '\\b\\d{6}\\b', desde: agora };

  it('monta a consulta com remetente e horário', () => {
    expect(montarConsulta(crit)).toBe(`from:(no-reply@plataforma.test) after:${Math.floor(agora / 1000)}`);
  });

  it('só aceita remetente certo, depois do início, com exatamente um código', () => {
    expect(extrairCodigo([msg('Plataforma <no-reply@plataforma.test>', 'código 123456')], crit)).toEqual({ ok: true, codigo: '123456' });
    expect(extrairCodigo([msg('golpista@x.com', 'código 123456')], crit)).toEqual({ ok: false, motivo: 'nenhum' });
    expect(extrairCodigo([msg('no-reply@plataforma.test', 'código 123456', agora - 60_000)], crit)).toEqual({ ok: false, motivo: 'nenhum' });
    expect(extrairCodigo([msg('no-reply@plataforma.test', '111111 ou 222222')], crit)).toEqual({ ok: false, motivo: 'ambiguo' });
  });

  it('cliente HTTP renova o acesso e lê o corpo da mensagem', async () => {
    const corpo = Buffer.from('Seu código é 654321').toString('base64url');
    const f = (async (url: string) => {
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }));
      if (url.includes('/messages?')) return new Response(JSON.stringify({ messages: [{ id: 'm1' }] }));
      return new Response(
        JSON.stringify({
          internalDate: String(agora + 5000),
          payload: { mimeType: 'text/plain', body: { data: corpo }, headers: [{ name: 'From', value: 'no-reply@plataforma.test' }] },
        }),
      );
    }) as unknown as typeof fetch;
    const c = criarClienteGmail({ clientId: 'id', clientSecret: 's', refreshToken: 'r', fetchImpl: f });
    const m = await c.buscar(montarConsulta(crit));
    expect(extrairCodigo(m, crit)).toEqual({ ok: true, codigo: '654321' });
  });
});

describe('Fase 2 — navegador e receitas (Chromium de verdade, site local)', () => {
  it('detecta CAPTCHA (e só detecta)', async () => {
    const c = await navegador.newContext();
    const p = new PaginaPlaywright(await c.newPage());
    await p.abrir(`${base}/captcha`, 3000);
    expect(await detectarCaptcha(p)).toBe(true);
    await p.abrir(`${base}/cadastro`, 3000);
    expect(await detectarCaptcha(p)).toBe(false);
    await c.close();
  });

  it('cria a conta de ponta a ponta: senha da Dory, código do Gmail, chave salva na Dory', async () => {
    await gravarReceita('criar_conta', receitaCadastro());
    const { opcoes, cofre } = montar({ gmail: gmailFalso(() => [{ id: '1', remetente: 'no-reply@plataforma.test', assunto: '', corpo: 'código 482913', recebidaEm: Date.now() }]) });
    const t = await tarefaAprovada();
    expect(await ciclo(opcoes)).toBe('executou');
    const final = await buscarTarefa(banco, t.id);
    expect(final?.status).toBe('concluida');
    expect(final?.resultado).toMatchObject({ dados: { segredos_criados: ['TESTE_PLATAFORMA_API_KEY'] } });
    expect([...cofre.itens.values()][0]).toMatchObject({ nome: 'TESTE_PLATAFORMA_API_KEY', valor: CHAVE_API });
    const ref = await banco.query(`select nome, plataforma from segredos_ref`);
    expect(ref.rows).toEqual([{ nome: 'TESTE_PLATAFORMA_API_KEY', plataforma: 'plataforma_teste' }]);
    const rec = await banco.query(`select ultima_execucao_ok is not null as ok from receitas`);
    expect(rec.rows[0].ok).toBe(true);
    // nada vazou
    const tudo = logs.join('\n');
    for (const v of [SENHA, CHAVE_API, '482913']) expect(tudo).not.toContain(v);
    for (const t of ['tarefas', 'auditoria', 'efeitos', 'avisos', 'segredos_ref']) {
      for (const v of [SENHA, CHAVE_API]) {
        const q = await banco.query(`select count(*)::int as n from ${t} where ${t}::text like $1`, [`%${v}%`]);
        expect(q.rows[0].n, `${t}`).toBe(0);
      }
    }
  });

  it('capturas de tela cobrem senha e chave', async () => {
    const c = await navegador.newContext();
    const pg = await c.newPage();
    const p = new PaginaPlaywright(pg);
    await p.abrir(`${base}/cadastro`, 3000);
    await p.preencher('#senha', SENHA, 3000);
    const comMascara = await p.capturarTela([]);
    await pg.evaluate(() => document.querySelectorAll('input[type=password]').forEach((e) => ((e as HTMLInputElement).type = 'text')));
    const semMascara = await pg.screenshot({ fullPage: true });
    expect(comMascara.equals(semMascara)).toBe(false);
    await c.close();
  });

  it('CAPTCHA sem navegador ao vivo: tarefa espera o Breno e ele é avisado', async () => {
    await gravarReceita('criar_conta', { passos: [{ tipo: 'abrir', url: `${base}/captcha` }, { tipo: 'preencher', seletor: '#email', valor: { texto: 'x' } }] });
    const { opcoes } = montar();
    const t = await tarefaAprovada();
    await ciclo(opcoes);
    expect(await buscarTarefa(banco, t.id)).toMatchObject({ status: 'aguardando_humano', erro: { codigo: 'CAPTCHA' } });
    const av = await banco.query(`select conteudo->>'texto' as texto from avisos where tipo = 'pedido_humano'`);
    expect(av.rows[0].texto).toContain('CAPTCHA');
    const rec = await banco.query(`select falhas_seguidas from receitas`);
    expect(rec.rows[0].falhas_seguidas).toBe(0); // CAPTCHA não conta como receita quebrada
  });

  it('CAPTCHA com navegador ao vivo: manda o link, espera o Breno resolver e continua', async () => {
    await gravarReceita('criar_conta', { passos: [{ tipo: 'abrir', url: 'https://plataforma.test/x' }, { tipo: 'conferir', texto: 'bem-vindo' }] });
    let verificacoes = 0;
    const paginaFalsa: PaginaNavegador = {
      abrir: async () => {},
      preencher: async () => {},
      clicar: async () => {},
      esperarSeletor: async () => {},
      esperarTexto: async () => {},
      lerTexto: async () => '',
      url: () => 'https://plataforma.test/x',
      capturarTela: async () => Buffer.from(''),
      // CAPTCHA some depois de algumas verificações (o Breno resolveu pelo celular)
      html: async () => (++verificacoes < 4 ? '<div class="g-recaptcha"></div>' : '<p>bem-vindo</p>'),
    };
    const { opcoes } = montar({ linkAoVivo: 'https://ao-vivo.exemplo/sessao/abc', pagina: async () => paginaFalsa });
    const t = await tarefaAprovada();
    await ciclo(opcoes);
    expect((await buscarTarefa(banco, t.id))?.status).toBe('concluida');
    const av = await banco.query(`select conteudo->>'link' as link from avisos where tipo = 'pedido_humano'`);
    expect(av.rows[0].link).toBe('https://ao-vivo.exemplo/sessao/abc');
  });

  it('código que não chega → pede o Breno; 3 falhas seguidas → receita para revisão', async () => {
    await gravarReceita('criar_conta', receitaCadastro());
    const { opcoes } = montar({ gmail: gmailFalso(() => []) });
    for (let i = 0; i < 3; i++) {
      const t = await tarefaAprovada(`c${i}`);
      await ciclo(opcoes);
      expect(await buscarTarefa(banco, t.id)).toMatchObject({ status: 'aguardando_humano', erro: { codigo: 'CODIGO_NAO_CHEGOU' } });
    }
    const rec = await banco.query(`select falhas_seguidas from receitas`);
    expect(rec.rows[0].falhas_seguidas).toBe(3);
    const av = await banco.query(`select count(*)::int as n from avisos where conteudo->>'texto' like '%falhou 3 vezes%'`);
    expect(av.rows[0].n).toBe(1);
  });

  it('receita não aprovada pelo Vigia não roda', async () => {
    await gravarReceita('criar_conta', receitaCadastro(), false);
    const { opcoes } = montar();
    const t = await tarefaAprovada();
    await ciclo(opcoes);
    expect(await buscarTarefa(banco, t.id)).toMatchObject({ status: 'aguardando_humano', erro: { codigo: 'SEM_RECEITA' } });
  });

  it('elemento que não aparece = travamento, com pedido de ajuda', async () => {
    await gravarReceita('criar_conta', { passos: [{ tipo: 'abrir', url: `${base}/cadastro` }, { tipo: 'clicar', seletor: '#botao-que-nao-existe' }] });
    const { opcoes } = montar();
    const t = await tarefaAprovada();
    await ciclo(opcoes);
    expect(await buscarTarefa(banco, t.id)).toMatchObject({ status: 'aguardando_humano', erro: { codigo: 'TRAVAMENTO' } });
  });
});
