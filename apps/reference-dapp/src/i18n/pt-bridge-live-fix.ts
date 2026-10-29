// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BRIDGE-LIVE-FIX-003: refusals at the execution boundary, the compact financial Review (fee treatments, FloFi fee status, total
 * additional payable costs) and the FloFi Assistant chat.
 */
export const portugueseBridgeLiveFix: Readonly<Record<string, string>> = {
  // Execution-boundary refusals (simulationError).
  'Your wallet may already have sent this request. FloFi never sends it again; it keeps checking the network for its result.':
    'A sua carteira pode já ter enviado este pedido. A FloFi nunca o envia de novo; ela continua verificando o resultado na rede.',
  'FloFi could not re-check the route with the provider just before your wallet request, so nothing was sent. Try again in a moment.':
    'A FloFi não conseguiu conferir a rota com o provedor logo antes do pedido na carteira, então nada foi enviado. Tente de novo em instantes.',
  'The provider quote or the on-chain state changed after your Review, so nothing was sent. Get a fresh quote and review it again.':
    'A cotação do provedor ou o estado on-chain mudou depois da sua revisão, então nada foi enviado. Busque uma nova cotação e revise de novo.',
  'The reviewed request was no longer authorized when FloFi was about to open your wallet, so nothing was sent. Review it again.':
    'O pedido revisado não estava mais autorizado quando a FloFi ia abrir a sua carteira, então nada foi enviado. Revise de novo.',
  'Another transaction from this wallet took the next transaction slot (nonce), so nothing was sent. Review it again.':
    'Outra transação desta carteira ocupou o próximo número de transação (nonce), então nada foi enviado. Revise de novo.',
  'The workflow or its reviewed transaction changed before your wallet was asked, so nothing was sent. Review it again.':
    'O workflow ou a transação revisada mudou antes do pedido à carteira, então nada foi enviado. Revise de novo.',
  'Your wallet connection changed, so nothing was sent. Reconnect the reviewed wallet and review again.':
    'A conexão da sua carteira mudou, então nada foi enviado. Reconecte a carteira revisada e revise de novo.',
  'Your wallet did not authorize FloFi for this account. Reconnect the wallet, then try again.':
    'A sua carteira não autorizou a FloFi para esta conta. Reconecte a carteira e tente de novo.',
  'This wallet cannot send this kind of request. Use another wallet, then try again.': 'Esta carteira não consegue enviar este tipo de pedido. Use outra carteira e tente de novo.',
  'Another request for this workflow is still in progress.': 'Outro pedido deste workflow ainda está em andamento.',
  'Check this workflow in Simulate before execution.': 'Confira este workflow em Simular antes da execução.',
  'Execution is unavailable for this route.': 'A execução não está disponível para esta rota.',
  'Destination delivery': 'Entrega no destino',
  // The compact financial Review.
  'Sending': 'Enviando', 'Expected receipt': 'Recebimento esperado', 'Minimum receipt': 'Recebimento mínimo',
  'Already included in the quoted output': 'Já incluída no valor cotado', 'Maximum, separate from the output': 'Máximo, separado do valor recebido',
  'Estimated, paid on top': 'Estimado, pago à parte', 'network fee up to {0}': 'taxa de rede de até {0}', 'Up to {0}': 'Até {0}',
  'None beyond the amount sent': 'Nenhum além do valor enviado', 'Quote expiry': 'Validade da cotação', 'Total additional payable costs': 'Total de custos adicionais a pagar',
  'Fee breakdown': 'Detalhamento das taxas', 'Not charged': 'Não cobrada', 'Cost lines FloFi cannot classify': 'Linhas de custo que a FloFi não consegue classificar',
  "FloFi's 0.1% fee per completed workflow is not collected on-chain, and this route records no fee obligation yet.":
    'A taxa de 0,1% da FloFi por workflow concluído não é cobrada on-chain, e esta rota ainda não registra obrigação de taxa.',
  'Pool fee': 'Taxa do pool', 'Uniswap v3 fee tier, already reflected in the quoted output.': 'Faixa de taxa do Uniswap v3, já refletida no valor cotado.',
  "Ceiling for the token approval request; the swap's own network fee is checked after the approval confirms.":
    'Teto para o pedido de aprovação do token; a taxa de rede da troca é verificada depois que a aprovação for confirmada.',
  'Ceiling for this wallet request, separate from the swap output.': 'Teto para este pedido na carteira, separado do valor da troca.',
};
