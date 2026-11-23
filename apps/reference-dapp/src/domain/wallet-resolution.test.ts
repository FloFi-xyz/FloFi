// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001: the bridge recipient every surface reads (`destinationRequirement`), across the matrix of the five
 * public mainnets and every wallet source FloFi knows (a wallet connected in this page, a Privy embedded wallet, a wallet linked to the FloFi
 * account, an address saved in Credentials, a typed address), plus the refusal wording that replaced "Connect the wallet that will sign".
 *
 * Evidence level: MOCKED unit tests over the product's own resolution and authoring code. No wallet is connected, nothing is signed, quoted or sent;
 * none of this proves a public execution with real funds.
 */
import { describe, expect, it } from 'vitest';
import { UNIVERSAL_DIRECTED_PAIRS, UNIVERSAL_NETWORK_KEYS, UNIVERSAL_NETWORKS, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';
import { DESTINATION_ISSUE, destinationEcosystemOf, destinationIssue, destinationIssueMessage, destinationRequirement, resolveDestinationWallet,
  type DestinationCandidate, type DestinationEcosystem, type DestinationInventory } from './destination-wallet';
import { createUniversalBridgeFromInput, universalBridgeFields, universalCanvasInput } from './universal-bridge-authoring';
import { destinationWalletMessage, simulationError } from './simulation-presentation';
import { simulationUnavailableReason } from './simulation-unavailable';
import { translate } from '../i18n/locale';
import { UNIVERSAL_NOT_EXECUTABLE } from '../server/universal-router/service';
import { UNIVERSAL_ROUTER_DEPLOYMENT } from '@defi-workflow-engine/action-registry';

const EVM_A = '0x90f5aa2a1b2c3d4e5f60718293a4b5c6d7e8d303', EVM_B = '0x1111111111111111111111111111111111111111';
const SOL_A = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2', SOL_B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const candidate = (ecosystem: DestinationEcosystem, address: string, providerName: string, source: DestinationCandidate['source']): DestinationCandidate =>
  ({ ecosystem, address, providerName, source });
const empty: DestinationInventory = { session: [], account: [], saved: [] };
const ecosystemOf = (key: UniversalNetworkKey) => UNIVERSAL_NETWORKS[key].ecosystem;

/**
 * The route classes the runtime itself declares (no live quote): Relay is executable where the universal router pins its Relay deployment (the
 * EVM depository per chain, the Solana program) on both sides; LI.FI and Mayan are discovered and compared only (Mayan has no Robinhood Chain);
 * Across serves EVM only and, in the universal router, is comparison only (it executes through the certified Router bridge for that bridge's
 * own pairs). A pair is EXECUTABLE when one of its providers is; a live quote may still find no liquidity for it.
 */
const relayPinned = (key: UniversalNetworkKey) => key === 'solana' ? Boolean(UNIVERSAL_ROUTER_DEPLOYMENT.solana.relayProgram)
  : Boolean(UNIVERSAL_ROUTER_DEPLOYMENT.evm[UNIVERSAL_NETWORKS[key].chain]?.relayDepository);
type RouteClass = 'EXECUTABLE' | 'QUOTE_ONLY' | 'UNSUPPORTED';
function providerClass(provider: 'relay' | 'lifi' | 'mayan' | 'across', source: UniversalNetworkKey, destination: UniversalNetworkKey): RouteClass {
  const s = UNIVERSAL_NETWORKS[source].providers, d = UNIVERSAL_NETWORKS[destination].providers;
  if (provider === 'relay') return relayPinned(source) && relayPinned(destination) ? 'EXECUTABLE' : 'UNSUPPORTED';
  if (provider === 'mayan') return s.mayan && d.mayan ? 'QUOTE_ONLY' : 'UNSUPPORTED';
  if (provider === 'across') return s.across !== null && d.across !== null ? 'QUOTE_ONLY' : 'UNSUPPORTED';
  return 'QUOTE_ONLY';
}
const ROUTE_MATRIX = UNIVERSAL_DIRECTED_PAIRS.map(({ source, destination }) => ({ source, destination,
  providers: Object.fromEntries((['relay', 'lifi', 'mayan', 'across'] as const).map(p => [p, providerClass(p, source, destination)])) as Record<string, RouteClass> }));

describe('BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001 route matrix of the public mainnets', () => {
  it('covers exactly Ethereum, Base, Arbitrum One, Solana and Robinhood Chain (20 directed pairs; BNB Chain is not in the public runtime)', () => {
    expect([...UNIVERSAL_NETWORK_KEYS].sort()).toEqual(['arbitrum-one', 'base', 'ethereum', 'robinhood', 'solana']);
    expect(UNIVERSAL_DIRECTED_PAIRS).toHaveLength(20);
    expect(Object.values(UNIVERSAL_NETWORKS).some(n => /bnb|bsc|binance/i.test(n.name + n.chain))).toBe(false);
  });
  it('classifies every provider of every pair as the runtime declares it, and quote-only providers keep their non-wallet reasons', () => {
    expect(UNIVERSAL_NOT_EXECUTABLE).toEqual({ lifi: 'LIFI_BRIDGE_VERIFIER_NOT_IMPLEMENTED', mayan: 'MAYAN_TRANSACTION_BUILDER_NOT_VERIFIED', across: 'ACROSS_EXECUTES_ON_CERTIFIED_ROUTER' });
    for (const row of ROUTE_MATRIX) {
      expect(row.providers.relay).toBe('EXECUTABLE');
      expect(row.providers.lifi).toBe('QUOTE_ONLY');
      expect(row.providers.mayan).toBe(row.source === 'robinhood' || row.destination === 'robinhood' ? 'UNSUPPORTED' : 'QUOTE_ONLY');
      expect(row.providers.across).toBe(row.source === 'solana' || row.destination === 'solana' ? 'UNSUPPORTED' : 'QUOTE_ONLY');
    }
    // A route limitation is never worded as a wallet problem.
    for (const code of [...Object.values(UNIVERSAL_NOT_EXECUTABLE), 'UNIVERSAL_NO_EXECUTABLE_ROUTE', 'RELAY_NO_ROUTE', 'UNIVERSAL_DESTINATION_NETWORK_UNSUPPORTED']) {
      expect(simulationError(code)).not.toMatch(/wallet/i);
    }
  });
  it('authors the implicit recipient by ecosystem: the signing wallet within one ecosystem, the destination wallet across ecosystems', () => {
    for (const { source, destination } of UNIVERSAL_DIRECTED_PAIRS) {
      const fields = universalBridgeFields(universalCanvasInput({ source, destination }, '1'));
      expect(fields.recipient).toBe(ecosystemOf(source) === ecosystemOf(destination) ? 'CONNECTED_OWNER' : 'CONNECTED_DESTINATION_WALLET');
      expect(() => createUniversalBridgeFromInput('bridge', universalCanvasInput({ source, destination }, '1'))).not.toThrow();
    }
  });
});

/** Every wallet source, per destination ecosystem, and what each must resolve to. */
const SCENARIOS: readonly { readonly name: string; readonly inventory: (eco: DestinationEcosystem) => DestinationInventory; readonly expected: 'RESOLVED' | 'CHOOSE' | 'LOADING' | 'NONE';
  readonly source?: DestinationCandidate['source'] }[] = [
  { name: 'external wallet connected in this page (MetaMask / Phantom / Solflare)', expected: 'RESOLVED', source: 'SESSION',
    inventory: eco => ({ ...empty, session: [candidate(eco, eco === 'evm' ? EVM_A : SOL_A, eco === 'evm' ? 'MetaMask' : 'Phantom', 'SESSION')] }) },
  { name: 'Privy embedded wallet of the FloFi account (Google or email sign-in)', expected: 'RESOLVED', source: 'ACCOUNT',
    inventory: eco => ({ ...empty, account: [candidate(eco, eco === 'evm' ? EVM_A : SOL_A, 'FloFi Wallet', 'ACCOUNT')] }) },
  { name: 'external wallet linked to the FloFi account (not connected now)', expected: 'RESOLVED', source: 'ACCOUNT',
    inventory: eco => ({ ...empty, account: [candidate(eco, eco === 'evm' ? EVM_A : SOL_A, eco === 'evm' ? 'Rabby' : 'Solflare', 'ACCOUNT')] }) },
  { name: 'the same Privy wallet reported by Privy and by the account (deduplicated)', expected: 'RESOLVED', source: 'ACCOUNT',
    inventory: eco => ({ ...empty, account: [candidate(eco, eco === 'evm' ? EVM_A : SOL_A, 'FloFi Wallet', 'ACCOUNT'), candidate(eco, eco === 'evm' ? EVM_A.toUpperCase().replace('0X', '0x') : SOL_A, 'FloFi Wallet', 'ACCOUNT')] }) },
  { name: 'address saved in Credentials only', expected: 'RESOLVED', source: 'SAVED',
    inventory: eco => ({ ...empty, saved: [candidate(eco, eco === 'evm' ? EVM_A : SOL_A, 'Saved', 'SAVED')] }) },
  { name: 'session restored after reload: the account wallets are still being read', expected: 'LOADING',
    inventory: eco => ({ ...empty, saved: [candidate(eco, eco === 'evm' ? EVM_A : SOL_A, 'Saved', 'SAVED')], loading: true }) },
  { name: 'a connected wallet answers at once even while the account is read', expected: 'RESOLVED', source: 'SESSION',
    inventory: eco => ({ ...empty, session: [candidate(eco, eco === 'evm' ? EVM_A : SOL_A, 'Phantom', 'SESSION')], loading: true }) },
  { name: 'several account wallets (Privy embedded + linked): the owner chooses, never a silent pick', expected: 'CHOOSE',
    inventory: eco => ({ ...empty, account: [candidate(eco, eco === 'evm' ? EVM_A : SOL_A, 'FloFi Wallet', 'ACCOUNT'), candidate(eco, eco === 'evm' ? EVM_B : SOL_B, 'Linked', 'ACCOUNT')] }) },
  { name: 'the account read failed: a saved address is offered to choose, never filled ahead of the account (security review)', expected: 'CHOOSE',
    inventory: eco => ({ ...empty, saved: [candidate(eco, eco === 'evm' ? EVM_A : SOL_A, 'Saved', 'SAVED')], accountUnavailable: true }) },
  { name: 'the account read failed but a wallet is connected: the session wallet still answers', expected: 'RESOLVED', source: 'SESSION',
    inventory: eco => ({ ...empty, session: [candidate(eco, eco === 'evm' ? EVM_A : SOL_A, 'Phantom', 'SESSION')], accountUnavailable: true }) },
  { name: 'no wallet of that ecosystem anywhere', expected: 'NONE', inventory: () => empty },
  { name: 'only wallets of the OTHER ecosystem (an EVM address never fills a Solana destination, nor the reverse)', expected: 'NONE',
    inventory: eco => ({ session: [candidate(eco === 'evm' ? 'solana' : 'evm', eco === 'evm' ? SOL_A : EVM_A, 'Other', 'SESSION')], account: [], saved: [] }) },
  { name: 'a mislabelled saved entry (EVM address labelled Solana) is never used', expected: 'NONE',
    inventory: eco => ({ ...empty, saved: [candidate(eco, eco === 'evm' ? SOL_A : EVM_A, 'Mislabelled', 'SAVED')] }) },
];

describe('BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001 wallet matrix × every directed pair', () => {
  for (const scenario of SCENARIOS) it(scenario.name, () => {
    for (const { source, destination } of UNIVERSAL_DIRECTED_PAIRS) {
      const eco = destinationEcosystemOf(destination), cross = ecosystemOf(source) !== ecosystemOf(destination);
      const resolution = resolveDestinationWallet(eco, scenario.inventory(eco));
      expect(resolution.kind).toBe(scenario.expected);
      if (resolution.kind === 'RESOLVED') expect(resolution.wallet.source).toBe(scenario.source);
      const recipient = universalBridgeFields(universalCanvasInput({ source, destination }, '1')).recipient;
      const requirement = destinationRequirement(recipient, resolution);
      if (!cross) {
        // EVM → EVM: the signing wallet receives; no second connection, no warning, whatever else is (or is not) known.
        expect(requirement).toEqual({ kind: 'OWNER' });
        expect(destinationIssue(requirement)).toBeNull();
        continue;
      }
      // BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001: a choice offered only because the account read failed is that failure (UNAVAILABLE).
      const expectedIssue = resolution.kind === 'CHOOSE' && resolution.unconfirmed ? DESTINATION_ISSUE.UNAVAILABLE
        : { RESOLVED: null, CHOOSE: DESTINATION_ISSUE.CHOOSE, LOADING: DESTINATION_ISSUE.LOADING, NONE: DESTINATION_ISSUE.REQUIRED }[scenario.expected];
      expect(destinationIssue(requirement)).toBe(expectedIssue);
      // An explicit recipient is the owner's own choice: it is never replaced by a resolved wallet, and never blocked here (the server checks it).
      const explicit = destinationRequirement(eco === 'evm' ? EVM_B : SOL_B, resolution);
      expect(explicit).toEqual({ kind: 'EXPLICIT', address: eco === 'evm' ? EVM_B : SOL_B });
      expect(destinationIssue(explicit)).toBeNull();
    }
  });
  it('a resolution follows the wallets in front of it: switching wallets before Review changes the resolved address (Review binds what it shows)', () => {
    const before = resolveDestinationWallet('solana', { ...empty, session: [candidate('solana', SOL_A, 'Phantom', 'SESSION')] });
    const after = resolveDestinationWallet('solana', { ...empty, session: [candidate('solana', SOL_B, 'Solflare', 'SESSION')] });
    expect(before.kind === 'RESOLVED' && before.wallet.address).toBe(SOL_A);
    expect(after.kind === 'RESOLVED' && after.wallet.address).toBe(SOL_B);
    // Disconnecting the only wallet leaves nothing to fill: Simulate is blocked again, never sent without a destination.
    expect(destinationIssue(destinationRequirement('CONNECTED_DESTINATION_WALLET', resolveDestinationWallet('solana', empty)))).toBe(DESTINATION_ISSUE.REQUIRED);
  });
});

describe('BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001 refusal wording (incident regression)', () => {
  const signer = 'Connect the wallet that will sign this workflow, then simulate again.';
  it('UNIVERSAL_DESTINATION_WALLET_REQUIRED asks for the RECEIVING wallet, never the signing one', () => {
    const message = simulationError('UNIVERSAL_DESTINATION_WALLET_REQUIRED');
    expect(message).not.toBe(signer);
    expect(message).toMatch(/receives the funds on the destination network/);
    expect(message).toMatch(/source wallet does not need to change/);
    expect(simulationError('UNIVERSAL_DESTINATION_WALLET_REQUIRED', 'universal')).toBe(message);
    // The chat's "can't start the review" reason reads the same refusal.
    expect(simulationUnavailableReason({ incomplete: false, unsupported: false, walletRequired: false, providerUnavailable: false, staleQuote: false,
      error: 'UNIVERSAL_DESTINATION_WALLET_REQUIRED' })).toBe(message);
  });
  it('a pending choice, a loading inventory and an invalid destination each have their own sentence', () => {
    const codes = ['UNIVERSAL_DESTINATION_WALLET_REQUIRED', 'UNIVERSAL_DESTINATION_WALLET_CHOICE_REQUIRED', 'UNIVERSAL_DESTINATION_WALLETS_LOADING', 'UNIVERSAL_DESTINATION_WALLET_INVALID'];
    const messages = codes.map(code => simulationError(code));
    expect(new Set(messages).size).toBe(codes.length);
    for (const [i, code] of codes.entries()) { expect(messages[i]).toBe(destinationWalletMessage(code)); expect(messages[i]).not.toBe(signer); }
  });
  it('a missing SOURCE wallet still asks to connect the signing wallet', () => {
    for (const code of ['UNIVERSAL_WALLET_REQUIRED', 'UNIVERSAL_SOLANA_WALLET_REQUIRED', 'ROUTER_WALLET_REQUIRED', 'TRANSFER_WALLET_REQUIRED']) expect(simulationError(code)).toBe(signer);
  });
  it('a wallet on another network is asked to switch networks; an expired wallet session to sign in again', () => {
    expect(simulationError('UNIVERSAL_WRONG_CHAIN')).toMatch(/Switch your wallet to the source network/);
    expect(simulationError('UNIVERSAL_WRONG_OWNER')).toBe('Reconnect the wallet used for this workflow and simulate again.');
    expect(simulationError('WALLET_SESSION_REQUIRED')).toMatch(/sign-in expired/);
    // Wallet-execution review: an expired wallet session is not "this result has expired"; an account session is not a wallet sign-in.
    expect(simulationError('WALLET_SESSION_EXPIRED')).toMatch(/sign-in expired/);
    expect(simulationError('SIWE_SESSION_EXPIRED')).toMatch(/sign-in expired/);
    expect(simulationError('ACCOUNT_SESSION_EXPIRED')).not.toMatch(/wallet sign-in/);
    expect(simulationError('UNIVERSAL_WRONG_CHAIN')).toMatch(/then try again/);
  });
  it('Across in the universal router names the certified Router bridge instead of "not yet executable"', () => {
    expect(simulationError('ACROSS_EXECUTES_ON_CERTIFIED_ROUTER')).toMatch(/certified Router bridge/);
    expect(simulationError('LIFI_BRIDGE_VERIFIER_NOT_IMPLEMENTED')).toMatch(/comparison only/);
  });
  it('names the destination network and is translated (EN/PT) for every blocking state', () => {
    for (const issue of Object.values(DESTINATION_ISSUE)) {
      const en = translate('EN', destinationIssueMessage(issue), 'Solana', 'Solana'), pt = translate('PT', destinationIssueMessage(issue), 'Solana', 'Solana');
      expect(en).toContain('Solana');
      expect(en).not.toMatch(/\{\d\}/);
      expect(pt).toContain('Solana');
      expect(pt).not.toBe(en);
      expect(en).not.toMatch(/will sign/);
    }
    for (const code of ['UNIVERSAL_DESTINATION_WALLET_REQUIRED', 'UNIVERSAL_DESTINATION_WALLET_CHOICE_REQUIRED', 'UNIVERSAL_DESTINATION_WALLETS_LOADING', 'UNIVERSAL_DESTINATION_WALLET_INVALID',
      'UNIVERSAL_WRONG_CHAIN', 'WALLET_SESSION_REQUIRED', 'LIFI_BRIDGE_VERIFIER_NOT_IMPLEMENTED']) {
      const message = simulationError(code);
      expect(translate('PT', message)).not.toBe(message);
    }
    expect(translate('EN', destinationIssueMessage(DESTINATION_ISSUE.REQUIRED), 'Base', 'EVM')).toBe('No EVM wallet can receive on Base yet. Connect one on the Bridge card or enter its public address. Nothing was signed or sent.');
    for (const field of ['Required: a wallet that can receive on {0} ({1} address). Connect one or enter its public address.', 'No wallet was connected. You can enter its public address instead.',
      'Choose which of your {1} wallets receives on {0}, or enter its public address.', 'Checking your wallets for {0}…', 'Connect a Solana wallet', 'Connect an EVM wallet']) {
      expect(translate('PT', field)).not.toBe(field);
    }
  });
});
