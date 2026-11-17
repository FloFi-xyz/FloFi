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
  'Balance on {0} at {1}: {2}': 'Saldo na {0} às {1}: {2}', 'Balance on {0}: {1}': 'Saldo na {0}: {1}',
  'Max keeps {0} for network fees.': 'O máximo reserva {0} para as taxas da rede.',
  'Nothing is signed: you still simulate and review.': 'Nada é assinado: você ainda simula e revisa.',
};
