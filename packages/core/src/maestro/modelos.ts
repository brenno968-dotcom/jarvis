// Modelos de negócio (seção 8): roteiros reutilizáveis que o Maestro usa como ponto de partida.
// Novo tipo de negócio = novo roteiro aqui, sem mexer no Maestro.

export type ModeloNegocio =
  | 'produto_digital'
  | 'fisico_estoque'
  | 'fisico_sem_estoque'
  | 'marketplace'
  | 'servico'
  | 'afiliado';

export interface EtapaModelo {
  etapa_id: string;
  titulo: string;
  agente: 'maestro' | 'jarvis_infra' | 'oferta' | 'trafego' | 'vendas' | 'fornecedores' | 'logistica' | 'fiscal';
  acao: string;
  plataforma?: string;
  depende_de: string[];
}

export interface Roteiro {
  modelo: ModeloNegocio;
  descricao: string;
  etapas: EtapaModelo[];
  riscos_tipicos: string[];
  /** Checagens da seção 11 que NÃO podem ficar como "nao_aplicavel" neste modelo. */
  checagens_obrigatorias: string[];
}

const comum = (prefixo: EtapaModelo[] = []): EtapaModelo[] => [
  ...prefixo,
  { etapa_id: 'dominio', titulo: 'Domínio/subdomínio e e-mail', agente: 'jarvis_infra', acao: 'configurar_dominio', depende_de: [] },
  { etapa_id: 'whatsapp', titulo: 'Número de WhatsApp e perfil', agente: 'jarvis_infra', acao: 'configurar_whatsapp', depende_de: [] },
];

