// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-E2E-RELIABILITY-001: execution-boundary refusals named precisely, and a landed approval never read as the action itself. */
export const portugueseE2eReliability: Readonly<Record<string, string>> = {
  'Your input token balance is too low for this swap. Nothing was sent.': 'O seu saldo do token de entrada é insuficiente para esta troca. Nada foi enviado.',
  'The observed on-chain result does not match the reviewed bounds, so FloFi stopped and keeps this run for review. Nothing is retried automatically.':
    'O resultado observado na rede não corresponde aos limites revisados, então a FloFi parou e mantém esta execução para revisão. Nada é repetido automaticamente.',
  'You declined this request in your wallet, so it was not signed or sent. Earlier confirmed requests stay recorded.':
    'Você recusou este pedido na carteira, então ele não foi assinado nem enviado. Os pedidos já confirmados continuam registrados.',
  'The connected wallet is not the wallet this Review was prepared for, so nothing was sent. Reconnect that wallet, or simulate again with this one.':
    'A carteira conectada não é a carteira para a qual esta revisão foi preparada, então nada foi enviado. Reconecte essa carteira ou simule de novo com esta.',
  '{0} of {1} actions completed. The token approval is confirmed on-chain; it only allows the spend. The action itself has not been sent yet and needs its own confirmation in your wallet.':
    '{0} de {1} ações concluídas. A aprovação do token está confirmada na rede; ela apenas autoriza o gasto. A ação em si ainda não foi enviada e precisa da sua própria confirmação na carteira.',
  'You chose not to continue now.': 'Você escolheu não continuar agora.',
  'Check the status, then continue again.': 'Verifique o status e depois continue de novo.',
  'A corporate action changed the shares per token since your Review.': 'Um evento societário alterou as ações por token desde a sua revisão.',
  'The reviewed quote expired before the next request could start.': 'A cotação revisada expirou antes de o próximo pedido poder começar.',
  'The reviewed route no longer quotes your reviewed minimum output.': 'A rota revisada já não cota o seu mínimo de saída revisado.',
  'Your wallet’s on-chain state or the network fee changed since the Review (for example its next transaction number, allowance or the fee ceiling).':
    'O estado da sua carteira na rede ou a taxa de rede mudou desde a revisão (por exemplo o próximo número de transação, a permissão ou o teto de taxa).',
};
