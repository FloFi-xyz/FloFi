// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (execution continuity, layout, Flight and locale): Brazilian Portuguese for this hotfix's copy. Spread LAST in `pt.ts`, so these
 * entries win over older wording of the same English key.
 */
export const portugueseExecutionContinuity: Readonly<Record<string, string>> = {
  // The shared execution vocabulary (`domain/execution-phase.ts`); its other labels (Prepared, Sent to the network, Reconciled, Completed,
  // Failed) already have catalog entries.
  'Waiting for your authorization': 'Aguardando sua autorização',
  'Sent to your wallet': 'Enviado à sua carteira',
  'Confirmed on {0}': 'Confirmado na {0}',
  'Waiting for delivery on {0}': 'Aguardando a entrega na {0}',
  'Outcome unknown': 'Resultado desconhecido',
  // Locale contract: the chat's own lifecycle words as catalog keys too (a message that carries no rendering in both languages still translates).
  'Review workflow': 'Revisar fluxo',
  'Step {0} of {1}': 'Etapa {0} de {1}',

  // FloFi's own wallet copy (`wallet/wallet-errors.ts`): the sentence for an unnamed wallet, and the same sentence for a named one ({0} is the
  // wallet's own name, e.g. MetaMask), so a Portuguese screen never shows "your wallet" or an English request in a wallet notice.
  'You declined the connection in your wallet. Choose Connect Wallet to try again.': 'Você recusou a conexão na sua carteira. Escolha Conectar carteira para tentar novamente.',
  'You declined the connection in {0}. Choose Connect Wallet to try again.': 'Você recusou a conexão na {0}. Escolha Conectar carteira para tentar novamente.',
  'You declined the network switch in your wallet. Nothing changed.': 'Você recusou a troca de rede na sua carteira. Nada mudou.',
  'You declined the network switch in {0}. Nothing changed.': 'Você recusou a troca de rede na {0}. Nada mudou.',
  'Your wallet already has a request waiting. Open your wallet to approve or reject it, then try again.': 'Sua carteira já tem um pedido aguardando. Abra a carteira para aprovar ou recusar e tente novamente.',
  '{0} already has a request waiting. Open {0} to approve or reject it, then try again.': 'A {0} já tem um pedido aguardando. Abra a {0} para aprovar ou recusar e tente novamente.',
  'Your wallet has not authorized FloFi for this account. Unlock your wallet, then connect again.': 'Sua carteira não autorizou a FloFi para esta conta. Desbloqueie a carteira e conecte novamente.',
  '{0} has not authorized FloFi for this account. Unlock {0}, then connect again.': 'A {0} não autorizou a FloFi para esta conta. Desbloqueie a {0} e conecte novamente.',
  'Your wallet is not connected to the network right now. Check your wallet, then try again.': 'Sua carteira não está conectada à rede agora. Verifique a carteira e tente novamente.',
  '{0} is not connected to the network right now. Check {0}, then try again.': 'A {0} não está conectada à rede agora. Verifique a {0} e tente novamente.',
  'Your wallet stayed on another network. Choose the network in your wallet, then try again.': 'Sua carteira continuou em outra rede. Escolha a rede na carteira e tente novamente.',
  '{0} stayed on another network. Choose the network in {0}, then try again.': 'A {0} continuou em outra rede. Escolha a rede na {0} e tente novamente.',
  'Could not connect your wallet. Unlock it, make sure it is enabled for this site, and try again.': 'Não foi possível conectar a sua carteira. Desbloqueie-a, confirme que está habilitada para este site e tente novamente.',
  'Could not connect {0}. Unlock it, make sure it is enabled for this site, and try again.': 'Não foi possível conectar a {0}. Desbloqueie-a, confirme que está habilitada para este site e tente novamente.',
  'Could not switch networks in your wallet. Check your wallet and try again.': 'Não foi possível trocar de rede na sua carteira. Verifique a carteira e tente novamente.',
  'Could not switch networks in {0}. Check {0} and try again.': 'Não foi possível trocar de rede na {0}. Verifique a {0} e tente novamente.',
  'You declined the request in your Solana wallet. Choose it again when you are ready.': 'Você recusou o pedido na sua carteira Solana. Escolha-a novamente quando estiver pronto.',
  'You declined the request in {0}. Choose it again when you are ready.': 'Você recusou o pedido na {0}. Escolha-a novamente quando estiver pronto.',
  'Another wallet request is still in progress. Finish it in your wallet, then try again.': 'Outro pedido da carteira ainda está em andamento. Conclua-o na carteira e tente novamente.',
  'Two installed wallets are both named {0}. Disable one of them for this site, then try again.': 'Duas carteiras instaladas se chamam {0}. Desative uma delas para este site e tente novamente.',
  'Two installed wallets have the same name. Disable one of them for this site, then try again.': 'Duas carteiras instaladas têm o mesmo nome. Desative uma delas para este site e tente novamente.',
  'Your Solana wallet switched accounts during the request. Check the account in your Solana wallet, then try again.': 'Sua carteira Solana trocou de conta durante o pedido. Verifique a conta na carteira Solana e tente novamente.',
  '{0} switched accounts during the request. Check the account in {0}, then try again.': 'A {0} trocou de conta durante o pedido. Verifique a conta na {0} e tente novamente.',
  'Your Solana wallet needs your approval to reconnect. Choose Connect Wallet and approve it in your Solana wallet.': 'Sua carteira Solana precisa da sua aprovação para reconectar. Escolha Conectar carteira e aprove na carteira Solana.',
  '{0} needs your approval to reconnect. Choose Connect Wallet and approve it in {0}.': 'A {0} precisa da sua aprovação para reconectar. Escolha Conectar carteira e aprove na {0}.',
  'Your Solana wallet cannot connect and sign on Solana. Unlock it, or choose another Solana wallet.': 'Sua carteira Solana não consegue conectar e assinar na Solana. Desbloqueie-a ou escolha outra carteira Solana.',
  'Your Solana wallet cannot connect and sign on Solana Devnet. Unlock it, or choose another Solana wallet.': 'Sua carteira Solana não consegue conectar e assinar na Solana Devnet. Desbloqueie-a ou escolha outra carteira Solana.',
  '{0} cannot connect and sign on {1}. Unlock it, or choose another Solana wallet.': 'A {0} não consegue conectar e assinar na {1}. Desbloqueie-a ou escolha outra carteira Solana.',
  'Your Solana wallet cannot sign FloFi\'s sign-in message. Choose another Solana wallet.': 'Sua carteira Solana não consegue assinar a mensagem de login da FloFi. Escolha outra carteira Solana.',
  '{0} cannot sign FloFi\'s sign-in message. Choose another Solana wallet.': 'A {0} não consegue assinar a mensagem de login da FloFi. Escolha outra carteira Solana.',
  'Could not connect your Solana wallet. Unlock it, make sure it is enabled for this site, and try again.': 'Não foi possível conectar a sua carteira Solana. Desbloqueie-a, confirme que está habilitada para este site e tente novamente.',
};
