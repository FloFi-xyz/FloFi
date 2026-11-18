// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PositionScan } from '../../domain/defi-positions';
import { LocaleProvider } from '../../i18n/locale';
import { DefiPositions, PositionResults } from './defi-positions';

const scan = (status: PositionScan['status']): PositionScan => ({ protocol: 'Aave V3', network: 'Ethereum', chain: 'eip155:1',
  status, observedAt: null, provenance: 'PUBLIC_MAINNET', positions: [] });
afterEach(() => vi.useRealTimers());

describe('Dashboard positions rendering', () => {
  it('discloses the read-only section in EN and PT before loading wallets', () => {
    const english = renderToStaticMarkup(<DefiPositions evm={null} solana={null}/>);
    expect(english).toMatch(/<h2[^>]*><button type="button"[^>]*aria-expanded="false"[^>]*aria-controls="[^"]+"[^>]*>My DeFi Positions<\/button><\/h2>/);
    expect(english).not.toContain('Checking wallets');
    const portuguese = renderToStaticMarkup(<LocaleProvider initialLanguage="PT"><DefiPositions evm={null} solana={null}/></LocaleProvider>);
    expect(portuguese).toContain('Minhas posições DeFi');
  });
  it('reserves the empty label for complete scans', () => {
    expect(renderToStaticMarkup(<PositionResults scans={[scan('COMPLETE')]}/>)).toContain('No positions found in this scan.');
    for (const status of ['PARTIAL', 'UNAVAILABLE', 'UNSUPPORTED', 'NETWORK_UNAVAILABLE'] as const) {
      expect(renderToStaticMarkup(<PositionResults scans={[scan(status)]}/>)).not.toContain('No positions found');
    }
    expect(renderToStaticMarkup(<PositionResults scans={[scan('PARTIAL')]}/>)).toContain('Partial scan');
    expect(renderToStaticMarkup(<PositionResults scans={[scan('UNSUPPORTED')]}/>)).toContain('Protocol unsupported');
  });
  it('shows debt as debt and hides expired prices', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T12:00:00.000Z'));
    const available = [{ ...scan('COMPLETE'), positions: [{ id: 'debt', type: 'VARIABLE_DEBT' as const, assets: [{
      address: '0x' + '3'.repeat(40), symbol: 'USDC', decimals: 6, units: '2500000', valuation: {
        usd: '2.51', observedAt: '2026-11-18T11:59:00.000Z', expiresAt: '2026-11-18T12:01:00.000Z',
      },
    }] }] }];
    const valued = renderToStaticMarkup(<PositionResults scans={available}/>);
    expect(valued).toContain('Variable debt');
    expect(valued).toContain('2.5 USDC');
    expect(valued).toContain('≈ $2.51 (Chainlink)');
    vi.setSystemTime(new Date('2026-11-18T12:01:00.000Z'));
    const expired = renderToStaticMarkup(<PositionResults scans={available}/>);
    expect(expired).not.toContain('$2.51');
    expect(expired).toContain('Valuation unavailable');
  });
});
