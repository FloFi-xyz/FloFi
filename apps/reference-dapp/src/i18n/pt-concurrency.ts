// SPDX-License-Identifier: AGPL-3.0-only
/**
 * HOTFIX-PHANTOM-LIGHTHOUSE-001 / HOTFIX-WORKFLOW-CONCURRENCY-001: verified wallet protections, independent executions of one wallet and
 * the transaction-identity refusals that replace the former one-pending-transaction-per-wallet messages.
 */
export const portugueseConcurrency: Readonly<Record<string, string>> = {
  'Your wallet added {0} protection check(s) (Lighthouse) before signing. FloFi verified that they only check the result and change nothing you reviewed: if the result is worse than your wallet expects, the whole transaction fails and only the network fee is spent.':
    'A sua carteira acrescentou {0} verificação(ões) de proteção (Lighthouse) antes de assinar. O FloFi verificou que elas só conferem o resultado e não alteram nada do que reviu: se o resultado for pior do que a sua carteira espera, a transação inteira falha e só a taxa de rede é gasta.',
  'This transaction is still being confirmed, and FloFi keeps tracking it. You can simulate another, separate transaction meanwhile: it needs its own Review and wallet signature. Every execution stays listed in Dashboard.':
    'Esta transação ainda está a ser confirmada, e o FloFi continua a acompanhá-la. Entretanto pode simular outra transação, separada: ela precisa da sua própria Revisão e da assinatura da carteira. Todas as execuções continuam listadas no Painel.',
  'Your wallet added {0} instruction(s) from {1} that FloFi could not verify as read-only protection checks of the transaction you reviewed, so it did not send it and nothing reached Solana. Simulate again for a fresh Review.':
    'A sua carteira acrescentou {0} instrução(ões) de {1} que o FloFi não conseguiu verificar como verificações de proteção só de leitura da transação que reviu, por isso não a enviou e nada chegou à Solana. Simule novamente para obter uma nova Revisão.',
  'This signed transaction already belongs to another FloFi execution, so FloFi did not send it again and nothing new reached Solana. Simulate again for a fresh, separate transaction.':
    'Esta transação assinada já pertence a outra execução do FloFi, por isso o FloFi não a enviou outra vez e nada de novo chegou à Solana. Simule novamente para obter uma transação nova e separada.',
  'This exact transaction is already handled by another FloFi execution, which keeps tracking it. Simulate again for a fresh, separate transaction.':
    'Esta transação exata já é tratada por outra execução do FloFi, que continua a acompanhá-la. Simule novamente para obter uma transação nova e separada.',
  'This execution already has a transaction, and FloFi keeps tracking it; it is never sent twice. Simulate again to start a separate execution.':
    'Esta execução já tem uma transação, e o FloFi continua a acompanhá-la; ela nunca é enviada duas vezes. Simule novamente para iniciar uma execução separada.',
};
