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
  // A confirmed approval whose allowance read-back is not in yet (owner-bound swaps).
  'The approval is confirmed. FloFi is still reading its allowance on the network before preparing the swap. Nothing new was sent; try again in a moment.':
    'A aprovação está confirmada. A FloFi ainda está lendo a permissão na rede antes de preparar o swap. Nada novo foi enviado; tente novamente em instantes.',
};
