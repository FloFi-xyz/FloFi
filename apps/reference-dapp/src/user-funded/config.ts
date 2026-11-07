// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: user-funded workflow execution configuration — server-only, fail closed. A malformed value disables the
 * feature with DELEGATION-style closed codes; nothing falls back to another transport, chain or payer.
 *
 *   FLOFI_USER_FUNDED_EXECUTION   enabled | disabled (default): workflow runs may be authorized per execution group (EIP-5792 wallet batches,
 *                                 user-signed ERC-4337 operations of the owner's own account, Solana sign-all / durable-nonce groups). The
 *                                 owner's account pays every network fee; FloFi funds, advances, sponsors or reimburses nothing.
 *   FLOFI_USER_FUNDED_CHAINS      comma-separated public mainnets opted in (CAIP-2: eip155:1, eip155:8453, eip155:42161, eip155:4663,
 *                                 solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp). Unset: every group stays USER_FUNDED_CHAIN_DISABLED (confirm each step).
 *   FLOFI_BUNDLER_RPC_<chainId>   per EVM chain ERC-4337 v0.7 bundler JSON-RPC (https). A chain without one offers no pre-signed user
 *                                 operations (delayed EVM steps then ask the owner's wallet when they are due); wallet batches need none.
 *   FLOFI_USER_FUNDED_RPC_<id>    per EVM chain read JSON-RPC (https) for account code, EntryPoint nonces, receipts and balances; falls back
 *                                 to FLOFI_DELEGATION_RPC_<id>. Solana reads use the owner flows' own cluster RPC.
 *   FLOFI_SOLANA_NONCE_ACCOUNTS   enabled | disabled (default enabled): offer owner-controlled durable nonce accounts for delayed Solana steps.
 */
import { isHostedDeployment } from '../server/deployment.ts';

type Env = Readonly<Record<string, string | undefined>>;
export const USER_FUNDED_MAINNET_CHAINS: readonly string[] = Object.freeze(['eip155:1', 'eip155:8453', 'eip155:42161', 'eip155:4663', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp']);
export type UserFundedConfig = { readonly enabled: true; readonly chains: readonly string[]; readonly bundlers: Readonly<Record<string, string>>;
  readonly rpc: Readonly<Record<string, string>>; readonly solanaNonceAccounts: boolean; readonly hosted: boolean };
export type UserFundedConfigResult = UserFundedConfig | { readonly enabled: false; readonly code: 'USER_FUNDED_NOT_ENABLED' | 'USER_FUNDED_CONFIGURATION_INVALID'; readonly reason?: string };
const invalid = (reason: string) => ({ enabled: false, code: 'USER_FUNDED_CONFIGURATION_INVALID', reason } as const);

function httpsUrls(env: Env, prefix: string): Readonly<Record<string, string>> | string {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = new RegExp(`^${prefix}([1-9][0-9]{0,18})$`).exec(key);
    if (!match || !value) continue;
    try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) return key; out[`eip155:${match[1]}`] = url.toString(); }
    catch { return key; }
  }
  return out;
}
export function readUserFundedConfig(env: Env): UserFundedConfigResult {
  const flag = env.FLOFI_USER_FUNDED_EXECUTION ?? 'disabled';
  if (flag === 'disabled' || flag === '') return { enabled: false, code: 'USER_FUNDED_NOT_ENABLED' };
  if (flag !== 'enabled') return invalid('FLOFI_USER_FUNDED_EXECUTION');
  const chains = (env.FLOFI_USER_FUNDED_CHAINS ?? '').split(',').map(c => c.trim()).filter(Boolean);
  if (chains.some(c => !USER_FUNDED_MAINNET_CHAINS.includes(c)) || new Set(chains).size !== chains.length) return invalid('FLOFI_USER_FUNDED_CHAINS');
  const bundlers = httpsUrls(env, 'FLOFI_BUNDLER_RPC_');
  if (typeof bundlers === 'string') return invalid(bundlers);
  const own = httpsUrls(env, 'FLOFI_USER_FUNDED_RPC_');
  if (typeof own === 'string') return invalid(own);
  const fallback = httpsUrls(env, 'FLOFI_DELEGATION_RPC_');
  if (typeof fallback === 'string') return invalid(fallback);
  const rpc = { ...fallback, ...own };
  // A bundler without a read RPC for its chain cannot reconcile: refused rather than half-configured.
  for (const chain of Object.keys(bundlers)) if (!rpc[chain]) return invalid(`FLOFI_USER_FUNDED_RPC_${chain.slice('eip155:'.length)}`);
  const nonce = env.FLOFI_SOLANA_NONCE_ACCOUNTS ?? 'enabled';
  if (nonce !== 'enabled' && nonce !== 'disabled') return invalid('FLOFI_SOLANA_NONCE_ACCOUNTS');
  return { enabled: true, chains, bundlers, rpc, solanaNonceAccounts: nonce === 'enabled', hosted: isHostedDeployment(env) };
}
