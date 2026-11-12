// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Dashboard wallet portfolio widget (pt-BR). Network, asset and protocol names (Base, Solana, Chainlink, ETH, WETH, SOL, WSOL),
 * "MOCKED" and "EVM" stay as they are. Shared words repeat the existing product translations.
 */
export const portuguesePortfolio: Readonly<Record<string, string>> = {
  'Network filter': 'Filtrar por rede', 'All networks': 'Todas as redes',
  'Portfolio value (priced)': 'Valor do portfólio (com preço)', 'Portfolio value': 'Valor do portfólio',
  '1 holding has no available valuation.': '1 ativo está sem avaliação disponível.',
  '{0} holdings have no available valuation.': '{0} ativos estão sem avaliação disponível.',
  'Verified prices only': 'Somente preços verificados',
  'Network allocation of priced holdings': 'Distribuição dos ativos com preço por rede',
  'No priced allocation available.': 'Não há distribuição com preços disponíveis.',
  'Allocation by network': 'Distribuição por rede', 'Valuation unavailable': 'Avaliação indisponível',
  'Allocation includes priced holdings only.': 'A distribuição inclui somente ativos com preço.',
  'Prices observed {0}.': 'Preços observados em {0}.', 'Top holdings': 'Principais ativos', 'View all assets': 'Ver todos os ativos',
  'Refresh failed. Showing the last available balances; try refreshing again.': 'A atualização falhou. Exibindo os últimos saldos disponíveis; tente atualizar novamente.',
  // Card
  'Wallet portfolio': 'Portfólio da carteira', 'Connect a wallet to see its balances.': 'Conecte uma carteira para ver os saldos dela.',
  'Test data (MOCKED)': 'Dados de teste (MOCKED)', 'Refresh': 'Atualizar', 'Refreshing…': 'Atualizando…', 'Retry': 'Tentar novamente',
  'Reading wallet balances…': 'Lendo os saldos da carteira…', 'Refreshing wallet balances…': 'Atualizando os saldos da carteira…',
  'Wallet balances are unavailable right now.': 'Os saldos da carteira estão indisponíveis no momento.',
  'No network is enabled for balance reads on this deployment.': 'Nenhuma rede está habilitada para leitura de saldos nesta implantação.',
  'No balances found on the networks read.': 'Nenhum saldo encontrado nas redes lidas.',
  'Some networks could not be read.': 'Algumas redes não puderam ser lidas.',
  'Priced holdings': 'Ativos com preço', '{0} of {1} holdings priced': '{0} de {1} ativos com preço', 'Holdings: {0}': 'Ativos: {0}', 'Other': 'Outros',
  'No verified USD price for these assets.': 'Não há preço verificado em USD para estes ativos.',
  'USD values are unavailable on this deployment.': 'Valores em USD não estão disponíveis nesta implantação.',
  'Show details': 'Ver detalhes', 'Hide details': 'Ocultar detalhes', 'Collapse': 'Recolher',
  // Details
  'Wallet': 'Carteira', 'EVM wallet': 'Carteira EVM', 'Solana wallet': 'Carteira Solana', 'Copy address': 'Copiar endereço', 'Copied': 'Copiado',
  'Networks': 'Redes', 'Read': 'Lida', 'Unavailable': 'Indisponível', 'Mainnet': 'Rede principal', 'Block {0}': 'Bloco {0}', 'Slot {0}': 'Slot {0}',
  'Native balance only: listed token balances could not be read.': 'Somente o saldo nativo: os saldos dos tokens listados não puderam ser lidos.',
  '{0} listed tokens were not checked.': '{0} tokens listados não foram verificados.',
  'Some token balances could not be read.': 'Alguns saldos de tokens não puderam ser lidos.',
  'Not enabled on this deployment: {0}': 'Não habilitadas nesta implantação: {0}',
  'Assets': 'Ativos', 'Asset': 'Ativo', 'Network': 'Rede', 'Balance': 'Saldo', 'Price': 'Preço', 'Value': 'Valor',
  '1 unlisted token not shown': '1 token não listado não exibido', '{0} unlisted tokens not shown': '{0} tokens não listados não exibidos',
  'Prices: Chainlink USD feeds on Base, observed {0}. Values are estimates, not quotes.':
    'Preços: feeds USD da Chainlink na Base, observados em {0}. Os valores são estimativas, não cotações.',
  'Prices: test fixture (MOCKED), observed {0}. Not market data.': 'Preços: fixture de teste (MOCKED), observados em {0}. Não são dados de mercado.',
  'Only assets with a verified Chainlink USD feed on this deployment are priced. Other assets show no value.':
    'Somente ativos com um feed USD verificado da Chainlink nesta implantação têm preço. Os demais ativos não exibem valor.',
  '{0}: balance unavailable': '{0}: saldo indisponível',
  'Underlying shares': 'Ações subjacentes',
  'Scaled by the token multiplier': 'Ajustado pelo multiplicador do token',
  'Includes accrued interest': 'Inclui juros acumulados',
  'On-chain amount: {0}': 'Quantidade on-chain: {0}',
  'Part of this balance is confidential and cannot be read.': 'Parte deste saldo é confidencial e não pode ser lida.',
  'This token uses a Token-2022 extension FloFi cannot interpret, so its balance is not shown.':
    'Este token usa uma extensão Token-2022 que a FloFi não consegue interpretar, por isso o saldo não é exibido.',
  'This balance could not be interpreted safely, so it is not shown.': 'Este saldo não pôde ser interpretado com segurança, por isso não é exibido.',
  'Transactions, DeFi positions and perpetuals are not shown: FloFi has no verified source for them. Your FloFi executions are in Your workflows.':
    'Transações, posições DeFi e perpétuos não são exibidos: o FloFi não tem uma fonte verificada para eles. Suas execuções no FloFi estão em Seus fluxos.',
  'Updated {0}': 'Atualizado em {0}',
};
