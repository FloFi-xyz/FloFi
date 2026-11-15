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
  'Part of the fees included in the quote.': 'Parte das taxas incluídas na cotação.',
  'Paid separately, on top of the amount sent.': 'Pago à parte, além do valor enviado.',
  'Provider fees included in the quote': 'Taxas do provedor incluídas na cotação',
  'About {0} of the amount you send. Already taken out of the expected amount; never charged again.':
    'Cerca de {0} do valor que você envia. Já descontado do valor esperado; nunca cobrado de novo.',
  'Provider fees take about {0} of the amount you send. Fixed costs weigh more for small amounts. Review the amounts before you continue.':
    'As taxas do provedor levam cerca de {0} do valor que você envia. Custos fixos pesam mais em valores pequenos. Revise os valores antes de continuar.',
  'The recipient’s Solana wallet has no {0} account yet. The bridge provider creates it at delivery; its one-time cost is part of the provider’s destination fee, already included in the quote.':
    'A carteira Solana do destinatário ainda não tem uma conta de {0}. O provedor da ponte a cria na entrega; esse custo único faz parte da taxa de destino do provedor, já incluída na cotação.',
};
