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
  /**
   * BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001: the FloFi account's wallets (Privy, linked) are still being read. Until they answer, a
   * destination that the session cannot fill is unknown (`LOADING`), never "missing" and never filled from a lower tier ahead of them.
   */
  readonly loading?: boolean;
  /**
   * The account's wallets could not be read (a failed request, not "none"). The device's saved addresses are then offered to choose from, never
   * filled automatically ahead of wallets the account may hold (security review).
   *
   * BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001: the same holds for the account tier itself (Privy's embedded wallets, which this browser lists
   * without the server): one of them is offered to CHOOSE, never filled silently, because the account may hold another wallet of that ecosystem
   * the failed read did not return. With no wallet known at all the answer is `UNAVAILABLE` ("could not check"), never `NONE` ("you have none").
   */
  readonly accountUnavailable?: boolean;
};
export type DestinationResolution =
  | { readonly kind: 'RESOLVED'; readonly wallet: DestinationCandidate; readonly alternatives: readonly DestinationCandidate[] }
  /**
   * `unconfirmed`: offered only because the account's wallets could not be read (it may be one wallet): FloFi asks the owner to choose or retry,
   * and says it could not read the account — never "you have more than one wallet".
   */
  | { readonly kind: 'CHOOSE'; readonly candidates: readonly DestinationCandidate[]; readonly unconfirmed?: true }
  | { readonly kind: 'LOADING' }
  /** The account's wallets could not be read and no other wallet of the ecosystem is known: unknown, not "none" (the owner may retry). */
  | { readonly kind: 'UNAVAILABLE' }
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
  for (const [index, tier] of [of(inventory.session), of(inventory.account), of(inventory.saved)].entries()) {
    // The session tier answers at once; the account tier (and the saved one below it) waits for the account's wallets to be read.
    if (index === 1 && inventory.loading) return { kind: 'LOADING' };
    if (index >= 1 && inventory.accountUnavailable && tier.length) return { kind: 'CHOOSE', candidates: all, unconfirmed: true };
    if (tier.length === 1) return { kind: 'RESOLVED', wallet: tier[0]!, alternatives: all.filter(wallet => wallet !== tier[0]) };
    if (tier.length > 1) return { kind: 'CHOOSE', candidates: all };
  }
  return inventory.accountUnavailable ? { kind: 'UNAVAILABLE' } : { kind: 'NONE' };
}

/**
 * BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001: the one answer every surface (Chat, Canvas card, Editor panel, Simulate) gives about a bridge's
 * recipient, from the node's canonical `recipient` and the destination resolution above. It only reads public addresses: the RECEIVING wallet
 * never needs to be connected or to sign; the SOURCE wallet's signer is a separate requirement, checked where the source signs.
 *
 * - `OWNER`: within one ecosystem (EVM → EVM) the implicit recipient is the signing wallet itself (`CONNECTED_OWNER`): nothing to resolve, no
 *   second connection, no warning.
 * - `EXPLICIT`: an address written into the workflow; the server re-checks it for the destination network at Review.
 * - `RESOLVED`: across ecosystems, the owner's one wallet of the destination ecosystem at the first tier that has one (session, account, saved).
 * - `LOADING`: the account's wallets have not answered yet: unknown, never "missing".
 * - `CHOOSE`: several wallets at that tier: the owner chooses (never a silent pick).
 * - `UNAVAILABLE`: the account's wallets could not be read (after FloFi's own retry) and no other wallet is known: the owner retries, connects
 *   one or enters a public address — never told they have no wallet.
 * - `REQUIRED`: no wallet of the destination ecosystem is known: the owner connects one, chooses one or enters a public address.
 * Only `REQUIRED`, `CHOOSE`, `UNAVAILABLE` and `LOADING` block Simulate; the server keeps its own `UNIVERSAL_DESTINATION_WALLET_REQUIRED` refusal
 * regardless.
 */
export type DestinationRequirement =
  | { readonly kind: 'OWNER' }
  | { readonly kind: 'EXPLICIT'; readonly address: string }
  | { readonly kind: 'RESOLVED'; readonly wallet: DestinationCandidate }
  | { readonly kind: 'LOADING' }
  | { readonly kind: 'CHOOSE'; readonly candidates: readonly DestinationCandidate[] }
  | { readonly kind: 'UNAVAILABLE' }
  | { readonly kind: 'REQUIRED' };
