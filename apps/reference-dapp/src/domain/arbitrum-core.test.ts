// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARBITRUM_ONE, discoverNetworkCapabilities, parseArbitrumTokenList, workflowAsset } from '@defi-workflow-engine/action-registry';
import { assetIdentity, networkMark } from './asset-identity';
import { OFFICIAL_CATALOG_CHAINS, officialCatalogLoaded, registerNetworkCatalog, resetNetworkCatalogs, resolveAssetReference, resolveNetworkAsset } from './asset-catalogs';
import { AUTHORING_CAPABILITIES, bridgeOffers, capabilityNetworks, catalogCapabilityNetworks } from './authoring-capabilities';
import { CATALOG_NETWORK_IDENTITIES, NETWORKS, catalogNetworkOfChatName, catalogNetworksNamed, networkIdentity } from './network-registry';
import { mentionedNetworks } from './copilot-authoring';
import { copilotSupportsSection } from '../server/copilot-capabilities';
import { prepareCatalogsForText, prepareNetworkCatalogs } from '../platform/catalogs';
import { composeStrategy, semanticWorkflowHash } from '../engine/strategy-engine';
import { supportedNetworks } from '../engine/capability-catalog';
import { cryptoProfiles } from './crypto-action-picker';
import { walletNetwork } from '../wallet/evm-networks';

const bytes = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8');
const catalog = () => parseArbitrumTokenList(bytes, '2026-10-11T21:36:16.041Z');
const chain = ARBITRUM_ONE.chain;
afterEach(resetNetworkCatalogs);

