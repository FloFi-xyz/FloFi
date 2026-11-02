// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { base58Encode, type RawSolanaAccount } from '@defi-workflow-engine/reference-compiler';
import { clockAccount, interestBearing, metadataPointer, scaledUiAmount, token2022Mint } from '../test-utils/token-2022-fixtures.ts';
import { clockUnixTimestamp, ONE_IN_BASIS_POINTS, SECONDS_PER_YEAR, SOLANA_TOKEN_2022_PROGRAM, token2022AccountIssue, token2022Display, token2022Rule,
  type Token2022Rule } from './solana-token-amount.ts';

const mintAccount = (data: Uint8Array, owner = SOLANA_TOKEN_2022_PROGRAM): RawSolanaAccount => ({ lamports: 2_000_000n, owner, data });
const NOW = 1_800_000_000n, YEAR = BigInt(SECONDS_PER_YEAR);
const shown = (raw: bigint, rule: Token2022Rule) => { const display = token2022Display(raw, rule); return display.ok ? [display.units.toString(), display.basis] : [display.code]; };

describe('Token-2022 displayed balances', () => {
  it('uses the token program constants: a 365.24-day year and basis points', () => {
    expect(SECONDS_PER_YEAR).toBe(31_556_736); expect(ONE_IN_BASIS_POINTS).toBe(10_000);
  });
  it('shows a standard Token-2022 balance (no amount extension, metadata only) exactly as its raw amount, even beyond 2^53', () => {
    const rule = token2022Rule(mintAccount(token2022Mint(6, [metadataPointer()])), NOW);
    expect(rule).toEqual({ ok: true, decimals: 6, basis: 'RAW', factor: 1 });
    expect(shown(18_446_744_073_709_551_615n, rule)).toEqual(['18446744073709551615', 'RAW']);
    expect(token2022Rule(mintAccount(token2022Mint(9)), NOW)).toEqual({ ok: true, decimals: 9, basis: 'RAW', factor: 1 });
  });
  it('applies the current Scaled UI Amount multiplier, switching to the new one at its effective time, truncating to a base unit', () => {
    const before = token2022Rule(mintAccount(token2022Mint(6, [metadataPointer(), scaledUiAmount(1.5, NOW + 1n, 2)])), NOW);
    expect(before).toEqual({ ok: true, decimals: 6, basis: 'SCALED_UI_AMOUNT', factor: 1.5 });
    expect(shown(2_000_000n, before)).toEqual(['3000000', 'SCALED_UI_AMOUNT']);
    expect(shown(3n, before)).toEqual(['4', 'SCALED_UI_AMOUNT']); // 4.5 base units: truncated, never rounded up
    const at = token2022Rule(mintAccount(token2022Mint(6, [scaledUiAmount(1.5, NOW, 2)])), NOW);
    expect(shown(2_000_000n, at)).toEqual(['4000000', 'SCALED_UI_AMOUNT']);
    const down = token2022Rule(mintAccount(token2022Mint(6, [scaledUiAmount(0.5, 0n, 0.5)])), NOW);
    expect(shown(2_000_001n, down)).toEqual(['1000000', 'SCALED_UI_AMOUNT']);
  });
  it('accrues Interest-Bearing balances continuously from the pre-update average rate and the current rate', () => {
    // One year at 5% after initialization: e^0.05.
    const yearAt5 = token2022Rule(mintAccount(token2022Mint(6, [interestBearing(NOW - YEAR, 0, NOW - YEAR, 500)])), NOW);
    expect(yearAt5.ok && yearAt5.basis).toBe('INTEREST_BEARING');
    expect(yearAt5.ok && yearAt5.factor).toBeCloseTo(Math.exp(0.05), 15);
    expect(shown(1_000_000_000n, yearAt5)).toEqual(['1051271096', 'INTEREST_BEARING']);
    // Half a year averaging 3% before the last update, then a quarter year at -2%: e^(0.015) × e^(-0.005).
    const half = YEAR / 2n, quarter = YEAR / 4n;
    const changed = token2022Rule(mintAccount(token2022Mint(2, [interestBearing(NOW - quarter - half, 300, NOW - quarter, -200)])), NOW);
    expect(changed.ok && changed.factor).toBeCloseTo(Math.exp(0.015) * Math.exp(-0.005), 15);
    expect(shown(100_000n, changed)).toEqual([String(Math.floor(100_000 * Math.exp(0.015) * Math.exp(-0.005))), 'INTEREST_BEARING']);
    // A zero rate keeps the raw amount exactly.
    const flat = token2022Rule(mintAccount(token2022Mint(6, [interestBearing(NOW - YEAR, 0, NOW - YEAR, 0)])), NOW);
    expect(shown(18_446_744_073_709_551_615n, flat)).toEqual(['18446744073709551615', 'INTEREST_BEARING']);
  });
  it('fails closed per mint: missing, foreign, malformed, uninitialized, unknown or combined extensions and invalid multipliers', () => {
    expect(token2022Rule(null, NOW)).toEqual({ ok: false, code: 'SOLANA_TOKEN_MINT_UNAVAILABLE' });
    expect(token2022Rule(mintAccount(token2022Mint(6), 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), NOW)).toEqual({ ok: false, code: 'SOLANA_TOKEN_MINT_MISMATCH' });
    expect(token2022Rule(mintAccount(new Uint8Array(81)), NOW)).toEqual({ ok: false, code: 'SOLANA_TOKEN_MINT_INVALID' });
    expect(token2022Rule(mintAccount(token2022Mint(6, [], false)), NOW)).toEqual({ ok: false, code: 'SOLANA_TOKEN_MINT_INVALID' });
    expect(token2022Rule(mintAccount(token2022Mint(6, [{ type: 99, value: new Uint8Array(8) }])), NOW)).toEqual({ ok: false, code: 'SOLANA_TOKEN_EXTENSION_UNSUPPORTED' });
    expect(token2022Rule(mintAccount(token2022Mint(6, [scaledUiAmount(1, 0n, 1), interestBearing(NOW, 0, NOW, 1)])), NOW))
      .toEqual({ ok: false, code: 'SOLANA_TOKEN_EXTENSION_UNSUPPORTED' });
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY])
      expect(token2022Rule(mintAccount(token2022Mint(6, [scaledUiAmount(bad, NOW + 10n, 1)])), NOW)).toEqual({ ok: false, code: 'SOLANA_TOKEN_EXTENSION_INVALID' });
    expect(token2022Rule(mintAccount(token2022Mint(6, [{ type: 25, value: new Uint8Array(55) }])), NOW)).toEqual({ ok: false, code: 'SOLANA_TOKEN_EXTENSION_INVALID' });
    expect(token2022Rule(mintAccount(token2022Mint(6, [{ type: 10, value: new Uint8Array(51) }])), NOW)).toEqual({ ok: false, code: 'SOLANA_TOKEN_EXTENSION_INVALID' });
    const huge = token2022Rule(mintAccount(token2022Mint(6, [scaledUiAmount(1e308, 0n, 1e308)])), NOW);
    expect(shown(10n ** 18n, huge)).toEqual(['SOLANA_TOKEN_AMOUNT_UNREPRESENTABLE']);
  });
  it('reads a balance-neutral account as whole, and refuses a confidential or unclassified account extension', () => {
    expect(token2022AccountIssue([])).toBeNull();
    expect(token2022AccountIssue([2, 7, 8, 11, 13, 15, 17, 27])).toBeNull();
    expect(token2022AccountIssue([7, 5])).toBe('SOLANA_TOKEN_CONFIDENTIAL_BALANCE');
    expect(token2022AccountIssue([7, 99])).toBe('SOLANA_TOKEN_EXTENSION_UNSUPPORTED');
  });
  it('reads the cluster time only from the Clock sysvar', () => {
    expect(clockUnixTimestamp(clockAccount(NOW))).toBe(NOW);
    expect(() => clockUnixTimestamp(clockAccount(NOW, base58Encode(new Uint8Array(32).fill(1))))).toThrow('SOLANA_CLOCK_UNAVAILABLE');
    expect(() => clockUnixTimestamp(null)).toThrow('SOLANA_CLOCK_UNAVAILABLE');
    expect(() => clockUnixTimestamp({ ...clockAccount(NOW), data: new Uint8Array(41) })).toThrow('SOLANA_CLOCK_UNAVAILABLE');
  });
});