export function destinationRequirement(recipient: string, resolution: DestinationResolution): DestinationRequirement {
  if (recipient === 'CONNECTED_OWNER') return { kind: 'OWNER' };
  if (recipient !== 'CONNECTED_DESTINATION_WALLET') return { kind: 'EXPLICIT', address: recipient };
  if (resolution.kind === 'RESOLVED') return { kind: 'RESOLVED', wallet: resolution.wallet };
  // A choice offered only because the account could not be read is that failure (with the owner's known wallets to choose from).
  if (resolution.kind === 'CHOOSE') return resolution.unconfirmed ? { kind: 'UNAVAILABLE' } : { kind: 'CHOOSE', candidates: resolution.candidates };
  if (resolution.kind === 'LOADING') return { kind: 'LOADING' };
  if (resolution.kind === 'UNAVAILABLE') return { kind: 'UNAVAILABLE' };
  return { kind: 'REQUIRED' };
}
/** The refusal a blocking requirement stands for (the server's own code for a missing wallet; two client-only codes for the other states). */
export const DESTINATION_ISSUE = Object.freeze({ REQUIRED: 'UNIVERSAL_DESTINATION_WALLET_REQUIRED', CHOOSE: 'UNIVERSAL_DESTINATION_WALLET_CHOICE_REQUIRED',
  LOADING: 'UNIVERSAL_DESTINATION_WALLETS_LOADING', UNAVAILABLE: 'UNIVERSAL_DESTINATION_WALLETS_UNAVAILABLE' } as const);
export type DestinationIssue = typeof DESTINATION_ISSUE[keyof typeof DESTINATION_ISSUE];
export function destinationIssue(requirement: DestinationRequirement): DestinationIssue | null {
  return requirement.kind === 'REQUIRED' || requirement.kind === 'CHOOSE' || requirement.kind === 'LOADING' || requirement.kind === 'UNAVAILABLE'
    ? DESTINATION_ISSUE[requirement.kind] : null;
}
/**
 * Where a blocking destination is explained. `editor`: the Canvas and its chat, where the Bridge card (its Destination wallet field, Connect,
 * Try again and the owner's wallets) is at hand. `approve`: the signing surface of a handed-off proposal (chat, MCP, Telegram), which has no
 * Bridge card: it offers Connect and Try again itself (a wallet connected here is the first one FloFi uses), and sends a choice or a typed
 * address to the Canvas. `approve-embedded`: the same surface embedded for an MCP client, which has no Canvas to open either.
 */
export type DestinationSurface = 'editor' | 'approve' | 'approve-embedded';
/**
 * What the owner does about a blocking destination, naming the destination network (`{0}`), the kind of wallet it needs (`{1}`: Solana / EVM)
 * and, on /approve, the wallet to connect with its article (`{2}`: `destinationWalletPhrase`, translated). A catalog key: callers translate it.
 * Never "connect the wallet that will sign": the source wallet is not what is missing. One message per reason and surface
 * (BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001: never a component the surface does not have).
 */
