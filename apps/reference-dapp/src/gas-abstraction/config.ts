// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): token-paid network fee configuration — server-only, per mechanism, fail-closed.
 *
 * Every mechanism is OFF unless its switch says `enabled`; a malformed value disables only that mechanism (its operations keep native gas,
 * exactly as before) with a closed code; nothing is guessed and nothing falls back to FloFi paying. No variable here makes FloFi a payer: each
 * mechanism charges the owner (USDC through Circle, USDC/USDT to Pimlico, the swap's own tokens through 0x). Contract addresses and mints are
 * pinned in code from official sources, never read from the environment.
 *
 *   FLOFI_CIRCLE_USDC_GAS=enabled                 Circle Paymaster (permissionless: no Circle account or key). It also needs, per chain, the
 *                                                 user-funded execution an ERC-4337 bundler and read RPC already use (`FLOFI_USER_FUNDED_EXECUTION`,
 *                                                 `FLOFI_BUNDLER_RPC_<chainId>`, `FLOFI_USER_FUNDED_RPC_<chainId>`; user-funded/config.ts).
 *   FLOFI_CIRCLE_USDC_GAS_CHAINS                  optional subset of eip155:1, eip155:8453, eip155:42161 (default: all three)
 *
 *   FLOFI_KORA_TOKEN_GAS=enabled                  Pimlico hosted Kora: SOL fee fronted by Pimlico, paid back by the owner in USDC/USDT
 *   FLOFI_PIMLICO_KORA_RPC_URL                    https://solana.pimlico.io/v1/mainnet/rpc?apikey=… (secret: carries the API key)
 *   FLOFI_KORA_SIGNER                             pinned fee payer (`getPayerSigner.signer_address`); an answer naming another key is refused
 *   FLOFI_KORA_PAYMENT_ADDRESS                    pinned payment wallet (`getPayerSigner.payment_address`)
 *   FLOFI_KORA_FEE_TOKENS                         optional subset of USDC,USDT (default: both)
 *
 *   FLOFI_ZEROX_GASLESS=enabled                   0x Gasless API v2 swaps on Robinhood Chain (4663)
 *   FLOFI_ZEROX_API_KEY                           0x dashboard key with Gasless enabled (secret; header `0x-api-key`, server-side only)
 *   FLOFI_ZEROX_API_URL                           optional; https://api.0x.org (default) — or the loopback harness http://127.0.0.1:<port> in tests
 *
 * Hosts are pinned: a provider URL on any other host is refused (a malicious or mistyped endpoint can never receive owner signatures or the key).
 */

type Env = Readonly<Record<string, string | undefined>>;

export const CIRCLE_GAS_CHAINS: readonly string[] = Object.freeze(['eip155:1', 'eip155:8453', 'eip155:42161']);
export const KORA_FEE_TOKENS = Object.freeze({
  USDC: Object.freeze({ symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 }),
  USDT: Object.freeze({ symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 }),
});
export type KoraFeeToken = (typeof KORA_FEE_TOKENS)[keyof typeof KORA_FEE_TOKENS];
export const KORA_RPC_HOST = 'solana.pimlico.io';
export const ZEROX_API_HOST = 'api.0x.org';
export const ZEROX_GASLESS_CHAINS: readonly string[] = Object.freeze(['eip155:4663']);

export type CircleGasConfig = { readonly enabled: true; readonly chains: readonly string[] } | { readonly enabled: false; readonly code: string };
export type KoraGasConfig = { readonly enabled: true; readonly rpcUrl: string; readonly signer: string; readonly paymentAddress: string; readonly feeTokens: readonly KoraFeeToken[];
  /** The loopback harness, never a public provider (tests and local acceptance only). */
  readonly loopback: boolean } | { readonly enabled: false; readonly code: string };
export type ZeroExGaslessConfig = { readonly enabled: true; readonly apiUrl: string; readonly apiKey: string; readonly chains: readonly string[]; readonly loopback: boolean }
  | { readonly enabled: false; readonly code: string };
export type GasAbstractionConfig = { readonly circle: CircleGasConfig; readonly kora: KoraGasConfig; readonly zeroEx: ZeroExGaslessConfig };

const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const off = (code: string) => ({ enabled: false, code } as const);
/** The switch: absent or `disabled` is off; `enabled` is on; anything else is a configuration error (off, with its code). */
function switchOf(value: string | undefined, invalid: string): 'on' | 'off' | string {
  if (value === undefined || value === '' || value === 'disabled') return 'off';
  return value === 'enabled' ? 'on' : invalid;
}
/** https on the pinned host, or plain http on 127.0.0.1 (loopback harness); no credentials in the authority part. */
function providerUrl(text: string | undefined, host: string): { readonly url: string; readonly loopback: boolean } | null {
  if (!text) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.username || url.password || url.hash) return null;
  if (url.protocol === 'https:' && url.hostname === host && !url.port) return { url: url.toString(), loopback: false };
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return { url: url.toString(), loopback: true };
  return null;
}

