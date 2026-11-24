// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BETA-UX-INTELLIGENCE-001: automatic account wallets (WS01), copyable public addresses (WS02) and inherited workflow fields (WS04).
 */
export const portugueseBetaUxIntelligence: Readonly<Record<string, string>> = {
  // WS01: wallet lifecycle in the header
  'Setting up your wallet…': 'Preparando sua carteira…',
  "Your wallet couldn't be set up.": 'Não foi possível preparar sua carteira.',
  // WS02: public wallet addresses
  'Copy EVM address': 'Copiar endereço EVM',
  'Copy Solana address': 'Copiar endereço Solana',
  'EVM address copied.': 'Endereço EVM copiado.',
  'Solana address copied.': 'Endereço Solana copiado.',
  // WS04: inherited workflow fields
  "Uses what step {0} delivers, up to this card's amount.": 'Usa o que a etapa {0} entregar, até o valor deste cartão.',
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
  'Filled from step {0}: network, asset and amount. Check the card, then apply.':
    'Preenchido a partir da etapa {0}: rede, ativo e valor. Confira o cartão e aplique.',
  'Filled the network and asset from step {0}. Enter the amount, then apply.':
    'Rede e ativo preenchidos a partir da etapa {0}. Informe o valor e aplique.',
};
