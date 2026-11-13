// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002 review round 2: the universal bridge form's destination field. Its accessible name is its visible label
 * ("Destination wallet"), the message under it is linked as its description, and with no automatic wallet (several to choose from, or none)
 * the placeholder names the kind of address instead of promising a connected wallet. FloFi's own fallback wallet name is translated.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DestinationCandidate, DestinationResolution } from '../domain/destination-wallet';

const fixture = vi.hoisted(() => ({ evm: { kind: 'NONE' } as DestinationResolution, wallets: [] as DestinationCandidate[] }));
vi.mock('../state/workflow-store', () => ({ useWorkflow: () => ({ state: { workflow: { nodes: [], revision: 1 } }, propose: vi.fn(), amountInputs: {} }) }));
vi.mock('../state/universal-router-store', () => ({ useUniversalRouter: () => null }));
vi.mock('../state/build009-wallet-store', () => ({ useOptionalBuild009Wallet: () => null }));
vi.mock('../state/destination-wallets', async importOriginal => {
  const actual = await importOriginal<typeof import('../state/destination-wallets')>();
  return { ...actual, useDestinationWallets: () => ({ inventory: { session: [], account: fixture.wallets, saved: [] }, evm: fixture.evm, solana: { kind: 'NONE' } }) };
});
const { UniversalBridgeForm } = await import('./universal-bridge-panel');
const { LocaleProvider } = await import('../i18n/locale');
import type { Language } from '../i18n/locale';

const METAMASK = '0x4b212af0a923256961487ae72499ca79f920b3ce', RABBY = '0x1111111111111111111111111111111111111111';
const wallet = (address: string, providerName: string): DestinationCandidate => ({ ecosystem: 'evm', address, providerName, source: 'ACCOUNT' });
// The form's default pair is Solana → Base: a cross-ecosystem bridge whose destination is an EVM wallet.
const render = (language: Language = 'EN') => renderToStaticMarkup(createElement(LocaleProvider, { initialLanguage: language,
  children: createElement(UniversalBridgeForm, { nodeId: 'bridge', options: true }) }));
const input = (html: string) => /<label>(?:Destination wallet|Carteira de destino)<input[^>]*\/><\/label>/.exec(html)?.[0] ?? '';

describe('BUILD-FLOFI-MAINNET-EXEC-002 universal bridge destination field', () => {
  it('several wallets (CHOOSE): named by its visible label, described by the message, and an address placeholder', () => {
    fixture.wallets = [wallet(METAMASK, 'MetaMask'), wallet(RABBY, 'Rabby')]; fixture.evm = { kind: 'CHOOSE', candidates: fixture.wallets };
    const html = render(), field = input(html);
    expect(field).not.toBe('');
    expect(field).not.toContain('aria-label');
    expect(html).not.toContain('Universal bridge recipient');
    expect(field).toContain('placeholder="Address (0x…)"');
    expect(field).not.toMatch(/placeholder="[^"]*connected/i);
    const described = /aria-describedby="([^"]+)"/.exec(field)?.[1];
    expect(html).toContain(`<small id="${described}" role="status">Choose one of your wallets or enter an address.</small>`);
  });
  it('no wallet (NONE): an address placeholder and the message as its description, in Portuguese too', () => {
    fixture.wallets = []; fixture.evm = { kind: 'NONE' };
    const html = render(), field = input(html), described = /aria-describedby="([^"]+)"/.exec(field)?.[1];
    expect(field).toContain('placeholder="Address (0x…)"');
    expect(html).toContain(`<small id="${described}" role="status">Enter the destination address on Base.</small>`);
    const pt = input(render('PT'));
    expect(pt).toContain('placeholder="Endereço (0x…)"');
  });
  it('one wallet (RESOLVED): the automatic wallet is the placeholder, with FloFi\'s fallback wallet name translated; no message, no description', () => {
    fixture.wallets = [wallet(METAMASK, 'Browser wallet')]; fixture.evm = { kind: 'RESOLVED', wallet: fixture.wallets[0]!, alternatives: [] };
    const field = input(render());
    expect(field).toContain('placeholder="Base · Browser wallet · 0x4b…b3ce"');
    expect(field).not.toContain('aria-describedby');
    expect(input(render('PT'))).toContain('placeholder="Base · Carteira do navegador · 0x4b…b3ce"');
    // A wallet's own name is never changed.
    fixture.wallets = [wallet(METAMASK, 'MetaMask')]; fixture.evm = { kind: 'RESOLVED', wallet: fixture.wallets[0]!, alternatives: [] };
    expect(input(render('PT'))).toContain('placeholder="Base · MetaMask · 0x4b…b3ce"');
  });
});
