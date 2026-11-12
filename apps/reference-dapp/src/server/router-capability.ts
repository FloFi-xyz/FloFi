// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 (owner test 2026-11-12, Arbitrum USDC → Base USDC): whether the certified Cross-chain Router (BUILD-ROUTER-001 / BUILD-BASE-001) can execute
 * one of its pairs for the owner on THIS deployment. The answer is the Router flow's own `info` (`executionEnabled`: its live mode and its
 * real-funds owner-execution opt-in), exactly what the Router store shows; with no remote runtime, the same deployment gates in process.
 *
 * Read-only and informational: it decides how a Canvas estimate is labelled (quote-only or "simulate and review"), never a route, an amount or
 * any authorization. Simulate re-quotes, re-verifies (code pins, calldata decode, exact recipient and amounts) and simulates everything, and the
 * owner's wallet still signs every transaction. Cached briefly per process; a failed read is "not executable" (fail closed).
 */
import type { RouterNetwork } from './router-runtime.ts';
import { routerNetworkMode, routerNetworkRuntime } from './router-runtime.ts';
import { cloudFlow } from './flow-runtime.ts';
import type { FlowName } from '../../backend/flows.ts';

type Env = Readonly<Record<string, string | undefined>>;
const TTL_MS = 60_000;
const cache = new Map<string, { readonly at: number; readonly value: boolean }>();
/** The flow name of a Router network (`crosschain-router`, `crosschain-router-testnet`, `crosschain-router-<network>`), as `router-action.ts`. */
export const routerFlowName = (network: RouterNetwork): FlowName =>
  (network === 'mainnet' ? 'crosschain-router' : `crosschain-router-${network}`) as FlowName;

export async function certifiedRouterExecution(network: RouterNetwork, env: Env = process.env, now: () => number = Date.now): Promise<boolean> {
  const key = `${network}`, hit = cache.get(key);
  if (hit && now() - hit.at < TTL_MS) return hit.value;
  try {
    const cloud = await cloudFlow<{ readonly executionEnabled?: unknown }>(routerFlowName(network), 'info', [], { env, principal: null, timeoutMs: 5_000, maxAttempts: 1 });
    // A refused or failed read (this caller's access, an outage) is "not executable" for this answer only: never cached for other callers.
    if (cloud && !cloud.ok) return false;
    const mode = cloud ? null : routerNetworkMode(network, env);
    const value = cloud ? cloud.value?.executionEnabled === true : mode !== 'off' && routerNetworkRuntime(network, mode!, env).executionEnabled === true;
    cache.set(key, { at: now(), value });
    return value;
  } catch { return false; }
}
/** Test seam: forget cached answers. */
export function resetCertifiedRouterExecution(): void { cache.clear(); }
