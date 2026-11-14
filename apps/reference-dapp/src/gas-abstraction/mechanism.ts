// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010): how a step's network fee is paid. Pure, deterministic, no I/O.
 *
 * Four mechanisms, chosen per execution (a step, an execution group), never per workflow design:
 *
 *   NATIVE_WALLET_GAS        the owner's wallet pays the network fee in ETH / SOL, exactly as before (the default, always first).
 *   CIRCLE_USDC_PAYMASTER    Ethereum, Base, Arbitrum One: an ERC-4337 user operation of the owner's own smart account whose fee Circle's
 *                            permissionless paymaster fronts and charges back in the owner's USDC (EIP-2612 permit, capped).
 *   PIMLICO_KORA_SPL_FEE     Solana: Pimlico's hosted Kora fee payer fronts the SOL fee; the same transaction pays it back from the owner's
 *                            USDC/USDT to Pimlico's payment address (an SPL transfer the owner signs).
 *   ZEROX_GASLESS_SWAP       Robinhood Chain: a 0x Gasless API v2 swap; 0x's relayer sends it and takes its cost out of the trade.
 *
 * The policy (ADR-0010 §2): the owner's own native gas whenever it covers the fee (nothing changes for anyone who holds ETH/SOL); a token-paid
 * mechanism only when native gas is short AND that mechanism is proven eligible for exactly this operation; otherwise native gas with the precise
 * reason each alternative was not available. The owner is always the economic payer: no mechanism here lets FloFi pay (ADR-0009 sponsorship is a
 * separate, operator-only, off-by-default feature and is never chosen by this policy).
 */

export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const GAS_MECHANISMS = ['NATIVE_WALLET_GAS', 'CIRCLE_USDC_PAYMASTER', 'PIMLICO_KORA_SPL_FEE', 'ZEROX_GASLESS_SWAP'] as const;
export type GasMechanism = (typeof GAS_MECHANISMS)[number];
export type TokenGasMechanism = Exclude<GasMechanism, 'NATIVE_WALLET_GAS'>;
export const TOKEN_GAS_MECHANISMS: readonly TokenGasMechanism[] = Object.freeze(['CIRCLE_USDC_PAYMASTER', 'PIMLICO_KORA_SPL_FEE', 'ZEROX_GASLESS_SWAP']);

/** The token-paid alternative each FloFi mainnet offers (CAIP-2). A chain absent here has none: native gas only. */
export const TOKEN_GAS_BY_CHAIN: Readonly<Record<string, TokenGasMechanism>> = Object.freeze({
  'eip155:1': 'CIRCLE_USDC_PAYMASTER',
  'eip155:8453': 'CIRCLE_USDC_PAYMASTER',
  'eip155:42161': 'CIRCLE_USDC_PAYMASTER',
  'eip155:4663': 'ZEROX_GASLESS_SWAP',
  [SOLANA_MAINNET]: 'PIMLICO_KORA_SPL_FEE',
});

/** An amount of a token in its base units, with what a person needs to read it. */
export type TokenAmount = { readonly token: string; readonly symbol: string; readonly decimals: number; readonly amount: string };

/**
 * What the owner authorizes about the fee, bound into the Review and the signed artifact. `maxFee` is the most the owner can pay for it; a
 * token mechanism's `signatures` is the number of wallet prompts it needs (never rounded down).
 */
export type GasPayment =
  | { readonly mechanism: 'NATIVE_WALLET_GAS'; readonly maxFee: { readonly amount: string; readonly unit: 'wei' | 'lamports' } | null; readonly signatures: number }
  | { readonly mechanism: 'CIRCLE_USDC_PAYMASTER'; readonly maxFee: TokenAmount;
      /** 2: a USDC permit, then the operation. 3: a FloFi Wallet's first use — its EIP-7702 upgrade authorization first (owner consent required). */
      readonly signatures: 2 | 3;
      /** The pinned Circle paymaster, its EntryPoint and the permit's allowance cap (spender = paymaster). */
      readonly paymaster: string; readonly entryPoint: string; readonly permitCap: string;
      /** The EIP-7702 upgrade inside this operation (FloFi Wallet's first use only): the pinned delegate the owner's address designates. */
      readonly upgrade?: { readonly delegate: string; readonly chainId: number } }
  | { readonly mechanism: 'PIMLICO_KORA_SPL_FEE'; readonly maxFee: TokenAmount; readonly signatures: 1;
      /** Pimlico's fee payer (static key 0) and the wallet whose associated token account receives the fee. */
      readonly feePayer: string; readonly paymentAddress: string }
  | { readonly mechanism: 'ZEROX_GASLESS_SWAP'; readonly maxFee: TokenAmount; readonly signatures: 1 | 2;
      /** 0x's own fee in the trade, shown beside the gas fee (both come out of the swap); null when 0x charges none. */
      readonly zeroExFee: TokenAmount | null };

