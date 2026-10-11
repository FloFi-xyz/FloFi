// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-RH-002: Robinhood Chain — the Stocks card catalog search, Stock Token facts, mainnet transfers and the USDC ⇄ USDG bridge routes. */
export const portugueseRobinhood: Readonly<Record<string, string>> = {
  'Featured': 'Destaques', 'Search assets': 'Pesquisar ativos', 'Search Stock Tokens': 'Pesquisar Stock Tokens',
  'Search by symbol or company name…': 'Pesquise por símbolo ou nome da empresa…', 'Loading Robinhood Stock Tokens…': 'Carregando os Stock Tokens da Robinhood…',
  'Robinhood Stock Tokens are unavailable right now.': 'Os Stock Tokens da Robinhood estão indisponíveis no momento.',
  'No Stock Token matches this search.': 'Nenhum Stock Token corresponde a esta pesquisa.', 'Stock Token results': 'Resultados de Stock Tokens',
  '{0} Stock Tokens · type to search': '{0} Stock Tokens · digite para pesquisar', 'Stock Token details': 'Detalhes do Stock Token',
  '{0} shares per token': '{0} ações por token', 'Shares per token': 'Ações por token',
  'A corporate action will change the shares per token after this Review expires.': 'Um evento societário vai alterar as ações por token depois que esta revisão expirar.',
  'Fractional trading of the underlying share is restricted.': 'A negociação fracionada da ação subjacente está restrita.',
  'Stock Tokens are issued by Robinhood Assets (Jersey) Limited and are not offered to US persons or in restricted jurisdictions.':
    'Os Stock Tokens são emitidos pela Robinhood Assets (Jersey) Limited e não são oferecidos a pessoas dos EUA nem em jurisdições restritas.',
  '{0} is not enabled on this app instance.': '{0} não está habilitado nesta instância do app.',
  'Real funds: your wallet signs and sends this transaction on {0}. Flofi never signs for you.': 'Fundos reais: sua carteira assina e envia esta transação na {0}. O Flofi nunca assina por você.',
  'Real funds: your wallet signs and sends this transaction; Flofi never signs for you.': 'Fundos reais: sua carteira assina e envia esta transação; o Flofi nunca assina por você.',
  'Stocks · Uniswap ·': 'Ações · Uniswap ·', 'Stocks amount ({0})': 'Valor para ações ({0})',
  'Robinhood Chain transfer': 'Transferência na Robinhood Chain', 'Transfer asset': 'Ativo da transferência', 'Transfer amount': 'Valor da transferência',
  'Recipient (optional)': 'Destinatário (opcional)', 'Transfer recipient': 'Destinatário da transferência', 'to your connected wallet.': 'para sua carteira conectada.',
  'Exact amount': 'Valor exato', 'units)': 'unidades)', 'Asset balance': 'Saldo do ativo', '(token transfer)': '(transferência de token)',
  'Cross-chain Router · {0} → {1} · {2} → {3}. Real funds on mainnet; a route is chosen and shown at Review.':
    'Router entre redes · {0} → {1} · {2} → {3}. Fundos reais na rede principal; a rota é escolhida e mostrada na revisão.',
  'Cross-chain amount ({0})': 'Montante entre redes ({0})', 'Between {0} and {1} {2} per bridge in this release.': 'Entre {0} e {1} {2} por transferência nesta versão.',
  'USDG from': 'USDG de', '{0} through the Cross-chain Router ·': '{0} através do Router entre redes ·',
  // Robinhood Chain liquidity (catalog pairs, real funds).
  'Liquidity fee tier': 'Faixa de taxa da liquidez',
  'Real funds on Robinhood Chain. Simulate checks both tokens against the official registry and the live pool.':
    'Fundos reais na Robinhood Chain. A simulação confere os dois tokens no registro oficial e no pool ativo.',
  '{0} {1} and {2} {3}': '{0} {1} e {2} {3}', 'across the full price range': 'em toda a faixa de preço',
  'between {0} and {1} {2} per {3}': 'entre {0} e {1} {2} por {3}', '· fee {0}%.': '· taxa {0}%.',
  'Real funds on Robinhood Chain: your wallet signs every request after your Review; Flofi never signs or sends.':
    'Fundos reais na Robinhood Chain: sua carteira assina cada solicitação depois da sua revisão; o Flofi nunca assina nem envia.',
  '{0} per {1} · tick': '{0} por {1} · tick', '{0} per {1} · exact ticks': '{0} por {1} · ticks exatos',
};
