// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-001: read-only previews of a flow's simulation, for callers that may not create runs (the MCP gateway).
 *
 * A preview runs the flow's UNCHANGED `simulate` (the EVM swap's `prepare`) — the same validators, provider routing, chain
 * reads, transaction simulation, artifact compilation and Manifest as the DApp — on an observe-only transport and on a run
 * log that exists only for that one call. Nothing is persisted: there is no durable run, so nothing is bound to the account
 * argument, no wallet session principal is involved, and the Review commitment it computes can never be authorized (the
 * flow's `review` needs a durable run). The owner re-simulates in the DApp under their wallet session before any Review.
 */
import { assertLogName, reentrantLeases, utf8, type ExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { ETHEREUM_ROUTER_NETWORKS } from '@defi-workflow-engine/action-registry';
import type { FlowDeps, FlowName } from './flows.ts';
import { jupiterBuildQuery, jupiterIntent, parseJupiterBuild } from '@defi-workflow-engine/reference-compiler';
import { hashArtifactBytes } from '@defi-workflow-engine/workflow-contracts';
import { createBaseSepoliaReviewContext, validateAuthoringWorkflow } from '@defi-workflow-engine/reference-linter';

export type PreviewPurpose = 'SIMULATION' | 'QUOTE';
export type JupiterQuotePreview = { readonly format: 'flofi.jupiter-quote-preview.v1'; readonly workflowHash: string; readonly nodeId: string;
  readonly chain: string; readonly input: { readonly mint: string; readonly decimals: number; readonly symbol: string };
  readonly output: { readonly mint: string; readonly decimals: number; readonly symbol: string }; readonly amount: string;
  readonly expectedOut: string; readonly minimumOut: string; readonly slippageBps: number; readonly expiresAt: string };
/** Economic quote validation only: no wallet balances, transaction simulation, run, Review or unsigned bytes. */
export async function jupiterQuotePreview(args: readonly unknown[], deps: FlowDeps, now = Date.now()): Promise<JupiterQuotePreview> {
  if (!deps.http) throw new Error('JUPITER_CONFIGURATION_INVALID');
  const workflow = validateAuthoringWorkflow(args[0], createBaseSepoliaReviewContext());
  const intent = jupiterIntent(workflow, args[1] as string);
  const { quote } = parseJupiterBuild(await deps.http(jupiterBuildQuery(intent)), intent, new Date(now).toISOString());
  return { format: 'flofi.jupiter-quote-preview.v1', workflowHash: hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow))),
    nodeId: intent.nodeId, chain: workflow.nodes.find(n => n.nodeId === intent.nodeId)!.chainId,
    input: { mint: intent.input.mint, decimals: intent.input.decimals, symbol: intent.input.symbol },
    output: { mint: intent.output.mint, decimals: intent.output.decimals, symbol: intent.output.symbol }, amount: intent.amount,
    expectedOut: quote.outAmount, minimumOut: quote.otherAmountThreshold, slippageBps: intent.slippageBps, expiresAt: new Date(now + 30_000).toISOString() };
}


/** The one preview method per flow. A flow missing here has no preview (e.g. Orca liquidity needs a browser-generated key). */
export const PREVIEW_METHODS: Readonly<Partial<Record<FlowName, 'simulate' | 'prepare'>>> = Object.freeze({
  'crosschain-router': 'simulate', 'crosschain-router-testnet': 'simulate', 'aave-supply': 'simulate', 'base-sepolia-swap': 'prepare',
  'uniswap-liquidity': 'simulate', 'jupiter-swap': 'simulate', 'solana-devnet-swap': 'simulate', 'lending-composition': 'simulate',
  // BUILD-RH-002: Robinhood Chain (real funds) previews are the same read-only simulations; nothing is authorized, signed or sent.
  'robinhood-swap': 'prepare', 'robinhood-liquidity': 'simulate', 'crosschain-router-base-to-robinhood': 'simulate', 'crosschain-router-robinhood-to-base': 'simulate',
  'crosschain-router-arbitrum-to-robinhood': 'simulate', 'crosschain-router-robinhood-to-arbitrum': 'simulate',
  // BUILD-BASE-001: Base mainnet (real funds) previews, likewise read-only.
  'arbitrum-swap': 'prepare', 'arbitrum-liquidity': 'simulate', 'base-swap': 'prepare', 'base-liquidity': 'simulate', 'base-aave': 'simulate', 'arbitrum-aave': 'simulate', 'crosschain-router-arbitrum-to-base': 'simulate',
  'ethereum-swap': 'prepare', 'ethereum-liquidity': 'simulate', 'ethereum-aave': 'simulate',
  // BUILD-SOLANA-TRANSFER-UX-001: Solana transfer previews are the same read-only simulations.
  'solana-transfer': 'simulate', 'solana-devnet-transfer': 'simulate',
  // BUILD-CROSSCHAIN-UNIVERSAL-001: the universal router's preview is its unchanged read-only simulation (nothing persisted, signed or sent).
  'crosschain-universal': 'simulate',
  ...Object.fromEntries(ETHEREUM_ROUTER_NETWORKS.map(route => [`crosschain-router-${route}`, 'simulate' as const])),
});

/**
 * A run log scoped to one preview call and discarded with it. It keeps the durable store's contract (strict extension, the
 * service's own validator, exclusive create), so the service behaves exactly as it does on PostgreSQL; it is never shared
 * between calls and holds no state anything else reads.
 */
export function previewStorage(): ExecutionStorage {
  const logs = new Map<string, Uint8Array>();
  return {
    log: {
      read: async name => logs.get(assertLogName(name)) ?? null,
      async extend(name, next, validate) {
        const prior = logs.get(assertLogName(name));
        if (prior && (next.length <= prior.length || utf8(next.subarray(0, prior.length)) !== utf8(prior))) throw new Error('JOURNAL_CORRUPT');
        validate(next);
        logs.set(name, next.slice());
      },
      async create(name, bytes) {
        if (logs.has(assertLogName(name))) return false;
        logs.set(name, bytes.slice());
        return true;
      },
      list: async (prefix, limit) => [...logs.keys()].filter(name => name.startsWith(prefix)).sort().slice(0, limit),
    },
    // One call, one store: there is no other holder to exclude.
    leases: reentrantLeases({ hold: (_key, action) => action() }),
  };
}
