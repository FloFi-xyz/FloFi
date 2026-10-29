// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/canonical.js';
import { CATALOG_SWAP_CHAINS, CATALOG_SWAP_REFERENCE_PAIRS, CATALOG_SWAP_WETH9, catalogSwapKind, catalogSwapMaximumUnits, createCatalogSwapNode, isCatalogSwapNode, isReferencePairSwap,
  readCatalogSwapNode, type CatalogAssetRef } from '../src/index.js';

const BASE = 'eip155:8453';
const usdc: CatalogAssetRef = { chain: BASE, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, officialId: null };
const weth: CatalogAssetRef = { chain: BASE, address: '0x4200000000000000000000000000000000000006', decimals: 18, officialId: null };
const cbbtc: CatalogAssetRef = { chain: BASE, address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', decimals: 8, officialId: null };
const swap = (input: CatalogAssetRef, output: CatalogAssetRef, amount = '100000000') => createCatalogSwapNode('node-002', { chain: BASE, input, output, amount, slippageBps: 50 });

describe('BUILD-BASE-001 catalog swaps on Base', () => {
  it('declares Base a catalog-swap network next to Robinhood Chain', () => {
    expect(CATALOG_SWAP_CHAINS).toEqual(['eip155:4663', 'eip155:8453', 'eip155:42161', 'eip155:1']);
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
    expect(() => createCatalogSwapNode('node-002', { chain: 'eip155:137', input: usdc, output: cbbtc, amount: '1', slippageBps: 50 })).toThrow('CATALOG_SWAP_NETWORK_UNSUPPORTED');
    expect(() => createCatalogSwapNode('node-002', { chain: 'eip155:42161', input: usdc, output: cbbtc, amount: '1', slippageBps: 50 })).toThrow('CATALOG_SWAP_ASSET_INVALID');
    expect(() => swap(usdc, { ...cbbtc, chain: 'eip155:4663' })).toThrow('CATALOG_SWAP_ASSET_INVALID');
    expect(canonicalJson(swap(usdc, cbbtc))).toBe(canonicalJson(node));
  });
});

describe('BUILD-FLOFI-BRIDGE-LIVE-FIX-003 native ETH and WETH9 conversions', () => {
  const eth: CatalogAssetRef = { chain: BASE, address: null, decimals: 18, officialId: null };
  const create = (input: CatalogAssetRef, output: CatalogAssetRef, amount: string, slippageBps: number) => createCatalogSwapNode('node-002', { chain: BASE, input, output, amount, slippageBps });
  it('native ETH is its own IR asset (nativeId, no address), never WETH, and round-trips exactly', () => {
    const node = create(eth, usdc, '1000000000000000', 100);
    expect(node.inputs[0]).toEqual({ name: 'amount-in', kind: 'QUANTITY', value: { asset: { chainId: BASE, nativeId: 'ETH', decimals: 18 }, amount: '1000000000000000' } });
    expect(node.adapterConstraints.protocols).toEqual(['uniswap']);
    expect(isCatalogSwapNode(node)).toBe(true); expect(isReferencePairSwap(node)).toBe(false);
    expect(readCatalogSwapNode(node)).toEqual({ chain: BASE, input: eth, output: usdc, amount: '1000000000000000', slippageBps: 100 });
    const out = create(usdc, eth, '5000000', 100);
    expect(out.inputs[1]).toEqual({ name: 'asset-out', kind: 'ASSET', value: { chainId: BASE, nativeId: 'ETH', decimals: 18 } });
    expect(readCatalogSwapNode(out).output).toEqual(eth);
    expect(canonicalJson(create(eth, usdc, '1', 100))).not.toBe(canonicalJson(create(weth, cbbtc, '1', 100)));
  });
  it('ETH ⇄ WETH9 is a 1:1 WETH9 conversion: protocol weth9, no slippage constraint, minimum = amount', () => {
    const wrap = create(eth, weth, '10000000000000000', 0), unwrap = create(weth, eth, '10000000000000000', 0);
    expect(catalogSwapKind(readCatalogSwapNode(wrap))).toBe('WRAP'); expect(catalogSwapKind(readCatalogSwapNode(unwrap))).toBe('UNWRAP');
    expect(wrap.adapterConstraints.protocols).toEqual(['weth9']);
    expect(wrap.userConstraints.map(c => c.kind)).toEqual(['MAXIMUM_INPUT']);
    expect(wrap.expectedOutputs[0]!.minimumAmount).toBe('10000000000000000');
    expect(() => create(eth, weth, '1', 50)).toThrow('CATALOG_SWAP_SLIPPAGE_INVALID');
    expect(catalogSwapKind(readCatalogSwapNode(create(eth, usdc, '1', 50)))).toBe('SWAP');
  });
  it('refuses a malformed native side, native on both sides, or a forged conversion declaration', () => {
    expect(() => create({ ...eth, decimals: 6 }, usdc, '1', 50)).toThrow('CATALOG_SWAP_ASSET_INVALID');
    expect(() => create({ ...eth, officialId: '0x' + '1'.repeat(64) }, usdc, '1', 50)).toThrow('CATALOG_SWAP_ASSET_INVALID');
    expect(() => create(eth, eth, '1', 50)).toThrow('CATALOG_SWAP_PAIR_INVALID');
    const forged = { ...create(eth, usdc, '1', 50), adapterConstraints: { adapters: [], protocols: ['weth9'] } };
    expect(() => readCatalogSwapNode(forged)).toThrow();
    const otherNative = create(eth, usdc, '1', 50);
    const sol = { ...otherNative, inputs: otherNative.inputs.map(p => p.name === 'amount-in' ? { ...p, value: { asset: { chainId: BASE, nativeId: 'SOL', decimals: 18 }, amount: '1' } } : p) };
    expect(() => readCatalogSwapNode(sol as typeof otherNative)).toThrow('CATALOG_SWAP_NODE_INVALID');
  });
  it('every catalog network knows its WETH9 (the one its SwapRouter02 reports)', () => {
    expect(Object.keys(CATALOG_SWAP_WETH9).sort()).toEqual([...CATALOG_SWAP_CHAINS].sort());
  });
});
