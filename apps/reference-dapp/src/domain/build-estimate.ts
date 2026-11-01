// SPDX-License-Identifier: AGPL-3.0-only
import type { UsdEstimate } from './usd-estimate';
import type { DiscoveryResult } from '../server/universal-router/discovery';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { bridgeEstimateRequest } from './bridge-estimate';
import { parseTokenAmount } from './jupiter-authoring';
import { cryptoSelectionOf } from './crypto-action-picker';

/** Presentation data only. Deliberately excludes Review, calldata, execution IDs and financial authority. */
export type BuildEstimate = { readonly workflowHash: string; readonly nodeId: string; readonly chain: string;
  readonly provider: string; readonly expected: string; readonly minimum: string | null; readonly symbol: string;
  readonly slippageBps: number; readonly expiresAt: string;
  readonly correlationId?: string;
  readonly bridge?: { readonly discovery: DiscoveryResult; readonly selected: number; readonly execution: 'SIMULATION_AND_REVIEW_REQUIRED' | 'QUOTE_ONLY' };
  /** BUILD-FIX-UX-001: USD equivalents from the deployment's verified price source (mainnet assets only); absent when none applies. */
  readonly usd?: UsdEstimate | null };
export type BuildEstimateResult = { ok: true; estimate: BuildEstimate } | { ok: false; code: string; reason?: string; correlationId?: string; discovery?: DiscoveryResult };

/** Economic validation also runs in the browser: HTTP 200 and a matching hash alone cannot put an amount on a card. */
export function estimateMatchesNode(estimate: BuildEstimate, workflow: SemanticWorkflow, nodeId: string): boolean {
  try {
    const node = workflow.nodes.find(n => n.nodeId === nodeId), output = node?.inputs.find(i => i.name === 'asset-out');
    const slip = node?.userConstraints.find(c => c.kind === 'MAXIMUM_SLIPPAGE_BPS');
    if (!node || output?.kind !== 'ASSET' || slip?.kind !== 'MAXIMUM_SLIPPAGE_BPS' || estimate.slippageBps !== slip.maximumBps) return false;
    const expected = BigInt(parseTokenAmount(estimate.expected, output.value.decimals));
    const minimum = estimate.minimum === null ? null : BigInt(parseTokenAmount(estimate.minimum, output.value.decimals));
    if (expected <= 0n || minimum !== null && (minimum <= 0n || minimum > expected)) return false;
    if (node.actionType === 'asset.bridge') {
      const request = bridgeEstimateRequest(node), bridge = estimate.bridge, result = bridge?.discovery, selected = result?.candidates[bridge!.selected];
      return !!request && !!result && !!selected && request.providers!.includes(selected.provider) && selected.provider === estimate.provider &&
        result.sourceChain === node.chainId && result.destinationChain === output.value.chainId && result.amount === request.amount &&
        result.outputToken.decimals === output.value.decimals && result.outputToken.address === (request.outputToken.kind === 'TOKEN' ? request.outputToken.address : null) &&
        selected.expectedOutput === String(expected) && selected.minimumOutput === String(minimum) &&
        (selected.status === 'LIVE_QUOTE' && bridge!.execution === 'QUOTE_ONLY' || selected.status === 'EXECUTABLE' && bridge!.execution === 'SIMULATION_AND_REVIEW_REQUIRED');
    }
    const selection = cryptoSelectionOf(node);
    if (selection?.to && selection.to !== estimate.symbol) return false;
    return minimum === null || minimum >= expected * BigInt(10_000 - slip.maximumBps) / 10_000n;
  } catch { return false; }
}

/**
 * UX-007: live-quote feedback waits this long after the last edit before asking for an estimate. Short enough to feel immediate while
 * typing, long enough that "1", "10", "100" coalesce into one request. Estimation only: Simulate remains the authoritative quote.
 */
