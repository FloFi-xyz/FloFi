// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002 review round 2 (frontend): the compact chat Review's visible lines, who pays each network fee when FloFi offers
 * to sponsor it, the Bridge card's wallet choices, FloFi's fallback wallet name and an unwrapping route's evidence note. New keys only.
 */
export const portugueseRound2Frontend: Readonly<Record<string, string>> = {
  // Compact chat Review.
  'See Technical details': 'Veja os detalhes técnicos',
  'Funded by': 'Financiada por',
  'Bound amount': 'Valor vinculado',
  'The swap’s reconciled output, up to {0}': 'O resultado reconciliado do swap, até {0}',
  // Whole-workflow Review: network-fee sponsorship (ADR-0009).
  'All {0} steps run as ONE wallet confirmation on {1}: one atomic transaction from your own wallet; FloFi offers to pay its network fee (your wallet must support sponsored fees on this network).':
    'As {0} etapas rodam com UMA confirmação na carteira em {1}: uma transação atômica da sua própria carteira; a FloFi se oferece para pagar a taxa de rede dela (sua carteira precisa oferecer suporte a taxas patrocinadas nesta rede).',
  'All {0} steps run as ONE wallet confirmation on {1}: one atomic transaction from your own wallet; FloFi offers to pay its network fee, and your wallet pays it only if it does not support sponsored fees.':
    'As {0} etapas rodam com UMA confirmação na carteira em {1}: uma transação atômica da sua própria carteira; a FloFi se oferece para pagar a taxa de rede dela, e sua carteira só a paga se não oferecer suporte a taxas patrocinadas.',
  'FloFi offers to pay the network fee; your wallet must support sponsored fees on {0}.':
    'A FloFi se oferece para pagar a taxa de rede; sua carteira precisa oferecer suporte a taxas patrocinadas na {0}.',
  'FloFi offers to pay the network fee of group {0}; your wallet must support sponsored fees on {1}.':
    'A FloFi se oferece para pagar a taxa de rede do grupo {0}; sua carteira precisa oferecer suporte a taxas patrocinadas na {1}.',
  'FloFi offers to pay the network fee; your wallet pays it only if it does not support sponsored fees.':
    'A FloFi se oferece para pagar a taxa de rede; sua carteira só a paga se não oferecer suporte a taxas patrocinadas.',
  'FloFi offers to pay the network fee of group {0}; your wallet pays it only if it does not support sponsored fees.':
    'A FloFi se oferece para pagar a taxa de rede do grupo {0}; sua carteira só a paga se não oferecer suporte a taxas patrocinadas.',
  'Your wallet pays every other network fee.': 'Sua carteira paga as demais taxas de rede.',
  'FloFi never signs or sends for you.': 'A FloFi nunca assina nem envia por você.',
  'None from your wallet: FloFi offers to pay it': 'Nada da sua carteira: a FloFi se oferece para pagá-la',
  'Later requests, quoted when due': 'Pedidos seguintes, cotados quando chegar a vez deles',
  // Bridge destination wallet.
  'Your wallets': 'Suas carteiras',
  'Browser wallet': 'Carteira do navegador',
  // Execution evidence: an unwrapping route (WETH converted to ETH before the deposit).
  'The source deposit has not been requested. A confirmed unwrap can still have network costs; its ETH stays in your wallet.':
    'O envio dos tokens na origem ainda não foi solicitado. Uma conversão confirmada ainda pode ter custos de rede; o ETH resultante continua na sua carteira.',
};
