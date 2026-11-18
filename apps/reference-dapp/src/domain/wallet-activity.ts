// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001 (History): the read model of a wallet's on-chain token movements — what it received and sent — as
 * the server reads it from public chain data (`server/wallet-activity.ts`). Client-safe and pure: no request, no signer, no authority.
 *
 * Integrity rules every surface keeps:
 *   - a movement is shown only for an asset of the network's verified catalog (verified symbol and decimals); any other token is counted as
 *     `hidden`, never named or valued (the portfolio's existing spam protection)
 *   - a transaction that both sends and receives different assets for the wallet (a swap, a liquidity change, a bridge leg) is one
 *     "Contract interaction", never two ordinary transfers; a token minted to or burned from the wallet says so; a self-transfer is "Self"
 *   - "FloFi" is said only where a FloFi execution record carries the same transaction; nothing else claims an origin
 *   - a network the deployment cannot read history for is reported as such (`coverage`), never as an empty history
 */
import { formatAssetAmount } from '@defi-workflow-engine/action-registry';

export const ACTIVITY_NETWORKS = ['ethereum', 'base', 'arbitrum-one', 'robinhood', 'solana'] as const;
export type ActivityNetworkId = (typeof ACTIVITY_NETWORKS)[number];
export type ActivityDirection = 'IN' | 'OUT' | 'SELF';
/** TRANSFER: one-way movement; INTERACTION: the same transaction moved assets both ways (swap, liquidity, bridge leg); MINT / BURN: from / to the zero address. */
export type ActivityKind = 'TRANSFER' | 'INTERACTION' | 'MINT' | 'BURN';
export type ActivityCategory = 'NATIVE' | 'TOKEN' | 'INTERNAL';
export type WalletTransfer = {
  /** Unique per movement: `<chain>:<transaction>:<leg>`. */ readonly id: string;
  readonly network: ActivityNetworkId; readonly networkName: string; readonly chain: string;
  readonly direction: ActivityDirection; readonly kind: ActivityKind; readonly category: ActivityCategory;
  readonly asset: { readonly symbol: string; readonly decimals: number; readonly address: string | null; readonly logo: string | null };
  /** Exact base units (decimal string, never negative); the direction carries the sign. */ readonly amount: string;
  /** The other side of the movement when the chain data names it (sender for IN, recipient for OUT); null otherwise. */ readonly counterparty: string | null;
  /** The network's canonical transaction identifier (EVM transaction hash, Solana signature). */ readonly transaction: string;
  readonly explorerUrl: string | null; readonly timestamp: string | null; readonly block: string | null;
  /** CONFIRMED: included in a block (EVM) or confirmed (Solana); FINALIZED: the cluster reports it finalized. */ readonly status: 'CONFIRMED' | 'FINALIZED';
};
/**
 * COVERED: the provider lists this wallet's history for the listed categories; PARTIAL: some categories are not covered (`missing`); UNSUPPORTED:
 * no history source is configured for the network; UNAVAILABLE: the read failed or ran out of time (its history is unknown, not empty); OFF: the
 * network is not enabled on this deployment.
 */
export type ActivityCoverage = { readonly network: ActivityNetworkId; readonly name: string; readonly status: 'COVERED' | 'PARTIAL' | 'UNSUPPORTED' | 'UNAVAILABLE' | 'OFF';
  readonly code: string | null; readonly covers: readonly ActivityCategory[]; readonly missing: readonly ActivityCategory[] };
export type WalletActivityPage = { readonly account: string; readonly transfers: readonly WalletTransfer[]; readonly coverage: readonly ActivityCoverage[];
  /** Opaque continuation (null: nothing more on any covered network). */ readonly cursor: string | null;
  /** Movements of tokens outside the verified catalogs, not shown. */ readonly hidden: number;
  readonly provenance: 'PUBLIC_MAINNET' | 'MOCKED'; readonly observedAt: string };

export const ZERO_EVM = '0x0000000000000000000000000000000000000000';
/** One leg as a reader extracts it, before the transaction-level classification. */
export type ActivityLeg = Omit<WalletTransfer, 'kind'> & { readonly from: string | null; readonly to: string | null };
/**
 * The transaction-level kind of each leg: legs of one transaction that move the wallet's assets both ways are one interaction; a leg from the
 * zero address is a mint, to it a burn; anything else is a transfer.
 */
export function classifyLegs(legs: readonly ActivityLeg[]): WalletTransfer[] {
  const byTransaction = new Map<string, ActivityLeg[]>();
  for (const leg of legs) {
    const key = `${leg.chain}:${leg.transaction}`;
    byTransaction.set(key, [...byTransaction.get(key) ?? [], leg]);
  }
  return legs.map(({ from, to, ...leg }) => {
    const siblings = byTransaction.get(`${leg.chain}:${leg.transaction}`)!;
    const both = siblings.some(s => s.direction === 'IN') && siblings.some(s => s.direction === 'OUT');
    const kind: ActivityKind = both ? 'INTERACTION' : from === ZERO_EVM && leg.direction === 'IN' ? 'MINT' : to === ZERO_EVM && leg.direction === 'OUT' ? 'BURN' : 'TRANSFER';
    return { ...leg, kind };
  });
}

export type ActivityFilter = 'ALL' | 'IN' | 'OUT';
/** Lower-cases EVM hashes (Solana signatures are case-sensitive base58). */
export const transactionKey = (transaction: string) => /^0x[0-9a-fA-F]{64}$/.test(transaction) ? transaction.toLowerCase() : transaction;
/**
 * What a History view lists: newest first, without duplicates, filtered by direction. `recorded`: transactions a FloFi execution record of this
 * wallet carries — in the All view they are left to that record (shown once, as the workflow), in Received/Sent they are listed and marked FloFi.
 */
export function activityRows(transfers: readonly WalletTransfer[], filter: ActivityFilter, recorded: ReadonlySet<string> = new Set()) {
  const seen = new Set<string>();
  const unique = transfers.filter(t => !seen.has(t.id) && Boolean(seen.add(t.id)));
  const time = (t: WalletTransfer) => t.timestamp ? Date.parse(t.timestamp) : 0;
  return unique.filter(t => filter === 'ALL' ? !recorded.has(transactionKey(t.transaction)) : filter === 'IN' ? t.direction === 'IN' || t.direction === 'SELF' : t.direction === 'OUT' || t.direction === 'SELF')
    .sort((a, b) => time(b) - time(a) || a.id.localeCompare(b.id))
    .map(t => ({ transfer: t, flofi: recorded.has(transactionKey(t.transaction)) }));
}
/** The signed amount as shown: "+1.5 USDC" received, "−1.5 USDC" sent (a minus sign, never a hyphen), "1.5 USDC" for a self-transfer. */
export function signedAmount(t: Pick<WalletTransfer, 'amount' | 'direction' | 'asset'>): string {
  const value = `${formatAssetAmount(t.amount, t.asset.decimals)} ${t.asset.symbol}`;
  return t.direction === 'IN' ? `+${value}` : t.direction === 'OUT' ? `−${value}` : value;
}
export const shortAddress = (address: string) => address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
