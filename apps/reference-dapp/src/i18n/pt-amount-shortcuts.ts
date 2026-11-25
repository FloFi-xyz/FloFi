// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (pt-BR, UX-02): the 25% · 50% · 75% · Max shortcuts under FloFi's amount question. Network and asset names
 * (Base, Solana, ETH, USDC) stay as they are.
 */
export const portugueseAmountShortcuts: Readonly<Record<string, string>> = {
  'Amount shortcuts': 'Atalhos de valor', 'Max': 'Máx',
  'Use your maximum: {0}': 'Usar o máximo: {0}', 'Use {0} of your balance: {1}': 'Usar {0} do seu saldo: {1}',
  'Reading your balance…': 'Lendo seu saldo…',
  'Connect the wallet that will sign to use your balance. You can still type an amount.': 'Conecte a carteira que vai assinar para usar seu saldo. Você ainda pode digitar um valor.',
  'Your balance could not be read. Type an amount instead.': 'Não foi possível ler seu saldo. Digite um valor.',
  'Your balance changed. Check the amounts and choose again.': 'Seu saldo mudou. Confira os valores e escolha de novo.',
  'The amount you asked for': 'O valor que você pediu',
  'Use all your {0} on {1}: {2}': 'Usar todo o seu {0} na {1}: {2}',
  'Use {0}% of your {1} on {2}: {3}': 'Usar {0}% do seu {1} na {2}: {3}',
  'FloFi keeps {0} for network fees, so that share of your {1} cannot be used. Type a smaller amount.':
    'O FloFi reserva {0} para as taxas de rede, então essa parte do seu saldo de {1} não pode ser usada. Digite um valor menor.',
  'FloFi cannot write that share of your balance as an amount here. Type an amount.': 'O FloFi não consegue escrever essa parte do seu saldo como um valor aqui. Digite um valor.',
  'Your {0} balance on {1} is {2}, so there is nothing to use for this request. Add funds or type an amount.':
    'Seu saldo de {0} na {1} é {2}, então não há nada para usar neste pedido. Adicione fundos ou digite um valor.',
  'Balance on {0} at {1}: {2}': 'Saldo na {0} às {1}: {2}', 'Balance on {0}: {1}': 'Saldo na {0}: {1}',
  'Max keeps {0} for network fees.': 'O máximo reserva {0} para as taxas da rede.',
  'Nothing is signed: you still simulate and review.': 'Nada é assinado: você ainda simula e revisa.',
};
