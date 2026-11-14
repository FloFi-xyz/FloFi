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
  'if your ETH cannot pay its network fee, it can be paid from your USDC through Circle: then two signatures (a USDC permit, then the operation)':
    'se o seu ETH não puder pagar a taxa de rede deste grupo, ela pode ser paga com seu USDC pela Circle: então são duas assinaturas (uma permissão de USDC e, depois, a operação)',
  'Network fee paid: {0}': 'Taxa de rede paga: {0}',
  '{0} — paid from your USDC through Circle': '{0} — paga com seu USDC pela Circle',
  '{0} — paid from your USDC through Circle + later requests, quoted when due':
    '{0} — paga com seu USDC pela Circle + os pedidos seguintes, cotados quando chegar a vez deles',
  '{0} + {1} — paid from your USDC through Circle': '{0} + {1} — paga com seu USDC pela Circle',
  '{0} + {1} — paid from your USDC through Circle + later requests, quoted when due':
    '{0} + {1} — paga com seu USDC pela Circle + os pedidos seguintes, cotados quando chegar a vez deles',
  'The network fee is paid from your USDC through Circle. FloFi never signs or sends for you.':
    'A taxa de rede é paga com seu USDC pela Circle. A FloFi nunca assina nem envia por você.',
  // Review UX3: the visible "Token permission" line of a Circle-paid request (its USDC permit).
  'Circle\'s paymaster may take up to {0} for the network fee; what is left stays approved until your next USDC permit':
    'O paymaster da Circle pode cobrar até {0} pela taxa de rede; o que sobrar continua aprovado até a sua próxima permissão de USDC',
  // Review UX8 (/approve): cancelling an unrelayed Circle-paid operation is an ordinary transaction paid in ETH.
  'Cancelling is an ordinary transaction from your wallet, and its network fee is paid in ETH, not in USDC through Circle: you need a small amount of ETH on {0} first.':
    'Cancelar é uma transação comum da sua carteira, e a taxa de rede dela é paga em ETH, não em USDC pela Circle: você precisa de um pouco de ETH em {0} antes.',
  // Review B1/LQ1 (all token-paid mechanisms): a later step on the same network still needs its native coin for the network fee.
  'A later step on {0} needs {1} for its network fee: {2}. Add {1} before starting, or the run will stop there.':
    'Uma etapa posterior em {0} precisa de {1} para a taxa de rede: {2}. Adicione {1} antes de começar, ou a execução vai parar ali.',
  'Later steps on {0} need {1} for their network fee: {2}. Add {1} before starting, or the run will stop there.':
    'Etapas posteriores em {0} precisam de {1} para a taxa de rede: {2}. Adicione {1} antes de começar, ou a execução vai parar ali.',
  'step {0} ({1})': 'etapa {0} ({1})',
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
  'How the network fee is paid changed since it was shown to you: your ETH on this network now covers it, or no longer does. Nothing was sent. Authorize again to see the request with the fee as it is paid now.':
    'A forma de pagar a taxa de rede mudou desde que ela foi mostrada a você: o seu ETH nesta rede agora a cobre, ou deixou de cobrir. Nada foi enviado. Autorize de novo para ver o pedido com a taxa como ela é paga agora.',
  // Review UX1: the Editor's Review bound the mechanism; the way forward is to end the run and review again (and the button that does it).
  'How the network fee is paid changed since your review: your ETH on this network now covers it, or no longer does. Nothing was sent. End this workflow and review it again to see how the fee is paid now.':
    'A forma de pagar a taxa de rede mudou desde a sua revisão: o seu ETH nesta rede agora a cobre, ou deixou de cobrir. Nada foi enviado. Encerre este fluxo e revise-o de novo para ver como a taxa é paga agora.',
  'End and review again': 'Encerrar e revisar de novo',
  // Review UX1: the USDC cap rose since the Review (CIRCLE_FEE_CAP_ROSE_CONFIRM): shown and confirmed before the wallet is asked.
  'Network fee, at most {0} — paid from your USDC through Circle (reviewed {1}: the network fee or the ETH price moved since your review)':
    'Taxa de rede, no máximo {0} — paga com seu USDC pela Circle (revisado: {1}; a taxa de rede ou o preço do ETH mudou desde a sua revisão)',
  'Prices moved since your review. Confirm what your wallet will be asked:': 'Os preços mudaram desde a sua revisão. Confirme o que será pedido à sua carteira:',
  // Review UX4: the two Circle signatures, one at a time (never the batch calls).
  'EXECUTION · SIGNATURE {0} OF {1}': 'EXECUÇÃO · ASSINATURA {0} DE {1}',
  'Signature 1 of 2: USDC permit, at most {0}. It lets Circle\'s paymaster take the network fee from your USDC.':
    'Assinatura 1 de 2: permissão de USDC, no máximo {0}. Ela permite que o paymaster da Circle cobre a taxa de rede do seu USDC.',
  'Signature 2 of 2: the operation. Your wallet shows it as typed data; FloFi relays it, and Circle\'s paymaster takes the network fee from your USDC.':
    'Assinatura 2 de 2: a operação. A sua carteira a mostra como dados tipados; a FloFi a encaminha, e o paymaster da Circle cobra a taxa de rede do seu USDC.',
  'Sign the USDC permit in your wallet. It sends no transaction.': 'Assine a permissão de USDC na sua carteira. Ela não envia nenhuma transação.',
  'Sign the operation in your wallet. It sends no transaction: FloFi relays it.': 'Assine a operação na sua carteira. Ela não envia nenhuma transação: a FloFi a encaminha.',
  // Review UX7: a Circle-paid group is one operation and two signatures, never "one wallet confirmation" or "one per group".
  '{0} calls in the operation ({1} token approvals)': '{0} chamadas na operação ({1} aprovações de token)',
  'All {0} steps run as ONE operation on {1} from your own account: two signatures in your wallet (a USDC permit for the network fee, then the operation), then FloFi relays it and Circle\'s paymaster takes the network fee from your USDC.':
    'As {0} etapas rodam como UMA operação em {1} da sua própria conta: duas assinaturas na sua carteira (uma permissão de USDC para a taxa de rede e, depois, a operação); então a FloFi a encaminha e o paymaster da Circle cobra a taxa de rede do seu USDC.',
  'All {0} steps run in {2} wallet requests: a group whose network fee is paid from your USDC through Circle asks for two signatures (a USDC permit, then the operation); a later group is asked when it becomes due.':
    'As {0} etapas rodam com {2} pedidos à carteira: um grupo cuja taxa de rede é paga com seu USDC pela Circle pede duas assinaturas (uma permissão de USDC e, depois, a operação); um grupo posterior é pedido quando chegar a vez dele.',
  'FloFi did not send this request after its time window ended (it would only have failed and still cost you the network fee in USDC). It did not execute, and no network fee was taken.':
    'A FloFi não enviou este pedido depois que o prazo dele terminou (ele apenas falharia e ainda custaria a taxa de rede em USDC). Ele não foi executado e nenhuma taxa de rede foi cobrada.',
  'The service that relays this request does not support this smart-account version on this network, so nothing was sent. Load the request again to see how the network fee can be paid.':
    'O serviço que encaminha este pedido não aceita esta versão de conta inteligente nesta rede, então nada foi enviado. Carregue o pedido de novo para ver como a taxa de rede pode ser paga.',
  // Owner requirement (FloFi Wallet + Circle): the EIP-7702 upgrade inside the first Circle-paid operation.
  // Owner requirement (FloFi Wallet + Circle): FloFi's consent card before the first Circle-paid operation (the upgrade) or a later one (the fee).
  'Upgrade this FloFi Wallet address to pay the network fee in USDC': 'Atualizar este endereço da FloFi Wallet para pagar a taxa de rede em USDC',
  'The upgrade is an EIP-7702 delegation of this FloFi Wallet address on {0} to the open-source Simple7702Account contract, so the network fee can be paid in USDC.':
    'A atualização é uma delegação EIP-7702 deste endereço da FloFi Wallet em {0} para o contrato de código aberto Simple7702Account, para que a taxa de rede possa ser paga em USDC.',
  'Your address, balances and control do not change.': 'Seu endereço, seus saldos e o seu controle não mudam.',
  'The upgrade stays until you replace it.': 'A atualização permanece até que você a substitua.',
  'Three signatures follow this first time: the upgrade, a USDC permit, then the operation.':
    'Seguem três assinaturas desta primeira vez: a atualização, uma permissão de USDC e, depois, a operação.',
  'Upgrade and continue': 'Atualizar e continuar',
  'Pay this network fee in USDC through Circle': 'Pagar esta taxa de rede em USDC pela Circle',
  'Your ETH on {0} does not cover this network fee. FloFi Wallet can pay it from your USDC through Circle instead.':
    'Seu ETH em {0} não cobre esta taxa de rede. A FloFi Wallet pode pagá-la com seu USDC pela Circle.',
  'Two signatures follow: a USDC permit, then the operation.': 'Seguem duas assinaturas: uma permissão de USDC e, depois, a operação.',
  'Pay in USDC and continue': 'Pagar em USDC e continuar',
  'Not now': 'Agora não',
  'Choosing Not now signs nothing: the step continues through its own review, which pays its network fee in ETH.':
    'Se escolher Agora não, nada é assinado: a etapa segue pela própria revisão, que paga a taxa de rede em ETH.',
  'Nothing was signed. Step {0} continues through its own review, which pays its network fee in ETH.':
    'Nada foi assinado. A etapa {0} segue pela própria revisão, que paga a taxa de rede em ETH.',
  'Three signatures: the smart-account upgrade, a USDC permit for the fee, then the operation':
    'Três assinaturas: a atualização da conta inteligente, uma permissão de USDC para a taxa e, depois, a operação',
  // The Editor's step-by-step Review with FloFi Wallet: where the USDC fee is available, and that each step run here pays ETH.
  'Paying the network fee in USDC through Circle with FloFi Wallet is available when a workflow is approved through a FloFi approval link (/approve) and authorized in groups. Here each step runs on its own and pays its network fee in ETH.':
    'Pagar a taxa de rede em USDC pela Circle com a FloFi Wallet está disponível quando um fluxo é aprovado por um link de aprovação da FloFi (/approve) e autorizado em grupos. Aqui, cada etapa roda sozinha e paga a taxa de rede em ETH.',
  'You already signed part of this request, so FloFi keeps it as it is. Nothing more was signed or sent.':
    'Você já assinou parte deste pedido, então a FloFi o mantém como está. Nada mais foi assinado nem enviado.',
  'This request has no network fee in USDC to decline. Nothing was signed or sent.':
    'Este pedido não tem taxa de rede em USDC para recusar. Nada foi assinado nem enviado.',
  'this wallet has a transaction still pending on this network': 'esta carteira tem uma transação ainda pendente nesta rede',
  'You did not agree to the smart-account upgrade, so nothing was signed or sent. Add ETH on this network to pay the network fee instead.':
    'Você não concordou com a atualização da conta inteligente, então nada foi assinado nem enviado. Adicione ETH nesta rede para pagar a taxa de rede.',
  'Agree to the smart-account upgrade first. Nothing was signed or sent.': 'Concorde primeiro com a atualização da conta inteligente. Nada foi assinado nem enviado.',
  'The smart-account upgrade signature could not be verified, so nothing was sent. Try again.':
    'Não foi possível verificar a assinatura da atualização da conta inteligente, então nada foi enviado. Tente de novo.',
  'This wallet changed since your review (another transaction or upgrade), so the upgrade was not used and nothing was sent. Load the request again.':
    'Esta carteira mudou desde a sua revisão (outra transação ou atualização), então a atualização não foi usada e nada foi enviado. Carregue o pedido de novo.',
  'This request has no smart-account upgrade to agree to. Nothing was signed or sent.': 'Este pedido não tem atualização de conta inteligente para concordar. Nada foi assinado nem enviado.',
  'FloFi Wallet signs an account upgrade only after you agree to it in FloFi. Nothing was signed.':
    'A FloFi Wallet assina uma atualização de conta apenas depois que você concorda com ela na FloFi. Nada foi assinado.',
  'FloFi Wallet signs an account upgrade only for the smart account and network you reviewed in FloFi. Nothing was signed.':
    'A FloFi Wallet assina uma atualização de conta apenas para a conta inteligente e a rede que você revisou na FloFi. Nada foi assinado.',
  // Final review (P1): FloFi Wallet asked once per signature of a prepared request; a new preparation is a new request.
  'FloFi Wallet was already asked for this signature once (if you cancelled it there, nothing was signed), so FloFi does not ask it again for this request. Nothing was sent. This request expires within a few minutes; then continue, and FloFi prepares a new one for you to sign.':
    'A FloFi Wallet já foi solicitada a fazer esta assinatura uma vez (se você a cancelou lá, nada foi assinado), então a FloFi não a solicita de novo para este pedido. Nada foi enviado. Este pedido expira em poucos minutos; depois continue, e a FloFi prepara um novo para você assinar.',
  'FloFi Wallet may have signed, but FloFi did not receive the signature, so nothing was sent. This request expires within a few minutes; then continue, and FloFi prepares a new one for you to sign.':
    'A FloFi Wallet pode ter assinado, mas a FloFi não recebeu a assinatura, então nada foi enviado. Este pedido expira em poucos minutos; depois continue, e a FloFi prepara um novo para você assinar.',
  // Final review (P3): the Editor's Authorize found another fee mechanism before anything was stored.
  'How the network fee is paid changed since your review: your ETH on this network now covers it, or no longer does. Nothing was signed or sent, and this workflow was not started. Review it again to see how the fee is paid now.':
    'A forma de pagar a taxa de rede mudou desde a sua revisão: seu ETH nesta rede agora a cobre, ou deixou de cobrir. Nada foi assinado nem enviado, e este fluxo não foi iniciado. Revise-o de novo para ver como a taxa é paga agora.',
};
