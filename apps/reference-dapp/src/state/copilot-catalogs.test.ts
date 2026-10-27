// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { parseArbitrumTokenList } from '@defi-workflow-engine/action-registry';
import { baseCatalog } from '../server/base-mainnet.test-harness';

const loaders = vi.hoisted(() => ({ evm: vi.fn(), solana: vi.fn() }));
vi.mock('../app/asset-catalog-action', () => ({ loadNetworkAssetCatalog: loaders.evm }));
vi.mock('../app/solana-asset-catalog-action', () => ({ loadSolanaAuthoringAssetCatalog: loaders.solana }));
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); });

it('loads both sides from the active draft on a bare reply and retries a failed catalog through the validated loader', async () => {
  const arb = parseArbitrumTokenList(readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8'), '2026-10-27T00:00:00Z');
  let available = false;
  loaders.evm.mockImplementation(async (chain: string) => chain === 'eip155:8453' ? { ok: true, catalog: baseCatalog() }
    : available ? { ok: true, catalog: arb } : { ok: false, code: 'ASSET_CATALOG_UNAVAILABLE' });
  const { ensureCopilotCatalogs } = await import('./copilot-catalogs');
  const { resolveAssetReference } = await import('../domain/asset-catalogs');
  const draft = { action: { sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM' } };
  await ensureCopilotCatalogs('LINK', draft);
  expect(resolveAssetReference('eip155:42161', 'LINK').kind).toBe('UNAVAILABLE');
  available = true;
  await ensureCopilotCatalogs('LINK', draft);
  expect(resolveAssetReference('eip155:42161', 'LINK')).toMatchObject({ kind: 'FOUND', asset: { symbol: 'LINK', chain: 'eip155:42161', decimals: 18 } });
  expect(loaders.evm.mock.calls.map(call => call[0])).toEqual(['eip155:8453', 'eip155:42161', 'eip155:42161']);
});

it('loads the existing verified Solana catalog for a contextual mint/name and recovers after a failed read', async () => {
  const { parseJupiterVerifiedCatalog, solanaDisplayCatalogLoaded, resolveSolanaCatalogAsset } = await import('../domain/solana-asset-catalog');
  const catalog = parseJupiterVerifiedCatalog(JSON.stringify([{ id: 'DezXAZ8z7PnrnRJjz3wXBoRgixCaJ5x2XK1y3YF8ox4', symbol: 'BONK', name: 'Bonk', decimals: 5,
    isVerified: true, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }]), '2026-10-27T00:00:00Z');
  loaders.solana.mockResolvedValueOnce({ ok: false, code: 'SOLANA_TOKEN_CATALOG_UNAVAILABLE' }).mockResolvedValue({ ok: true, catalog });
  const { ensureCopilotCatalogs } = await import('./copilot-catalogs');
  await ensureCopilotCatalogs('Bonk', { action: { destinationNetwork: 'SOLANA' } });
  expect(solanaDisplayCatalogLoaded()).toBe(false);
  await ensureCopilotCatalogs('Bonk', { action: { destinationNetwork: 'SOLANA' } });
  expect(resolveSolanaCatalogAsset('Bonk')).toMatchObject({ symbol: 'BONK', decimals: 5 });
  expect(loaders.solana).toHaveBeenCalledTimes(2);
});
