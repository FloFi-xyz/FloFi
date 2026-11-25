// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The flow runtime as FloFi's /app server actions use it. BUILD-FLOFI-FLIGHT-001: loading this module registers the Flight FloFi
 * simulation record as the flow runtime's simulation observer (`server/simulation-observer.ts`), in the very function that runs the
 * action, so a successful /app simulation can earn a boarding pass. The flow runtime never imports the campaign, its accounts or its
 * requests; MCP, channels and the Developer API call the runtime directly and record nothing.
 */
import { observeSimulations } from '../server/simulation-observer';
import { cloudFlow as runtimeFlow, flowRuntimeKind } from '../server/flow-runtime';
import { isFlightRecoveryMethod, requireFlightMethodAccess, requireFlightProductAccess, walletPrincipalOf, withFlightAccess, withFlightProductAccess } from '../server/flight-access';
import { guardFlowExecution } from '../server/execution-guard';
import { readDeveloperConfig } from '../developer/config';
import { issuesWalletRequest } from '../workflow-runs/external-step';

const REGISTERED = Symbol.for('flofi.flight.observer.registered');
// The record (with the account and request code it needs) loads on the first successful hosted simulation, never when an action module
// is merely imported (tests and tools import these modules outside a Next.js request).
observeSimulations(async (call, env) => (await import('../flight/simulation-evidence')).recordFlightSimulation(call, env));
if (!(globalThis as Record<symbol, unknown>)[REGISTERED]) {
  (globalThis as Record<symbol, unknown>)[REGISTERED] = true;
  // A fixed, content-free line, so a deployment's runtime logs show the observer is in place.
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), severity: 'INFO', event: 'flight.observer.registered', service: 'flofi-web' }) + '\n');
}

export { cloudFlowMode, cloudRuns } from '../server/flow-runtime';
const durableRuntime = (env: Readonly<Record<string, string | undefined>>) => {
  const kind = flowRuntimeKind(env);
  return kind === 'remote' || kind === 'embedded';
};

/** The durable backend checks the exact named and recorded run owners for wallet-specific operations. */
export async function withFlightFlowAccess<T>(work: () => Promise<T>): Promise<T> {
  if (!durableRuntime(process.env)) return withFlightAccess(work);
  return withFlightProductAccess(work);
}

export async function cloudFlow<T>(...args: Parameters<typeof runtimeFlow<T>>) {
  const [flow, method, values, options] = args;
  try { guardFlowExecution(method); } catch (error) {
    return { ok: false as const, code: error instanceof Error ? error.message : 'EXECUTION_PAUSED' };
  }
  let principal = options?.principal ?? null;
  const config = issuesWalletRequest(method) ? readDeveloperConfig(options?.env ?? process.env) : null;
  const developerLive = config?.enabled === true && config.live;
  if (developerLive && !principal) {
    const solana = method === 'handoff' ? false : typeof values[1] === 'string' && !values[1].startsWith('0x');
    // An unreadable session leaves the principal unset: an external step is then refused, an ordinary flow is unaffected.
    const { currentSolanaSession, currentWalletSession } = await import('../server/session-principal.ts');
    principal = (await (solana ? currentSolanaSession() : currentWalletSession()).catch(() => null))?.account ?? null;
  }
  const env = options?.env ?? process.env;
  const proven = walletPrincipalOf(principal);
  // In the durable runtime, a run's owner is checked even for methods taking only a run ID.
  const identity = !proven && !isFlightRecoveryMethod(method) && durableRuntime(env)
    ? await requireFlightProductAccess(env)
    : await requireFlightMethodAccess(method, proven ?? undefined, env);
  return runtimeFlow<T>(flow, method, values, { ...options, principal, betaIdentity: identity, developerLive });
}
