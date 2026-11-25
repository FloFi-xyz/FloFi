// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { FLOFI_WALLET_BRIDGE_ISSUE, floFiWalletBridgeIssue } from './flofi-wallet-bridge';
import { translate } from '../i18n/translate';
import { SIGNING_FLOWS } from '../wallet/flofi-signing';

const base = { kind: 'router', signerIsFloFiWallet: true, groupedRun: false, executing: false, ecosystem: 'evm' } as const;

describe('FloFi Wallet and bridges (BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001, incident 9)', () => {
  it('names the limitation before Simulate for a Router or universal bridge FloFi Wallet would sign', () => {
    expect(floFiWalletBridgeIssue(base)).toBe(FLOFI_WALLET_BRIDGE_ISSUE.evm);
    expect(floFiWalletBridgeIssue({ ...base, kind: 'universal' })).toBe(FLOFI_WALLET_BRIDGE_ISSUE.evm);
    expect(floFiWalletBridgeIssue({ ...base, kind: 'universal', ecosystem: 'solana' })).toBe(FLOFI_WALLET_BRIDGE_ISSUE.solana);
  });
  it('names a later bridge of a step-by-step workflow before its first step (wallet-execution review)', () => {
    const later = [{ kind: 'public', chainId: 'eip155:8453' }, { kind: 'router', chainId: 'eip155:8453' }];
    expect(floFiWalletBridgeIssue({ ...base, kind: 'public', laterSteps: later })).toBe(FLOFI_WALLET_BRIDGE_ISSUE.laterEvm);
    expect(floFiWalletBridgeIssue({ ...base, kind: 'solana-swap', ecosystem: 'solana', laterSteps: [{ kind: 'universal', chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }] }))
      .toBe(FLOFI_WALLET_BRIDGE_ISSUE.laterSolana);
    // A bridge signed from the other ecosystem is not signed by this FloFi Wallet; unknown kinds and grouped runs stay silent.
    expect(floFiWalletBridgeIssue({ ...base, kind: 'public', laterSteps: [{ kind: 'universal', chainId: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }] })).toBeNull();
    expect(floFiWalletBridgeIssue({ ...base, kind: 'public', laterSteps: [{ kind: null, chainId: 'eip155:8453' }] })).toBeNull();
    expect(floFiWalletBridgeIssue({ ...base, kind: 'public', groupedRun: true, laterSteps: later })).toBeNull();
  });
  it('mirrors the server: bridges are not a flow FloFi Wallet can bind', () => {
    expect(Object.keys(SIGNING_FLOWS).filter(flow => /router|bridge|universal|across|relay/i.test(flow))).toEqual([]);
  });
  it.each([
    ['another wallet signs', { signerIsFloFiWallet: false }],
    ['a grouped workflow run (Circle-paid groups are signed by FloFi Wallet)', { groupedRun: true }],
    ['the bridge is already executing', { executing: true }],
    ['a swap FloFi Wallet signs', { kind: 'public' }],
    ['a Jupiter swap', { kind: 'solana-swap' }],
    ['a transfer', { kind: 'transfer' }],
  ] as const)('stays silent when %s', (_name, patch) => {
    expect(floFiWalletBridgeIssue({ ...base, ...patch })).toBeNull();
  });
  it('is said in Portuguese', () => {
    for (const message of Object.values(FLOFI_WALLET_BRIDGE_ISSUE)) {
      const pt = translate('PT', message);
      expect(pt).not.toBe(message);
      expect(pt).toContain('FloFi Wallet');
    }
  });
});
