// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-P0-MAINNET-EXECUTION-RELIABILITY: pre-send nonce classification, re-review after a refusal, bridge costs, Log out. New keys only. */
export const portugueseExecutionReliability: Readonly<Record<string, string>> = {
  'Your wallet reported an older transaction number than the network, so nothing was sent by FloFi. Wait a moment, then refresh and review this step again.':
    'Sua carteira informou um número de transação mais antigo que o da rede, então a FloFi não enviou nada. Aguarde um momento, depois atualize e revise esta etapa de novo.',
  'Your wallet shows a pending transaction that FloFi does not see on the network yet, so nothing was sent by FloFi. Check pending transactions in your wallet, then refresh and review this step again.':
    'Sua carteira mostra uma transação pendente que a FloFi ainda não vê na rede, então a FloFi não enviou nada. Confira as transações pendentes na sua carteira, depois atualize e revise esta etapa de novo.',
  'Your wallet and the network reported different transaction numbers. No transaction was sent by FloFi. Check pending wallet transactions, then refresh and review this step again.':
    'Sua carteira e a rede informaram números de transação diferentes. A FloFi não enviou nenhuma transação. Confira as transações pendentes na carteira, depois atualize e revise esta etapa de novo.',
  'This run reached its limit of wallet attempts, so nothing more was sent. Simulate again to start a fresh run of the same workflow.':
    'Esta execução atingiu o limite de tentativas na carteira, então nada mais foi enviado. Simule de novo para iniciar uma nova execução do mesmo fluxo.',
  'Refresh & review': 'Atualizar e revisar',
};
