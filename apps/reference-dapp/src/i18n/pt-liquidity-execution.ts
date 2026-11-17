// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001 (EXEC-01): a Review that expired (or no longer stood) before the next wallet request of a
 * liquidity run, refreshed in place with its confirmed steps kept. New keys only.
 */
export const portugueseLiquidityExecution: Readonly<Record<string, string>> = {
  'Your Review expired before FloFi asked your wallet for the next request, so nothing more was sent. The confirmed steps stay recorded and are not repeated. Simulate again to refresh the Review of the same run, then authorize it to continue.':
    'Sua revisão expirou antes de a FloFi pedir o próximo pedido à sua carteira, então nada mais foi enviado. As etapas confirmadas continuam registradas e não são repetidas. Simule de novo para atualizar a revisão da mesma execução e autorize-a para continuar.',
  'Your Review expired before FloFi asked your wallet, so nothing was sent. Simulate again to refresh the Review, then authorize it to continue.':
    'Sua revisão expirou antes de a FloFi pedir à sua carteira, então nada foi enviado. Simule de novo para atualizar a revisão e autorize-a para continuar.',
  'Your Review expired before FloFi asked your wallet for the next request, so nothing was sent. FloFi refreshed the simulation and Review of the same position; confirmed steps are kept and not repeated. Check it and authorize again to continue.':
    'Sua revisão expirou antes de a FloFi pedir o próximo pedido à sua carteira, então nada foi enviado. A FloFi atualizou a simulação e a revisão da mesma posição; as etapas confirmadas são mantidas e não se repetem. Confira e autorize de novo para continuar.',
  'The pool or the network fee changed after your Review, so nothing was sent. FloFi refreshed the simulation and Review of the same position; confirmed steps are kept and not repeated. Check it and authorize again to continue.':
    'O pool ou a taxa de rede mudou depois da sua revisão, então nada foi enviado. A FloFi atualizou a simulação e a revisão da mesma posição; as etapas confirmadas são mantidas e não se repetem. Confira e autorize de novo para continuar.',
  'An earlier wallet request was not sent and the Review was refreshed. Check the updated Review and authorize it again.':
    'Um pedido anterior à carteira não foi enviado e a revisão foi atualizada. Confira a revisão atualizada e autorize-a de novo.',
};
