// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: user-funded execution groups on the approval page — the owner's own wallet authorizes and pays. */
export const portugueseUserFunded: Readonly<Record<string, string>> = {
  'FloFi no longer executes steps from its own account: your own wallet pays every fee.': 'A FloFi não executa mais etapas a partir da própria conta: a sua carteira paga todas as taxas.',
  'One wallet confirmation (atomic batch)': 'Uma confirmação na carteira (lote atômico)',
  'One signature now; FloFi relays it when due': 'Uma assinatura agora; a FloFi a encaminha quando chegar a vez',
  'One wallet confirmation per step': 'Uma confirmação na carteira por etapa',
  'One Solana signing request for every transaction': 'Um pedido de assinatura Solana para todas as transações',
  'One Solana signing request now': 'Um pedido de assinatura Solana agora',
  'One Solana prompt per step': 'Um pedido Solana por etapa',
  'Planned': 'Planejado', 'Prepared': 'Preparado', 'Submitted': 'Enviado',
  'You authorize each group with your own wallet': 'Você autoriza cada grupo com a sua própria carteira',
  'Pay the fees from my own wallet, in one wallet interaction': 'Pagar as taxas com a minha própria carteira, numa única interação da carteira',
  'Pay the fees from my own wallet, in {0} wallet interactions': 'Pagar as taxas com a minha própria carteira, em {0} interações da carteira',
  'Execution groups': 'Grupos de execução',
  'Steps {0}–{1} on {2}': 'Etapas {0}–{1} em {2}',
  'signed now': 'assinado agora', 'signed when it becomes due': 'assinado quando chegar a vez',
  'waits for the delivery of step {0}': 'aguarda a entrega da etapa {0}',
  'your wallet upgrades this account inside the same confirmation (one time)': 'a sua carteira atualiza esta conta na mesma confirmação (uma única vez)',
  'Your wallet pays every network fee. FloFi never pays, advances or reimburses gas.': 'A sua carteira paga todas as taxas de rede. A FloFi nunca paga, adianta nem reembolsa gás.',
  'Fees paid by {0}': 'Taxas pagas por {0}',
  'At most {0} in network fees': 'No máximo {0} em taxas de rede',
  'Network fees paid: {0}': 'Taxas de rede pagas: {0}',
  'Authorize steps {0}–{1} now': 'Autorizar as etapas {0}–{1} agora',
  'Check my wallet for the batch': 'Verificar o lote na minha carteira',
  'Sign steps {0}–{1} now; FloFi relays them when they are due': 'Assinar as etapas {0}–{1} agora; a FloFi as encaminha quando chegar a vez',
  // Authorization plan notes (shown on the approval page and in chat).
  'Your own wallet pays every network fee; FloFi never pays, advances or reimburses gas.': 'A sua própria carteira paga todas as taxas de rede; a FloFi nunca paga, adianta nem reembolsa gás.',
  'One wallet interaction is not one transaction: a batch executes several steps in one transaction on one network; each network needs its own wallet authorization.':
    'Uma interação da carteira não é uma transação: um lote executa várias etapas numa transação em uma rede; cada rede precisa da sua própria autorização da carteira.',
  'Each group starts only after the previous one reconciled on chain.': 'Cada grupo só começa depois de o anterior ser reconciliado na rede.',
};
