// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001 (pt-BR): the Live Canvas execution states, the History wallet activity (received and sent
 * transfers, coverage) and the Automations / My Account loading states. New keys only; shared words reuse the existing catalog.
 */
export const portugueseLiveCanvasActivity: Readonly<Record<string, string>> = {
  // Live Canvas
  'Execution status: {0}': 'Estado da execução: {0}', 'Live execution': 'Execução em andamento',
  'Transactions, receipts and recorded evidence': 'Transações, comprovantes e evidências registradas', 'Your authorization': 'Sua autorização', 'Estimate from before execution': 'Estimativa anterior à execução',
  // History: wallet activity
  'History view': 'Visualização do histórico', 'Wallet activity': 'Atividade da carteira', 'Sent': 'Enviado',
  'Refresh wallet activity': 'Atualizar atividade da carteira', 'Loading wallet activity…': 'Carregando a atividade da carteira…', 'Load more activity': 'Carregar mais atividade',
  'Tokens your wallet received and sent on supported networks, including transfers made outside FloFi. A transaction FloFi matches to a workflow record above is shown with that record, not repeated here.': 'Tokens que sua carteira recebeu e enviou nas redes suportadas, incluindo transferências feitas fora da FloFi. Uma transação que a FloFi associa a um registro de fluxo acima aparece nesse registro e não é repetida aqui.',
  'Tokens your wallet received, including transfers from other wallets and outside FloFi.': 'Tokens que sua carteira recebeu, incluindo transferências de outras carteiras e de fora da FloFi.',
  'Tokens your wallet sent, including transfers made outside FloFi.': 'Tokens que sua carteira enviou, incluindo transferências feitas fora da FloFi.',
  'Contract interaction': 'Interação com contrato', 'Minted': 'Emitido', 'Burned': 'Queimado', 'FloFi workflow': 'Fluxo da FloFi', 'Finalized': 'Finalizado',
  'To {0}': 'Para {0}', 'Between your own accounts': 'Entre suas próprias contas',
  'Sender not shown by the network data': 'Remetente não informado pelos dados da rede', 'Recipient not shown by the network data': 'Destinatário não informado pelos dados da rede',
  'received': 'recebido', 'sent': 'enviado', 'moved between your accounts': 'movido entre suas contas',
  '{0}: ETH moved by contracts (internal transfers) is not listed.': '{0}: ETH movimentado por contratos (transferências internas) não é listado.',
  '{0}: only the first 6 token accounts of this wallet are read; tokens received in other token accounts are not listed.': '{0}: só as 6 primeiras contas de token desta carteira são lidas; tokens recebidos em outras contas de token não são listados.',
  '{0}: some transactions could not be read right now, so their movements are not listed.': '{0}: algumas transações não puderam ser lidas agora, então as movimentações delas não são listadas.',
  '{0}: part of the activity is not listed.': '{0}: parte da atividade não é listada.',
  'FloFi stopped reading wallet activity for this browser.': 'A FloFi parou de ler a atividade da carteira neste navegador.',
  'A wallet used in this browser is not linked to your FloFi account': 'Uma carteira usada neste navegador não está vinculada à sua conta FloFi',
  'Wallet activity could not be read on any network right now. This does not mean there is none.': 'Não foi possível ler a atividade da carteira em nenhuma rede agora. Isso não significa que não haja nenhuma.',
  'The recent movements of this wallet are your FloFi workflows above. Open Received or Sent to see each transfer.': 'As movimentações recentes desta carteira são seus fluxos da FloFi acima. Abra Recebido ou Enviado para ver cada transferência.',
  '{0}: wallet activity is not available on this network yet.': '{0}: a atividade da carteira ainda não está disponível nesta rede.',
  '{0}: activity could not be loaded right now. This does not mean there is none.': '{0}: não foi possível carregar a atividade agora. Isso não significa que não haja nenhuma.',
  'Verify this wallet above to see its activity.': 'Verifique esta carteira acima para ver a atividade dela.',
  'Wallet activity is temporarily unavailable. Your FloFi workflow history is not affected.': 'A atividade da carteira está temporariamente indisponível. Seu histórico de fluxos da FloFi não foi afetado.',
  'No received transfers found on the covered networks.': 'Nenhuma transferência recebida encontrada nas redes cobertas.',
  'No sent transfers found on the covered networks.': 'Nenhuma transferência enviada encontrada nas redes cobertas.',
  'No wallet activity found on the covered networks.': 'Nenhuma atividade da carteira encontrada nas redes cobertas.',
  'Network coverage': 'Cobertura por rede', '1 movement of an unverified token is hidden.': '1 movimentação de um token não verificado está oculta.',
  '{0} movements of unverified tokens are hidden.': '{0} movimentações de tokens não verificados estão ocultas.',
  'Wallet activity was refreshed many times in a short period. Try again in a minute.': 'A atividade da carteira foi atualizada muitas vezes em pouco tempo. Tente novamente em um minuto.',
  '1 older movement appears when more activity is loaded.': '1 movimentação mais antiga aparece ao carregar mais atividade.',
  '{0} older movements appear when more activity is loaded.': '{0} movimentações mais antigas aparecem ao carregar mais atividade.',
  // Automations loading
  'Automations are temporarily unavailable. This is not a change to your automations.': 'As automações estão temporariamente indisponíveis. Isso não altera suas automações.',
};
