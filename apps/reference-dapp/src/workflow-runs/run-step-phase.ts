// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (E1): where a run's step stands in the shared execution vocabulary (`domain/execution-phase.ts`), derived from the durable run view
 * alone — for the facts a batched bridge adds: its source batch confirmed while its delivery on the destination network is awaited
 * (AWAITING_DESTINATION), or not observed past its fill deadline (OUTCOME_UNKNOWN), and a reconciled step (RECONCILED). Any other state keeps its
 * surface's own words (null). "X of N steps completed" counts reconciled steps only (`workflowProgress`).
 *
 * Presentation only, client-safe (no server import): a phase is never authority, and nothing here signs, submits or retries.
 */
import { workflowProgress, type ExecutionPhase } from '../domain/execution-phase';

/** The network a delivery lands on, by CAIP-2 chain (FloFi's EVM mainnets; anything else is shown as its chain id). */
const NETWORK_LABEL: Readonly<Record<string, string>> = Object.freeze({ 'eip155:1': 'Ethereum', 'eip155:8453': 'Base', 'eip155:42161': 'Arbitrum One',
  'eip155:4663': 'Robinhood Chain' });
export const networkLabel = (chain: string) => NETWORK_LABEL[chain] ?? chain;
type DeliveryLike = { readonly step: number; readonly chain: string; readonly state: string } | null | undefined;
type RunLike = { readonly mode: string | null; readonly steps: readonly { readonly index: number; readonly state: string }[];
  readonly groups: readonly { readonly steps: readonly [number, number]; readonly chain: string; readonly state: string; readonly delivery?: DeliveryLike }[] };

/** The phase of one step, with the network its label names (`{0}`), or null when the step's own state words apply. */
export function runStepPhase(run: RunLike, step: { readonly index: number; readonly state: string }): { readonly phase: ExecutionPhase; readonly network: string | null } | null {
  if (step.state === 'RECONCILED') return { phase: 'RECONCILED', network: null };
  if (run.mode !== 'USER_FUNDED') return null;
  const group = run.groups.find(g => g.steps[0] <= step.index && step.index <= g.steps[1]);
  const delivery = group?.delivery;
  if (!group || !delivery || delivery.step !== step.index) return null;
  if (delivery.state === 'AWAITING_DESTINATION' && (step.state === 'DELEGATED' || step.state === 'UNCERTAIN')) return { phase: 'AWAITING_DESTINATION', network: networkLabel(delivery.chain) };
  if (delivery.state === 'NOT_OBSERVED' && step.state === 'UNCERTAIN') return { phase: 'OUTCOME_UNKNOWN', network: null };
  return null;
}
/** The group whose source batch is confirmed while its bridge's delivery is awaited: the source and destination networks, else null. */
export function awaitedDelivery(run: RunLike): { readonly source: string; readonly destination: string; readonly step: number } | null {
  const g = run.groups.find(x => x.delivery?.state === 'AWAITING_DESTINATION' && (x.state === 'SUBMITTED' || x.state === 'UNCERTAIN'));
  return g?.delivery ? { source: networkLabel(g.chain), destination: networkLabel(g.delivery.chain), step: g.delivery.step } : null;
}
/** "X of N steps completed": reconciled steps only (never a group, a transaction or a submitted step). */
export function runProgress(run: RunLike): { readonly completed: number; readonly total: number } {
  return workflowProgress(run.steps.map(s => s.state === 'RECONCILED' ? 'RECONCILED' as const : 'PREPARED' as const));
}
