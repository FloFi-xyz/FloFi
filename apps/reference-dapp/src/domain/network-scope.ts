// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-PRODUCT-001: FloFi is a Mainnet-only product for every public user. This is the one policy every surface applies
 * (Canvas, chat, Copilot, MCP, the Developer API, channels, automations, approval handoffs, simulation and execution).
 *
 *  - `PUBLIC_MAINNET`  the product: authoring, discovery, simulation, Review and execution exist on mainnets only. A test network is never
 *                      offered, created, simulated, reviewed or signed. Historical test-network runs, receipts and evidence stay readable.
 *  - `ENGINEERING`     isolated CI, QA and engineering certification on a local (never hosted) server that opts in explicitly
 *                      (`server/network-scope.ts`). It keeps every existing test-network engine reachable for automated tests.
 *
 * There is no user-facing switch between the two. Nothing here grants authority: a mainnet network still needs a fresh simulation, the
 * owner's Review and the owner's wallet signature, and the deployment's own enablement still decides which mainnet actions run.
 */
import { familyCounterpart, networkIdentity, type NetworkIdentity } from './network-registry';

export type NetworkScope = 'PUBLIC_MAINNET' | 'ENGINEERING';
/** The refusal every surface reports for a test network in the public product. */
export const TEST_NETWORK_NOT_AVAILABLE = 'TEST_NETWORK_NOT_AVAILABLE';
/** The only value that opts a local server into engineering certification (`server/network-scope.ts`). */
export const ENGINEERING_TESTNETS = 'ENGINEERING_TESTNETS';
type Env = Readonly<Record<string, string | undefined>>;
/**
 * The scope a server environment selects: engineering only on a local (never hosted) server that opts in. The hosted check is
 * `server/deployment.ts` `isHostedDeployment` (repeated here because this module is client-safe; a test keeps them equal).
 */
export function scopeOfEnv(env: Env): NetworkScope {
  const hosted = env.VERCEL === '1' || Boolean(env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID) || env.FLOFI_DEPLOYMENT === 'hosted';
  return !hosted && env.FLOFI_NETWORK_SCOPE === ENGINEERING_TESTNETS ? 'ENGINEERING' : 'PUBLIC_MAINNET';
}
let active: NetworkScope | null = null;
/**
 * The scope shared authoring code (Canvas pickers, chat and Copilot copy, the editor's proposal guard) applies. It is a deployment-wide
 * fact, never a user choice: the product layout hands the server's scope to the browser once (`setActiveNetworkScope`); a server reads its
 * own environment. A browser that was never told (any public page) is Mainnet-only.
 */
export function activeNetworkScope(): NetworkScope {
  if (active) return active;
  // A browser bundle carries no server environment (Next.js inlines only NEXT_PUBLIC_ values), so it reads as Mainnet-only.
  const env = (globalThis as { process?: { env?: Env } }).process?.env;
  return env ? scopeOfEnv(env) : 'PUBLIC_MAINNET';
}
/** `null` forgets a scope set earlier (tests), so the environment applies again. */
export function setActiveNetworkScope(scope: NetworkScope | null): void { active = scope; }
/**
 * Runs `run` (synchronously) with `scope` active, then restores the previous scope. Only for engine regression checks over curated corpora (the
 * Copilot learning evaluation), never for authoring, discovery or execution.
 */
export function withNetworkScope<T>(scope: NetworkScope, run: () => T): T {
  const previous = active;
  active = scope;
  try { return run(); } finally { active = previous; }
}
/** Development-only chains that never reach a hosted product (MOCKED templates, the local fork). */
const LOCAL_CHAINS = new Set(['mock:local', 'eip155:31337']);

