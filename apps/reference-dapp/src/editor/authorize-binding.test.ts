// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { bindingOf, reviewedWallets, runMatchesBinding } from './authorize-binding.ts';

const HASH = '0x' + 'ab'.repeat(32), OWNER = '0x' + 'A1'.repeat(20);
const groups = [{ strategy: 'EVM_WALLET_BATCH', steps: [0, 2] as const }];

describe('P0: the Editor Authorize is bound to the Review', () => {
  it('accepts the canonical workflow hash a Review returns (0x + 64 hex) and normalizes the owner', () => {
    expect(bindingOf({ owner: OWNER, workflowHash: HASH, groups })).toEqual({ owner: OWNER.toLowerCase(), workflowHash: HASH, groups });
  });
  it('refuses a malformed binding (nothing is started for it)', () => {
    for (const bad of [null, {}, { owner: OWNER, workflowHash: HASH.slice(2), groups }, { owner: OWNER, workflowHash: HASH.toUpperCase(), groups },
      { owner: '0x12', workflowHash: HASH, groups }, { owner: OWNER, workflowHash: HASH, groups: [] },
      { owner: OWNER, workflowHash: HASH, groups: [{ strategy: 'EVM_WALLET_BATCH', steps: [0] }] },
      { owner: OWNER, workflowHash: HASH, groups: [{ strategy: 'EVM_WALLET_BATCH', steps: [-1, 2] }] }]) expect(bindingOf(bad)).toBeNull();
  });
  it('final review (P3): carries the first group\'s reviewed fee mechanism when given, and refuses any other value', () => {
    expect(bindingOf({ owner: OWNER, workflowHash: HASH, groups, firstGroupGas: 'CIRCLE_USDC_PAYMASTER' })).toEqual({ owner: OWNER.toLowerCase(), workflowHash: HASH, groups,
      firstGroupGas: 'CIRCLE_USDC_PAYMASTER' });
    expect(bindingOf({ owner: OWNER, workflowHash: HASH, groups, firstGroupGas: 'NATIVE_WALLET_GAS' })?.firstGroupGas).toBe('NATIVE_WALLET_GAS');
    for (const firstGroupGas of ['ZEROX_GASLESS_SWAP', null, 1]) expect(bindingOf({ owner: OWNER, workflowHash: HASH, groups, firstGroupGas })).toBeNull();
  });
  it('a run matches only with the same hash and the same groups in order', () => {
    const binding = bindingOf({ owner: OWNER, workflowHash: HASH, groups })!;
    expect(runMatchesBinding({ workflowHash: HASH, groups }, binding)).toBe(true);
    expect(runMatchesBinding({ workflowHash: '0x' + 'cd'.repeat(32), groups }, binding)).toBe(false);
    expect(runMatchesBinding({ workflowHash: HASH, groups: [{ strategy: 'EVM_OWNER_STEP', steps: [0, 2] }] }, binding)).toBe(false);
    expect(runMatchesBinding({ workflowHash: HASH, groups: [{ strategy: 'EVM_WALLET_BATCH', steps: [0, 1] }, { strategy: 'EVM_WALLET_BATCH', steps: [2, 2] }] }, binding)).toBe(false);
  });
});

// KAN-20 (surfaces 9.2 item 7): a reviewed Solana owner is bound exactly as given, and only that proven Solana wallet claims the run.
describe('KAN-20: the Editor Authorize bound to a Solana owner', () => {
  // A (seed-derived, on curve) and A' (a valid case variant of A: another wallet).
  const A = '2CERLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb', A2 = '2CErLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb', B = 'C4o8DvwfiPWCQPPH4AfDLBtG7vbCixVKYdwj1S4pDrty';
  const solanaGroups = [{ strategy: 'SOLANA_SIGN_ALL', steps: [0, 2] as const }];
  it('keeps a base58 owner verbatim with namespace solana; refuses characters base58 has not; the EVM binding is unchanged (no namespace)', () => {
    expect(bindingOf({ owner: A, workflowHash: HASH, groups: solanaGroups, firstGroupGas: 'NATIVE_WALLET_GAS' })).toEqual({ owner: A, workflowHash: HASH,
      groups: solanaGroups, firstGroupGas: 'NATIVE_WALLET_GAS', namespace: 'solana' });
    expect(bindingOf({ owner: A2, workflowHash: HASH, groups: solanaGroups })?.owner).toBe(A2);
    for (const bad of [A.replace('L', 'l'), A.replace('k', '0'), A.replace('C', 'O'), A.replace('G', 'I'), A.slice(0, 31), A + 'x'.repeat(12), ` ${A}`, `${A} `])
      expect(bindingOf({ owner: bad, workflowHash: HASH, groups: solanaGroups }), bad).toBeNull();
    expect(bindingOf({ owner: OWNER, workflowHash: HASH, groups })).not.toHaveProperty('namespace');
  });
  it('claims with exactly the reviewed Solana wallet (a case variant is another wallet); EVM selection exactly as before', () => {
    const solana = bindingOf({ owner: A, workflowHash: HASH, groups: solanaGroups })!;
    const proven = [{ namespace: 'eip155' as const, address: OWNER.toLowerCase() }, { namespace: 'solana' as const, address: A2 }, { namespace: 'solana' as const, address: A }];
    expect(reviewedWallets(proven, solana)).toEqual({ ok: true, wallets: [{ namespace: 'solana', address: A }] });
    expect(reviewedWallets(proven.slice(0, 2), solana)).toEqual({ ok: false, code: 'SOLANA_WALLET_PROOF_REQUIRED' });
    expect(reviewedWallets([{ namespace: 'solana', address: B }], solana)).toEqual({ ok: false, code: 'SOLANA_WALLET_PROOF_REQUIRED' });
    const evm = bindingOf({ owner: OWNER, workflowHash: HASH, groups })!;
    expect(reviewedWallets(proven, evm)).toEqual({ ok: true, wallets: proven });
    expect(reviewedWallets([{ namespace: 'eip155', address: '0x' + '9'.repeat(40) }, { namespace: 'solana', address: A }], evm)).toEqual({ ok: false, code: 'EVM_WALLET_PROOF_REQUIRED' });
  });
});
