// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001 (incident 10): a reconciled run step's received amount, resolved only through the catalog. */
import { describe, expect, it } from 'vitest';
import { displayTokenAmount } from './token-amount-display';
import { reconciledReceived } from './run-outcome-amounts';

const ARB = 'eip155:42161', WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const catalog = (chain: string, reference: { id?: string }) => reference.id === `${ARB}/erc20:${WETH}`
  ? { id: reference.id, chain, symbol: 'WETH', decimals: 18 } : reference.id === `${ARB}/slip44:60` ? { id: reference.id, chain, symbol: 'ETH', decimals: 18 } : null;
const resolve = catalog as unknown as Parameters<typeof reconciledReceived>[1];

describe('BUILD-FLOFI-UNIVERSAL-CHANNEL-EXECUTION-PARITY-001: reconciled received amounts', () => {
  it('reads the owner-observed incident amount in the token\'s own units (checksummed or native ids included)', () => {
    const received = reconciledReceived({ state: 'RECONCILED', outcome: { received: [{ asset: `${ARB}/erc20:${WETH.toUpperCase().replace('0X', '0x')}`, amount: '595831000000000' },
      { asset: `${ARB}/native:ETH`, amount: '1' }] } }, resolve);
    expect(received).toEqual([{ asset: `${ARB}/erc20:${WETH.toUpperCase().replace('0X', '0x')}`, units: '595831000000000', decimals: 18, symbol: 'WETH' },
      { asset: `${ARB}/native:ETH`, units: '1', decimals: 18, symbol: 'ETH' }]);
    expect(displayTokenAmount({ units: received[0]!.units, decimals: 18 }, { rounding: 'down', symbol: 'WETH' })?.text).toBe('0.000595831 WETH');
  });
  it('shows nothing before reconciliation, for an unknown asset or a malformed amount (never a guess, never 0)', () => {
    expect(reconciledReceived({ state: 'AWAITING_OWNER', outcome: { received: [{ asset: `${ARB}/erc20:${WETH}`, amount: '1' }] } }, resolve)).toEqual([]);
    expect(reconciledReceived({ state: 'RECONCILED', outcome: null }, resolve)).toEqual([]);
    expect(reconciledReceived({ state: 'RECONCILED', outcome: { received: [{ asset: `${ARB}/erc20:0x${'1'.repeat(40)}`, amount: '5' },
      { asset: `${ARB}/erc20:${WETH}`, amount: '-1' }, { asset: 'garbage', amount: '1' }] } }, resolve)).toEqual([]);
    expect(reconciledReceived({ state: 'RECONCILED', outcome: { received: [{ asset: `${ARB}/erc20:${WETH}`, amount: '1' }] } },
      (() => { throw new Error('CATALOG_DOWN'); }) as unknown as typeof resolve)).toEqual([]);
  });
});
