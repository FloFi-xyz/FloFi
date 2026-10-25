// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-MAINNET-PRODUCT-001: the Mainnet-only product's notices (legacy test-network workflows and proposals, real funds at Review). */
export const portugueseMainnetProduct: Readonly<Record<string, string>> = {
  'This proposal uses a test network': 'Esta proposta usa uma rede de teste',
  'It was prepared for {0}. FloFi now runs on mainnets only, with real funds, so nothing was loaded or authorized. Ask {1} for a new proposal on {2}, or build it yourself in FloFi.':
    'Ela foi preparada para {0}. O FloFi agora funciona só em mainnets, com fundos reais, então nada foi carregado nem autorizado. Peça a {1} uma nova proposta na {2}, ou monte-a você mesmo no FloFi.',
  'a test network': 'uma rede de teste',
  'a mainnet': 'uma mainnet',
  'Nothing on this workflow runs on a test network. Rebuilding turns each step into a draft on its mainnet with the same amount: check every value and apply it. Mainnet uses real funds, and nothing runs before a fresh simulation, your Review and your wallet signature.':
    'Nada deste fluxo roda em uma rede de teste. Refazer transforma cada etapa em um rascunho na mainnet correspondente, com o mesmo valor: confira cada valor e aplique-o. A mainnet usa fundos reais, e nada roda antes de uma nova simulação, da sua Revisão e da assinatura da sua carteira.',
  'Rebuild on {0}': 'Refazer na {0}',
  '{0} is a test network. FloFi runs on mainnets only, with real funds: rebuild this on {1}.': '{0} é uma rede de teste. O FloFi funciona só em mainnets, com fundos reais: refaça isto na {1}.',
  '{0} are test networks. FloFi runs on mainnets only, with real funds: rebuild this on {1}.': '{0} são redes de teste. O FloFi funciona só em mainnets, com fundos reais: refaça isto na {1}.',
  '{0} is a test network. FloFi runs on mainnets only, with real funds.': '{0} é uma rede de teste. O FloFi funciona só em mainnets, com fundos reais.',
  '{0} are test networks. FloFi runs on mainnets only, with real funds.': '{0} são redes de teste. O FloFi funciona só em mainnets, com fundos reais.',
  'Real funds on {0}: the amounts above leave your wallet, and your wallet also pays the network fee in {1}. Your wallet shows the exact transaction before you confirm.':
    'Fundos reais na {0}: os valores acima saem da sua carteira, e a sua carteira também paga a taxa de rede em {1}. A sua carteira mostra a transação exata antes de você confirmar.',
  'This workflow uses a test network. FloFi runs on mainnets only: rebuild it on its mainnet in the Canvas first.':
    'Este fluxo usa uma rede de teste. O FloFi funciona só em mainnets: refaça-o primeiro na mainnet correspondente, no Canvas.',
};
