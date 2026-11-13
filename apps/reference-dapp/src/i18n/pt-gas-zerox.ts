// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §5): PT-BR of the 0x Gasless swap on Robinhood Chain — the Review's fee and signature
 * lines, why paying the fee in tokens is not available, the execution refusals, the evidence labels and FloFi Wallet's typed-data refusal.
 * Wording: "taxa de rede", "paga em <token>", "incluída no swap"; never "grátis", "sem taxas" or "patrocinado" for a fee the owner pays.
 */
export const portugueseGasZeroEx: Readonly<Record<string, string>> = {
  // Review: who pays the network fee and in which token (domain/gas-payment.ts, domain/simulation-presentation.ts).
  'Network fee (included in the swap)': 'Taxa de rede (incluída no swap)',
  '0x fee (included in the swap)': 'Taxa da 0x (incluída no swap)',
  'Signatures': 'Assinaturas',
  '2 (token approval, then the trade)': '2 (aprovação do token e depois a negociação)',
  'Executed by': 'Executado por',
  'Route sources': 'Fontes da rota',
  'Trade hash': 'Hash da negociação',
  'Signed trade valid until': 'Negociação assinada válida até',
  // FloFi's own Uniswap v3 reference beside 0x's quote (review Z3, Technical details).
  '0x quote': 'Cotação da 0x',
  'FloFi reference (Uniswap v3)': 'Referência da FloFi (Uniswap v3)',
  'Lowest 0x minimum FloFi accepts': 'Menor mínimo da 0x que a FloFi aceita',
  'Expected {0}, at least {1}': 'Esperado {0}, no mínimo {1}',
  '{0} (FloFi\'s minimum less 0x\'s fees)': '{0} (o mínimo da FloFi menos as taxas da 0x)',
  'Token approval by signature': 'Aprovação do token por assinatura',
  'Permit2 {0} may spend any amount of {1}': 'O Permit2 {0} pode gastar qualquer quantia de {1}',
  'Permit2 {0} may spend at most {1}': 'O Permit2 {0} pode gastar no máximo {1}',
  'Paid from your {0}: 0x takes it out of the swap, so no ETH is needed. The amounts you receive are after this fee.':
    'Paga em {0}: a 0x desconta do próprio swap, então não é preciso ETH. Os valores que você recebe já descontam esta taxa.',
  'The provider\'s own fee, taken out of the swap.': 'A taxa do próprio provedor, descontada do swap.',
  'This approval lets Permit2 spend any amount of {0} from this wallet until you change or revoke it.':
    'Esta aprovação permite ao Permit2 gastar qualquer quantia de {0} desta carteira até você alterá-la ou revogá-la.',
  'This swap is executed by 0x\'s settlement contract along 0x\'s quoted route, not the Uniswap pool. You sign; 0x\'s relayer sends it and takes the network fee from the swap.':
    'Este swap é executado pelo contrato de liquidação da 0x, pela rota cotada pela 0x, e não pelo pool da Uniswap. Você assina; o retransmissor da 0x envia e desconta a taxa de rede do swap.',
  'Paid in ETH by your wallet, separate from the swap output.': 'Paga em ETH pela sua carteira, à parte do valor recebido no swap.',
  'This wallet does not have enough ETH for the network fee of this swap. Add ETH on this network before you authorize.':
    'Esta carteira não tem ETH suficiente para a taxa de rede deste swap. Adicione ETH nesta rede antes de autorizar.',
  '{0}, included in the swap': '{0}, incluída no swap',
  'You sign; 0x sends the swap and takes the network fee out of it. FloFi never signs or pays for you.':
    'Você assina; a 0x envia o swap e desconta dele a taxa de rede. A FloFi nunca assina nem paga por você.',
  // Why paying the network fee in tokens is not available (domain/gas-payment.ts).
  'Paying the network fee in tokens is not enabled on this FloFi server.': 'Pagar a taxa de rede em tokens não está ativado neste servidor da FloFi.',
  'Paying the network fee in tokens is not available on this network right now.': 'Pagar a taxa de rede em tokens não está disponível nesta rede agora.',
  'A swap that sells ETH cannot pay its network fee in tokens.': 'Um swap que vende ETH não pode pagar a taxa de rede em tokens.',
  'A swap into native ETH cannot pay its network fee in tokens yet. Swap into WETH instead.':
    'Um swap para ETH nativo ainda não pode pagar a taxa de rede em tokens. Faça o swap para WETH.',
  'This token cannot be approved with a signature, and approving it needs ETH.': 'Este token não pode ser aprovado por assinatura, e aprová-lo exige ETH.',
  'This wallet is a smart account, which this fee option does not support.': 'Esta carteira é uma conta inteligente, que esta forma de pagar a taxa não aceita.',
  'The provider has no liquidity for this pair and amount.': 'O provedor não tem liquidez para este par e este valor.',
  'The provider has no route for this pair and amount.': 'O provedor não tem rota para este par e este valor.',
  'The amount is below the provider minimum for this option.': 'O valor está abaixo do mínimo do provedor para esta opção.',
  'The provider does not support this token.': 'O provedor não aceita este token.',
  'The provider does not offer this token to FloFi.': 'O provedor não oferece este token à FloFi.',
  'The provider does not offer Stock Tokens to FloFi.': 'O provedor não oferece Stock Tokens à FloFi.',
  'The provider does not accept this wallet.': 'O provedor não aceita esta carteira.',
  'The wallet balance is lower than this amount.': 'O saldo da carteira é menor que este valor.',
  'The provider quote did not charge the network fee to this swap, so FloFi refused it.': 'A cotação do provedor não cobrou a taxa de rede deste swap, por isso a FloFi a recusou.',
  'The provider quote expired too quickly to review and sign.': 'A cotação do provedor expirou rápido demais para revisar e assinar.',
  'The provider quote pays less than FloFi\'s own Uniswap quote for this swap, beyond the provider\'s fees, so FloFi refused it.':
    'A cotação do provedor paga menos que a própria cotação da FloFi na Uniswap para este swap, além das taxas do provedor, por isso a FloFi a recusou.',
  'The provider did not answer. Try again shortly.': 'O provedor não respondeu. Tente novamente em instantes.',
  'FloFi could not verify the provider quote for this swap.': 'A FloFi não conseguiu verificar a cotação do provedor para este swap.',
  // Execution refusals and outcomes (domain/simulation-presentation.ts simulationError).
  'How the network fee is paid changed since your Review (your ETH balance moved), so nothing was signed or sent. Review the updated swap.':
    'A forma de pagar a taxa de rede mudou desde a sua Revisão (o seu saldo de ETH mudou), por isso nada foi assinado nem enviado. Revise o swap atualizado.',
  'The signature did not match the reviewed swap, so nothing was submitted. Authorize again with the reviewed wallet.':
    'A assinatura não corresponde ao swap revisado, por isso nada foi enviado. Autorize de novo com a carteira revisada.',
  'Paying the network fee in tokens needs a standard wallet account, and this one is a smart account. Add ETH for the network fee instead. Nothing was signed.':
    'Pagar a taxa de rede em tokens exige uma conta de carteira padrão, e esta é uma conta inteligente. Adicione ETH para a taxa de rede. Nada foi assinado.',
  'The swap through 0x did not go through, and none of your tokens moved. Simulate again for a fresh quote.':
    'O swap pela 0x não foi concluído, e nenhum dos seus tokens se moveu. Simule de novo para obter uma cotação nova.',
  'This signed swap is already handled by another FloFi execution, which keeps tracking it. Simulate again for a fresh, separate swap.':
    'Este swap assinado já é tratado por outra execução da FloFi, que continua acompanhando-o. Simule de novo para um swap novo e separado.',
  'The 0x service did not answer, so nothing was signed or submitted. Try again shortly.': 'O serviço da 0x não respondeu, por isso nada foi assinado nem enviado. Tente novamente em instantes.',
  'Your wallet did not return the signatures, so nothing was submitted. Authorize again when ready.':
    'A sua carteira não devolveu as assinaturas, por isso nada foi enviado. Autorize de novo quando quiser.',
  // User-funded batches on Robinhood Chain (components/editor-workflow-run.tsx, components/approval-handoff.tsx).
  'Your wallet does not hold enough ETH on Robinhood Chain for the network fee of this batch. Run this workflow with Confirm each step: each swap can then pay its network fee from the tokens it swaps. Nothing was sent.':
    'A sua carteira não tem ETH suficiente na Robinhood Chain para a taxa de rede deste lote. Execute este fluxo com Confirmar cada etapa: cada swap poderá então pagar a taxa de rede com os tokens que troca. Nada foi enviado.',
  // Evidence (domain/execution-evidence.ts).
  '0x trade hash': 'Hash da negociação na 0x',
  'Network fee paid from the swap': 'Taxa de rede paga com o swap',
  // FloFi Wallet (wallet/flofi-signing.ts).
  'FloFi Wallet signs typed data only for a swap you reviewed in FloFi. Nothing was signed.': 'A FloFi Wallet assina dados estruturados apenas para um swap que você revisou na FloFi. Nada foi assinado.',
};
