// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 catalog reliability: every message the Canvas shows when an amount or action edit is refused (`canvasAmountMessage`). The support reference
 * is a `{0}` template, so the code stays visible in every language. Network, asset and protocol names stay as they are.
 */
export const portugueseCatalogReliability: Readonly<Record<string, string>> = {
  'Enter a valid amount greater than 0.': 'Informe um valor válido maior que 0.',
  'This step cannot change to another kind of action. Remove it and add the new action instead.':
    'Esta etapa não pode virar outro tipo de ação. Remova-a e adicione a nova ação.',
  'This amount is protected.': 'Este valor está protegido.',
  'The workflow changed. Review this amount again.': 'O fluxo mudou. Revise este valor novamente.',
  'This action cannot be combined with the current workflow. Check its settings or use a separate workflow.':
    'Esta ação não pode ser combinada com o fluxo atual. Verifique as configurações dela ou use um fluxo separado.',
  'This workflow already has the maximum number of steps.': 'Este fluxo já tem o número máximo de etapas.',
  'This amount cannot be applied without changing other settings of the action. Your workflow was not changed. Press Cancel to keep the current amount, or open the action’s Settings.':
    'Este valor não pode ser aplicado sem alterar outras configurações da ação. Seu fluxo não foi alterado. Pressione Cancelar para manter o valor atual ou abra as Configurações da ação.',
  'The swap and its linked step are on different networks. Choose the same network for both.':
    'O swap e a etapa vinculada estão em redes diferentes. Escolha a mesma rede para os dois.',
  'Choose matching bridge networks.': 'Escolha redes compatíveis para a ponte.',
  'This asset is not available for this action on this network. Choose another asset.': 'Este ativo não está disponível para esta ação nesta rede. Escolha outro ativo.',
  'This action is not available on this network. Choose another network.': 'Esta ação não está disponível nesta rede. Escolha outra rede.',
  'This swap does not support the native asset on this network. Choose the wrapped asset.': 'Este swap não aceita o ativo nativo nesta rede. Escolha o ativo encapsulado.',
  'Enter a valid slippage percentage.': 'Informe um percentual de slippage válido.',
  'Enter a valid price range: the lower bound must be below the upper bound.': 'Informe uma faixa de preço válida: o limite inferior deve ficar abaixo do superior.',
  'Choose two different assets.': 'Escolha dois ativos diferentes.',
  'Robinhood Stock Tokens are unavailable right now. Try again in a moment.': 'Os Stock Tokens da Robinhood estão indisponíveis no momento. Tente novamente em instantes.',
  'This change could not be applied (reference {0}). Your workflow was not changed. Press Cancel to keep the current amount, or open the action’s Settings.':
    'Esta alteração não pôde ser aplicada (referência {0}). Seu fluxo não foi alterado. Pressione Cancelar para manter o valor atual ou abra as Configurações da ação.',
  'This change could not be applied. Your workflow was not changed. Press Cancel to keep the current amount, or open the action’s Settings.':
    'Esta alteração não pôde ser aplicada. Seu fluxo não foi alterado. Pressione Cancelar para manter o valor atual ou abra as Configurações da ação.',
};
