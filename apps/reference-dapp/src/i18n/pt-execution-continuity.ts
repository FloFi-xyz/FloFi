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
  // One progress truth for the whole workflow (`domain/workflow-progress.ts`).
  '{0} of {1} steps completed': '{0} de {1} etapas concluídas',
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
};