export function readCircleGasConfig(env: Env): CircleGasConfig {
  const flag = switchOf(env.FLOFI_CIRCLE_USDC_GAS, 'CIRCLE_GAS_CONFIGURATION_INVALID');
  if (flag === 'off') return off('CIRCLE_GAS_NOT_ENABLED');
  if (flag !== 'on') return off(flag);
  const listed = (env.FLOFI_CIRCLE_USDC_GAS_CHAINS ?? '').split(',').map(c => c.trim()).filter(Boolean);
  if (listed.some(c => !CIRCLE_GAS_CHAINS.includes(c)) || new Set(listed).size !== listed.length) return off('CIRCLE_GAS_CONFIGURATION_INVALID');
  return { enabled: true, chains: listed.length ? listed : CIRCLE_GAS_CHAINS };
}

export function readKoraGasConfig(env: Env): KoraGasConfig {
  const flag = switchOf(env.FLOFI_KORA_TOKEN_GAS, 'KORA_CONFIGURATION_INVALID');
  if (flag === 'off') return off('KORA_NOT_ENABLED');
  if (flag !== 'on') return off(flag);
  const rpc = providerUrl(env.FLOFI_PIMLICO_KORA_RPC_URL, KORA_RPC_HOST);
  const signer = env.FLOFI_KORA_SIGNER?.trim() ?? '', paymentAddress = env.FLOFI_KORA_PAYMENT_ADDRESS?.trim() ?? '';
  if (!rpc || !BASE58_KEY.test(signer) || !BASE58_KEY.test(paymentAddress)) return off('KORA_CONFIGURATION_INVALID');
  // Mainnet only: the hosted endpoint's cluster is part of its path (`/v1/mainnet/rpc`); devnet would sign against another cluster.
  if (!rpc.loopback && !/^\/v1\/mainnet\/rpc\/?$/.test(new URL(rpc.url).pathname)) return off('KORA_CONFIGURATION_INVALID');
  const listed = (env.FLOFI_KORA_FEE_TOKENS ?? '').split(',').map(t => t.trim().toUpperCase()).filter(Boolean);
  if (listed.some(t => !(t in KORA_FEE_TOKENS)) || new Set(listed).size !== listed.length) return off('KORA_CONFIGURATION_INVALID');
  const feeTokens = (listed.length ? listed : Object.keys(KORA_FEE_TOKENS)).map(t => KORA_FEE_TOKENS[t as keyof typeof KORA_FEE_TOKENS]);
  return { enabled: true, rpcUrl: rpc.url, signer, paymentAddress, feeTokens, loopback: rpc.loopback };
}

export function readZeroExGaslessConfig(env: Env): ZeroExGaslessConfig {
  const flag = switchOf(env.FLOFI_ZEROX_GASLESS, 'ZEROX_CONFIGURATION_INVALID');
  if (flag === 'off') return off('ZEROX_GASLESS_NOT_ENABLED');
  if (flag !== 'on') return off(flag);
  const apiKey = env.FLOFI_ZEROX_API_KEY?.trim() ?? '';
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(apiKey)) return off('ZEROX_API_KEY_NOT_CONFIGURED');
  const api = providerUrl(env.FLOFI_ZEROX_API_URL ?? `https://${ZEROX_API_HOST}`, ZEROX_API_HOST);
  if (!api || new URL(api.url).pathname !== '/' || new URL(api.url).search) return off('ZEROX_CONFIGURATION_INVALID');
  return { enabled: true, apiUrl: api.url.replace(/\/$/, ''), apiKey, chains: ZEROX_GASLESS_CHAINS, loopback: api.loopback };
}

export function readGasAbstractionConfig(env: Env): GasAbstractionConfig {
  return { circle: readCircleGasConfig(env), kora: readKoraGasConfig(env), zeroEx: readZeroExGaslessConfig(env) };
}

/** What a readiness probe or an operator page may show: switches and codes only — never a URL, key or pin. */
export function gasAbstractionReadiness(config: GasAbstractionConfig): Readonly<Record<'circle' | 'kora' | 'zeroEx', string>> {
  const state = (c: { readonly enabled: boolean; readonly code?: string }) => c.enabled ? 'ENABLED' : c.code ?? 'DISABLED';
  return { circle: state(config.circle), kora: state(config.kora), zeroEx: state(config.zeroEx) };
}
