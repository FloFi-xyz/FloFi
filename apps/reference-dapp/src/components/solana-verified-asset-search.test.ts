// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { parseJupiterVerifiedCatalog, searchSolanaCatalog } from '../domain/solana-asset-catalog';
const catalog = parseJupiterVerifiedCatalog(JSON.stringify([
  { id: SOLANA_MAINNET_TOKENS.USDC.mint, symbol: 'USDC', name: 'USD Coin', decimals: 6, isVerified: true, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
  { id: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP', name: 'Jupiter', decimals: 6, isVerified: true, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
]), '2026-10-26T00:00:00.000Z');
describe('Solana catalog search', () => {
  it('searches the validated source beyond the original three shortcuts', () => {
    expect(searchSolanaCatalog(catalog.assets, 'Jupiter').map(t => t.symbol)).toEqual(['JUP']);
    expect(searchSolanaCatalog(catalog.assets, 'jup')).toHaveLength(1);
  });
  it('searches by mint and does not invent unknown assets', () => {
    expect(searchSolanaCatalog(catalog.assets, SOLANA_MAINNET_TOKENS.USDC.mint)[0]!.symbol).toBe('USDC');
    expect(searchSolanaCatalog(catalog.assets, 'not-a-token')).toEqual([]);
  });
});
