// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 workflow execution: the Editor's whole-workflow Review, Authorize and progress, and the direct Canvas edits. Network, asset and protocol
 * names stay as they are; placeholders are preserved.
 */
export const portugueseWorkflowExecution: Readonly<Record<string, string>> = {
  'This workflow runs as one workflow run: follow it in Execute.': 'Este fluxo roda como uma única execução: acompanhe em Execute.',
  'All {0} steps are reviewed together and authorized at once where your wallet can batch them.':
    'As {0} etapas são revisadas juntas e autorizadas de uma vez quando sua carteira consegue agrupá-las.',
  'Open workflow progress': 'Abrir o progresso do fluxo',
  'Open the workflow review': 'Abrir a revisão do fluxo',
  'Review whole workflow': 'Revisar o fluxo inteiro',
  'Apply {0} change': 'Aplicar alteração de {0}',
  '{0} on {1}: enter the amount in {0} on the card and press Enter. A new Simulation and Review follow.':
    '{0} em {1}: informe o valor em {0} no card e pressione Enter. Uma nova Simulação e Revisão vêm em seguida.',
  'Step {0} delivers {1} on {2}: this step will no longer be funded by it. Press Enter to apply the change.':
    'A etapa {0} entrega {1} em {2}: esta etapa deixará de ser financiada por ela. Pressione Enter para aplicar a alteração.',
  'Whole workflow': 'Fluxo inteiro',
  'Workflow progress': 'Progresso do fluxo',
  'Review the whole workflow': 'Revise o fluxo inteiro',
  'FloFi checks every step together — amounts, minimums, fees and Aave risk — and asks your wallet only once where it can batch. Nothing is signed or sent by a review.':
    'A FloFi verifica todas as etapas juntas — valores, mínimos, taxas e risco no Aave — e pede à sua carteira uma única vez quando ela consegue agrupar. Uma revisão não assina nem envia nada.',
  'All {0} steps run as ONE wallet confirmation on {1}: one atomic transaction from your own wallet, which pays the network fee.':
    'As {0} etapas rodam com UMA confirmação na carteira em {1}: uma transação atômica da sua própria carteira, que paga a taxa de rede.',
  'All {0} steps run in {2} wallet confirmations, one per group; a later group is asked when it becomes due.':
    'As {0} etapas rodam com {2} confirmações na carteira, uma por grupo; um grupo posterior é pedido quando chegar a vez dele.',
  'This workflow needs a confirmation in your wallet for each step on its own.': 'Este fluxo precisa de uma confirmação na sua carteira para cada etapa separadamente.',
  'Spends (the minimum step {0} guarantees)': 'Gasta (o mínimo que a etapa {0} garante)',
  'Spends (what step {0} delivers, at most)': 'Gasta (o que a etapa {0} entregar, no máximo)',
  'Spends': 'Gasta',
  'You receive': 'Você recebe',
  'Minimum (your slippage limit)': 'Mínimo (seu limite de slippage)',
  'Quoted when this step becomes due': 'Cotado quando chegar a vez desta etapa',
  'Received (reconciled)': 'Recebido (reconciliado)',
  'Group {0} · {1}': 'Grupo {0} · {1}',
  '{0} calls in the batch ({1} token approvals)': '{0} chamadas no lote ({1} aprovações de token)',
  'about {0} in network fees, at most {1}': 'cerca de {0} em taxas de rede, no máximo {1}',
  'network fees paid: {0}': 'taxas de rede pagas: {0}',
  'Aave health factor after the batch': 'Health factor no Aave após o lote',
  '{0} (FloFi requires at least 2.00)': '{0} (a FloFi exige no mínimo 2,00)',
  'What your wallet is asked': 'O que sua carteira vai pedir',
  'at least {0} wallet confirmations': 'pelo menos {0} confirmações na carteira',
  'one wallet confirmation': 'uma confirmação na carteira',
  '{0} wallet confirmations': '{0} confirmações na carteira',
  '{0} on-chain transactions': '{0} transações on-chain',
  '{0} calls batched': '{0} chamadas agrupadas',
  '{0} signatures': '{0} assinaturas',
  '{0} network switches': '{0} trocas de rede',
  'your wallet may upgrade this account to its smart account inside the same confirmation (one time)':
    'sua carteira pode converter esta conta em smart account dentro da mesma confirmação (uma única vez)',
  'Prices': 'Preços',
  'Expired at {0}: review again to refresh them before authorizing.': 'Expiraram às {0}: revise novamente para atualizá-los antes de autorizar.',
  'Quoted at {0}, valid until {1}': 'Cotados às {0}, válidos até {1}',
  'Your wallet pays every network fee. FloFi never pays, advances or reimburses gas, and never signs or sends for you.':
    'Sua carteira paga todas as taxas de rede. A FloFi nunca paga, adianta ou reembolsa gas, e nunca assina nem envia por você.',
  'Prices moved since your review. Your wallet would be asked with these minimums:': 'Os preços mudaram desde a sua revisão. Sua carteira seria consultada com estes mínimos:',
  'Step {0}: {1} (reviewed {2})': 'Etapa {0}: {1} (revisado {2})',
  'Confirm the request in your wallet. It shows every call of the batch and the network fee.':
    'Confirme o pedido na sua carteira. Ela mostra cada chamada do lote e a taxa de rede.',
  'Sign the FloFi sign-in message in your wallet (once per session). It authorizes no transaction.':
    'Assine a mensagem de login da FloFi na sua carteira (uma vez por sessão). Ela não autoriza nenhuma transação.',
  'Reviewing the whole workflow…': 'Revisando o fluxo inteiro…',
  'Review again': 'Revisar novamente',
  'Preparing your wallet request…': 'Preparando o pedido para a sua carteira…',
  'Authorize workflow · 1 wallet confirmation': 'Autorizar fluxo · 1 confirmação na carteira',
  'Authorize workflow': 'Autorizar fluxo',
  'Confirm the updated minimums': 'Confirmar os mínimos atualizados',
  'Authorize steps {0}–{1} now': 'Autorizar as etapas {0}–{1} agora',
  'Quote expired: updating': 'Cotação expirada: atualizando',
  // Panel state and mechanism labels (looked up from closed codes).
  'Authorized in the batch': 'Autorizada no lote',
  'Confirmed in your wallet': 'Confirmado na sua carteira',
  'One wallet confirmation: one atomic transaction': 'Uma confirmação na carteira: uma transação atômica',
  'Each step confirmed in your wallet': 'Cada etapa confirmada na sua carteira',
  // Why fewer wallet interactions are not possible / why the batch is refused.
  'Your wallet does not offer atomic batching on this network, so each step is confirmed in your wallet.':
    'Sua carteira não oferece agrupamento atômico nesta rede, então cada etapa é confirmada na sua carteira.',
  'Your wallet did not report atomic batching on this network, so each step is confirmed in your wallet.':
    'Sua carteira não informou agrupamento atômico nesta rede, então cada etapa é confirmada na sua carteira.',
  'Grouped authorization is not enabled for this network on this FloFi deployment.': 'A autorização agrupada não está ativada para esta rede nesta instalação da FloFi.',
  'A step spends what an earlier step delivers on another network; it is authorized when that delivery lands.':
    'Uma etapa gasta o que uma etapa anterior entrega em outra rede; ela é autorizada quando essa entrega chegar.',
  'A step after a bridge is authorized when the bridge delivery lands (no relay is configured for signing it earlier).':
    'Uma etapa após uma ponte é autorizada quando a entrega da ponte chegar (não há relay configurado para assiná-la antes).',
  'A step after a bridge is authorized when the bridge delivery lands (your account is not a smart account).':
    'Uma etapa após uma ponte é autorizada quando a entrega da ponte chegar (sua conta não é uma smart account).',
  'Your Solana wallet confirms each transaction separately.': 'Sua carteira Solana confirma cada transação separadamente.',
  'A Solana step after a bridge is signed when the delivery lands (a recent blockhash expires within about a minute).':
    'Uma etapa Solana após uma ponte é assinada quando a entrega chegar (um blockhash recente expira em cerca de um minuto).',
  'Not available for this step ({0}).': 'Indisponível para esta etapa ({0}).',
  'This Borrow would leave your Aave health factor below 2.0 after the batch. Lower the Borrow amount or supply more collateral.':
    'Este Borrow deixaria seu health factor no Aave abaixo de 2,0 após o lote. Reduza o valor do Borrow ou forneça mais colateral.',
  'FloFi simulated the whole batch and step {0} would fail on chain now. Check its amount, balance and allowance; nothing was sent.':
    'A FloFi simulou o lote inteiro e a etapa {0} falharia on-chain agora. Verifique o valor, o saldo e o allowance; nada foi enviado.',
  'The swap in step {0} would deliver less than its signed minimum now. Review again for a fresh quote.':
    'O swap da etapa {0} entregaria menos que o mínimo assinado agora. Revise novamente para obter uma cotação nova.',
  'This network’s RPC cannot simulate the whole batch, so FloFi does not offer it in one confirmation. Each step is confirmed on its own instead.':
    'O RPC desta rede não consegue simular o lote inteiro, então a FloFi não o oferece em uma confirmação. Cada etapa é confirmada separadamente.',
  'Your wallet does not hold enough ETH on this network for the network fee of the batch.': 'Sua carteira não tem ETH suficiente nesta rede para a taxa de rede do lote.',
  'An Aave step names another account than the connected wallet. Rebuild that step with this wallet.':
    'Uma etapa do Aave indica outra conta que não a carteira conectada. Refaça essa etapa com esta carteira.',
  'A swap allows more than 3% slippage, which cannot be fixed in one batch. Lower the slippage.': 'Um swap permite mais de 3% de slippage, o que não pode ser fixado em um lote. Reduza o slippage.',
  'Sign in to FloFi to run the whole workflow with one wallet confirmation. You can still confirm each step on its own.':
    'Entre na FloFi para executar o fluxo inteiro com uma confirmação na carteira. Você ainda pode confirmar cada etapa separadamente.',
  'Connect your wallet to review the whole workflow.': 'Conecte sua carteira para revisar o fluxo inteiro.',
  'The reviewed prices expired. Review the workflow again to refresh them.': 'Os preços revisados expiraram. Revise o fluxo novamente para atualizá-los.',
  'You declined the request in your wallet. Nothing was sent. You can authorize again; the workflow can be ended once the prepared request expires.':
    'Você recusou o pedido na sua carteira. Nada foi enviado. Você pode autorizar novamente; o fluxo pode ser encerrado quando o pedido preparado expirar.',
  'Your wallet already has the batch for these steps, but FloFi has not recorded it yet. Do not send it again: FloFi reads it back from your wallet.':
    'Sua carteira já tem o lote destas etapas, mas a FloFi ainda não o registrou. Não o envie de novo: a FloFi o lê de volta na sua carteira.',
  'A prepared wallet request is still valid, so the workflow cannot be ended yet. Try again after it expires.':
    'Um pedido preparado para a carteira ainda é válido, então o fluxo ainda não pode ser encerrado. Tente de novo depois que ele expirar.',
  'FloFi could not compare the prepared minimums with your review, so your wallet was not asked. Try again.':
    'A FloFi não conseguiu comparar os mínimos preparados com a sua revisão, então nada foi pedido à sua carteira. Tente de novo.',
  'Sign in with your wallet to follow this workflow. The sign-in authorizes no transaction.':
    'Entre com a sua carteira para acompanhar este fluxo. A entrada não autoriza nenhuma transação.',
  'The workflow or its plan changed since your review. Nothing was asked from your wallet. Review the whole workflow again.':
    'O fluxo ou o plano dele mudou desde a sua revisão. Nada foi pedido à sua carteira. Revise o fluxo inteiro de novo.',
  'Too many reviews in a short time. Wait a few minutes and review again.': 'Revisões demais em pouco tempo. Aguarde alguns minutos e revise de novo.',
  'An Aave step after a bridge is authorized when the bridge delivery lands, after FloFi simulates it on that state (health factor and supply cap).':
    'Uma etapa da Aave depois de uma ponte é autorizada quando a entrega da ponte chega, depois que a FloFi a simula nesse estado (fator de saúde e limite de fornecimento).',
  'Grouping would not ask your wallet fewer times for this workflow, so each step is confirmed on its own.':
    'Agrupar não pediria menos confirmações à sua carteira neste fluxo, então cada etapa é confirmada separadamente.',
  'Group {0}': 'Grupo {0}', 'Wallet request': 'Pedido à carteira',
  'Before it, your wallet may ask to switch to {0} if it is on another network and, once per session, to sign FloFi\'s sign-in message (no transaction).':
    'Antes disso, sua carteira pode pedir para mudar para {0} se estiver em outra rede e, uma vez por sessão, para assinar a mensagem de entrada da FloFi (nenhuma transação).',
  'The wallet request itself does not expire on chain: confirm it promptly, or reject it and review again. Each swap\'s minimum is fixed when FloFi prepares the request.':
    'O pedido à carteira não expira sozinho na rede: confirme-o logo, ou recuse-o e revise de novo. O mínimo de cada swap é fixado quando a FloFi prepara o pedido.',
  'Load workflow progress': 'Carregar o andamento do fluxo',
  'The prepared wallet request is valid until {0}; the workflow can be ended after that.':
    'O pedido preparado para a carteira vale até {0}; o fluxo pode ser encerrado depois disso.',
  'Too many workflow runs are waiting for you. Finish or end one of them first.': 'Há execuções de fluxo demais aguardando você. Conclua ou encerre uma delas primeiro.',
  'Your wallet cannot batch on this network.': 'Sua carteira não consegue agrupar nesta rede.',
  'FloFi cannot prepare this workflow now ({0}). Nothing was sent.': 'A FloFi não consegue preparar este fluxo agora ({0}). Nada foi enviado.',
  'FloFi could not complete this request ({0}). Nothing was sent.': 'A FloFi não conseguiu concluir este pedido ({0}). Nada foi enviado.',
  'This workflow runs as one workflow run: open Execute and choose Review whole workflow, then Authorize workflow.':
    'Este fluxo roda como uma única execução: abra Execute e escolha Revisar o fluxo inteiro e depois Autorizar fluxo.',
};
