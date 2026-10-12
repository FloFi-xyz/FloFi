// SPDX-License-Identifier: AGPL-3.0-only
import type { UsdEstimate } from './usd-estimate';

/** Presentation data only. Deliberately excludes Review, calldata, execution IDs and financial authority. */
export type BuildEstimate = { readonly workflowHash: string; readonly nodeId: string; readonly chain: string;
  readonly provider: string; readonly expected: string; readonly minimum: string | null; readonly symbol: string;
  readonly slippageBps: number; readonly expiresAt: string;
  /** BUILD-FIX-UX-001: USD equivalents from the deployment's verified price source (mainnet assets only); absent when none applies. */
  readonly usd?: UsdEstimate | null };
export type BuildEstimateResult = { ok: true; estimate: BuildEstimate } | { ok: false; code: string };

/**
 * UX-007: live-quote feedback waits this long after the last edit before asking for an estimate. Short enough to feel immediate while
 * typing, long enough that "1", "10", "100" coalesce into one request. Estimation only: Simulate remains the authoritative quote.
 */
export const LIVE_QUOTE_DEBOUNCE_MS = 200;
/** One cancellable request per authoring snapshot. Late completions cannot publish after cancel/timeout. */
export function requestBuildEstimate(load: (signal: AbortSignal) => Promise<BuildEstimateResult>,
  publish: (result: BuildEstimateResult) => void, debounceMs = LIVE_QUOTE_DEBOUNCE_MS, timeoutMs = 15_000): () => void {
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
