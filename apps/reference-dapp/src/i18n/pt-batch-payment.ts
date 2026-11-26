// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02): the Batch Payment card ("Pagamento em lote"), pt-BR. New keys only. */
export const portugueseBatchPayment: Readonly<Record<string, string>> = {
  'Batch Payment': 'Pagamento em lote',
  'Add batch payment': 'Adicionar pagamento em lote',
  'Batch Payment recipients': 'Destinatários do pagamento em lote',
  'Recipient {0} address': 'Endereço do destinatário {0}',
  'Recipient {0} amount ({1})': 'Valor do destinatário {0} ({1})',
  'Remove recipient {0}': 'Remover destinatário {0}',
  'Same amount for all': 'Mesmo valor para todos',
  '{0} recipients': '{0} destinatários',
  'Total: enter every amount': 'Total: informe todos os valores',
  'Total: {0} {1}': 'Total: {0} {1}',
  'All payments run together in one wallet approval, or none of them run.': 'Todos os pagamentos são executados juntos em uma única aprovação na carteira, ou nenhum é executado.',
  'Apply batch payment': 'Aplicar pagamento em lote',
  'Apply changes': 'Aplicar alterações',
  'Wallet batch': 'Lote na carteira',
  'Add at least 2 recipients.': 'Adicione pelo menos 2 destinatários.',
  'A Batch Payment pays at most 8 recipients.': 'Um pagamento em lote paga no máximo 8 destinatários.',
  'Enter a valid 0x address for every recipient (a mixed-case address must match its checksum).':
    'Informe um endereço 0x válido para cada destinatário (um endereço com maiúsculas e minúsculas precisa corresponder ao seu checksum).',
  'An address appears more than once. Remove the repeated recipient: payments are never merged.':
    'Um endereço aparece mais de uma vez. Remova o destinatário repetido: os pagamentos nunca são somados.',
  'Enter a positive amount for every recipient.': 'Informe um valor positivo para cada destinatário.',
  'Batch Payment is available on Base, Arbitrum One, Ethereum and Robinhood Chain.': 'O pagamento em lote está disponível na Base, Arbitrum One, Ethereum e Robinhood Chain.',
  'Choose an asset available for Batch Payment on this network.': 'Escolha um ativo disponível para pagamento em lote nesta rede.',
  'Check the recipients and amounts.': 'Confira os destinatários e os valores.',
  'An ETH amount is above the per-payment maximum FloFi sends on this network. Lower it or split the payment.':
    'Um valor em ETH está acima do máximo por pagamento que a FloFi envia nesta rede. Diminua o valor ou divida o pagamento.',
  'An amount has more decimal places than this asset allows.': 'Um valor tem mais casas decimais do que este ativo permite.',
  'ETH is paid only to plain wallet addresses (not contracts or smart accounts).': 'ETH é pago apenas para endereços de carteira comuns (não contratos nem contas inteligentes).',
};
