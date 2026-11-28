// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001: how a dependent step consumes an earlier step's output (all of it, a share, a fixed amount), a stale
 * dependent amount on the Canvas, and the bridge-fee refusal worded as the minimum the owner accepted.
 */
export const portugueseDependencyModes: Readonly<Record<string, string>> = {
  'A dependent step set to a share spends that share of what the earlier step delivered; one set to a fixed amount spends exactly that amount and stops before anything is signed when the earlier step delivered less.':
    'Uma etapa dependente definida como uma parte gasta essa parte do que a etapa anterior entregou; uma definida com valor fixo gasta exatamente esse valor e para antes de qualquer assinatura quando a etapa anterior entregou menos.',
  'The earlier step does not deliver the fixed amount the next step spends, so your wallet was not asked. Nothing was sent; lower the fixed amount or review the workflow again.':
    'A etapa anterior não entrega o valor fixo que a próxima etapa gasta, então sua carteira não foi consultada. Nada foi enviado; diminua o valor fixo ou revise o fluxo de novo.',
};