export const LIVE_QUOTE_DEBOUNCE_MS = 200;
/** Allows cold runtime reads plus the bounded optional USD lookup; cancellation still discards late results. */
export const BUILD_ESTIMATE_TIMEOUT_MS = 45_000;
/** One cancellable request per authoring snapshot. Late completions cannot publish after cancel/timeout. */
export function requestBuildEstimate(load: (signal: AbortSignal) => Promise<BuildEstimateResult>,
  publish: (result: BuildEstimateResult) => void, debounceMs = LIVE_QUOTE_DEBOUNCE_MS, timeoutMs = BUILD_ESTIMATE_TIMEOUT_MS): () => void {
  const controller = new AbortController();
  let active = true, timeout: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timeout = setTimeout(() => { if (!active) return; active = false; controller.abort(); publish({ ok: false, code: 'ESTIMATE_TIMEOUT' }); }, timeoutMs);
    load(controller.signal).then(result => { if (active) { active = false; clearTimeout(timeout); publish(result); } }, () => {
      if (active) { active = false; clearTimeout(timeout); publish({ ok: false, code: 'ESTIMATE_UNAVAILABLE' }); }
    });
  }, debounceMs);
  return () => { active = false; clearTimeout(timer); clearTimeout(timeout); controller.abort(); };
}

/** User-facing diagnosis. Technical codes and correlation IDs remain available separately. */
export function buildEstimateFailureMessage(code: string): string {
  if (/BELOW_MINIMUM|AMOUNT_TOO_LOW/.test(code)) return 'The amount is below the provider minimum. Choose a larger amount or another provider.';
  if (/ABOVE_MAXIMUM|AMOUNT_TOO_HIGH/.test(code)) return 'The amount is above the provider maximum. Choose a smaller amount or another provider.';
  if (/INSUFFICIENT_LIQUIDITY/.test(code)) return 'The provider has insufficient liquidity for these assets and this amount. Try another provider or try again later.';
  if (/INTERNAL_ERROR/.test(code)) return 'An internal quote error occurred. Try again or use the support reference.';
  if (/QUOTE_EXPIRED/.test(code)) return 'This quote expired. Request a fresh estimate.';
  if (/CONFIGURATION|NOT_CONFIGURED/.test(code)) return 'Quote service is not configured. Contact support.';
  if (/TIMEOUT/.test(code)) return 'The quote request timed out. Try again.';
  if (/NO_POOL|NO_ROUTE|LIQUIDITY|POOL_UNUSABLE/.test(code)) return 'No liquid pool is available for this pair and amount.';
  if (/NOT_ENABLED/.test(code)) return 'Quotes are not enabled for this network.';
  if (code !== 'ESTIMATE_UNAVAILABLE' && /UNAVAILABLE|HTTP_|RATE_LIMIT/.test(code)) return 'The quote provider or network is unavailable. Try again shortly.';
  if (/RESPONSE_|MINIMUM_INVALID|MISMATCH/.test(code)) return 'The quote did not match this swap. Try again.';
  if (/^JUPITER_.*(INVALID|UNSUPPORTED|UNEXPECTED)$/.test(code)) return 'The provider response could not be verified. Try another route or try again later.';
  // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001 (P0-07): every remaining answer says what happened; none is an unexplained "unavailable".
  if (/DEPENDENCY_UNRESOLVED/.test(code)) return 'This step uses the output of an earlier step, so its quote is calculated when you simulate the workflow.';
  if (/TEST_NETWORK_NOT_AVAILABLE/.test(code)) return 'Test networks are not available in FloFi. Choose a mainnet for this swap.';
  if (/ESTIMATE_UNSUPPORTED|ESTIMATE_INVALID/.test(code)) return 'A live estimate is not available for this action on this network. Simulate to get the provider quote.';
  if (/WRONG_PROVIDER_CHAIN|STALE_CHAIN_HEAD|RPC_RESPONSE_INVALID|QUOTE_BLOCK_REORG/.test(code)) return 'The network did not answer consistently, so no quote is shown. Try again shortly.';
  if (/INSUFFICIENT_INPUT|INSUFFICIENT_BALANCE/.test(code)) return 'The wallet balance is lower than this amount. Reduce the amount or add funds.';
  return 'Quote unavailable: the provider returned no usable quote for this swap and amount. Try again, or simulate to see the provider’s full answer.';
}
/** The technical reference shown next to a generic quote failure (support can trace it); null when the message already names the cause. */
export function buildEstimateFailureReference(code: string | undefined): string | null {
  return code && /^[A-Z][A-Z0-9_]{2,80}$/.test(code) && buildEstimateFailureMessage(code).startsWith('Quote unavailable') ? code : null;
}