export const ROTEIROS: Record<ModeloNegocio, Roteiro> = {
  produto_digital: {
    modelo: 'produto_digital',
    descricao: 'Curso, livro, template ou software vendido em plataforma de infoproduto.',
    etapas: [
      ...comum(),
      { etapa_id: 'produto', titulo: 'Produzir o produto (rascunho para revisão)', agente: 'oferta', acao: 'produzir_produto', depende_de: [] },
      { etapa_id: 'conta_venda', titulo: 'Conta na plataforma de venda', agente: 'jarvis_infra', acao: 'criar_conta', plataforma: 'hotmart', depende_de: [] },
      { etapa_id: 'publicar', titulo: 'Publicar o produto', agente: 'jarvis_infra', acao: 'publicar_produto', depende_de: ['produto', 'conta_venda'] },
      { etapa_id: 'campanha', titulo: 'Campanha de captação (opt-in)', agente: 'trafego', acao: 'publicar_campanha', depende_de: ['publicar', 'whatsapp'] },
      { etapa_id: 'vendas', titulo: 'Atendimento e vendas (módulos do Nexus)', agente: 'vendas', acao: 'ativar_atendimento', depende_de: ['whatsapp', 'publicar'] },
    ],
    riscos_tipicos: ['Conta de anúncios nova tem limite de gasto baixo', 'Reembolso alto se o produto não for revisado'],
    checagens_obrigatorias: ['politicas_plataforma', 'opt_in_whatsapp', 'lgpd_consumidor', 'fiscal'],
  },
  fisico_estoque: {
    modelo: 'fisico_estoque',
    descricao: 'Produto físico comprado antes de vender, com estoque próprio.',
    etapas: [
      ...comum(),
      { etapa_id: 'fornecedor', titulo: 'Escolher fornecedor e pedir amostra', agente: 'fornecedores', acao: 'cotar_fornecedores', depende_de: [] },
      { etapa_id: 'compra', titulo: 'Comprar o primeiro lote (pequeno)', agente: 'fornecedores', acao: 'comprar_estoque', depende_de: ['fornecedor'] },
      { etapa_id: 'nota', titulo: 'Emissão de nota fiscal funcionando', agente: 'fiscal', acao: 'configurar_emissor_nota', depende_de: [] },
      { etapa_id: 'loja', titulo: 'Loja/marketplace e páginas', agente: 'oferta', acao: 'publicar_produto', depende_de: ['compra', 'nota'] },
      { etapa_id: 'frete', titulo: 'Frete e etiquetas', agente: 'logistica', acao: 'configurar_frete', depende_de: ['loja'] },
      { etapa_id: 'campanha', titulo: 'Campanha de captação (opt-in)', agente: 'trafego', acao: 'publicar_campanha', depende_de: ['loja', 'frete'] },
    ],
    riscos_tipicos: ['Dinheiro parado em estoque', 'Margem real menor depois de frete, taxa e devolução', 'Regulação da categoria'],
    checagens_obrigatorias: ['politicas_plataforma', 'lgpd_consumidor', 'fiscal', 'regulacao_produto'],
  },
  fisico_sem_estoque: {
    modelo: 'fisico_sem_estoque',
    descricao: 'Produto físico enviado direto pelo fornecedor (sem estoque próprio).',
    etapas: [
      ...comum(),
      { etapa_id: 'fornecedor', titulo: 'Fornecedor que envia direto', agente: 'fornecedores', acao: 'cotar_fornecedores', depende_de: [] },
      { etapa_id: 'nota', titulo: 'Emissão de nota fiscal funcionando', agente: 'fiscal', acao: 'configurar_emissor_nota', depende_de: [] },
      { etapa_id: 'loja', titulo: 'Loja/marketplace e páginas', agente: 'oferta', acao: 'publicar_produto', depende_de: ['fornecedor', 'nota'] },
      { etapa_id: 'campanha', titulo: 'Campanha de captação (opt-in)', agente: 'trafego', acao: 'publicar_campanha', depende_de: ['loja'] },
    ],
    riscos_tipicos: ['Prazo de entrega longo', 'Qualidade fora do controle', 'Reclamação recai sobre a loja'],
    checagens_obrigatorias: ['politicas_plataforma', 'lgpd_consumidor', 'fiscal', 'regulacao_produto'],
  },
  marketplace: {
    modelo: 'marketplace',
    descricao: 'Venda em marketplace (Mercado Livre, Shopee etc.).',
    etapas: [
      { etapa_id: 'conta', titulo: 'Conta de vendedor no marketplace', agente: 'jarvis_infra', acao: 'criar_conta', plataforma: 'mercado_livre', depende_de: [] },
      { etapa_id: 'nota', titulo: 'Emissão de nota fiscal funcionando', agente: 'fiscal', acao: 'configurar_emissor_nota', depende_de: [] },
      { etapa_id: 'anuncios', titulo: 'Anúncios dos produtos', agente: 'oferta', acao: 'publicar_produto', depende_de: ['conta', 'nota'] },
      { etapa_id: 'logistica', titulo: 'Envio/fulfillment do marketplace', agente: 'logistica', acao: 'configurar_frete', depende_de: ['anuncios'] },
    ],
    riscos_tipicos: ['Taxas do marketplace', 'Reputação do vendedor começa zerada'],
    checagens_obrigatorias: ['politicas_plataforma', 'lgpd_consumidor', 'fiscal', 'regulacao_produto'],
  },
  servico: {
    modelo: 'servico',
    descricao: 'Consultoria, agência ou assinatura de serviço.',
    etapas: [
      ...comum(),
      { etapa_id: 'oferta', titulo: 'Oferta e página do serviço', agente: 'oferta', acao: 'publicar_produto', depende_de: ['dominio'] },
      { etapa_id: 'contrato', titulo: 'Modelo de contrato (Autentique)', agente: 'vendas', acao: 'configurar_contrato', depende_de: [] },
      { etapa_id: 'campanha', titulo: 'Campanha de captação (opt-in)', agente: 'trafego', acao: 'publicar_campanha', depende_de: ['oferta', 'whatsapp'] },
    ],
    riscos_tipicos: ['Capacidade de entrega limita o crescimento'],
    checagens_obrigatorias: ['opt_in_whatsapp', 'lgpd_consumidor', 'fiscal'],
  },
  afiliado: {
    modelo: 'afiliado',
    descricao: 'Venda de produto de terceiros por comissão.',
    etapas: [
      { etapa_id: 'afiliacao', titulo: 'Afiliar-se ao produto', agente: 'jarvis_infra', acao: 'criar_conta', plataforma: 'hotmart', depende_de: [] },
      { etapa_id: 'campanha', titulo: 'Campanha de captação (opt-in)', agente: 'trafego', acao: 'publicar_campanha', depende_de: ['afiliacao'] },
    ],
    riscos_tipicos: ['Regras do produtor sobre anúncios', 'Comissão pode mudar'],
    checagens_obrigatorias: ['politicas_plataforma', 'lgpd_consumidor'],
  },
};
