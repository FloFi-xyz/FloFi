// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (execution continuity, layout, Flight and locale): Brazilian Portuguese for this hotfix's copy. Spread LAST in `pt.ts`, so these
 * entries win over older wording of the same English key.
 */
export const portugueseExecutionContinuity: Readonly<Record<string, string>> = {
  // The shared execution vocabulary (`domain/execution-phase.ts`); its other labels (Prepared, Sent to the network, Reconciled, Completed,
  // Failed) already have catalog entries.
  'Waiting for your authorization': 'Aguardando sua autorização',
  'Sent to your wallet': 'Enviado à sua carteira',
  'Confirmed on {0}': 'Confirmado na {0}',
  'Waiting for delivery on {0}': 'Aguardando a entrega na {0}',
  'Outcome unknown': 'Resultado desconhecido',
  // P0 hotfix (E1): Swap → Bridge in one wallet batch, and the run waiting for the bridge delivery (editor-workflow-run.tsx, workflow-run-panel.tsx).
  'A bridge after another bridge is authorized when the first delivery lands (its price and deadline are fixed when you sign it).':
    'Uma ponte depois de outra ponte é autorizada quando a primeira entrega chega (o preço e o prazo dela são fixados quando você assina).',
  'This bridge uses a route FloFi does not batch (only a direct Across deposit is batched), so it runs through its own review and wallet confirmations.':
    'Esta ponte usa uma rota que o FloFi não agrupa (só um depósito direto na Across é agrupado), então ela passa pela própria revisão e pelas confirmações na carteira.',
  'This bridge route is not one FloFi batches, so it runs through its own review and wallet confirmations.':
    'Esta rota de ponte não é uma das que o FloFi agrupa, então ela passa pela própria revisão e pelas confirmações na carteira.',
  'This bridge moves an asset FloFi does not batch, so it runs through its own review and wallet confirmations.':
    'Esta ponte move um ativo que o FloFi não agrupa, então ela passa pela própria revisão e pelas confirmações na carteira.',
  'FloFi cannot follow deliveries on this bridge\'s destination network here, so the bridge runs through its own review and wallet confirmations.':
    'O FloFi não consegue acompanhar entregas na rede de destino desta ponte aqui, então a ponte passa pela própria revisão e pelas confirmações na carteira.',
  'This bridge pays another wallet than the connected one, so it cannot be batched. It runs through its own review and wallet confirmations.':
    'Esta ponte paga outra carteira que não a conectada, então não pode ser agrupada. Ela passa pela própria revisão e pelas confirmações na carteira.',
  'The bridge provider did not answer with a route just now, so your wallet was not asked. Nothing was sent; try again.':
    'O provedor da ponte não respondeu com uma rota agora, então sua carteira não foi consultada. Nada foi enviado; tente novamente.',
  'The bridge fee is above your slippage limit for this amount, so your wallet was not asked. Nothing was sent; raise the limit or bridge more.':
    'A taxa da ponte está acima do seu limite de variação para este valor, então sua carteira não foi consultada. Nada foi enviado; aumente o limite ou transfira mais.',
  'The bridge quote would expire before the batch could execute, so your wallet was not asked. Nothing was sent; try again.':
    'A cotação da ponte expiraria antes de o lote poder ser executado, então sua carteira não foi consultada. Nada foi enviado; tente novamente.',
  'The bridge deadline leaves too little time for the delivery, so your wallet was not asked. Nothing was sent; try again.':
    'O prazo da ponte deixa pouco tempo para a entrega, então sua carteira não foi consultada. Nada foi enviado; tente novamente.',
  'The bridge quote reserves its delivery past its own deadline, so your wallet was not asked. Nothing was sent; try again.':
    'A cotação da ponte reserva a entrega para depois do próprio prazo, então sua carteira não foi consultada. Nada foi enviado; tente novamente.',
  'FloFi simulated the batch and the bridge deposit would not be exactly the one you sign, so your wallet was not asked. Nothing was sent.':
    'O FloFi simulou o lote e o depósito da ponte não seria exatamente o que você assina, então sua carteira não foi consultada. Nada foi enviado.',
  'Bridge deposits are paused on this network right now, so your wallet was not asked. Nothing was sent.':
    'Os depósitos da ponte estão pausados nesta rede agora, então sua carteira não foi consultada. Nada foi enviado.',
  'Bridge deliveries are paused on the destination network right now, so your wallet was not asked. Nothing was sent.':
    'As entregas da ponte estão pausadas na rede de destino agora, então sua carteira não foi consultada. Nada foi enviado.',
  'A bridge contract is not the one FloFi verified, so nothing was prepared. Nothing was sent.':
    'Um contrato da ponte não é o que o FloFi verificou, então nada foi preparado. Nada foi enviado.',
  'The bridge quote did not match what FloFi asked for (amount, recipient or tokens), so your wallet was not asked. Nothing was sent.':
    'A cotação da ponte não corresponde ao que o FloFi pediu (valor, destinatário ou tokens), então sua carteira não foi consultada. Nada foi enviado.',
  'Arrives on {0}': 'Chega na {0}',
  'Delivery': 'Entrega',
  'FloFi waits for this delivery on {0} and verifies it before the workflow completes.':
    'O FloFi aguarda esta entrega na {0} e a verifica antes de concluir o fluxo.',
  'Then FloFi waits for the bridge delivery on {0} and completes the workflow once it has verified it; you can leave this page meanwhile.':
    'Depois, o FloFi aguarda a entrega da ponte na {0} e conclui o fluxo assim que a verificar; você pode sair desta página enquanto isso.',
  'The bridge then runs through its own review: its token approval and its deposit may each ask your wallet once more.':
    'A ponte então passa pela própria revisão: a aprovação do token e o depósito podem pedir, cada um, mais uma confirmação na sua carteira.',
  '{0} of {1} steps completed': '{0} de {1} etapas concluídas',
  'Bridge deposit on Across (step {0})': 'Depósito da ponte na Across (passo {0})',
  'Your batch is confirmed on {0}. FloFi is waiting for the delivery on {1} and keeps checking even if you leave this page; nothing is sent again.':
    'Seu lote está confirmado na {0}. O FloFi aguarda a entrega na {1} e continua verificando mesmo se você sair desta página; nada é enviado novamente.',
  // One progress truth for the whole workflow (`domain/workflow-progress.ts`).
  'Waiting for delivery': 'Aguardando a entrega',
  // Execute continues a step-by-step workflow in place (`components/workflow-progress-panel.tsx`, `components/execute-workspace.tsx`).
  'Step {0} of {1}': 'Etapa {0} de {1}',
  'Delivered {0}': 'Entregou {0}',
  'Receives (estimate)': 'Recebe (estimativa)',
  'Simulating…': 'Simulando…',
  'Next step of this workflow': 'Próxima etapa deste fluxo',
  'Workflow result': 'Resultado do fluxo',
  'Workflow in progress': 'Fluxo em andamento',
  'Step {0} of {1} continues here. Completed steps stay completed; nothing is sent again.':
    'A etapa {0} de {1} continua aqui. As etapas concluídas continuam concluídas; nada é reenviado.',
  'FloFi is simulating step {0} with current provider data. Nothing is signed or sent.':
    'A FloFi está simulando a etapa {0} com dados atuais dos provedores. Nada é assinado nem enviado.',
  'Step {0} is ready. Check what it spends and receives, then authorize it in your wallet. Your wallet asks you to confirm; FloFi never signs for you.':
    'A etapa {0} está pronta. Confira o que ela gasta e recebe e autorize na sua carteira. Sua carteira pede a sua confirmação; a FloFi nunca assina por você.',
  'Step {0} needs its own simulation before you authorize it. Nothing is signed or sent.':
    'A etapa {0} precisa da própria simulação antes de você autorizá-la. Nada é assinado nem enviado.',
  'Step {0} cannot continue right now. Nothing was sent.': 'A etapa {0} não pode continuar agora. Nada foi enviado.',
  'Step {0} is completed and reconciled: it delivered {1}.': 'A etapa {0} foi concluída e reconciliada: entregou {1}.',
  'Step {0} is completed and reconciled.': 'A etapa {0} foi concluída e reconciliada.',
  'Switch your wallet to {0} to continue with this step.': 'Mude sua carteira para a {0} para continuar com esta etapa.',
  'Their records stay in your history. Nothing is left to simulate, review or sign for this workflow.':
    'Os registros ficam no seu histórico. Não resta nada a simular, revisar ou assinar neste fluxo.',
  // A confirmed approval whose allowance read-back is not in yet (owner-bound swaps).
  'The approval is confirmed. FloFi is still reading its allowance on the network before preparing the swap. Nothing new was sent; try again in a moment.':
    'A aprovação está confirmada. A FloFi ainda está lendo a permissão na rede antes de preparar o swap. Nada novo foi enviado; tente novamente em instantes.',
  // Flight transition (src/components/flight/flight-transition.tsx): the product's hand-off to /board and its "could not check" state.
  'Taking you to Flight FloFi…': 'Levando você ao Flight FloFi…',
  'We could not check your access': 'Não conseguimos verificar seu acesso',
  'Your FloFi workspace opens once your Flight FloFi access is confirmed.': 'Seu espaço de trabalho FloFi abre assim que seu acesso ao Flight FloFi for confirmado.',
};
