// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-MAINNET-EXEC-002 (review round 2): in-place re-quote reasons, unwrap observation and destination labels. New keys only. */
export const portugueseRound2Requote: Readonly<Record<string, string>> = {
  'The network fee moved after your Review, so nothing was sent. FloFi got a fresh quote for the same workflow: check what changed and authorize again.':
    'A taxa de rede mudou depois da sua revisão, então nada foi enviado. A FloFi buscou uma nova cotação para o mesmo fluxo: confira o que mudou e autorize de novo.',
  'Your Review expired before the wallet request, so nothing was sent. FloFi got a fresh quote for the same workflow: check what changed and authorize again.':
    'Sua revisão expirou antes do pedido à carteira, então nada foi enviado. A FloFi buscou uma nova cotação para o mesmo fluxo: confira o que mudou e autorize de novo.',
  'Your WETH is now ETH in your wallet. Nothing was bridged yet: the bridge deposit needs its own wallet request.':
    'Seu WETH agora é ETH na sua carteira. Nada foi enviado pela ponte ainda: o depósito da ponte precisa do seu próprio pedido à carteira.',
};
