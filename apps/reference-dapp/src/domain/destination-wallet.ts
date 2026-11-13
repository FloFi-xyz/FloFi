// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: the destination wallet of a bridge — which of the owner's own wallets receives the funds on the destination
 * network, and how an address typed by hand is checked for that network.
 *
 * Across ecosystems (EVM → Solana, Solana → EVM) the signing wallet cannot receive: the funds go to the owner's wallet of the OTHER ecosystem.
 * FloFi resolves it in this order (owner request):
 *  1. the destination ecosystem's wallet connected in this session;
 *  2. a wallet of that ecosystem associated with the FloFi account (Privy embedded or linked to the account);
 *  3. a wallet of that ecosystem saved in Credentials → Wallets;
 *  4. when a tier holds more than one wallet, the owner chooses among them;
 *  5. otherwise (or whenever the owner prefers) a public address typed by hand.
 * The first tier that has exactly one wallet fills the field; a tier with several asks the owner to choose (never a guess). Only public
 * addresses are ever read or accepted: no private key, seed phrase or secret is asked for or stored. Nothing here connects, signs or sends.
 */
import { canonicalUniversalAddress, UNIVERSAL_NETWORKS, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';

export type DestinationEcosystem = 'evm' | 'solana';
export type DestinationSource = 'SESSION' | 'ACCOUNT' | 'SAVED' | 'MANUAL';
export type DestinationCandidate = { readonly ecosystem: DestinationEcosystem; readonly address: string; readonly providerName: string; readonly source: DestinationSource };
export type DestinationInventory = {
  /** Wallets connected in this page, per ecosystem. */
  readonly session: readonly DestinationCandidate[];
  /** Wallets associated with the signed-in FloFi account (Privy embedded or linked account wallets). */
  readonly account: readonly DestinationCandidate[];
  /** Public addresses saved in Credentials → Wallets on this device. */
  readonly saved: readonly DestinationCandidate[];
};
export type DestinationResolution =
  | { readonly kind: 'RESOLVED'; readonly wallet: DestinationCandidate; readonly alternatives: readonly DestinationCandidate[] }
  | { readonly kind: 'CHOOSE'; readonly candidates: readonly DestinationCandidate[] }
  | { readonly kind: 'NONE' };

const canonical = (ecosystem: DestinationEcosystem, address: string) => ecosystem === 'evm' ? address.toLowerCase() : address;
/** Review P2: a candidate is used only when its ADDRESS is valid for the ecosystem (the same canonical check the server binds), not just its label. */
const validFor = (ecosystem: DestinationEcosystem, address: string) => {
  try { canonicalUniversalAddress(UNIVERSAL_NETWORKS[ecosystem === 'solana' ? 'solana' : 'base'], address.trim(), 'DESTINATION_INVALID'); return true; }
  catch { return false; }
};
const unique = (wallets: readonly DestinationCandidate[]) => wallets.filter((wallet, index) =>
  wallets.findIndex(other => canonical(other.ecosystem, other.address) === canonical(wallet.ecosystem, wallet.address)) === index);

/** The owner's destination wallet of `ecosystem` by the order above. */
export function resolveDestinationWallet(ecosystem: DestinationEcosystem, inventory: DestinationInventory): DestinationResolution {
  const of = (tier: readonly DestinationCandidate[]) => unique(tier.filter(wallet => wallet.ecosystem === ecosystem && validFor(ecosystem, wallet.address)));
  const all = unique([...of(inventory.session), ...of(inventory.account), ...of(inventory.saved)]);
  for (const tier of [of(inventory.session), of(inventory.account), of(inventory.saved)]) {
    if (tier.length === 1) return { kind: 'RESOLVED', wallet: tier[0]!, alternatives: all.filter(wallet => wallet !== tier[0]) };
    if (tier.length > 1) return { kind: 'CHOOSE', candidates: all };
  }
  return { kind: 'NONE' };
}

/** The ecosystem of a universal network (`'EVM' | 'SOLANA'` in the contracts, lower case in the wallet stores). */
export const destinationEcosystemOf = (network: UniversalNetworkKey): DestinationEcosystem => UNIVERSAL_NETWORKS[network].ecosystem === 'SOLANA' ? 'solana' : 'evm';

export type DestinationCheck = { readonly ok: true; readonly address: string } | { readonly ok: false; readonly code: 'DESTINATION_REQUIRED' | 'DESTINATION_WRONG_ECOSYSTEM' | 'DESTINATION_INVALID' };
/**
 * A typed destination for `network`: the same canonical check the server binds at Review (`canonicalUniversalAddress`). An EVM address typed for a
 * Solana destination (or a Solana address for an EVM one) is named as the wrong kind of address, not just "invalid".
 */
export function checkDestinationAddress(network: UniversalNetworkKey, value: string): DestinationCheck {
  const text = value.trim();
  if (!text) return { ok: false, code: 'DESTINATION_REQUIRED' };
  const target = UNIVERSAL_NETWORKS[network];
  try { return { ok: true, address: canonicalUniversalAddress(target, text, 'DESTINATION_INVALID') }; }
  catch {
    const evmShaped = /^0x[0-9a-fA-F]{40}$/.test(text), solanaShaped = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);
    return { ok: false, code: target.ecosystem === 'SOLANA' && evmShaped || target.ecosystem === 'EVM' && solanaShaped ? 'DESTINATION_WRONG_ECOSYSTEM' : 'DESTINATION_INVALID' };
  }
}
/** "Solana · Phantom · 8xY…k2P": network, provider and a short address (the full address stays available to the caller). */
export function destinationLabel(network: UniversalNetworkKey, wallet: Pick<DestinationCandidate, 'address' | 'providerName'>): string {
  const address = wallet.address.length > 12 ? `${wallet.address.slice(0, wallet.address.startsWith('0x') ? 4 : 3)}…${wallet.address.slice(-4)}` : wallet.address;
  return [UNIVERSAL_NETWORKS[network].name, wallet.providerName, address].filter(Boolean).join(' · ');
}