describe('BUILD-ARB-001 shared first-class recognition through shared runtime registration', () => {
  it('resolves one canonical network, its existing icon and wallet identity, including natural-language vocabulary', () => {
    const network = networkIdentity(chain)!;
    for (const value of ['arbitrum-one', 'Arbitrum', 'Arbitrum One', 'Arbitrum (42161)']) expect(networkIdentity(value)).toBe(network);
    expect(network).toMatchObject({ chain, name: ARBITRUM_ONE.name, environment: 'MAINNET', catalog: true, evm: ARBITRUM_ONE });
    expect(NETWORKS.filter(n => n.chain === chain)).toHaveLength(1);
    expect(new Set(NETWORKS.map(n => n.chain)).size).toBe(NETWORKS.length);
    expect(new Set(NETWORKS.map(n => n.key)).size).toBe(NETWORKS.length);
    expect(walletNetwork(ARBITRUM_ONE.chainHex)).toMatchObject({ chain, environment: 'mainnet', switchable: true, add: null });
    expect(networkMark(chain)).toEqual({ kind: 'image', src: '/brand/crypto/arbitrum.png' });
    expect(mentionedNetworks('Please bridge from Arbitrum One to Base')).toEqual(['BASE', 'ARBITRUM']);
    expect(mentionedNetworks('Arbitrum Sepolia')).toEqual(['ARBITRUM_SEPOLIA']);
    expect(catalogNetworkOfChatName('Arbitrum')).toBe(network);
    expect(catalogNetworkOfChatName('Arbitrum One')).toBe(network);
    expect(catalogNetworksNamed('Arbitrum Sepolia')).toEqual([]);
    expect(CATALOG_NETWORK_IDENTITIES.filter(n => n.chain === chain)).toEqual([network]);
    expect(OFFICIAL_CATALOG_CHAINS).toContain(chain);
  });
  it('uses the shared catalog loader seams, names and chain-bound resolver; unloaded listed assets fail closed', async () => {
    expect(officialCatalogLoaded(chain)).toBe(false);
    expect(resolveAssetReference(chain, 'Wrapped BTC')).toEqual({ kind: 'UNAVAILABLE' });
    expect(resolveNetworkAsset(chain, { symbol: 'ETH' })?.id).toBe(`${chain}/slip44:60`);
    const load = vi.fn(async () => catalog());
    await prepareNetworkCatalogs({ version: 2, steps: [{ action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'base' }] }, { 'arbitrum-one': load });
    expect(load).toHaveBeenCalledOnce();
    expect(officialCatalogLoaded(chain)).toBe(true);
    expect(resolveAssetReference(chain, 'Wrapped BTC')).toMatchObject({ kind: 'FOUND', by: 'NAME', asset: { chain, chainId: 42161, symbol: 'WBTC', decimals: 8 } });
    for (const reference of ['cbBTC', 'Tesla', 'USDG']) expect(resolveAssetReference(chain, reference)).toEqual({ kind: 'UNKNOWN' });
    resetNetworkCatalogs();
    await prepareCatalogsForText('Anything on Arbitrum One', { 'arbitrum-one': load });
    expect(load).toHaveBeenCalledTimes(2);
    resetNetworkCatalogs();
    await prepareCatalogsForText('Arbitrum', { 'arbitrum-one': async () => { throw Error('SOURCE_UNAVAILABLE'); } });
    expect(officialCatalogLoaded(chain)).toBe(false);
    expect(resolveAssetReference(chain, 'WBTC')).toEqual({ kind: 'UNAVAILABLE' });
  });
  it('revalidates chain, decimals and duplicates at shared registration, rather than trusting a hand-built catalog', () => {
    for (const change of [{ chainId: 8453 }, { chain: 'eip155:8453' }, { decimals: 37 }]) {
      const bad = catalog();
      expect(() => registerNetworkCatalog({ ...bad, assets: bad.assets.map((a, i) => i === 3 ? { ...a, ...change } : a) })).toThrow();
      expect(officialCatalogLoaded(chain)).toBe(false);
    }
    const bad = catalog();
    expect(() => registerNetworkCatalog({ ...bad, assets: [...bad.assets, bad.assets[3]!] })).toThrow('ASSET_CATALOG_DUPLICATE');
    expect(() => registerNetworkCatalog({ ...bad, chainId: 421614 })).toThrow('ASSET_CATALOG_INVALID');
    expect(() => registerNetworkCatalog({ ...bad, provenance: [] })).toThrow('ASSET_CATALOG_INVALID');
    expect(() => registerNetworkCatalog({ ...bad, assets: bad.assets.map((asset, i) => i === 3 ?
      { ...asset, source: { ...asset.source, provider: 'spam.endpoint', url: 'https://evil.example/tokens' } } : asset) })).toThrow('ASSET_CATALOG_INVALID');
  });
  it('keeps duplicate display names ambiguous and symbols within their network', () => {
    const data = JSON.parse(bytes) as { tokens: Record<string, unknown>[] };
    data.tokens = data.tokens.map(t => t.symbol === 'LINK' ? { ...t, name: 'Wrapped BTC' } : t);
    registerNetworkCatalog(parseArbitrumTokenList(JSON.stringify(data), '2026-10-11'));
    expect(resolveAssetReference(chain, 'Wrapped BTC')).toMatchObject({ kind: 'AMBIGUOUS' });
    expect(resolveNetworkAsset('eip155:8453', { symbol: 'ARB' })).toBeNull();
    expect(resolveNetworkAsset('eip155:4663', { symbol: 'ARB' })).toBeNull();
  });
  it('inherits trusted asset presentation and fallback without introducing symbol-based logo discovery', () => {
    registerNetworkCatalog(catalog());
    expect(assetIdentity({ network: chain, symbol: 'WBTC' }).mark).toMatchObject({ kind: 'logo', src: catalog().assets[4]!.logoUrl });
    expect(assetIdentity({ network: chain, symbol: 'ARB' }).mark).toMatchObject({ kind: 'monogram', text: 'AR' });
    for (const symbol of ['TSLA', 'cbBTC', 'USDT']) expect(assetIdentity({ network: chain, symbol }).mark.kind).toBe('monogram');
    expect(assetIdentity({ network: chain, symbol: 'USDC' }).mark).toEqual({ kind: 'image', src: '/brand/crypto/usdc.png' });
    expect(assetIdentity({ network: 'Robinhood Chain', symbol: 'WBTC' }).mark.kind).toBe('monogram');
  });
  it('keeps all visual metadata out of canonical asset projection and existing Router IR/hash', () => {
    const snapshot = () => {
      const composed = composeStrategy({ action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'base', asset: 'USDC', amount: '10', slippageBps: 50 });
      if (!composed.ok) throw Error(composed.code);
      return { workflow: composed.workflow, hash: semanticWorkflowHash(composed.workflow), assets: catalog().assets.map(workflowAsset) };
    };
    registerNetworkCatalog(catalog());
    const original = snapshot(), changed = catalog();
    const assets = changed.assets.map(asset => ({ ...asset, logoUrl: 'https://evil.example/image.png', name: 'Presentation changed' }));
    registerNetworkCatalog({ ...changed, assets });
    expect(snapshot()).toEqual(original);
    expect(assets.map(workflowAsset)).toEqual(original.assets);
    expect(JSON.stringify(original.workflow)).not.toMatch(/logoUrl|\/brand\/|coingecko|Presentation changed/);
  });
  it('keeps runtime capability truth generated and unbuilt liquidity/lending refused', () => {
    registerNetworkCatalog(catalog());
    expect(discoverNetworkCapabilities(chain)).toHaveLength(10);
    expect(supportedNetworks().find(n => n.id === 'arbitrum-one')).toMatchObject({ class: 'MAINNET', funds: 'REAL_FUNDS', actions: ['bridge', 'swap', 'transfer'] });
    expect(AUTHORING_CAPABILITIES.filter(c => c.network.chain === chain).every(c => ['bridge', 'swap', 'transfer'].includes(c.action))).toBe(true);
    expect(bridgeOffers().some(r => r.source.chain === chain && r.destination.key === 'base')).toBe(true);
    expect(bridgeOffers().some(r => r.destination.chain === chain && r.source.key === 'base')).toBe(true);
    expect(catalogCapabilityNetworks().map(n => n.key)).toEqual(['base', 'robinhood']);
    const supports = copilotSupportsSection();
    expect(supports).toContain('from Arbitrum One to Base');
    for (const line of supports.split('\n').filter(line => /^- (?:SUPPLY|LIQUIDITY)\b/.test(line))) expect(line).not.toContain('Arbitrum');
    for (const action of ['add_liquidity', 'supply', 'borrow', 'repay', 'withdraw'] as const) {
      expect(capabilityNetworks(action).some(n => n.chain === chain)).toBe(false);
      expect(cryptoProfiles(action === 'add_liquidity' ? 'pool' : action).some(p => p.chain === chain)).toBe(false);
    }
  });
});
