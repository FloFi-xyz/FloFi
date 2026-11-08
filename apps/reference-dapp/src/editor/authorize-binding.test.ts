// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { bindingOf, runMatchesBinding } from './authorize-binding.ts';

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
  it('a run matches only with the same hash and the same groups in order', () => {
    const binding = bindingOf({ owner: OWNER, workflowHash: HASH, groups })!;
    expect(runMatchesBinding({ workflowHash: HASH, groups }, binding)).toBe(true);
    expect(runMatchesBinding({ workflowHash: '0x' + 'cd'.repeat(32), groups }, binding)).toBe(false);
    expect(runMatchesBinding({ workflowHash: HASH, groups: [{ strategy: 'EVM_OWNER_STEP', steps: [0, 2] }] }, binding)).toBe(false);
    expect(runMatchesBinding({ workflowHash: HASH, groups: [{ strategy: 'EVM_WALLET_BATCH', steps: [0, 1] }, { strategy: 'EVM_WALLET_BATCH', steps: [2, 2] }] }, binding)).toBe(false);
  });
});
