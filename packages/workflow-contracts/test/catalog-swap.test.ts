// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical.js';
import { CATALOG_SWAP_CHAINS, CATALOG_SWAP_REFERENCE_PAIRS, catalogSwapMaximumUnits, createCatalogSwapNode, isCatalogSwapNode, isReferencePairSwap,
  readCatalogSwapNode, type CatalogAssetRef } from '../src/index.js';

const BASE = 'eip155:8453';
const usdc: CatalogAssetRef = { chain: BASE, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, officialId: null };
const weth: CatalogAssetRef = { chain: BASE, address: '0x4200000000000000000000000000000000000006', decimals: 18, officialId: null };
const cbbtc: CatalogAssetRef = { chain: BASE, address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', decimals: 8, officialId: null };
const swap = (input: CatalogAssetRef, output: CatalogAssetRef, amount = '100000000') => createCatalogSwapNode('node-002', { chain: BASE, input, output, amount, slippageBps: 50 });

describe('BUILD-BASE-001 catalog swaps on Base', () => {
  it('declares Base a catalog-swap network next to Robinhood Chain', () => {
    expect(CATALOG_SWAP_CHAINS).toEqual(['eip155:4663', 'eip155:8453', 'eip155:42161']);
    expect(CATALOG_SWAP_REFERENCE_PAIRS[BASE]).toEqual([usdc.address, weth.address]);
    expect(CATALOG_SWAP_REFERENCE_PAIRS['eip155:4663']).toBeUndefined();
  });
  it('authors any other Base catalog pair (USDC → cbBTC) on the canonical swap ports, bound by chain + address + decimals', () => {
    const node = swap(usdc, cbbtc);
    expect(isCatalogSwapNode(node)).toBe(true);
    expect(isReferencePairSwap(node)).toBe(false);
    expect(node).toMatchObject({ actionType: 'asset.swap.exact-input', chainId: BASE, requiredCapabilities: ['swap.direct-transaction'],
      adapterConstraints: { adapters: [], protocols: ['uniswap'] }, requiredAuthorizationClass: 'MODE_A', failurePolicy: 'ABORT' });
    expect(node.inputs.map(input => input.name)).toEqual(['amount-in', 'asset-out']);
    expect(readCatalogSwapNode(node)).toEqual({ chain: BASE, input: usdc, output: cbbtc, amount: '100000000', slippageBps: 50 });
    // Base USDC keeps its reference bound (1,000,000 USDC) in every pair; a listed asset uses the catalog bound (10^9 whole units).
    expect(node.editableBounds[0]!.maximumAmount).toBe('1000000000000');
    expect(swap(cbbtc, usdc, '100000').editableBounds[0]!.maximumAmount).toBe(catalogSwapMaximumUnits(8));
    expect(catalogSwapMaximumUnits(18, BASE, weth.address)).toBe('1000000000000000000000');
    expect(catalogSwapMaximumUnits(6)).toBe('1000000000000000');
    expect(() => swap(usdc, cbbtc, '1000000000001')).toThrow('CATALOG_SWAP_AMOUNT_INVALID');
  });
  it('keeps Base USDC ⇄ WETH the BUILD-002 reference swap: never a catalog swap, in either direction', () => {
    expect(() => swap(usdc, weth)).toThrow('CATALOG_SWAP_REFERENCE_PAIR');
    expect(() => swap(weth, usdc, '1000000000000000')).toThrow('CATALOG_SWAP_REFERENCE_PAIR');
    // The BUILD-002 declaration of the same intent is recognized as the reference pair and left to the reference registry.
    const reference = { ...swap(usdc, cbbtc), inputs: [{ name: 'amount-in', kind: 'QUANTITY' as const, value: { asset: { chainId: BASE, address: usdc.address, decimals: 6 }, amount: '1' } },
      { name: 'asset-out', kind: 'ASSET' as const, value: { chainId: BASE, address: weth.address, decimals: 18 } }] };
    expect(isReferencePairSwap(reference)).toBe(true);
    expect(isCatalogSwapNode(reference)).toBe(false);
    expect(() => readCatalogSwapNode(reference)).toThrow('CATALOG_SWAP_NODE_INVALID');
  });
  it('is a closed declaration: tampering with the bound, chain or ports fails closed', () => {
    const node = swap(usdc, cbbtc);
    expect(() => readCatalogSwapNode({ ...node, editableBounds: [{ ...node.editableBounds[0]!, maximumAmount: '1000000000000000' }] })).toThrow('CATALOG_SWAP_DECLARATION_INVALID');
    expect(() => createCatalogSwapNode('node-002', { chain: 'eip155:1', input: usdc, output: cbbtc, amount: '1', slippageBps: 50 })).toThrow('CATALOG_SWAP_NETWORK_UNSUPPORTED');
    expect(() => createCatalogSwapNode('node-002', { chain: 'eip155:42161', input: usdc, output: cbbtc, amount: '1', slippageBps: 50 })).toThrow('CATALOG_SWAP_ASSET_INVALID');
    expect(() => swap(usdc, { ...cbbtc, chain: 'eip155:4663' })).toThrow('CATALOG_SWAP_ASSET_INVALID');
    expect(canonicalJson(swap(usdc, cbbtc))).toBe(canonicalJson(node));
  });
});
