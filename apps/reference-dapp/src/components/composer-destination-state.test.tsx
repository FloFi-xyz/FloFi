// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001 (addendum): the Bridge card's "Destination wallet" states. Amber (`attention`): a required wallet is
 * missing or a choice is pending; red (`error`): the typed address is invalid or of another network; `loading`: the account's wallets are still
 * read (no premature "missing"); normal: a valid or automatically resolved address. Each state is said in text (and an icon), never colour alone,
 * names the network and the kind of wallet, and offers a connection, a choice or a typed address.
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../state/workflow-store', () => ({ useWorkflow: () => { throw new Error('NOT_USED'); } }));
vi.mock('@xyflow/react', () => ({ Handle: () => null, Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' } }));
const { DestinationField, destinationFieldState } = await import('./composer-card');
const { LocaleProvider } = await import('../i18n/locale');
import type { CardDestination } from './composer-card';
import type { Language } from '../i18n/locale';

const PHANTOM = '8xYk2PvDDaGkR9ZnAwzXeVGkXzW1sTdQfWw3mVdKk2P1';
const field = (patch: Partial<CardDestination>): CardDestination => ({ network: 'Solana', value: '', auto: null, autoAddress: null, candidates: [], status: 'required',
  placeholder: 'Solana address', onChange: vi.fn(), ecosystem: 'Solana', ...patch });
const render = (destination: CardDestination, language: Language = 'EN') =>
  renderToStaticMarkup(createElement(LocaleProvider, { initialLanguage: language, children: createElement(DestinationField, { destination }) }));

describe('BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001 destination field states', () => {
  it('maps every status to one visual state', () => {
    expect(destinationFieldState('required')).toBe('attention');
    expect(destinationFieldState('choose')).toBe('attention');
    expect(destinationFieldState('invalid')).toBe('error');
    expect(destinationFieldState('wrong-ecosystem')).toBe('error');
    expect(destinationFieldState('loading')).toBe('loading');
    expect(destinationFieldState('valid')).toBe('normal');
  });
  it('required (EVM → Solana, no Solana wallet): amber, an icon and text naming Solana, a connect action, the typed-address field', () => {
    const html = render(field({ onConnect: vi.fn() }));
    expect(html).toContain('data-destination-state="attention"');
    expect(html).toContain('aria-required="true"');
    expect(html).toContain('composer-destination-warning');
    expect(html).toContain('composer-destination-icon');
    expect(html).toContain('Required: the Solana wallet that receives on Solana. Connect one, choose one of your wallets, or enter its public address.');
    expect(html).toContain('>Connect a Solana wallet</button>');
    expect(html).not.toMatch(/will sign/);
    const pt = render(field({ onConnect: vi.fn() }), 'PT');
    expect(pt).toContain('Obrigatório: a carteira Solana que recebe em Solana.');
    expect(pt).toContain('>Conectar uma carteira Solana</button>');
  });
  it('required (Solana → Base, no EVM wallet): names the EVM wallet and Base', () => {
    const html = render(field({ network: 'Base', ecosystem: 'EVM', placeholder: 'Address (0x…)', onConnect: vi.fn() }));
    expect(html).toContain('Required: the EVM wallet that receives on Base.');
    expect(html).toContain('>Connect an EVM wallet</button>');
  });
  it('choose (several wallets): amber and the wallets as buttons, no automatic pick', () => {
    const html = render(field({ status: 'choose', candidates: [{ address: PHANTOM, label: 'Solana · Phantom · 8xY…k2P1' }, { address: 'B'.repeat(44), label: 'Solana · FloFi Wallet · BBB…BBBB' }] }));
    expect(html).toContain('data-destination-state="attention"');
    expect(html).toContain('Choose which of your Solana wallets receives on Solana, or enter its public address.');
    expect(html).toContain('Solana · FloFi Wallet');
    expect(html).not.toContain('Automatic:');
  });
  it('invalid or wrong-ecosystem typed address: red, aria-invalid', () => {
    for (const status of ['invalid', 'wrong-ecosystem'] as const) {
      const html = render(field({ status, value: '0x90f5aa2a1b2c3d4e5f60718293a4b5c6d7e8d303' }));
      expect(html).toContain('data-destination-state="error"');
      expect(html).toContain('aria-invalid="true"');
      expect(html).toContain('composer-recipient-error');
    }
  });
  it('loading: busy, "checking", never "required"', () => {
    const html = render(field({ status: 'loading' }));
    expect(html).toContain('data-destination-state="loading"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Checking your wallets for Solana…');
    expect(html).not.toContain('Required');
    expect(html).not.toContain('Connect a Solana wallet');
  });
  it('resolved automatically (a Privy embedded or connected wallet): normal, no warning', () => {
    const html = render(field({ status: 'valid', auto: 'Solana · FloFi Wallet · 7Np…T4K2', autoAddress: PHANTOM }));
    expect(html).toContain('data-destination-state="normal"');
    expect(html).toContain('Automatic: Solana · FloFi Wallet');
    expect(html).not.toContain('composer-destination-warning');
    expect(html).not.toContain('aria-required');
  });
});
