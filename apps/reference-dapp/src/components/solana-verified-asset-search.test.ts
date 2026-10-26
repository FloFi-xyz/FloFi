// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { searchSolanaVerifiedAssets } from './solana-verified-asset-search';

describe('Solana verified asset search (Universal Bridge / Swap parity)', () => {
  it('lists only FloFi\'s verified mainnet tokens — never invents a mint', () => {
    const all = searchSolanaVerifiedAssets('');
    expect(all.map(t => t.symbol).sort()).toEqual(Object.keys(SOLANA_MAINNET_TOKENS).sort());
    expect(all.every(t => Object.values(SOLANA_MAINNET_TOKENS).some(known => known.mint === t.mint))).toBe(true);
  });
  it('filters by symbol or mint substring', () => {
    expect(searchSolanaVerifiedAssets('usdc').map(t => t.symbol)).toEqual(['USDC']);
    expect(searchSolanaVerifiedAssets(SOLANA_MAINNET_TOKENS.USDT.mint.slice(0, 8)).map(t => t.symbol)).toEqual(['USDT']);
    expect(searchSolanaVerifiedAssets('not-a-token')).toEqual([]);
  });
});
