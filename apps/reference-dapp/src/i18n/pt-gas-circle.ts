// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §3): the network fee paid from the owner's USDC through Circle's paymaster (pt-BR). "Taxa
 * de rede", "paga com seu USDC", "a FloFi"; never "grátis", "sem taxas" or "patrocinado" (the owner pays it). Protocol names (Circle, USDC,
 * EntryPoint, paymaster, ETH) are kept.
 */
export const portugueseGasCircle: Readonly<Record<string, string>> = {
  // Review, Editor and /approve.
  'Network fee, at most {0} — paid from your USDC through Circle': 'Taxa de rede, no máximo {0} — paga com seu USDC pela Circle',
  'Two signatures: a USDC permit for the fee, then the operation': 'Duas assinaturas: uma permissão de USDC para a taxa e, depois, a operação',
  'Network fee paid: {0}': 'Taxa de rede paga: {0}',
  '{0} — paid from your USDC through Circle': '{0} — paga com seu USDC pela Circle',
  '{0} — paid from your USDC through Circle + later requests, quoted when due':
    '{0} — paga com seu USDC pela Circle + os pedidos seguintes, cotados quando chegar a vez deles',
  '{0} + {1} — paid from your USDC through Circle': '{0} + {1} — paga com seu USDC pela Circle',
  '{0} + {1} — paid from your USDC through Circle + later requests, quoted when due':
    '{0} + {1} — paga com seu USDC pela Circle + os pedidos seguintes, cotados quando chegar a vez deles',
  'The network fee is paid from your USDC through Circle. FloFi never signs or sends for you.':
    'A taxa de rede é paga com seu USDC pela Circle. A FloFi nunca assina nem envia por você.',
  // Technical details (collapsed).
  'Circle paymaster {0} · EntryPoint {1} · USDC permit cap {2}': 'Paymaster da Circle {0} · EntryPoint {1} · limite da permissão de USDC {2}',
  'What is left of the permit cap stays approved to Circle\'s paymaster until your next USDC permit replaces it.':
    'O que sobrar do limite da permissão continua aprovado para o paymaster da Circle até que a sua próxima permissão de USDC o substitua.',
  // Native-fee shortfall: why the USDC alternative was not available.
  'Paying this fee in USDC through Circle is not available: {0}.': 'Pagar esta taxa em USDC pela Circle não está disponível: {0}.',
  'this wallet is not a smart account on this network': 'esta carteira não é uma conta inteligente nesta rede',
  'Circle does not support this smart-account version on this network': 'a Circle não aceita esta versão de conta inteligente nesta rede',
  'this smart-account type is not supported': 'este tipo de conta inteligente não é aceito',
  'FloFi Wallet cannot sign it': 'a FloFi Wallet não consegue assiná-la',
  'the wallet that would sign it was not identified': 'a carteira que a assinaria não foi identificada',
  'the service that relays it does not support this smart-account version on this network': 'o serviço que a encaminha não aceita esta versão de conta inteligente nesta rede',
  'this wallet does not hold enough USDC for the steps and the fee': 'esta carteira não tem USDC suficiente para as etapas e a taxa',
  'no verified ETH price is available right now': 'não há um preço verificado de ETH disponível agora',
  'Circle\'s contract could not be verified on this network': 'o contrato da Circle não pôde ser verificado nesta rede',
  'this request also sends ETH that this wallet does not hold': 'este pedido também envia ETH que esta carteira não tem',
  'the service that relays it is not available on this network': 'o serviço que a encaminha não está disponível nesta rede',
  'this network cannot simulate the whole request': 'esta rede não consegue simular o pedido inteiro',
  'the network could not be read just now': 'não foi possível ler a rede agora',
  'it is not available here': 'não está disponível aqui',
  // Refusals before anything is relayed.
  'Your USDC permit for the network fee could not be verified, so nothing was sent. Try again.':
    'Não foi possível verificar a sua permissão de USDC para a taxa de rede, então nada foi enviado. Tente de novo.',
  'Another USDC permit from this wallet replaced the one for this network fee, so it can no longer pay it. Nothing was sent.':
    'Outra permissão de USDC desta carteira substituiu a desta taxa de rede, que por isso já não pode pagá-la. Nada foi enviado.',
  'The network fee rose above the USDC amount you approved, so nothing was sent. Ask again for a request with the new fee.':
    'A taxa de rede subiu acima do valor em USDC que você aprovou, então nada foi enviado. Peça de novo um pedido com a nova taxa.',
  'Sign the USDC permit for the network fee first. Nothing was sent.': 'Assine primeiro a permissão de USDC para a taxa de rede. Nada foi enviado.',
  'This request already moved on. Nothing was sent; load it again.': 'Este pedido já avançou. Nada foi enviado; carregue-o de novo.',
  'What your wallet would sign did not match the network fee FloFi showed, so your wallet was not asked. Nothing was sent.':
    'O que a sua carteira assinaria não correspondia à taxa de rede que a FloFi mostrou, então a carteira não foi acionada. Nada foi enviado.',
  'FloFi Wallet cannot pay network fees in USDC. Add ETH on this network to this wallet, or use a wallet with a smart account. Nothing was sent.':
    'A FloFi Wallet não consegue pagar taxas de rede em USDC. Adicione ETH nesta rede a esta carteira ou use uma carteira com conta inteligente. Nada foi enviado.',
  'Circle declined to take this network fee in USDC just now. Nothing was sent; try again later, or add ETH on this network.':
    'A Circle recusou cobrar esta taxa de rede em USDC agora. Nada foi enviado; tente de novo mais tarde ou adicione ETH nesta rede.',
  'This wallet does not hold enough USDC for the steps and the network fee. Nothing was sent.':
    'Esta carteira não tem USDC suficiente para as etapas e a taxa de rede. Nada foi enviado.',
  'The network fee of this request could not be bounded, so nothing was sent. Try again.':
    'Não foi possível limitar a taxa de rede deste pedido, então nada foi enviado. Tente de novo.',
  'The prepared request did not match what you approved, so nothing was sent.': 'O pedido preparado não correspondia ao que você aprovou, então nada foi enviado.',
  'Who pays the network fee changed since your review (ETH arrived in or left this wallet). Nothing was sent; review again.':
    'Quem paga a taxa de rede mudou desde a sua revisão (chegou ou saiu ETH desta carteira). Nada foi enviado; revise de novo.',
  'FloFi did not send this request after its time window ended (it would only have failed and still cost you the network fee in USDC). It did not execute, and no network fee was taken.':
    'A FloFi não enviou este pedido depois que o prazo dele terminou (ele apenas falharia e ainda custaria a taxa de rede em USDC). Ele não foi executado e nenhuma taxa de rede foi cobrada.',
  'The service that relays this request does not support this smart-account version on this network, so nothing was sent. Load the request again to see how the network fee can be paid.':
    'O serviço que encaminha este pedido não aceita esta versão de conta inteligente nesta rede, então nada foi enviado. Carregue o pedido de novo para ver como a taxa de rede pode ser paga.',
};
