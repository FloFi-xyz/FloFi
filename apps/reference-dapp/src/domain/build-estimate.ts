// SPDX-License-Identifier: AGPL-3.0-only
import type { UsdEstimate } from './usd-estimate';

/** Presentation data only. Deliberately excludes Review, calldata, execution IDs and financial authority. */
export type BuildEstimate = { readonly workflowHash: string; readonly nodeId: string; readonly chain: string;
  readonly provider: string; readonly expected: string; readonly minimum: string | null; readonly symbol: string;
  readonly slippageBps: number; readonly expiresAt: string;
  /** BUILD-FIX-UX-001: USD equivalents from the deployment's verified price source (mainnet assets only); absent when none applies. */
  readonly usd?: UsdEstimate | null };
export type BuildEstimateResult = { ok: true; estimate: BuildEstimate } | { ok: false; code: string; reason?: string; correlationId?: string };

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
  if (/CONFIGURATION|NOT_CONFIGURED/.test(code)) return 'Quote service is not configured. Contact support.';
  if (/TIMEOUT/.test(code)) return 'The quote request timed out. Try again.';
  if (/NO_POOL|NO_ROUTE|LIQUIDITY|POOL_UNUSABLE/.test(code)) return 'No liquid pool is available for this pair and amount.';
  if (/NOT_ENABLED/.test(code)) return 'Quotes are not enabled for this network.';
  if (code !== 'ESTIMATE_UNAVAILABLE' && /UNAVAILABLE|HTTP_|RATE_LIMIT/.test(code)) return 'The quote provider or network is unavailable. Try again shortly.';
  if (/RESPONSE_|MINIMUM_INVALID|MISMATCH/.test(code)) return 'The quote did not match this swap. Try again.';
  if (/^JUPITER_.*(INVALID|UNSUPPORTED|UNEXPECTED)$/.test(code)) return 'The provider response could not be verified. Try another route or try again later.';
  return 'Quote unavailable';
}
