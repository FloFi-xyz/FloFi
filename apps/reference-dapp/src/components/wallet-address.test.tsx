// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { addressEcosystem, shortWalletAddress, WalletAddress } from './wallet-address';
import { LocaleProvider, type Language } from '../i18n/locale';

const EVM = '0x52908400098527886E0F7030069857D2E4169EE7', SOL = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const render = (props: Parameters<typeof WalletAddress>[0], language: Language = 'EN') =>
  renderToStaticMarkup(createElement(LocaleProvider, { initialLanguage: language, children: createElement(WalletAddress, props) }));

describe('BUILD-FLOFI-BETA-UX-INTELLIGENCE-001 WS02 WalletAddress', () => {
  it('shows a short form, keeps the full canonical address in its tooltip, for screen readers and for Copy', () => {
    const html = render({ address: EVM });
    expect(html).toContain(`data-wallet-address="${EVM}"`);
    expect(html).toContain(`title="${EVM}"`);
    expect(html).toContain(`<span aria-hidden="true">${shortWalletAddress(EVM)}</span><span class="sr-only">${EVM}</span>`);
    expect(shortWalletAddress(EVM)).toBe('0x5290…9EE7');
    expect(html).toContain('aria-label="Copy EVM address"');
  });
  it('a Portuguese user name ending in "address" is never rewritten by a catalog template', async () => {
    const { translate } = await import('../i18n/translate');
    // This build adds no "{0} address" template (frontend review). Other, pre-existing catalog templates are out of this build's scope.
    expect(translate('PT', 'Treasury address')).not.toMatch(/^Endereço/);
  });
  it('names the ecosystem (and network) so EVM and Solana addresses are never confused', () => {
    expect(render({ address: EVM, network: 'Base' })).toContain('<span class="wallet-address-ecosystem">EVM · Base</span>');
    expect(render({ address: SOL })).toContain('<span class="wallet-address-ecosystem">Solana</span>');
    expect(render({ address: SOL })).toContain('data-ecosystem="solana"');
    expect(addressEcosystem(EVM)).toBe('evm');
    expect(addressEcosystem(SOL)).toBe('solana');
    expect(addressEcosystem('not an address')).toBeNull();
  });
  it('reads in Portuguese', () => {
    const html = render({ address: SOL }, 'PT');
    expect(html).toContain('aria-label="Copiar endereço Solana"');
  });
  it('a wallet with its own name names the copy button by that name, untranslated', () => {
    expect(render({ address: EVM, label: 'Work wallet', showEcosystem: false })).toContain('aria-label="Copy Work wallet address"');
    expect(render({ address: EVM, label: 'Work wallet', showEcosystem: false }, 'PT')).toContain('aria-label="Copiar endereço de Work wallet"');
  });
});
