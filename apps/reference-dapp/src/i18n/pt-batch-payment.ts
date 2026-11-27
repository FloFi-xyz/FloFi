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
  'Choose an asset available for Batch Payment on this network.': 'Escolha um ativo disponível para pagamento em lote nesta rede.',
  'Check the recipients and amounts.': 'Confira os destinatários e os valores.',
  // Shown when another card is still being configured (existing Canvas feedback, now also on the Batch Payment path); it had no PT entry.
  'Configure this action before adding another.': 'Configure esta ação antes de adicionar outra.',
  'An ETH amount is above the per-payment maximum FloFi sends on this network. Lower it or split the payment.':
    'Um valor em ETH está acima do máximo por pagamento que a FloFi envia nesta rede. Diminua o valor ou divida o pagamento.',
  'An amount has more decimal places than this asset allows.': 'Um valor tem mais casas decimais do que este ativo permite.',
  'ETH is paid only to plain wallet addresses (not contracts or smart accounts).': 'ETH é pago apenas para endereços de carteira comuns (não contratos nem contas inteligentes).',
  // Review fixes (FE-BATCH-04/07/10/11): the asset a network change cleared, the total without an asset, and why the card's run action is closed.
  'Choose an asset': 'Escolha um ativo',
  'Recipient {0} amount': 'Valor do destinatário {0}',
  'Total: choose an asset': 'Total: escolha um ativo',
  'Checking whether this Batch Payment can run here…': 'Verificando se este pagamento em lote pode ser executado aqui…',
  'Sign in to your FloFi account to simulate and run this Batch Payment.': 'Entre na sua conta FloFi para simular e executar este pagamento em lote.',
  'Batch Payment cannot run on this FloFi deployment yet. Nothing was signed or sent.': 'O pagamento em lote ainda não pode ser executado nesta implantação da FloFi. Nada foi assinado nem enviado.',
  'This Batch Payment cannot be simulated right now. Nothing was signed or sent.': 'Este pagamento em lote não pode ser simulado agora. Nada foi assinado nem enviado.',
  'This Batch Payment runs only as one atomic approval in your wallet (every payment, or none), and that is not available here. Nothing was signed or sent.':
    'Este pagamento em lote só é executado como uma única aprovação atômica na sua carteira (todos os pagamentos, ou nenhum), e isso não está disponível aqui. Nada foi assinado nem enviado.',
  // BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 (KAN-20): Solana in the same card (its availability sentence replaces the EVM-only one).
  'Enter a valid Solana wallet address for every recipient (base58, exactly as written: letter case matters).':
    'Informe um endereço de carteira Solana válido para cada destinatário (base58, exatamente como foi escrito: maiúsculas e minúsculas fazem diferença).',
  'A recipient is a Solana program, system account or token mint, which cannot receive a payment. Use the recipient\'s wallet address.':
    'Um destinatário é um programa, uma conta de sistema ou um mint de token da Solana, que não pode receber pagamento. Use o endereço da carteira do destinatário.',
  'A recipient is the Solana wallet you are paying from. Remove it: a Batch Payment never pays your own wallet.':
    'Um destinatário é a carteira Solana da qual você está pagando. Remova-o: um pagamento em lote nunca paga a sua própria carteira.',
  'The amounts of this Batch Payment are larger than Solana can carry.': 'Os valores deste pagamento em lote são maiores do que a Solana comporta.',
  'Batch Payment is available on Base, Arbitrum One, Ethereum, Robinhood Chain and Solana.': 'O pagamento em lote está disponível na Base, Arbitrum One, Ethereum, Robinhood Chain e Solana.',
};
