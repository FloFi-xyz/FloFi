// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the user-funded runtime of a process (web tier or worker), from its fail-closed configuration
 * (`config.ts`). It holds NO signer: every transport here reads, simulates, or relays bytes the owner's own wallet signed (the bundler takes
 * owner-signed user operations; Solana `sendTransaction` takes owner-signed transactions whose fee payer is the owner). There is no
 * FloFi-funded account anywhere in it, and nothing here can create one.
 *
 * P0 hotfix (E1): a certified Router pair (Across, same asset both sides) whose two chains are opted in with a read RPC is a batchable bridge
 * route (`bridgeRoutes`): the Router's own Across provider adapter quotes it (read-only HTTPS, the Router's optional API key and integrator id),
 * with the profile's own code pins. The Router flow's own deployment gates (live mode and its real-funds owner-execution opt-in) still decide,
 * per step, whether a run may prepare it (`evaluateGates` when the group is prepared).
 */
import type { Database } from '@defi-workflow-engine/cloud-runtime';
import { betaAccessMode, createBetaAccessStore } from '../flight/beta-access.ts';
import { flightCalendarFrom } from '../flight/campaign.ts';
import { CROSSCHAIN_ROUTER_PROFILES, JUPITER_SOLANA_MAINNET } from '@defi-workflow-engine/action-registry';
import { guarded, httpRpc } from '../delegation/chains.ts';
import type { UserFundedFacts } from '../workflow-runs/execution-groups.ts';
import { createJupiterHttp } from '../server/jupiter-http.ts';
import { createSolanaRpc, solanaRpcOverride } from '../server/solana-rpc.ts';
import { createRouteProviders, createRouterHttp } from '../server/router-providers.ts';
import { batchBridgeProfile, batchBridgeRoutes, type AcrossRoute } from './bridge-calls.ts';
import { bundlerRpc, createBundlerClient, type BundlerClient } from './bundler.ts';
import { readUserFundedConfig } from './config.ts';
import type { UserFundedDeps } from './groups.ts';

type Env = Readonly<Record<string, string | undefined>>;
export type UserFundedRuntime = { readonly facts: UserFundedFacts; readonly deps: UserFundedDeps | null };

/**
 * The deployment's user-funded facts only (no transport is created): the same chains the runtime below serves — Solana when enabled, an EVM
 * chain only with a read RPC, a bundler chain only with both. Used where a plan is described (MCP, channels) without executing anything.
 */
export function userFundedFactsOf(env: Env): UserFundedFacts {
  const config = readUserFundedConfig(env);
  if (!config.enabled) return { enabled: false, code: config.code, chains: [], bundlerChains: [], solanaNonceAccounts: false };
  const chains = config.chains.filter(c => c.startsWith('solana:') || Boolean(config.rpc[c]));
  return { enabled: true, code: null, chains, bundlerChains: Object.keys(config.bundlers).filter(c => chains.includes(c) && c.startsWith('eip155:')),
    solanaNonceAccounts: config.solanaNonceAccounts, bridgeRoutes: batchBridgeRoutes(chains, CROSSCHAIN_ROUTER_PROFILES) };
}
/** The deployment's user-funded facts and transports. Disabled or misconfigured: facts say why, and there are no transports at all. */
export function userFundedRuntime(env: Env, fetchImpl: typeof fetch = fetch, host?: { db: Database; tenantId: string }): UserFundedRuntime {
  const config = readUserFundedConfig(env);
  if (!config.enabled) return { facts: { enabled: false, code: config.code, chains: [], bundlerChains: [], solanaNonceAccounts: false }, deps: null };
  const evm = new Map<string, ReturnType<typeof guarded>>(), bundlers = new Map<string, BundlerClient>();
  for (const [chain, url] of Object.entries(config.rpc)) if (config.chains.includes(chain)) evm.set(chain, guarded(chain, 'read', 'PUBLIC', httpRpc(url, fetchImpl)));
  for (const [chain, url] of Object.entries(config.bundlers)) if (config.chains.includes(chain) && evm.has(chain))
    bundlers.set(chain, createBundlerClient(Number(chain.slice('eip155:'.length)), bundlerRpc(url, fetchImpl)));
  const solanaEnabled = config.chains.includes(JUPITER_SOLANA_MAINNET.chain);
  const solanaUrl = solanaEnabled ? solanaRpcOverride(env.GRYLOO_SOLANA_RPC_URL, 'USER_FUNDED_SOLANA_RPC_INVALID') ?? JUPITER_SOLANA_MAINNET.rpc : null;
  const chains = config.chains.filter(c => c.startsWith('solana:') || evm.has(c));
  const facts: UserFundedFacts = { enabled: true, code: null, chains, bundlerChains: [...bundlers.keys()],
    solanaNonceAccounts: config.solanaNonceAccounts, bridgeRoutes: batchBridgeRoutes(chains, CROSSCHAIN_ROUTER_PROFILES) };
  // The Router's own Across adapter per batchable route (read-only quotes and deposit status; pins: the profile's own, never overridden here).
  const http = createRouterHttp(fetchImpl), acrossRoutes = new Map<string, AcrossRoute>();
  const across = (source: string, destination: string): AcrossRoute | null => {
    if (!facts.bridgeRoutes?.includes(`${source}>${destination}`)) return null;
    const key = `${source}>${destination}`, cached = acrossRoutes.get(key);
    if (cached) return cached;
    const profile = batchBridgeProfile(source, destination);
    if (!profile) return null;
    const provider = createRouteProviders({ http, profile, ...env.ACROSS_API_KEY ? { acrossApiKey: env.ACROSS_API_KEY } : {},
      ...env.ACROSS_INTEGRATOR_ID ? { acrossIntegratorId: env.ACROSS_INTEGRATOR_ID } : {} }).across;
    const route: AcrossRoute = { profile, pins: profile.codeSha256, quote: provider.quote, status: provider.status };
    acrossRoutes.set(key, route);
    return route;
  };
  const deps: UserFundedDeps = { chains: facts.chains, evm: chain => evm.get(chain) ?? null, bundler: chain => bundlers.get(chain) ?? null, across,
    submissionRefusal: async (wallet, owner = wallet) => {
      const mode = betaAccessMode(env);
      if (mode === 'open') return null;
      if (mode !== 'beta') return 'BETA_ACCESS_CLOSED';
      const { calendar } = flightCalendarFrom(env);
      if (!host || !calendar) return 'BETA_ACCESS_UNAVAILABLE';
      const gate = createBetaAccessStore(host, calendar, env), now = Date.now();
      const grant = await gate.requireWallet(owner, now);
      if (!grant.ok) return grant.code;
      if (wallet.namespace === owner.namespace && wallet.address === owner.address) return null;
      const payer = await gate.requireAccount(grant.accountId, now, wallet);
      return payer.ok ? null : payer.code;
    },
    solana: solanaUrl ? createSolanaRpc(solanaUrl, false) : null,
    jupiter: solanaEnabled ? createJupiterHttp(JUPITER_SOLANA_MAINNET.api + JUPITER_SOLANA_MAINNET.endpoint, env.JUPITER_API_KEY) : null, now: () => new Date() };
  return { facts, deps };
}
