// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001: a bridge whose delivery is verified on the destination network while FloFi still verifies its finality
 * (EXEC-02), the Assistant's answers to "did it work?" about the current execution (CHAT-01), the Dashboard's run details while their optional
 * verification loads (PERF-01) and the Admin's account of why a recovery stopped again (ADMIN-01). Only new keys.
 */
export const portugueseExecutionUxReliability: Readonly<Record<string, string>> = {
  // EXEC-02: destination observed, definitive reconciliation pending.
  'Transfer observed on {0}': 'Transferência observada em {0}',
  'Transfer observed on destination chain': 'Transferência observada no destino',
  'The funds have been observed on the destination chain. FloFi is still verifying final settlement. No additional wallet signature is required.':
    'Os fundos foram observados na rede de destino. A FloFi continua a verificar a finalização da operação. Não precisa assinar novamente.',
  // PERF-01: the listed summary is shown while the full record loads.
  'Loading execution details…': 'Carregando os detalhes da execução…',
};
