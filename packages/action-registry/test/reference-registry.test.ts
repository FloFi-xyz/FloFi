// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { baseAssetRegistry, referenceRegistry, validateActionRegistry, checkActionCompatibility } from '../src/index.js';

describe('BUILD-003A declaration', () => {
  it('validates exact names and keeps all nested context immutable', () => {
    expect(validateActionRegistry(structuredClone(referenceRegistry))).toBe(true);
    expect(referenceRegistry.registryId).toBe('reference.registry');
    expect(referenceRegistry.actions[0]?.id).toBe('asset.swap.exact-input');
    expect(referenceRegistry.capabilities[0]?.id).toBe('swap.direct-transaction');
    expect(Object.isFrozen(referenceRegistry.actions[0]?.inputs)).toBe(true);
    expect(Object.isFrozen(baseAssetRegistry.USDC.asset)).toBe(true);
    expect(Object.isFrozen(baseAssetRegistry.WETH.asset)).toBe(true);
    expect(baseAssetRegistry.USDC.maximumAmountUnits).toBe((2n ** 256n - 1n).toString());
    expect(baseAssetRegistry.WETH.maximumAmountUnits).toBe((2n ** 256n - 1n).toString());
  });
  it('declaration compatibility never grants execution', () => {
    const result = checkActionCompatibility(structuredClone(referenceRegistry) as never, {
      actionId: 'asset.swap.exact-input', actionVersion: '1.0.0', capabilityId: 'swap.direct-transaction', capabilityVersion: '1.0.0', executionKind: 'DIRECT_TRANSACTION', authorizationMode: 'A',
    });
    expect(result.compatible).toBe(true);
    expect(result.executable).toBe(false);
    expect(result.enforcement).toBe('NOT_ENFORCED');
  });
});
