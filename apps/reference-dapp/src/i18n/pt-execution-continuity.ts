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
  // Flight transition (src/components/flight/flight-transition.tsx): the product's hand-off to /board and its "could not check" state.
  'Taking you to Flight FloFi…': 'Levando você ao Flight FloFi…',
  'We could not check your access': 'Não conseguimos verificar seu acesso',
  'Your FloFi workspace opens once your Flight FloFi access is confirmed.': 'Seu espaço de trabalho FloFi abre assim que seu acesso ao Flight FloFi for confirmado.',
};
