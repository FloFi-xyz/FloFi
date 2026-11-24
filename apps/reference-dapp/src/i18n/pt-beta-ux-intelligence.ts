// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BETA-UX-INTELLIGENCE-001: automatic account wallets (WS01), copyable public addresses (WS02) and inherited workflow fields (WS04).
 */
export const portugueseBetaUxIntelligence: Readonly<Record<string, string>> = {
  // WS01: wallet lifecycle in the header
  'Setting up your wallet…': 'Preparando a sua carteira…',
  "Your wallet couldn't be set up.": 'Não foi possível preparar a sua carteira.',
  'Your wallet is linked to another FloFi account.': 'A sua carteira está vinculada a outra conta FloFi.',
  // WS02: public wallet addresses
  '{0} address': 'Endereço {0}',
  'Wallet address': 'Endereço da carteira',
  'Your EVM wallet': 'Sua carteira EVM',
  'Your Solana wallet': 'Sua carteira Solana',
  // WS04: inherited workflow fields
  'Spends up to its amount from what step {0} actually delivers.': 'Gasta até o próprio valor a partir do que a etapa {0} realmente entregar.',
  'Connected to step {0}.': 'Conectada à etapa {0}.',
  'Connected to step {0}, but this step spends another asset. Choose the asset step {0} delivers to use its output.':
    'Conectada à etapa {0}, mas esta etapa gasta outro ativo. Escolha o ativo que a etapa {0} entrega para usar o resultado dela.',
  'Connected to step {0}, but this step runs on another network. Choose the network step {0} delivers on to use its output.':
    'Conectada à etapa {0}, mas esta etapa roda em outra rede. Escolha a rede em que a etapa {0} entrega para usar o resultado dela.',
  'Step {0} does not deliver an asset this step can spend; this step uses its own amount.':
    'A etapa {0} não entrega um ativo que esta etapa possa gastar; esta etapa usa o próprio valor.',
  'Step {0} sends its output to another wallet; this step uses its own amount.':
    'A etapa {0} envia o resultado para outra carteira; esta etapa usa o próprio valor.',
  'This step draws from Aave; it runs after step {0} with its own amount.':
    'Esta etapa retira da Aave; ela roda depois da etapa {0} com o próprio valor.',
  'Filled from the connected step: network, asset and amount. Check the card, then apply.':
    'Preenchido a partir da etapa conectada: rede, ativo e valor. Confira o card e aplique.',
};
