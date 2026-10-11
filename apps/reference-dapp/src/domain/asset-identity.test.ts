// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: the generic network and token visual identity. Local brand marks only where FloFi can vouch for the exact asset (a
 * code-pinned asset by chain and address, or the existing marks on networks without an official catalog); every other asset is a
 * deterministic monogram generated from its canonical identity. Never a remote image.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BASE_BASE_ASSETS } from '@defi-workflow-engine/action-registry';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { assetIdentity, monogramText, networkMark } from './asset-identity';
import { NETWORKS, catalogNetworkOfChatName, catalogNetworksNamed, networkIdentity } from './network-registry';
import { baseAsset, baseCatalog } from '../server/base-mainnet.test-harness';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';

beforeAll(() => { registerNetworkCatalog(baseCatalog()); registerNetworkCatalog(officialCatalog()); });
afterAll(() => resetNetworkCatalogs());
const mark = (symbol: string, network?: string, address?: string) => assetIdentity({ symbol, network, address }).mark;

describe('BUILD-BASE-001 network and asset visual identity', () => {
  it('shows local marks only for the code-pinned assets of a catalog network', () => {
    const usdc = BASE_BASE_ASSETS.assets.find(a => a.symbol === 'USDC')!;
    expect(mark('USDC', 'Base')).toEqual({ kind: 'image', src: '/brand/crypto/usdc.png' });
    expect(mark('USDC', 'eip155:8453', usdc.address!)).toEqual({ kind: 'image', src: '/brand/crypto/usdc.png' });
    expect(mark('WETH', 'Base')).toEqual({ kind: 'image', src: '/brand/crypto/ethereum.svg' });
    expect(mark('ETH', 'Base')).toEqual({ kind: 'image', src: '/brand/crypto/ethereum.svg' });
    expect(mark('WETH', 'Robinhood Chain')).toEqual({ kind: 'image', src: '/brand/crypto/ethereum.svg' });
  });
  it('gives every listed or issuer token a deterministic monogram, even when its symbol matches a known brand', () => {
    const cbbtc = mark('cbBTC', 'Base');
    expect(cbbtc).toMatchObject({ kind: 'monogram', text: 'CB' });
    expect(mark('cbBTC', 'Base')).toEqual(cbbtc);
    expect(mark('cbBTC', 'Base', baseAsset(baseCatalog(), 'cbBTC').address!)).toEqual(cbbtc);
    // A token-list entry named USDT is not vouched for by symbol on a catalog network.
    expect(mark('USDT', 'Base')).toMatchObject({ kind: 'monogram', text: 'US' });
    expect(mark('TSLA', 'Robinhood Chain')).toMatchObject({ kind: 'monogram', text: 'TS' });
    expect(mark('USDG', 'Robinhood Chain')).toMatchObject({ kind: 'monogram', text: 'US' });
    // Same symbol, another identity: another hue.
    expect((mark('AERO', 'Base') as { hue: number }).hue).not.toBe((mark('AERO', 'Robinhood Chain') as { hue: number }).hue);
  });
  it('keeps the existing marks on networks without an official catalog, and a neutral monogram otherwise', () => {
    expect(mark('USDC', 'Base Sepolia')).toEqual({ kind: 'image', src: '/brand/crypto/usdc.png' });
    expect(mark('SOL', 'Solana')).toEqual({ kind: 'image', src: '/brand/crypto/solana.svg' });
    expect(mark('devUSDC')).toEqual({ kind: 'image', src: '/brand/crypto/usdc.png' });
    expect(mark('XYZ')).toMatchObject({ kind: 'monogram', text: 'XY' });
  });
  it('resolves network marks by chain, name or alias and never points at a remote image', () => {
    for (const value of ['Base', 'eip155:8453', 'Base (8453)', 'base']) expect(networkMark(value)).toEqual({ kind: 'image', src: '/brand/crypto/base.svg' });
    expect(networkMark('Arbitrum')).toEqual(networkMark('Arbitrum One'));
    expect(networkMark('Polygon')).toMatchObject({ kind: 'monogram', text: 'PO' });
    for (const network of NETWORKS) expect(network.mark === null || network.mark.startsWith('/brand/')).toBe(true);
    for (const symbol of ['USDC', 'WETH', 'cbBTC', 'TSLA', 'SOL']) for (const network of ['Base', 'Robinhood Chain', 'Solana', undefined]) {
      const value = mark(symbol, network);
      if (value.kind === 'image') expect(value.src).toMatch(/^\/brand\//);
    }
    expect(monogramText('cbBTC')).toBe('CB'); expect(monogramText('1INCH')).toBe('1I'); expect(monogramText('—')).toBe('?');
  });
  it('names catalog networks from text or an untrusted intent, for loading their catalogs only', () => {
    expect(catalogNetworksNamed('swap 1 USDC to cbBTC on Base').map(n => n.key)).toEqual(['base']);
    expect(catalogNetworksNamed('swap on Base Sepolia').map(n => n.key)).toEqual([]);
    expect(catalogNetworksNamed('database of robinhoods').map(n => n.key)).toEqual([]);
    expect(catalogNetworksNamed('anything', { action: { network: 'ROBINHOOD' } }).map(n => n.key)).toEqual(['robinhood']);
    expect(catalogNetworkOfChatName('Robinhood Chain')?.key).toBe('robinhood');
    expect(catalogNetworkOfChatName('Robinhood Testnet')).toBeNull();
    expect(networkIdentity('eip155:4663')?.environment).toBe('MAINNET');
  });
});
