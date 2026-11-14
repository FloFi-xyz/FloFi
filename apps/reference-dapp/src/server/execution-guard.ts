// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Operator emergency pause for NEW on-chain submissions. Read on every call, including from cached services and workers.
 * Unset / `false`: the existing execution controls decide. `true`: paused. Any other configured value fails closed.
 * This switch adds no wallet authority and no amount limit. Receipt reads, wallet reports and reconciliation never call the guard.
 */
type Env = Readonly<Record<string, string | undefined>>;
export type ExecutionRefusal = 'EXECUTION_PAUSED' | 'EXECUTION_PAUSE_CONFIGURATION_INVALID';

export function executionRefusal(env: Env = process.env): ExecutionRefusal | null {
  const value = env.FLOFI_EXECUTION_PAUSED;
  return value === undefined || value === 'false' ? null : value === 'true' ? 'EXECUTION_PAUSED' : 'EXECUTION_PAUSE_CONFIGURATION_INVALID';
}
export function assertExecutionEnabled(env: Env = process.env): void {
  const code = executionRefusal(env);
  if (code) throw new Error(code);
}

/** Existing flow methods that release a new wallet request or submit signed bytes; reports/observations deliberately stay readable. */
const NEW_EXECUTION_METHODS: ReadonlySet<string> = new Set([
  'begin', 'beginSwap', 'beginLiquidity', 'handoff', 'submit', 'submitSwap', 'submitLiquidity', 'broadcast',
  // BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003: 0x Gasless — the typed-data request to the owner's wallet, and the one relay of its signatures.
  'beginGasless', 'submitGasless',
]);
export const isNewExecutionMethod = (method: string): boolean => NEW_EXECUTION_METHODS.has(method);
export function guardFlowExecution(method: string, env: Env = process.env): void {
  if (isNewExecutionMethod(method)) assertExecutionEnabled(env);
}