/** One alternative that was considered and could not be used, with the closed reason. */
export type MechanismUnavailable = { readonly mechanism: TokenGasMechanism; readonly code: string };

/** A token mechanism's eligibility for exactly this operation, decided by its own module (balances, wallet, account, provider). */
export type MechanismCandidate =
  | { readonly mechanism: TokenGasMechanism; readonly eligible: true }
  | { readonly mechanism: TokenGasMechanism; readonly eligible: false; readonly code: string };

export type GasSelectionInput = {
  /** CAIP-2 chain of the operation. */
  readonly chain: string;
  /** Does the owner's native balance cover the worst-case fee (plus any native value the operation sends)? null: not known (never assumed). */
  readonly nativeCovers: boolean | null;
  /** The token mechanism's verdict, when the chain has one and it was evaluated. */
  readonly candidate?: MechanismCandidate | null;
};
export type GasSelection =
  | { readonly mechanism: 'NATIVE_WALLET_GAS'; readonly nativeShort: false; readonly unavailable: readonly MechanismUnavailable[] }
  | { readonly mechanism: 'NATIVE_WALLET_GAS'; readonly nativeShort: true; readonly unavailable: readonly MechanismUnavailable[] }
  | { readonly mechanism: TokenGasMechanism; readonly nativeShort: true; readonly unavailable: readonly MechanismUnavailable[] };

/** The closed reasons shared by every mechanism (each module adds its own `CIRCLE_*`, `KORA_*`, `ZEROX_*` codes). */
export const GAS_ABSTRACTION_CODES = Object.freeze({
  notConfigured: 'TOKEN_GAS_NOT_CONFIGURED',
  chainUnsupported: 'TOKEN_GAS_CHAIN_UNSUPPORTED',
  notEvaluated: 'TOKEN_GAS_NOT_EVALUATED',
  mechanismMismatch: 'TOKEN_GAS_MECHANISM_MISMATCH',
  changed: 'GAS_MECHANISM_CHANGED_REVIEW_REQUIRED',
});

/**
 * The policy. Native gas whenever it covers the fee (or when coverage is unknown: nothing is switched on a guess); otherwise the chain's token
 * mechanism when its own module proved it eligible; otherwise native gas, short, with every reason. A candidate for another chain's mechanism is
 * refused (`TOKEN_GAS_MECHANISM_MISMATCH`), never used.
 */
export function selectGasMechanism(input: GasSelectionInput): GasSelection {
  const expected = TOKEN_GAS_BY_CHAIN[input.chain] ?? null;
  if (input.nativeCovers !== false) return { mechanism: 'NATIVE_WALLET_GAS', nativeShort: false, unavailable: [] };
  if (!expected) return { mechanism: 'NATIVE_WALLET_GAS', nativeShort: true, unavailable: [] };
  const candidate = input.candidate ?? null;
  if (!candidate) return { mechanism: 'NATIVE_WALLET_GAS', nativeShort: true, unavailable: [{ mechanism: expected, code: GAS_ABSTRACTION_CODES.notEvaluated }] };
  if (candidate.mechanism !== expected) return { mechanism: 'NATIVE_WALLET_GAS', nativeShort: true, unavailable: [{ mechanism: expected, code: GAS_ABSTRACTION_CODES.mechanismMismatch }] };
  if (!candidate.eligible) return { mechanism: 'NATIVE_WALLET_GAS', nativeShort: true, unavailable: [{ mechanism: expected, code: candidate.code }] };
  return { mechanism: expected, nativeShort: true, unavailable: [] };
}

/**
 * A reviewed mechanism must still be the one the policy picks when the owner authorizes (ETH may have arrived or left since the Review): a change
 * is never applied silently, it asks for a new Review.
 */
export function assertReviewedMechanism(reviewed: GasMechanism, now: GasSelection): void {
  if (reviewed !== now.mechanism) throw new Error(GAS_ABSTRACTION_CODES.changed);
}

/** Exact decimal text of a base-unit amount (no rounding, no float). */
export function formatUnits(amount: string, decimals: number): string {
  if (!/^(0|[1-9][0-9]*)$/.test(amount) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('TOKEN_AMOUNT_INVALID');
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals), fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** "0.042 USDC": a fee the owner pays, never shortened in the owner's favour (callers that shorten must round up). */
export function tokenAmountText(value: TokenAmount): string {
  return `${formatUnits(value.amount, value.decimals)} ${value.symbol}`;
}