export function destinationIssueMessage(issue: DestinationIssue, surface: DestinationSurface = 'editor', held = false): string {
  // Frontend-UX review: once /approve holds its automatic preparation (the destination was missing), a new read does not continue by itself.
  if (surface !== 'editor' && held && issue === 'UNIVERSAL_DESTINATION_WALLETS_LOADING')
    return 'FloFi is reading your wallets for {0} again. When they are read, choose Simulate. Nothing was signed or sent.';
  if (surface === 'approve') {
    if (issue === 'UNIVERSAL_DESTINATION_WALLET_CHOICE_REQUIRED') return 'You have more than one {1} wallet that can receive on {0}. Connect the one that receives the tokens here, or open the Canvas to choose it or to enter its public address. Nothing was signed or sent.';
    if (issue === 'UNIVERSAL_DESTINATION_WALLETS_LOADING') return 'FloFi is reading your wallets for {0}. This page continues by itself when they are read. Nothing was signed or sent.';
    if (issue === 'UNIVERSAL_DESTINATION_WALLETS_UNAVAILABLE') return 'FloFi could not read which {1} wallets your account has for {0}. Try again, connect {2} here, or open the Canvas to choose one or to enter its public address. Nothing was signed or sent.';
    return 'To receive the tokens on {0}, connect {2} here, or open the Canvas to enter its public address. Nothing was signed or sent.';
  }
  if (surface === 'approve-embedded') {
    if (issue === 'UNIVERSAL_DESTINATION_WALLET_CHOICE_REQUIRED') return 'You have more than one {1} wallet that can receive on {0}. Connect the one that receives the tokens here. Nothing was signed or sent.';
    if (issue === 'UNIVERSAL_DESTINATION_WALLETS_LOADING') return 'FloFi is reading your wallets for {0}. This page continues by itself when they are read. Nothing was signed or sent.';
    if (issue === 'UNIVERSAL_DESTINATION_WALLETS_UNAVAILABLE') return 'FloFi could not read which {1} wallets your account has for {0}. Try again, or connect the one that receives the tokens here. Nothing was signed or sent.';
    return 'To receive the tokens on {0}, connect {2} here. Nothing was signed or sent.';
  }
  if (issue === 'UNIVERSAL_DESTINATION_WALLET_CHOICE_REQUIRED') return 'You have more than one wallet on {0}. Choose the one that receives the funds, or enter its public address. Nothing was signed or sent.';
  if (issue === 'UNIVERSAL_DESTINATION_WALLETS_LOADING') return 'FloFi is still reading your wallets for {0}. Wait a moment, or enter the destination\'s public address. Nothing was signed or sent.';
  if (issue === 'UNIVERSAL_DESTINATION_WALLETS_UNAVAILABLE') return 'FloFi could not read which {1} wallets your account has for {0}. Use Try again or connect a wallet on the Bridge card, or enter the destination’s public address. Nothing was signed or sent.';
  return 'No {1} wallet can receive on {0} yet. Connect one on the Bridge card or enter its public address. Nothing was signed or sent.';
}
/** `{2}` of the /approve messages: the wallet to connect, with its article (a catalog key; PT "uma carteira Solana"). */
export const destinationWalletPhrase = (ecosystem: 'Solana' | 'EVM'): string => ecosystem === 'Solana' ? 'a Solana wallet' : 'an EVM wallet';

/**
 * BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001 (security, wallet-execution, workflow and bridge reviews): /approve prepares a handed-off
 * proposal's simulation by itself — except a universal bridge whose receiving wallet was missing for this proposal (`held`, the workflow it was
 * missing for: a choice or typed address on the Canvas is a new revision of the same proposal). Once that wallet resolves (a connected wallet,
 * Try again, a recovered read, a choice) its simulation may ask the source wallet to sign in, so the owner chooses Simulate. `blocked` is set by
 * the caller only for a proposal loaded for its proven wallet and a destination that is actually missing (not one still being read: that one
 * resolves by itself, as on arrival). Returns the key to remember and whether automatic preparation is held.
 */
export function destinationHoldsPreparation(input: { readonly kind: string; readonly blocked: boolean; readonly held: string | null; readonly key: string }):
  { readonly held: string | null; readonly holds: boolean } {
  const held = input.kind === 'universal' && input.blocked ? input.key : input.held;
  return { held, holds: input.kind === 'universal' && held === input.key };
}

/**
 * Review round 3: whether a Review's bound recipient may be called the owner's own wallet. The connected owner is; a destination wallet is only
 * when it is connected in this session or on the FloFi account (`own`). An address resolved from the device's saved Credentials is not proof
 * of control, and a typed (EXPLICIT) address is never claimed.
 */
export function boundRecipientOwned(kind: string, recipient: string, own: readonly string[]): boolean {
  if (kind === 'CONNECTED_OWNER') return true;
  if (kind !== 'CONNECTED_DESTINATION_WALLET') return false;
  return own.some(address => address === recipient || (address.startsWith('0x') && address.toLowerCase() === recipient.toLowerCase()));
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
