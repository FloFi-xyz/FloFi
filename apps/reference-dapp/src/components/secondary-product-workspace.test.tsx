// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DangerZone, SecondaryProductWorkspace } from './secondary-product-workspace';
import type { AccountState } from '../app/account-action';
import type { SolanaSession } from '../wallet/solana-wallet';

const fixture = vi.hoisted(() => ({ account: null as string | null, chainId: null as string | null, provider: null as { key: string; name: string; icon: string | null } | null,
  busy: false, reset: () => undefined, session: null as SolanaSession | null, disconnect: async () => undefined, connectWith: async () => null,
  credentials: { wallets: [] as unknown[], cards: [] as unknown[] }, connect: vi.fn() }));
vi.mock('../state/build009-wallet-store', async importOriginal => {
  const actual = await importOriginal<typeof import('../state/build009-wallet-store')>();
  return { ...actual, useBuild009Wallet: () => fixture };
});
vi.mock('../state/jupiter-store', () => ({ useJupiter: () => fixture }));
vi.mock('../state/wallet-connection', async importOriginal => ({ ...await importOriginal<typeof import('../state/wallet-connection')>(),
  useWalletConnection: () => ({ connect: fixture.connect, error: null, solanaChain: 'solana:devnet' }) }));
vi.mock('../state/credentials-store', () => ({ useCredentials: () => fixture.credentials, saveWalletReference: vi.fn(), renameSavedCredential: vi.fn(), removeSavedCredential: vi.fn() }));
vi.mock('../app/card-action', () => ({ cardProviderStatus: vi.fn() }));

const EVM = '0x1234567890123456789012345678901234567890', SOLANA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgA91';
const saved = (ecosystem: 'evm' | 'solana', providerKey: string, providerName: string, address: string, label = providerName, lastNetwork: string | null = null) =>
  ({ id: `${ecosystem}:${providerKey}:${address}`, ecosystem, address, providerKey, providerName, label, lastNetwork, addedAt: '2026-10-07T12:00:00.000Z' });
beforeEach(() => { Object.assign(fixture, { account: null, chainId: null, provider: null, busy: false, session: null, credentials: { wallets: [], cards: [] } }); fixture.connect.mockClear(); });
const markup = (workspace: 'credentials' | 'agents' | 'passkeys') => renderToStaticMarkup(createElement(SecondaryProductWorkspace, { workspace }));
const wallets = (html: string) => html.match(/class="ux-wallet-row"/g)?.length ?? 0;

