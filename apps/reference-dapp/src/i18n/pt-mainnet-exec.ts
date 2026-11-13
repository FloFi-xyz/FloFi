// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: bridge revalidation, cross-ecosystem destination wallets, the compact chat Review, the New workflow button and
 * network-fee sponsorship.
 */
export const portugueseMainnetExec: Readonly<Record<string, string>> = {
  // Execution boundary (simulationError).
  'The network fee rose above the maximum in your Review, so nothing was sent. Get a fresh quote and review it again.':
    'A taxa de rede subiu acima do máximo da sua revisão, então nada foi enviado. Obtenha uma nova cotação e revise de novo.',
  'The quote moved after your Review, so nothing was sent. FloFi got a fresh quote for the same workflow: check what changed and authorize again.':
    'A cotação mudou depois da sua revisão, então nada foi enviado. A FloFi obteve uma nova cotação para o mesmo fluxo: confira o que mudou e autorize de novo.',
  // Re-quote in place: the material values that moved.
  'Fresh quote': 'Nova cotação',
  'What changed since your Review': 'O que mudou desde a sua revisão',
  'Nothing material changed. Authorize the fresh Review to continue.': 'Nada relevante mudou. Autorize a nova revisão para continuar.',
  'Receives ≈': 'Recebe ≈',
  'Provider fee': 'Taxa do provedor',
  'Network fee, at most': 'Taxa de rede, no máximo',
  'Provider': 'Provedor',
  'Before': 'Antes',
  'Now': 'Agora',
  // Compact chat Review.
  'Receives': 'Recebe',
  '≈ {0}': '≈ {0}',
  'at most {0}': 'no máximo {0}',
  '≈ {0} · at most {1}': '≈ {0} · no máximo {1}',
  'Permission': 'Permissão',
  'Reviewed after step {0}': 'Revisada após a etapa {0}',
  // Bridge destination wallet.
  'Destination wallet': 'Carteira de destino',
  'Automatic: {0}': 'Automática: {0}',
  'Enter a valid {0} address.': 'Informe um endereço válido de {0}.',
  'This is not a {0} address.': 'Este não é um endereço de {0}.',
  'Choose one of your wallets or enter an address.': 'Escolha uma das suas carteiras ou informe um endereço.',
  'Enter the destination address on {0}.': 'Informe o endereço de destino em {0}.',
  'Solana address': 'Endereço Solana',
  'Address (0x…)': 'Endereço (0x…)',
  'Enter the destination wallet address.': 'Informe o endereço da carteira de destino.',
  'This address is for another kind of network. Enter an address of the destination network.': 'Este endereço é de outro tipo de rede. Informe um endereço da rede de destino.',
  'Enter a valid address for the destination network.': 'Informe um endereço válido da rede de destino.',
  // WETH paid as native ETH (Relay order paid in ETH).
  'Unwrap': 'Desembrulhar',
  'Unwrap transaction': 'Transação de desembrulho',
  'Unwrap {0} to ETH': 'Desembrulhar {0} em ETH',
  'Unwrap WETH to ETH': 'Desembrulhar WETH em ETH',
  'The provider is paid in ETH: your WETH is first unwrapped 1:1 into ETH in your wallet (its own wallet request), then deposited. A refund, if any, arrives as ETH.':
    'O provedor recebe em ETH: o seu WETH é primeiro desembrulhado 1:1 em ETH na sua carteira (um pedido próprio na carteira) e depois depositado. Um eventual reembolso chega em ETH.',
  // BUILD-FLOFI-MAINNET-EXEC-002 — network-fee sponsorship (ADR-0009)
  'Your wallet does not support sponsored network fees on this network, and your balance there cannot pay them, so FloFi did not ask your wallet. Add native gas to this wallet, or use a wallet that supports sponsored fees, then try again.':
    'Sua carteira não oferece suporte a taxas de rede patrocinadas nesta rede, e seu saldo nela não cobre essas taxas, então a FloFi não fez o pedido à sua carteira. Adicione gás nativo a esta carteira ou use uma carteira com suporte a taxas patrocinadas e tente de novo.',
  'Network fee sponsored: gas paid by FloFi (your wallet must support sponsored fees on this network)':
    'Taxa de rede patrocinada: gas pago pela FloFi (sua carteira precisa oferecer suporte a taxas patrocinadas nesta rede)',
  'Network fee sponsored when your wallet supports it: gas paid by FloFi; otherwise your wallet pays the estimate above':
    'Taxa de rede patrocinada quando sua carteira oferecer suporte: gas pago pela FloFi; caso contrário, sua carteira paga a estimativa acima',
  'Gas paid by FloFi: {0}': 'Gas pago pela FloFi: {0}',
};
