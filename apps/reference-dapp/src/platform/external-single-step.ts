// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001 (WS03): single-card one-confirmation parity for conversational channels.
 *
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 ran ONE eligible EVM card as a workflow run of that step (one EIP-5792 wallet batch with any exact
 * approval folded in, automatic reconciliation) only for the Editor's own requester. A one-step proposal from ChatGPT, Claude or Telegram kept
 * its SINGLE_FLOW contract, so the owner's wallet received the token approval and the swap as two separate requests, with a second Review on
 * Arbitrum One and Ethereum (owner incident of 24-11-2026).
 *
 * This module is the one rule that decides when such a proposal is handed off as a run of its one step instead. Fail closed, every condition
 * required, decided by the server at request time and checked again at the claim (never by the model, the host or the client):
 *  - the requester is an MCP account or a channel conversation (automations keep SINGLE_FLOW; the Editor and the live Developer API keep their
 *    own existing opt-ins);
 *  - exactly one step, on an EVM chain, whose flow the user-funded execution groups build (the same set as the Editor's `SINGLE_CARD_RUNTIMES`:
 *    a catalog swap, a certified Router bridge, a transfer, an Aave supply / borrow / repay / withdraw);
 *  - this deployment runs workflow runs and offers user-funded groups on that chain (a bridge also needs a certified batch route from it);
 *  - the database accepts a run of one step (migrations 0032 and 0033 with their exact certified identities, `singleStepRunsSupported`);
 *  - the step passes every run gate.
 * Anything else keeps the SINGLE_FLOW plan exactly as before. A run never promises one confirmation by itself: its whole-workflow Review plans
 * the groups for the owner's own wallet and says STEP_BY_STEP (the card's own flow) where the wallet cannot batch.
 */
import type { ApprovalRequesterKind } from './handoff-store.ts';

export const ONE_STEP_RUN_REQUESTERS: readonly ApprovalRequesterKind[] = Object.freeze(['MCP_ACCOUNT', 'CHANNEL_CONVERSATION'] as ApprovalRequesterKind[]);
const EVM = '(?:base|arbitrum|ethereum|robinhood)';
/** The flows the user-funded EVM groups build for one card (mainnet flows and their engineering test-network counterparts). */
const GROUPED_FLOW = new RegExp(`^(?:${EVM}-swap|base-sepolia-swap|crosschain-router-testnet|crosschain-router-${EVM}-to-${EVM}|${EVM}-mainnet-transfer|robinhood-transfer|(?:base|arbitrum|ethereum)-aave|aave-supply)$`);
const BRIDGE_FLOW = /^crosschain-router-/;

export const groupedSingleStepFlow = (flow: unknown): flow is string => typeof flow === 'string' && GROUPED_FLOW.test(flow);

/** The stored plan shape this rule reads (a handoff's plan, or `workflowPlan(…, { run: true })`). */
export type OneStepPlan = { readonly kind: string; readonly steps: readonly { readonly flow?: string | null }[] };
/** Whether a requester's stored plan is an external run of one grouped step (the claim's own re-check; pure). */
export function externalOneStepPlan(kind: string, plan: OneStepPlan): boolean {
  return (ONE_STEP_RUN_REQUESTERS as readonly string[]).includes(kind) && plan.kind === 'SEQUENTIAL' && plan.steps.length === 1 && groupedSingleStepFlow(plan.steps[0]!.flow);
}

/** What the deployment says about user-funded groups (`SequenceFacts.userFunded`), as far as this rule reads it. */
export type OneStepFacts = { readonly enabled: boolean; readonly userFunded?: { readonly enabled: boolean; readonly chains: readonly string[];
  readonly bridgeRoutes?: readonly string[] } | null } | null;
/** Whether the deployment can batch this one step on its chain (pure). `chain` is the step's CAIP-2 chain id. */
export function oneStepFactsAllow(facts: OneStepFacts, flow: string, chain: string | null): boolean {
  if (!facts?.enabled || !facts.userFunded?.enabled || !chain || !chain.startsWith('eip155:') || !facts.userFunded.chains.includes(chain)) return false;
  return !BRIDGE_FLOW.test(flow) || (facts.userFunded.bridgeRoutes ?? []).some(route => route.startsWith(`${chain}>`));
}

/** The CAIP-2 chain of a one-step composition's financial node (null when it has none or several). */
export function compositionChain(workflow: { readonly nodes?: unknown }): string | null {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes.filter(node => node && typeof node === 'object' && typeof (node as { actionType?: unknown }).actionType === 'string'
    && !(node as { actionType: string }).actionType.startsWith('mock-')) as { readonly chainId?: unknown }[] : [];
  return nodes.length === 1 && typeof nodes[0]!.chainId === 'string' ? nodes[0]!.chainId : null;
}
