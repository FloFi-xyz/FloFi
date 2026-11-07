// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: user-funded execution groups on the approval page — the owner's own wallet authorizes and pays. */
export const portugueseUserFunded: Readonly<Record<string, string>> = {
  'FloFi no longer executes steps from its own account: your own wallet pays every fee.': 'A FloFi não executa mais etapas a partir da própria conta: a sua carteira paga todas as taxas.',
  'Ask every time runs one-step workflows. This workflow has {0} steps: run it from the Canvas, where your own wallet confirms and pays for each step.':
    'Perguntar sempre executa fluxos de uma etapa. Este fluxo tem {0} etapas: execute-o a partir do Canvas, onde a sua própria carteira confirma e paga cada etapa.',
  'A dependent step spends what an earlier step actually delivered (after reconciliation), capped by its own amount.':
    'Uma etapa dependente gasta o que uma etapa anterior realmente entregou (após a reconciliação), limitado ao seu próprio valor.',
  'Automatic execution is retired: finish any remaining step from your own wallet; FloFi will not continue this execution.':
    'A execução automática foi desativada: conclua as etapas restantes com a sua própria carteira; a FloFi não continuará esta execução.',
  'Automatic execution is retired: it ran from FloFi\'s account, and FloFi never pays your network fees. Choose "Ask every time": your own wallet confirms and pays.':
    'A execução automática foi desativada: ela rodava a partir da conta da FloFi, e a FloFi nunca paga as suas taxas de rede. Escolha "Perguntar sempre": a sua própria carteira confirma e paga.',
  'One wallet confirmation (atomic batch)': 'Uma confirmação na carteira (lote atômico)',
  'One signature now; FloFi relays it when due': 'Uma assinatura agora; a FloFi a encaminha quando chegar a vez',
  'One wallet confirmation per step': 'Uma confirmação na carteira por etapa',
  'One Solana signing request for every transaction': 'Um pedido de assinatura Solana para todas as transações',
  'One Solana signing request now': 'Um pedido de assinatura Solana agora',
  'One Solana prompt per step': 'Um pedido Solana por etapa',
  // Group states: specific wording (the generic 'Planned' / 'Prepared' / 'Submitted' keys belong to other surfaces' translations).
  'Your wallet does not hold enough of this network\'s native token to pay the fees of this group. Add funds to your own wallet, then try again.':
    'A sua carteira não tem o token nativo desta rede em quantidade suficiente para pagar as taxas deste grupo. Adicione fundos à sua própria carteira e tente novamente.',
  'A group of this workflow may still be executing from your wallet. Wait until it is reconciled, then try again.':
    'Um grupo deste fluxo ainda pode estar em execução a partir da sua carteira. Aguarde a reconciliação e tente novamente.',
  'This group can be authorized only when it becomes due, after the previous group reconciled.': 'Este grupo só pode ser autorizado quando chegar a vez dele, depois que o grupo anterior for reconciliado.',
  'This preparation expired. Authorize again to get fresh quotes.': 'Esta preparação expirou. Autorize novamente para obter cotações novas.',
  'This group needs your wallet to already be a MetaMask smart account on this network.': 'Este grupo exige que a sua carteira já seja uma conta inteligente MetaMask nesta rede.',
  'Switch your wallet to the network of this group, then try again.': 'Troque a sua carteira para a rede deste grupo e tente novamente.',
  'The request was rejected in your wallet. Nothing was signed.': 'O pedido foi recusado na sua carteira. Nada foi assinado.',
  'Connect the Solana wallet of this workflow (the one you proved), then try again.': 'Conecte a carteira Solana deste fluxo (a que você comprovou) e tente novamente.',
  'Not signed yet': 'Ainda não assinado', 'Sent to the network': 'Enviado à rede',
  'Steps {0}–{1}': 'Etapas {0}–{1}', '{0} on {1}': '{0} em {1}', 'Authorize {0} now': 'Autorizar {0} agora',
  'Sign {0} now; FloFi relays it when it is due': 'Assinar {0} agora; a FloFi encaminha quando chegar a vez',
  'Authorize in groups with my own wallet (one wallet interaction)': 'Autorizar em grupos com a minha própria carteira (uma interação da carteira)',
  'Authorize in groups with my own wallet ({0} wallet interactions)': 'Autorizar em grupos com a minha própria carteira ({0} interações da carteira)',
  'Authorize in groups with my own wallet (at least {0} wallet interactions)': 'Autorizar em grupos com a minha própria carteira (pelo menos {0} interações da carteira)',
  'The grouping depends on what your wallet supports: FloFi asks your wallet before anything is signed, and a wallet that cannot batch confirms each step.':
    'O agrupamento depende do que a sua carteira suporta: a FloFi consulta a sua carteira antes de qualquer assinatura, e uma carteira que não agrupa confirma cada etapa.',
  'About {0} in network fees (an estimate; your wallet shows the final fee)': 'Cerca de {0} em taxas de rede (uma estimativa; a sua carteira mostra a taxa final)',
  'Waiting for your wallet to report the batch…': 'Aguardando a sua carteira informar o lote…',
  'You signed {0} as an operation FloFi did not relay. It stays valid until you cancel it with one transaction from your own wallet.':
    'Você assinou {0} como uma operação que a FloFi não encaminhou. Ela continua válida até você cancelá-la com uma transação da sua própria carteira.',
  'Cancel the signed operation for {0} in my wallet': 'Cancelar na minha carteira a operação assinada de {0}',
  'Cancellation sent from your wallet ({0}). Once it is confirmed, the signed operation can never execute.':
    'Cancelamento enviado pela sua carteira ({0}). Depois de confirmado, a operação assinada nunca poderá ser executada.',
  'Something you already signed for this step is never replaced: end this workflow and start a new one.':
    'Algo que você já assinou para esta etapa nunca é substituído: encerre este fluxo e comece um novo.',
  'Enrollment is retired: FloFi no longer executes from its own account and never pays your network fees. Existing Credentials can still be revoked.':
    'A inscrição foi desativada: a FloFi não executa mais a partir da própria conta e nunca paga as suas taxas de rede. Credenciais existentes ainda podem ser revogadas.',
  'You authorize each group with your own wallet': 'Você autoriza cada grupo com a sua própria carteira',
  'Execution groups': 'Grupos de execução',
  'signed now': 'assinado agora', 'signed when it becomes due': 'assinado quando chegar a vez',
  'waits for the delivery of step {0}': 'aguarda a entrega da etapa {0}',
  'your wallet upgrades this account inside the same confirmation (one time)': 'a sua carteira atualiza esta conta na mesma confirmação (uma única vez)',
  'Your wallet pays every network fee. FloFi never pays, advances or reimburses gas.': 'A sua carteira paga todas as taxas de rede. A FloFi nunca paga, adianta nem reembolsa gás.',
  'Fees paid by {0}': 'Taxas pagas por {0}',
  'At most {0} in network fees': 'No máximo {0} em taxas de rede',
  'Network fees paid: {0}': 'Taxas de rede pagas: {0}',
  'Check my wallet for the batch': 'Verificar o lote na minha carteira',
  // Authorization plan notes (shown on the approval page and in chat).
  'Your own wallet pays every network fee; FloFi never pays, advances or reimburses gas.': 'A sua própria carteira paga todas as taxas de rede; a FloFi nunca paga, adianta nem reembolsa gás.',
  'One wallet interaction is not one transaction: a batch executes several steps in one transaction on one network; each network needs its own wallet authorization.':
    'Uma interação da carteira não é uma transação: um lote executa várias etapas numa transação em uma rede; cada rede precisa da sua própria autorização da carteira.',
  'Each group starts only after the previous one reconciled on chain.': 'Cada grupo só começa depois de o anterior ser reconciliado na rede.',
};
