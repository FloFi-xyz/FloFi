// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: network-fee sponsorship configuration, per network, server-side only and fail-closed.
 *
 * Sponsorship pays a network fee on the owner's behalf; it never moves, holds or authorizes the owner's funds. Each network is configured on its
 * own (isolation): an EVM chain needs an ERC-7677 paymaster web service (its URL may carry the provider's API key — server-side only, never sent
 * to a browser), the pinned paymaster contract it must answer with, the EntryPoint, a per-operation cost cap and a daily budget; Solana needs
 * a sponsor fee-payer key (a FloFi operational key, never a user's), a per-transaction cap, a daily budget and a minimum balance kept back.
 * Anything missing or malformed disables that network's sponsorship (its operations stay user-funded, exactly as before); nothing is guessed.
 *
 *   FLOFI_GAS_SPONSORSHIP=enabled                    master switch (absent: every network user-funded)
 *   FLOFI_GAS_SPONSOR_PUBLIC_ORIGIN                  https origin of this deployment (the paymaster proxy URL wallets call)
 *   FLOFI_PAYMASTER_RPC_<chainId>                    ERC-7677 paymaster service URL (provider key inside; secret)
 *   FLOFI_PAYMASTER_ADDRESS_<chainId>                the paymaster contract its answers must name
 *   FLOFI_PAYMASTER_CONTEXT_<chainId>                optional JSON object forwarded as the provider's sponsorship context (e.g. a policy id)
 *   FLOFI_SPONSOR_MAX_WEI_PER_OP_<chainId>           worst-case cost cap of one sponsored operation, wei
 *   FLOFI_SPONSOR_DAILY_BUDGET_WEI_<chainId>         sum of worst-case costs sponsored per UTC day, wei
 *   FLOFI_SOLANA_SPONSOR_SECRET_KEY                  sponsor fee payer, base58 or JSON 64-byte secret (secret; a disposable key in tests only)
 *   FLOFI_SOLANA_SPONSOR_MAX_LAMPORTS_PER_TX         fee cap of one sponsored transaction
 *   FLOFI_SOLANA_SPONSOR_DAILY_BUDGET_LAMPORTS       sum of fee caps sponsored per UTC day
 *   FLOFI_SOLANA_SPONSOR_MIN_BALANCE_LAMPORTS        the sponsor never sponsors below this balance
 */
import { erc4337 } from '@defi-workflow-engine/reference-compiler';

type Env = Readonly<Record<string, string | undefined>>;
export type EvmSponsor = { readonly chain: string; readonly chainId: number; readonly paymasterRpc: string; readonly paymaster: string; readonly entryPoint: string;
  readonly context: Readonly<Record<string, unknown>> | null; readonly maxWeiPerOp: bigint; readonly dailyBudgetWei: bigint };
export type SolanaSponsor = { readonly chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'; readonly secretKey: Uint8Array; readonly maxLamportsPerTx: bigint;
  readonly dailyBudgetLamports: bigint; readonly minBalanceLamports: bigint };
export type GasSponsorshipConfig = { readonly enabled: boolean; readonly code: string | null; readonly publicOrigin: string | null;
  readonly evm: Readonly<Record<string, EvmSponsor>>; readonly solana: SolanaSponsor | null; readonly refusals: Readonly<Record<string, string>> };

/** The FloFi mainnets a paymaster may be configured for (Base, Arbitrum One, Ethereum, Robinhood Chain); never a test network. */
export const SPONSORABLE_EVM_CHAINS: readonly number[] = Object.freeze([8453, 42161, 1, 4663]);
const UNITS = /^[1-9][0-9]{0,30}$/, ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(text: string): Uint8Array | null {
  let value = 0n;
  for (const char of text) { const digit = BASE58.indexOf(char); if (digit < 0) return null; value = value * 58n + BigInt(digit); }
  const bytes: number[] = [];
  while (value > 0n) { bytes.unshift(Number(value & 0xffn)); value >>= 8n; }
  for (const char of text) { if (char !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
/** A 64-byte ed25519 secret (seed ‖ public key), base58 or a JSON byte array (the Solana CLI keypair file format). */
export function solanaSecretKey(text: string | undefined): Uint8Array | null {
  if (!text) return null;
  const trimmed = text.trim();
  const json = (): Uint8Array | null => {
    try { const parsed = JSON.parse(trimmed) as unknown; return Array.isArray(parsed) && parsed.every(n => Number.isInteger(n) && n >= 0 && n <= 255) ? Uint8Array.from(parsed as number[]) : null; }
    catch { return null; }
  };
  const bytes = trimmed.startsWith('[') ? json() : base58(trimmed);
  return bytes && bytes.length === 64 ? bytes : null;
}

/**
 * `options.solana`: decode the Solana sponsor key too. Off by default (review): no flow uses Solana sponsorship yet, so no process holds that
 * key in memory unless a Solana sponsoring flow asks for it explicitly.
 */
export function readGasSponsorshipConfig(env: Env, options: { readonly solana?: boolean } = {}): GasSponsorshipConfig {
  const off = (code: string): GasSponsorshipConfig => ({ enabled: false, code, publicOrigin: null, evm: {}, solana: null, refusals: {} });
  if (env.FLOFI_GAS_SPONSORSHIP !== 'enabled') return off('GAS_SPONSORSHIP_DISABLED');
  const urlOf = (text: string | undefined): URL | null => { try { return text ? new URL(text) : null; } catch { return null; } };
  const origin = urlOf(env.FLOFI_GAS_SPONSOR_PUBLIC_ORIGIN);
  // BUILD-FLOFI-MAINNET-EXEC-002 review (round 2): https, or plain http on the loopback address only (local acceptance); never another scheme.
  const publicOrigin = origin && (origin.protocol === 'https:' || origin.protocol === 'http:' && origin.hostname === '127.0.0.1') && origin.pathname === '/'
    ? origin.origin : null;
  const evm: Record<string, EvmSponsor> = {}, refusals: Record<string, string> = {};
  for (const chainId of SPONSORABLE_EVM_CHAINS) {
    const chain = `eip155:${chainId}`, rpc = env[`FLOFI_PAYMASTER_RPC_${chainId}`];
    if (!rpc) continue;
    const paymaster = env[`FLOFI_PAYMASTER_ADDRESS_${chainId}`], max = env[`FLOFI_SPONSOR_MAX_WEI_PER_OP_${chainId}`], budget = env[`FLOFI_SPONSOR_DAILY_BUDGET_WEI_${chainId}`];
    const url = urlOf(rpc);
    let context: Record<string, unknown> | null = null, contextOk = true;
    const contextText = env[`FLOFI_PAYMASTER_CONTEXT_${chainId}`];
    if (contextText) { try { const parsed = JSON.parse(contextText) as unknown; contextOk = Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed); context = contextOk ? parsed as Record<string, unknown> : null; } catch { contextOk = false; } }
    if (!url || url.protocol !== 'https:' && url.hostname !== '127.0.0.1' || !paymaster || !ADDRESS.test(paymaster) || !max || !UNITS.test(max) || !budget || !UNITS.test(budget) ||
        BigInt(budget) < BigInt(max) || !contextOk || !publicOrigin) { refusals[chain] = 'GAS_SPONSOR_EVM_CONFIG_INVALID'; continue; }
    evm[chain] = { chain, chainId, paymasterRpc: url.toString(), paymaster: paymaster.toLowerCase(), entryPoint: erc4337.ENTRY_POINT_V0_7, context,
      maxWeiPerOp: BigInt(max), dailyBudgetWei: BigInt(budget) };
  }
  let solana: SolanaSponsor | null = null;
  if (options.solana === true && env.FLOFI_SOLANA_SPONSOR_SECRET_KEY !== undefined) {
    const secretKey = solanaSecretKey(env.FLOFI_SOLANA_SPONSOR_SECRET_KEY), max = env.FLOFI_SOLANA_SPONSOR_MAX_LAMPORTS_PER_TX, budget = env.FLOFI_SOLANA_SPONSOR_DAILY_BUDGET_LAMPORTS,
      floor = env.FLOFI_SOLANA_SPONSOR_MIN_BALANCE_LAMPORTS;
    if (!secretKey || !max || !UNITS.test(max) || !budget || !UNITS.test(budget) || BigInt(budget) < BigInt(max) || !floor || !/^(0|[1-9][0-9]{0,30})$/.test(floor))
      refusals['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'] = 'GAS_SPONSOR_SOLANA_CONFIG_INVALID';
    else solana = { chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', secretKey, maxLamportsPerTx: BigInt(max), dailyBudgetLamports: BigInt(budget), minBalanceLamports: BigInt(floor) };
  }
  const any = Object.keys(evm).length > 0 || solana !== null;
  return { enabled: any, code: any ? null : 'GAS_SPONSORSHIP_NOT_CONFIGURED', publicOrigin, evm, solana, refusals };
}
/** The browser-facing paymaster proxy URL of a configured chain (no secret in it). */
export const paymasterProxyUrl = (config: GasSponsorshipConfig, chain: string) =>
  config.publicOrigin && config.evm[chain] ? `${config.publicOrigin}/api/gas/paymaster/${config.evm[chain]!.chainId}` : null;
