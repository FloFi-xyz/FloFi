// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 workflow execution: the Editor's whole-workflow Review, Authorize and progress, and the direct Canvas edits. Network, asset and protocol
 * names stay as they are; placeholders are preserved.
 */
export const portugueseWorkflowExecution: Readonly<Record<string, string>> = {
  'This workflow runs as one workflow run: follow it in Execute.': 'Este fluxo roda como uma única execução: acompanhe em Executar.',
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
  'This Borrow would leave your Aave health factor below 2.0 after the batch, so nothing was sent. Supply more collateral or repay part of your debt from your wallet, then try again, or end the workflow.':
    'Este Borrow deixaria seu fator de saúde na Aave abaixo de 2,0 depois do lote, então nada foi enviado. Forneça mais garantia ou pague parte da dívida pela sua carteira e tente de novo, ou encerre o fluxo.',
  'This Withdraw would leave your Aave health factor below 2.0 after the batch, so nothing was sent. Repay part of your debt or supply more collateral from your wallet, then try again, or end the workflow.':
    'Este Withdraw deixaria seu fator de saúde na Aave abaixo de 2,0 depois do lote, então nada foi enviado. Pague parte da dívida ou forneça mais garantia pela sua carteira e tente de novo, ou encerre o fluxo.',
  'This Repay is no longer smaller than your current Aave debt, so it cannot be batched and nothing was sent. Once the workflow shows it stopped, Try this step again runs the Repay through its own flow (it reads your debt again), or end the workflow.':
    'Este Repay não é mais menor que a sua dívida atual na Aave, então não pode entrar no lote e nada foi enviado. Quando o fluxo aparecer como interrompido, Tentar esta etapa de novo executa o Repay pelo próprio fluxo (que lê a dívida de novo), ou encerre o fluxo.',
  'This network’s RPC cannot simulate the whole batch, so it is not offered in one confirmation and nothing was sent. Once the workflow shows it stopped, Try this step again confirms each step through its own flow, or end the workflow.':
    'O RPC desta rede não consegue simular o lote inteiro, então ele não é oferecido em uma única confirmação e nada foi enviado. Quando o fluxo aparecer como interrompido, Tentar esta etapa de novo confirma cada etapa pelo próprio fluxo, ou encerre o fluxo.',
  'A step after a bridge is authorized when the bridge delivery lands (your wallet cannot sign it in advance).':
    'Uma etapa depois de uma ponte é autorizada quando a entrega da ponte chega (sua carteira não consegue assiná-la antecipadamente).',
  'You declined the request in your wallet. Nothing was sent. FloFi does not prepare another request for this workflow; you can end it.':
    'Você recusou o pedido na sua carteira. Nada foi enviado. A FloFi não prepara outro pedido para este fluxo; você pode encerrá-lo.',
  'A swap after a bridge whose output a later step spends is authorized when the bridge delivery lands, after FloFi simulates the whole batch and proves you receive that output.':
    'Um swap depois de uma ponte, cuja saída uma etapa seguinte gasta, é autorizado quando a entrega da ponte chega, depois que a FloFi simula o lote inteiro e comprova que você recebe essa saída.',
  'Grouping would not ask your wallet fewer times for this workflow, so each step is confirmed on its own.':
    'Agrupar não pediria menos confirmações à sua carteira neste fluxo, então cada etapa é confirmada separadamente.',
  'Group {0}': 'Grupo {0}', 'Wallet request': 'Pedido à carteira',
  'Before it, your wallet may ask to switch to {0} if it is on another network and, once per session, to sign FloFi\'s sign-in message (no transaction).':
    'Antes disso, sua carteira pode pedir para mudar para {0} se estiver em outra rede e, uma vez por sessão, para assinar a mensagem de entrada da FloFi (nenhuma transação).',
  'The wallet request itself does not expire on chain: confirm it promptly, or reject it and review again. Each swap\'s minimum is fixed when FloFi prepares the request.':
    'O pedido à carteira não expira sozinho na rede: confirme-o logo, ou recuse-o e revise de novo. O mínimo de cada swap é fixado quando a FloFi prepara o pedido.',
  'A workflow you authorized earlier in this browser has not been closed. Its progress, and any batch your wallet already has, are read from FloFi and your wallet.':
    'Um fluxo que você autorizou antes neste navegador não foi fechado. O andamento dele, e qualquer lote que sua carteira já tenha, são lidos da FloFi e da sua carteira.',
  'A workflow you authorized earlier in this browser has not been closed.': 'Um fluxo que você autorizou antes neste navegador não foi fechado.',
  'Show its progress': 'Mostrar o andamento',
  'FloFi could not complete this request ({0}). What your wallet already has stands: FloFi keeps following it and never sends it again.':
    'A FloFi não conseguiu concluir este pedido ({0}). O que sua carteira já tem continua valendo: a FloFi continua acompanhando e nunca o envia de novo.',
  '1 on-chain transaction': '1 transação on-chain', '1 signature': '1 assinatura',
  'Sign in with the wallet that started this workflow to follow it (the sign-in authorizes no transaction).':
    'Entre com a carteira que iniciou este fluxo para acompanhá-lo (a entrada não autoriza nenhuma transação).',
  'This workflow was started by another wallet. Connect that wallet to follow it.': 'Este fluxo foi iniciado por outra carteira. Conecte essa carteira para acompanhá-lo.',
  'Confirm what your wallet will be asked:': 'Confirme o que será pedido à sua carteira:',
  'Step {0} pays': 'A etapa {0} paga', 'Step {0}: minimum {1}': 'Etapa {0}: mínimo {1}',
  'Confirm and continue in my wallet': 'Confirmar e continuar na minha carteira',
  'Your wallet may already have sent this batch. Check your wallet\'s activity before ending the workflow: ending it does not stop a batch already on chain.':
    'Sua carteira pode já ter enviado este lote. Verifique a atividade da sua carteira antes de encerrar o fluxo: encerrá-lo não interrompe um lote que já está na rede.',
  'Forgetting removes this workflow only from this browser: the run, and anything your wallet already sent, stay. Check your wallet\'s activity first.':
    'Esquecer remove este fluxo apenas deste navegador: a execução, e o que sua carteira já enviou, continuam. Verifique antes a atividade da sua carteira.',
  'Forget this workflow in this browser': 'Esquecer este fluxo neste navegador',
  'Hide this workflow': 'Ocultar este fluxo',
  'This is a workflow you authorized earlier, not the one on the Canvas.': 'Este é um fluxo que você autorizou antes, não o que está no Canvas.',
  'Your wallet was asked to send this batch, but its answer never arrived, so FloFi cannot tell whether it was sent. Check your wallet\'s activity. FloFi will not ask your wallet for it again; the workflow can be ended once the prepared request expires.':
    'Sua carteira foi solicitada a enviar este lote, mas a resposta nunca chegou, então a FloFi não consegue saber se ele foi enviado. Verifique a atividade da sua carteira. A FloFi não vai pedir esse lote de novo à sua carteira; o fluxo pode ser encerrado quando o pedido preparado expirar.',
  'Load workflow progress': 'Carregar o andamento do fluxo',
  'The prepared wallet request is valid until {0}; the workflow can be ended after that.':
    'O pedido preparado para a carteira vale até {0}; o fluxo pode ser encerrado depois disso.',
  'Too many workflow runs are waiting for you. Finish or end one of them first.': 'Há execuções de fluxo demais aguardando você. Conclua ou encerre uma delas primeiro.',
  'Your wallet cannot batch on this network.': 'Sua carteira não consegue agrupar nesta rede.',
  'FloFi cannot prepare this workflow now ({0}). Nothing was sent.': 'A FloFi não consegue preparar este fluxo agora ({0}). Nada foi enviado.',
  'FloFi could not complete this request ({0}). Nothing was sent.': 'A FloFi não conseguiu concluir este pedido ({0}). Nada foi enviado.',
  'This workflow runs as one workflow run: open Execute and choose Review whole workflow, then Authorize workflow.':
    'Este fluxo roda como uma única execução: abra Executar e escolha Revisar o fluxo inteiro e depois Autorizar fluxo.',
  'about {0} in network fees (up to {1} at today\'s prices; your wallet sets the final fee)': 'cerca de {0} em taxas de rede (até {1} nos preços de agora; sua carteira define a taxa final)',
  'up to {0} in network fees at today\'s prices; your wallet sets the final fee': 'até {0} em taxas de rede nos preços de agora; sua carteira define a taxa final',
  'its quote expired at {0}: reject the request in your wallet; FloFi prepares a fresh one': 'a cotação expirou às {0}: recuse a solicitação na sua carteira; a FloFi prepara uma nova',
  'Aave health factor after group {0}': 'Fator de saúde da Aave após o grupo {0}',
  'Confirm the wallet request promptly: about 10 minutes after FloFi prepares it, an on-chain deadline refuses the whole batch (your wallet would still pay the network fee). Each swap\'s minimum is fixed when FloFi prepares the request.': 'Confirme a solicitação na carteira logo: cerca de 10 minutos depois de a FloFi prepará-la, um prazo on-chain recusa o lote inteiro (sua carteira ainda pagaria a taxa de rede). O mínimo de cada swap é fixado quando a FloFi prepara a solicitação.',
  'The wallet request itself does not expire on chain: confirm it promptly, or reject it and review again.': 'A solicitação na carteira não expira on-chain: confirme logo ou recuse e revise de novo.',
  'Resume the workflow': 'Retomar o fluxo',
  'Continue step {0} on the signing page': 'Continuar a etapa {0} na página de assinatura',
  'A swap of native ETH runs through its own review and wallet confirmation.': 'Um swap de ETH nativo passa pela própria revisão e confirmação na carteira.',
  'A swap of this asset (for example a Stock Token) runs through its own review, which checks it, and its own wallet confirmation.': 'Um swap deste ativo (por exemplo, um Stock Token) passa pela própria revisão, que o verifica, e pela própria confirmação na carteira.',
  'This step (for example wrapping or unwrapping ETH) runs through its own review and wallet confirmation.': 'Esta etapa (por exemplo, converter ETH em WETH ou o contrário) passa pela própria revisão e confirmação na carteira.',
  'This Withdraw would leave your Aave health factor below 2.0 after the batch. Withdraw less or repay part of the debt first.': 'Este Withdraw deixaria seu fator de saúde da Aave abaixo de 2,0 após o lote. Retire menos ou pague parte da dívida antes.',
  'A Repay must be smaller than your current debt (a full repayment is not offered here). Lower the Repay amount.': 'Um Repay precisa ser menor que sua dívida atual (o pagamento total não é oferecido aqui). Reduza o valor do Repay.',
  'Your wallet refused this batch before sending anything (it may not support it on this network). Nothing was sent; you can try again.': 'Sua carteira recusou este lote antes de enviar qualquer coisa (talvez não o suporte nesta rede). Nada foi enviado; você pode tentar de novo.',
  'Your wallet is locked or another account is selected. Unlock your wallet, select the account this run belongs to, and try again; nothing was sent.':
    'Sua carteira está bloqueada ou outra conta está selecionada. Desbloqueie a carteira, selecione a conta a que esta execução pertence e tente de novo; nada foi enviado.',
  'A token in this batch does not deliver the full amount the swap sends (it charges a fee on transfer or changes balances), so it cannot be batched. Nothing was sent.':
    'Um token deste lote não entrega o valor total que o swap envia (cobra uma taxa na transferência ou altera saldos), então ele não pode ser agrupado. Nada foi enviado.',
  'A token\'s contract does not match FloFi\'s catalog (its decimals differ on chain), so nothing was prepared.':
    'O contrato de um token não corresponde ao catálogo da FloFi (os decimais dele diferem on-chain), então nada foi preparado.',
  'A token in this workflow has no contract on this network, so nothing was prepared.': 'Um token deste fluxo não tem contrato nesta rede, então nada foi preparado.',
  'This network has no registered router to give the batch an on-chain expiry, so it is not offered as a batch. Nothing was sent.':
    'Esta rede não tem um roteador registrado para dar ao lote um prazo on-chain, então ele não é oferecido como lote. Nada foi enviado.',
  'FloFi could not read this network\'s data fee, so the batch was not offered. Nothing was sent; try again.': 'A FloFi não conseguiu ler a taxa de dados desta rede, então o lote não foi oferecido. Nada foi enviado; tente de novo.',
  'This step (for example a bridge or a liquidity position) runs through its own review and wallet confirmation.': 'Esta etapa (por exemplo, uma bridge ou uma posição de liquidez) passa pela própria revisão e confirmação na carteira.',
  'A swap allows more than 3% slippage, which cannot be fixed in one batch, so it is confirmed on its own. Lower the slippage to batch it.': 'Um swap permite mais de 3% de slippage, o que não pode ser fixado em um lote, então é confirmado sozinho. Reduza o slippage para agrupá-lo.',
  'An Aave step names another account than the connected wallet, so it cannot be batched. Rebuild that step with this wallet.': 'Uma etapa da Aave indica outra conta que não a carteira conectada, então não pode ser agrupada. Recrie essa etapa com esta carteira.',
  // A run halted before anything was sent (its first group refused for good when due), and refusals that name no step (Editor and /approve).
  'Stopped: nothing sent': 'Parado: nada enviado', 'Stopped': 'Parado',
  'Stopped before any step completed. FloFi submits nothing more of this workflow; you decide what happens next.':
    'Parado antes de qualquer etapa ser concluída. A FloFi não envia mais nada deste fluxo; você decide o que acontece a seguir.',
  'Stopped before anything was sent: your funds stay in your wallet.': 'Parado antes de qualquer envio: seus fundos continuam na sua carteira.',
  'You can run each step through its own flow from here, or end the workflow.': 'Daqui, você pode executar cada etapa pelo próprio fluxo dela ou encerrar o fluxo.',
  'FloFi simulated the whole batch and one of its calls would fail on chain now, so your wallet was not asked. Check the amounts, balances and allowances, then try again.':
    'A FloFi simulou o lote inteiro e uma das chamadas dele falharia on-chain agora, então nada foi pedido à sua carteira. Verifique os valores, os saldos e os allowances e tente de novo.',
  'A swap in this batch would deliver less than its signed minimum now, so your wallet was not asked. Try again for a fresh quote.':
    'Um swap deste lote entregaria menos que o mínimo assinado agora, então nada foi pedido à sua carteira. Tente de novo para obter uma cotação nova.',
  'its quote expired at {0}: FloFi does not ask your wallet for it again; check your wallet\'s activity, then you can end the workflow':
    'a cotação expirou às {0}: a FloFi não pede esse lote de novo à sua carteira; verifique a atividade da sua carteira e depois você pode encerrar o fluxo',
  // Review fixes (Editor and /approve): every wallet batch expires on chain (a transfer-only batch too); a batch already handed out is never prepared
  // a second time while it can still execute; a second, different answer for one group; a browser that cannot keep its "handed to the wallet"
  // record; a run ended while a batch it handed out was never answered; a transfer of a token a batch cannot carry.
  'Confirm the wallet request promptly: about 10 minutes after FloFi prepares it, an on-chain deadline refuses the whole batch (your wallet would still pay the network fee).':
    'Confirme a solicitação na carteira logo: cerca de 10 minutos depois de a FloFi prepará-la, um prazo on-chain recusa o lote inteiro (sua carteira ainda pagaria a taxa de rede).',
  // Round 5: the undated words stay true once the request has expired (a banner stays on screen); an expired request this page would not ask again
  // for points to the wallet's activity; a wallet answer for a group FloFi had already stopped; a Solana step spending an output of its own group.
  'FloFi already prepared a request for this step that may still be open in your wallet. Confirm it only within 10 minutes of when it was prepared (after that its on-chain deadline refuses it and your wallet would still pay the fee: reject it), or try again once it has expired; FloFi never prepares a second one that could run alongside it.':
    'A FloFi já preparou um pedido para esta etapa que ainda pode estar aberto na sua carteira. Confirme-o somente dentro de 10 minutos depois de ter sido preparado (depois disso, o prazo on-chain dele o recusa e sua carteira ainda pagaria a taxa: recuse-o), ou tente de novo depois que ele expirar; a FloFi nunca prepara um segundo pedido que possa ser executado junto com ele.',
  'FloFi did not ask your wallet this time: the request it already prepared stays valid on chain until {0}, and your wallet may hold it. If your wallet shows it, confirm it there; otherwise wait until {0}, then try again. FloFi never prepares a second request that could run alongside it.':
    'A FloFi não pediu nada à sua carteira desta vez: o pedido que ela já preparou continua válido on-chain até {0}, e sua carteira pode tê-lo. Se sua carteira mostrar o pedido, confirme-o lá; caso contrário, aguarde até {0} e tente de novo. A FloFi nunca prepara um segundo pedido que possa ser executado junto com ele.',
  'Your wallet reported a different batch for this step than the one FloFi recorded: it may have run twice. Check your wallet\'s activity; FloFi recorded only the first.':
    'Sua carteira informou um lote diferente para esta etapa do que o que a FloFi registrou: ele pode ter sido executado duas vezes. Verifique a atividade da sua carteira; a FloFi registrou apenas o primeiro.',
  'This browser could not keep a record of the request, so FloFi did not ask your wallet (that record is what stops a request from ever being sent twice). Allow site storage or use another browser, then try again.':
    'Este navegador não conseguiu guardar um registro do pedido, então a FloFi não pediu nada à sua carteira (é esse registro que impede que um pedido seja enviado duas vezes). Permita o armazenamento do site ou use outro navegador e tente de novo.',
  'A batch was handed to your wallet and FloFi never recorded an answer for it: it may have executed before it expired. Check your wallet\'s activity.':
    'Um lote foi entregue à sua carteira e a FloFi nunca registrou uma resposta para ele: ele pode ter sido executado antes de expirar. Verifique a atividade da sua carteira.',
  // Round 4: a step or group whose batch was handed out and never answered (the run stopped at its expiry, or was ended) is never "not run" or
  // "stopped before submission"; a halted run with such a batch claims neither that nothing was sent nor that the reconciled funds rest in the
  // wallet; a USER_FUNDED_PREPARED_STILL_VALID refusal still on screen once the prepared request's validity has passed says so.
  'Its batch may have executed before it expired; check your wallet\'s activity': 'O lote pode ter sido executado antes de expirar; verifique a atividade da sua carteira',
  'Stopped. FloFi submits nothing more of this workflow; you decide what happens next.': 'Parado. A FloFi não envia mais nada deste fluxo; você decide o que acontece a seguir.',
  'Partially completed: the reconciled steps stay done. FloFi submits nothing more of this workflow; you decide what happens next.':
    'Parcialmente concluído: as etapas reconciliadas ficam feitas. A FloFi não envia mais nada deste fluxo; você decide o que acontece a seguir.',
  'The request FloFi prepared expired at {0}; you can ask for a fresh one now.': 'O pedido que a FloFi preparou expirou às {0}; agora você pode pedir um novo.',
  'A transfer of this token (for example a Stock Token, or a token outside FloFi\'s catalog) runs through its own review and wallet confirmation.':
    'Uma transferência deste token (por exemplo, um Stock Token ou um token fora do catálogo da FloFi) passa pela própria revisão e confirmação na carteira.',
  'The request FloFi prepared expired at {0}. FloFi will not ask your wallet for a fresh one: check your wallet\'s activity (it may have executed before it expired), then end the workflow.':
    'O pedido que a FloFi preparou expirou às {0}. A FloFi não vai pedir um novo à sua carteira: verifique a atividade da sua carteira (ele pode ter sido executado antes de expirar) e depois encerre o fluxo.',
  'Your wallet reported a batch for a step FloFi had already stopped: it may have executed. Check your wallet\'s activity; FloFi could not record it.':
    'Sua carteira informou um lote para uma etapa que a FloFi já tinha parado: ele pode ter sido executado. Verifique a atividade da sua carteira; a FloFi não conseguiu registrá-lo.',
  'A Solana step that spends what an earlier step of the same batch delivers is signed once that output has landed (one more wallet prompt).':
    'Uma etapa na Solana que gasta o que uma etapa anterior do mesmo lote entrega é assinada depois que essa saída chega (um pedido a mais na carteira).',
  // Round 6: a still-valid request is the last one when the run's window would not allow a fresh one at its expiry; the run's window refusing a new
  // preparation (WORKFLOW_RUN_EXPIRED); an expired request while the wallet prompt is open is rejected there even when no fresh one follows.
  'FloFi did not ask your wallet this time: the request it already prepared stays valid on chain until {0}, and your wallet may hold it. If your wallet shows it, confirm it there before then. FloFi will not prepare another request for this step.':
    'A FloFi não pediu nada à sua carteira desta vez: o pedido que ela já preparou continua válido on-chain até {0}, e sua carteira pode tê-lo. Se sua carteira mostrar o pedido, confirme-o lá antes disso. A FloFi não vai preparar outro pedido para esta etapa.',
  'This workflow\'s time window has ended, or ends too soon for a new wallet request, so FloFi does not prepare another one for it. If a request is still open in your wallet, check your wallet\'s activity; you can end the workflow once no request of it can still execute.':
    'A janela de tempo deste fluxo terminou, ou termina cedo demais para um novo pedido à carteira, então a FloFi não prepara outro pedido para ele. Se um pedido ainda estiver aberto na sua carteira, verifique a atividade da sua carteira; você pode encerrar o fluxo quando nenhum pedido dele puder mais ser executado.',
  'its quote expired at {0}: reject the request in your wallet; FloFi does not prepare another one for this workflow':
    'a cotação expirou às {0}: recuse a solicitação na sua carteira; a FloFi não prepara outra para este fluxo',
};
