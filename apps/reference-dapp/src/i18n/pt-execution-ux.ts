// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-SOLANA-TRANSFER-UX-001: the shared chat-to-wallet execution experience, its readable errors and Solana transfers. */
export const portugueseExecutionUx: Readonly<Record<string, string>> = {
  'Could not switch your wallet to the workflow network. Check your wallet and try again.': 'Não foi possível mudar a carteira para a rede do fluxo. Verifique a carteira e tente novamente.',
  'Maximum token account deposit': 'Depósito máximo da conta de token',
  'Only paid if the recipient token account must be recreated before this transfer lands.': 'Só é pago se for necessário recriar a conta de token do destinatário antes da confirmação da transferência.',
  'Reviewed sender': 'Remetente revisto', 'Mainnet · Real funds': 'Mainnet · Fundos reais', 'Public testnet · Test funds': 'Testnet pública · Fundos de teste',
  'Token mint': 'Mint do token', 'Token contract': 'Contrato do token', 'Token decimals': 'Casas decimais do token', 'Token program': 'Programa do token',
  'Other SPL token': 'Outro token SPL',
  'FloFi verifies the mint, decimals, token program and supported extensions on chain before signing.': 'A FloFi verifica o mint, as casas decimais, o programa e as extensões suportadas na blockchain antes da assinatura.',
  'Transaction and reconciliation evidence': 'Evidências da transação e da reconciliação', 'View receipt and evidence': 'Ver recibo e evidências',
  'Send {0} to {1} on {2}.': 'Enviar {0} para {1} na {2}.', 'Solana transfer': 'Transferência Solana', 'Solana Devnet transfer': 'Transferência Solana Devnet',
  'Token approvals': 'Autorizações de tokens', 'Recipient token account deposit': 'Depósito da conta de token do destinatário',
  'Opens the recipient\'s token account; paid once, separate from the network fee.': 'Abre a conta de token do destinatário; pago uma vez, separado da taxa de rede.',
  'This token is not on FloFi\'s verified list. Its mint, decimals and token program were checked on chain; confirm it is the token you intend to send.':
    'Este token não está na lista verificada da FloFi. O mint, as casas decimais e o programa foram verificados na blockchain; confirme que é o token que pretende enviar.',
  'Token-2022 token: only extensions FloFi can verify were found, and the recipient receives exactly the amount sent.':
    'Token Token-2022: só foram encontradas extensões que a FloFi consegue verificar e o destinatário recebe exatamente o montante enviado.',
  'Preparing authorization…': 'A preparar a autorização…',
  'Solana address': 'Endereço Solana', 'Transfer details': 'Detalhes da transferência', 'From': 'De', 'Transfer result': 'Resultado da transferência',
  'Transfer independently reconciled. Sent {0}; the recipient received {1}; fee {2}.':
    'Transferência reconciliada de forma independente. Enviado {0}; o destinatário recebeu {1}; taxa {2}.',
  // Readable simulation errors.
  'Connect the wallet that will sign this workflow, then simulate again.': 'Ligue a carteira que vai assinar este fluxo e simule novamente.',
  'Check the destination address. It must be a valid wallet address on this network, not a token or program account.':
    'Verifique o endereço de destino. Tem de ser um endereço de carteira válido nesta rede, não uma conta de token nem de programa.',
  'This token uses a token feature FloFi cannot verify safely. Nothing was simulated or sent.':
    'Este token usa uma funcionalidade que a FloFi não consegue verificar com segurança. Nada foi simulado nem enviado.',
  'The token details do not match what is on the network. Check the token in Build and simulate again.':
    'Os dados do token não correspondem aos da rede. Verifique o token em Construir e simule novamente.',
  'Check the amount. It is outside what this network or token accepts.': 'Verifique o montante. Está fora do que esta rede ou este token aceita.',
  'Your current debt is lower than this repayment. Reduce the amount and simulate again.': 'A sua dívida atual é inferior a este reembolso. Reduza o montante e simule novamente.',
  'A previous transaction from this wallet is still being confirmed. Wait for it to finish, then simulate again.':
    'Uma transação anterior desta carteira ainda está a ser confirmada. Aguarde que termine e simule novamente.',
  'This wallet is a smart contract account. Use a standard wallet account to sign this workflow.':
    'Esta carteira é uma conta de contrato inteligente. Use uma conta de carteira normal para assinar este fluxo.',
  'This action is not available on this FloFi server right now. Nothing was simulated or sent.':
    'Esta ação não está disponível neste servidor FloFi neste momento. Nada foi simulado nem enviado.',
  'The network rejected this transaction in simulation, so nothing was sent. Check the amounts and your balances, then simulate again.':
    'A rede rejeitou esta transação na simulação, por isso nada foi enviado. Verifique os montantes e os seus saldos e simule novamente.',
  'FloFi could not complete this simulation, and nothing was sent. Check the workflow in Build, then simulate again.':
    'A FloFi não conseguiu concluir esta simulação e nada foi enviado. Verifique o fluxo em Construir e simule novamente.',
  'Check the workflow': 'Verifique o fluxo',
  // The one owner action after a simulation.
  'Authorize in wallet': 'Autorizar na carteira',
  // The /approve signing surface and its compact proposal notice.
  'This proposal was loaded for {0}. Switch your wallet to that account to authorize it.': 'Esta proposta foi carregada para {0}. Mude a carteira para essa conta para a autorizar.',
  'FloFi prepares a fresh simulation for this wallet. Check it, then authorize in your wallet.': 'A FloFi prepara uma simulação nova para esta carteira. Verifique-a e autorize na sua carteira.',
  'This proposal is already in a FloFi workflow for your wallet. Restore it to continue. An interrupted run stays in Your runs: reconcile it before starting again.':
    'Esta proposta já está num fluxo FloFi da sua carteira. Restaure-a para continuar. Uma execução interrompida fica em As suas execuções: reconcilie-a antes de recomeçar.',
  'Connect your wallet to load this proposal for a fresh simulation and your signature.': 'Ligue a carteira para carregar esta proposta para uma simulação nova e a sua assinatura.',
  'Authorize with your wallet': 'Autorizar com a sua carteira', 'Transaction to authorize': 'Transação a autorizar', '{0} actions': '{0} ações',
  'Requested actions': 'Ações pedidas', 'Valid for': 'Válido durante', '{0}s': '{0} s', 'Transactions': 'Transações',
  'You can return to your conversation. Its status follows this result when status sharing is on.':
    'Pode voltar à sua conversa. O estado segue este resultado quando a partilha de estado está ativa.',
  'View in FloFi': 'Ver na FloFi', 'Ready to authorize': 'Pronto para autorizar',
  'Check the details, then authorize. Your wallet shows the exact transaction for your confirmation.': 'Verifique os detalhes e autorize. A sua carteira mostra a transação exata para confirmar.',
  'Connect the wallet that will sign. Nothing is authorized until you confirm in your wallet.': 'Ligue a carteira que vai assinar. Nada é autorizado até confirmar na sua carteira.',
};