describe('secondary product workspaces', () => {
  it('renders functional Add wallet and Add card with truthful empty states and no secret affordances', () => {
    const html = markup('credentials');
    expect(html).toContain('<h1>Credentials</h1>');
    expect(html).toContain('>Wallets</h2>');
    expect(html).toContain('>Cards</h2>');
    expect(html.match(/class="ux-count">0<\/span>/g)).toHaveLength(2);
    for (const text of ['Add a wallet to save its public address here.', "Cards are added through a certified card provider&#x27;s secure entry."]) expect(html).toContain(text);
    for (const label of ['Add wallet', 'Add card']) expect(html).toMatch(new RegExp(`<button type="button" class="ux-button">[\\s\\S]*?${label}</button>`));
    // Board 13: Pix and boleto do not exist yet — one row with a "Coming soon" status and no control; "Add secret" is gone (no disabled fake button).
    const pix = html.slice(html.indexOf('aria-labelledby="credentials-payments"'), html.indexOf('</section>', html.indexOf('aria-labelledby="credentials-payments"')));
    expect(pix).toContain('Pix and boleto'); expect(pix).toContain('<span class="ux-tag" data-tone="soon">Coming soon</span>'); expect(pix).not.toMatch(/<button|<a\b/);
    expect(html).not.toContain('Add secret'); expect(html).not.toContain('disabled=""');
    // Signed out, there is no account to delete: no danger zone.
    expect(html).not.toContain('Danger zone');
    expect(html).not.toMatch(/Reveal|private key|seed phrase|balance|MPC|type="password"|cvv|cvc|PixBlock|Connected with|autocomplete="cc-/i);
    expect(html).not.toContain('<input');
    expect(fixture.connect).not.toHaveBeenCalled();
  });

  it('shows an active wallet that is not saved yet, with its provider, ecosystem and Save/Disconnect', () => {
    Object.assign(fixture, { account: EVM, chainId: '0x14a34', provider: { key: 'io.metamask', name: 'MetaMask', icon: null } });
    const html = markup('credentials');
    expect(wallets(html)).toBe(1);
    // Board 13: "MetaMask wallet · EVM · in use on Base Sepolia", the address in mono, a status tag, Save, and ··· for the other actions.
    expect(html).toContain(`<h3 class="ux-row-name">EVM Default <code class="ux-address" title="${EVM}">0x1234…7890</code></h3><p class="ux-row-meta">MetaMask wallet · EVM · in use on Base Sepolia</p>`);
    expect(html).toContain('workspace-wallet-status-active">Connected · not saved</span>');
    expect(html).toContain('<button type="button" class="ux-button" aria-label="Save EVM Default">Save</button>');
    expect(html).toMatch(/aria-haspopup="menu" aria-expanded="false"[^>]*aria-label="More actions for EVM Default"/);
    expect(html).toMatch(/role="menu" aria-label="More actions for EVM Default" class="ux-menu-list" hidden=""/);
    for (const label of ['Copy EVM Default address', 'Save EVM Default', 'Disconnect EVM Default']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toMatch(/aria-label="(Rename|Remove) (EVM Default|MetaMask)"/);
  });

  it('keeps several saved wallets distinct and marks only the exact active identity as Active', () => {
    Object.assign(fixture, { account: EVM, chainId: '0x14a34', provider: { key: 'io.rabby', name: 'Rabby Wallet', icon: null },
      session: { wallet: { name: 'Phantom', chains: ['solana:devnet'], accounts: [], features: {} }, account: { address: SOLANA, chains: ['solana:devnet'], features: [] }, chain: 'solana:devnet' } });
    fixture.credentials = { cards: [], wallets: [saved('evm', 'io.metamask', 'MetaMask', EVM, 'Main', 'eip155:84532'), saved('evm', 'io.rabby', 'Rabby Wallet', EVM),
      saved('evm', 'app.phantom', 'Phantom', EVM, 'Phantom EVM'), saved('solana', 'Phantom', 'Phantom', SOLANA, 'Phantom Solana', 'solana:devnet')] };
    const html = markup('credentials');
    expect(wallets(html)).toBe(4);
    expect(html).toContain('class="ux-count">4</span>');
    expect(html.match(/workspace-wallet-status-active">Active</g)).toHaveLength(2);
    expect(html).toContain('aria-label="Rabby Wallet, Ethereum" data-active="true"');
    expect(html).toContain('aria-label="Phantom Solana, Solana" data-active="true"');
    expect(html).toContain('aria-label="Main, Ethereum" data-active="false"');
    expect(html).toContain('aria-label="Phantom EVM, Ethereum" data-active="false"');
    for (const label of ['Connect Main', 'Rename Main', 'Remove Main', 'Disconnect Rabby Wallet', 'Disconnect Phantom Solana', 'Connect Phantom EVM']) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('Solana Devnet');
    expect(html).not.toMatch(/Connected · not saved|Reveal|private key/i);
  });

  it('shows safe saved-card metadata only, never provider references', () => {
    fixture.credentials = { wallets: [], cards: [{ id: 'card:mercado_pago:1562188766859', provider: 'mercado_pago', providerName: 'Mercado Pago',
      providerCustomerId: '470183340-cpunOI7UsIHlHr', providerCardId: '1562188766859', binding: `cb1.${'A'.repeat(40)}.${'B'.repeat(43)}`, paymentMethodId: 'visa',
      brand: 'visa', last4: '4821', expMonth: 8, expYear: 2029, label: 'Visa •••• 4821', addedAt: '2026-10-07T12:00:00.000Z', updatedAt: '2026-10-07T12:00:00.000Z' }] };
    const html = markup('credentials');
    expect(html).toContain('<h3 class="ux-row-name">Visa •••• 4821</h3><p class="ux-row-meta">Visa · Mercado Pago · ');
    expect(html).not.toMatch(/cb1\.|470183340|mercado_pago/);
    expect(html).toContain('•••• 4821</span> · Expires 08/29');
    expect(html).toContain('aria-label="Remove Visa •••• 4821"');
    expect(html).not.toMatch(/\d{12,}|cvv|cvc/i);
  });

  it('offers only Claude and ChatGPT with decorative official assets, "In testing" and nothing that looks clickable (board 14)', () => {
    const html = markup('agents');
    for (const label of ['Connect with Claude', 'Connect with ChatGPT', 'Use FloFi from inside Claude.', 'Use FloFi from inside ChatGPT.']) expect(html).toContain(label);
    expect(html).toContain('src="/brand/providers/claude-spark.svg"');
    expect(html).toContain('src="/brand/providers/openai-blossom-black.svg"');
    expect(html).toContain('src="/brand/providers/openai-blossom-white.svg"');
    expect(html.match(/class="ux-row-icon workspace-provider-mark" aria-hidden="true"/g)).toHaveLength(2);
    expect(html.match(/width="28" height="28" alt=""/g)).toHaveLength(1);
    expect(html.match(/width="56" height="56" alt=""/g)).toHaveLength(2);
    expect(html.match(/<span class="ux-tag" data-tone="testing">In testing<\/span>/g)).toHaveLength(2);
    // "Create client" is replaced by ONE "API clients · Coming soon" row; there is no control, disabled or not, and no arrow.
    expect(html).not.toContain('Create client'); expect(html.match(/API clients/g)).toHaveLength(1); expect(html.match(/data-tone="soon">Coming soon/g)).toHaveLength(1);
    expect(html).not.toMatch(/<button|disabled=""|M4 12h16m-5-5 5 5-5 5/);
    expect(html).not.toMatch(/>C<|>GPT<|>G<|Grok|<a\b|API key|OAuth|signing key|Connected with/i);
  });

  it('keeps EVM Default and Solana Default identities stable across provider names, accounts and networks', () => {
    fixture.account = '0x1234567890123456789012345678901234567890'; fixture.chainId = '0x14a34';
    fixture.session = { wallet: { name: 'Phantom', chains: ['solana:devnet'], accounts: [], features: {} }, account: { address: 'So11111111111111111111111111111111111111112', chains: ['solana:devnet'], features: [] }, chain: 'solana:devnet' };
    let html = markup('credentials');
    const identity = (name: string) => new RegExp(`<h3 class="ux-row-name">${name} <code`);
    expect(html).toMatch(identity('EVM Default')); expect(html).toMatch(identity('Solana Default'));
    // The provider is shown beneath the identity (HOTFIX-WALLET-SELECTOR), never as the identity itself.
    expect(html).not.toMatch(identity('Phantom')); expect(html).toContain('<p class="ux-row-meta">Phantom wallet · Solana · in use on Solana Devnet</p>');
    // A provider name that already says "wallet" is not repeated.
    expect(html).toContain('<p class="ux-row-meta">Browser wallet · EVM · in use on Base Sepolia</p>');
    fixture.account = '0x' + 'a'.repeat(40); fixture.chainId = '0x2105'; fixture.session.chain = 'solana:mainnet';
    html = markup('credentials'); expect(html).toMatch(identity('EVM Default')); expect(html).toMatch(identity('Solana Default'));
    expect(html).toContain(fixture.account); expect(html).toContain('Solana mainnet-beta'); expect(html).not.toContain('0x1234567890123456789012345678901234567890');
    fixture.session = null; html = markup('credentials'); expect(html).toMatch(identity('EVM Default')); expect(html).not.toMatch(identity('Solana Default'));
  });

  it('shows one "Coming soon" state where the passkey manager is not enabled, with no disabled switch or fake call to action (board 15)', () => {
    const html = markup('passkeys');
    expect(html).toContain('<h1>Passkeys</h1>');
    expect(html).toContain('<span class="ux-tag" data-tone="soon">Coming soon</span>');
    expect(html).toContain('Sign in with your fingerprint or face');
    expect(html).toContain('A passkey lets you sign in to FloFi without a password, using your device unlock. It does not sign transactions.');
    expect(html).not.toMatch(/role="switch"|disabled=""|<button|Add one to get started|Turn on to add a passkey/);
    expect(html).not.toMatch(/device name|registered|type="password"/i);
  });
  it('never claims "Coming soon" for passkeys while a connected wallet\'s deployment may serve the passkey manager', () => {
    const owner = { namespace: 'eip155' as const, address: EVM };
    const html = renderToStaticMarkup(createElement(SecondaryProductWorkspace, { workspace: 'passkeys', automations: { owner, onPropose: vi.fn(),
      proof: { proven: null } as unknown as NonNullable<Parameters<typeof SecondaryProductWorkspace>[0]['automations']>['proof'] } }));
    expect(html).toContain('<h1>Passkeys</h1>'); expect(html).toContain('Checking passkeys…'); expect(html).not.toContain('Coming soon');
  });
  it('keeps account deletion last and collapsed in a Danger zone, with its own confirmation step unchanged (board 13)', () => {
    const state = { availability: { accounts: true, managedWallets: true }, account: { wallets: [{ origin: 'privy' }], privy: true } } as unknown as AccountState;
    const html = renderToStaticMarkup(createElement(DangerZone, { state }));
    expect(html).toMatch(/^<details class="ux-details ux-danger-zone"><summary>Danger zone · delete FloFi account<\/summary>/); expect(html).not.toContain('open=""');
    // Opening the zone only offers the first step; the irreversible "Delete account" exists only after DeleteAccount's own confirmation.
    expect(html).toContain('>Delete FloFi account</button>'); expect(html).not.toContain('>Delete account</button>'); expect(html).not.toContain('Delete your FloFi account?');
  });
});