/** Whether a CAIP-2 chain, display name or registry key names a public test network (Sepolia, Devnet, Robinhood Chain Testnet). */
export function isTestNetwork(value: string | null | undefined): boolean {
  return networkIdentity(value)?.environment === 'TESTNET';
}
/** Whether `value` may be authored, simulated, reviewed or executed in `scope`. Unknown networks are left to the capability registries. */
export function networkAllowed(value: string | null | undefined, scope: NetworkScope): boolean {
  return scope === 'ENGINEERING' || !isTestNetwork(value);
}
type WorkflowLike = { readonly nodes: readonly { readonly chainId: string; readonly actionType: string }[] };
/** The test networks a workflow's financial steps use, by display name (empty for a mainnet or template-only workflow). */
export function workflowTestNetworks(workflow: WorkflowLike): readonly NetworkIdentity[] {
  const found = new Map<string, NetworkIdentity>();
  for (const node of workflow.nodes) {
    if (node.actionType.startsWith('mock-') || LOCAL_CHAINS.has(node.chainId)) continue;
    const identity = networkIdentity(node.chainId);
    if (identity?.environment === 'TESTNET') found.set(identity.key, identity);
  }
  return [...found.values()];
}
/**
 * The test networks an edit adds to a workflow in `scope` (none in engineering certification). The editor refuses such a proposal in the public
 * product; an edit of a legacy test-network workflow that adds none (or moves it to a mainnet) is not refused here (it stays non-executable).
 */
export function introducedTestNetworks(before: WorkflowLike, after: WorkflowLike, scope: NetworkScope): readonly NetworkIdentity[] {
  if (scope === 'ENGINEERING') return [];
  const existing = new Set(workflowTestNetworks(before).map(network => network.key));
  return workflowTestNetworks(after).filter(network => !existing.has(network.key));
}
/** Whether `workflow` can run in `scope`: in the public product, none of its steps is on a test network. */
export const workflowAllowed = (workflow: WorkflowLike, scope: NetworkScope) => scope === 'ENGINEERING' || workflowTestNetworks(workflow).length === 0;
/** The mainnet of the same network family (Base Sepolia → Base, Solana Devnet → Solana), or null when the family has none. */
export const mainnetCounterpart = (value: string | null | undefined): NetworkIdentity | null => {
  const counterpart = familyCounterpart(value, 'MAINNET');
  return counterpart?.environment === 'MAINNET' ? counterpart : null;
};
/**
 * Owner-facing explanation for a test-network workflow or request in the public product, as a translatable template and its values
 * (`tr(template, ...values)`); `testNetworkMessage` is the English text.
 */
export function testNetworkTemplate(networks: readonly NetworkIdentity[]): readonly [string, ...string[]] {
  const names = [...new Set(networks.map(network => network.name))];
  const named = names.length ? names.join(' and ') : 'a test network';
  const mainnets = [...new Set(networks.map(network => mainnetCounterpart(network.key)?.name).filter((name): name is string => Boolean(name)))];
  const plural = names.length > 1;
  if (!mainnets.length) return [plural ? '{0} are test networks. FloFi runs on mainnets only, with real funds.' : '{0} is a test network. FloFi runs on mainnets only, with real funds.', named];
  return [plural ? '{0} are test networks. FloFi runs on mainnets only, with real funds: rebuild this on {1}.'
    : '{0} is a test network. FloFi runs on mainnets only, with real funds: rebuild this on {1}.', named, mainnets.join(' or ')];
}
const fill = ([template, ...values]: readonly [string, ...string[]]) => template.replace(/\{(\d+)\}/g, (_, index: string) => values[Number(index)] ?? '');
export const testNetworkMessage = (networks: readonly NetworkIdentity[]): string => fill(testNetworkTemplate(networks));
/**
 * Review copy (owner requirement 5): what a mainnet authorization costs, in one sentence, without any environment choice, as a translatable
 * template and its values. Null for a test network (legacy, read-only) or an unknown chain.
 */
export const REAL_FUNDS_TEMPLATE = 'Real funds on {0}: the amounts above leave your wallet, and your wallet also pays the network fee in {1}. ' +
  'Your wallet shows the exact transaction before you confirm.';
export function realFundsTemplate(chain: string | null | undefined): readonly [string, string, string] | null {
  const network = networkIdentity(chain);
  if (network?.environment !== 'MAINNET') return null;
  return [REAL_FUNDS_TEMPLATE, network.name, network.chain.startsWith('solana:') ? 'SOL' : network.evm?.nativeCurrency.symbol ?? 'ETH'];
}
export const realFundsNotice = (chain: string | null | undefined): string | null => { const template = realFundsTemplate(chain); return template ? fill(template) : null; };
