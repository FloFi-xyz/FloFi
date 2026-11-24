// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DangerZone, SavedRecipientsSection, SecondaryProductWorkspace } from './secondary-product-workspace';
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
// BUILD-FLOFI-UNIFIED-COPILOT-001: the account's saved recipients come only from the (mocked) in-memory store, never from Web Storage.
const recipientsFixture = vi.hoisted(() => ({ state: { status: 'IDLE', recipients: [] as unknown[], code: null as string | null } }));
vi.mock('../state/saved-recipients-store', () => ({ useSavedRecipients: () => recipientsFixture.state, loadSavedRecipients: vi.fn(async () => recipientsFixture.state),
  invalidateSavedRecipients: vi.fn(), saveRecipientReference: vi.fn(), renameRecipientReference: vi.fn(), removeRecipientReference: vi.fn() }));

const EVM = '0x1234567890123456789012345678901234567890', SOLANA = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgA91';
const saved = (ecosystem: 'evm' | 'solana', providerKey: string, providerName: string, address: string, label = providerName, lastNetwork: string | null = null) =>
  ({ id: `${ecosystem}:${providerKey}:${address}`, ecosystem, address, providerKey, providerName, label, lastNetwork, addedAt: '2026-10-07T12:00:00.000Z' });
beforeEach(() => { Object.assign(fixture, { account: null, chainId: null, provider: null, busy: false, session: null, credentials: { wallets: [], cards: [] } }); fixture.connect.mockClear();
  recipientsFixture.state = { status: 'IDLE', recipients: [], code: null }; });
const markup = (workspace: 'credentials' | 'agents' | 'passkeys') => renderToStaticMarkup(createElement(SecondaryProductWorkspace, { workspace }));
const wallets = (html: string) => html.match(/class="ux-wallet-row"/g)?.length ?? 0;

describe('secondary product workspaces', () => {
  it('renders Add wallet and Add card with a pending wallet list in the server document and no secret affordances', () => {
    const html = markup('credentials');
    expect(html).toContain('<h1>Credentials</h1>');
    expect(html).toContain('>Wallets</h2>');
    expect(html).toContain('>Cards</h2>');
    expect(html).not.toContain('>Wallets</h2><span class="ux-count">0</span>');
    expect(html).toContain('>Cards</h2><span class="ux-count">0</span>');
    for (const text of ['Loading wallets…', "Cards are added through a certified card provider&#x27;s secure entry."]) expect(html).toContain(text);
    expect(html).not.toContain('Add a wallet to save its public address here.');
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
    // BUILD-FLOFI-BETA-UX-INTELLIGENCE-001 (WS02): the row's address is copyable in place (full address in its tooltip and on Copy).
    expect(html).toContain(`<h3 class="ux-row-name">EVM Default <span class="wallet-address-value ux-address" data-wallet-address="${EVM}" data-ecosystem="evm"><code class="numeric wallet-address" title="${EVM}"><span aria-hidden="true">0x1234…7890</span><span class="sr-only">${EVM}</span></code><button type="button" class="wallet-address-copy" aria-label="Copy EVM Default"`);
    expect(html).toContain('</h3><p class="ux-row-meta">MetaMask wallet · EVM · in use on Base Sepolia</p>');
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
    const identity = (name: string) => new RegExp(`<h3 class="ux-row-name">${name} <span class="wallet-address-value`);
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

describe('BUILD-FLOFI-UNIFIED-COPILOT-001 Credentials → Saved recipients', () => {
  const RCP_EVM = '0x52908400098527886e0f7030069857d2e4169ee7', RCP_SOL = 'GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq';
  const at = '2026-11-15T12:00:00.000Z';
  const recipient = (id: string, label: string, address: string, ecosystem: 'EVM' | 'SOLANA', status: 'EXTERNAL' | 'ACCOUNT_WALLET' | 'CONNECTED') =>
    ({ id: `rcp_${id.padEnd(26, 'a')}`, label, address, ecosystem, createdAt: at, updatedAt: at, status });
  const state = (accounts: boolean, signedIn: boolean) => ({ availability: { accounts, managedWallets: accounts }, account: signedIn ? { wallets: [], identities: [] } : null,
    privy: null }) as unknown as AccountState;
  const section = (account: AccountState | null) => renderToStaticMarkup(createElement(SavedRecipientsSection, { account }));

  it('sits between Wallets and Cards; before the account is read it only says it is loading (no list, count or form)', () => {
    const html = markup('credentials');
    const wallets = html.indexOf('id="credentials-wallets"'), saved = html.indexOf('id="credentials-recipients"'), cards = html.indexOf('id="credentials-cards"');
    expect(wallets).toBeGreaterThan(0); expect(saved).toBeGreaterThan(wallets); expect(cards).toBeGreaterThan(saved);
    expect(section(null)).toContain('Loading saved recipients…');
    expect(section(null)).not.toMatch(/<input|ux-count|Add recipient|<li/);
  });

  it('signed out: only the sign-in prompt, nothing stored or shown; a deployment without accounts says recipients are not available', () => {
    recipientsFixture.state = { status: 'READY', recipients: [recipient('a', 'Should not show', RCP_EVM, 'EVM', 'EXTERNAL')], code: null };
    const signedOut = section(state(true, false));
    expect(signedOut).toContain('Sign in to save the addresses you send to in your FloFi account. Nothing is saved on this device.');
    expect(signedOut).toContain('href="/login?returnTo=%2Fapp%2Fcredentials"');
    expect(signedOut).not.toMatch(/Should not show|<input|ux-count|Add recipient/);
    const none = section(state(false, false));
    expect(none).toContain('Saved recipients are not available on this deployment yet.');
    expect(none).not.toMatch(/Sign in|<input|ux-count|Should not show/);
  });

  it('signed in on a deployment without 0028: a neutral note, no fake data and no controls', () => {
    recipientsFixture.state = { status: 'UNAVAILABLE', recipients: [], code: 'RECIPIENTS_UNAVAILABLE' };
    const html = section(state(true, true));
    expect(html).toContain('data-recipients="unavailable">Saved recipients are not available on this deployment yet.</p>');
    expect(html).not.toMatch(/<button|<input|ux-count|<li/);
    recipientsFixture.state = { status: 'SIGNED_OUT', recipients: [], code: 'ACCOUNT_SESSION_REQUIRED' };
    expect(section(state(true, true))).toContain('Sign in to save the addresses you send to');
  });

  it('lists each recipient with its name, ecosystem, FULL address and derived status, says a name is not proof of ownership, and offers Add, rename and remove', () => {
    recipientsFixture.state = { status: 'READY', code: null, recipients: [recipient('a', 'Carteira da empresa', RCP_EVM, 'EVM', 'ACCOUNT_WALLET'),
      recipient('b', 'Maria', RCP_SOL, 'SOLANA', 'EXTERNAL')] };
    const html = section(state(true, true));
    expect(html).toContain('<span class="ux-count">2</span>');
    expect(html).toContain('It is not proof of who owns the address and it authorizes nothing');
    expect(html).toMatch(/<button type="button" class="ux-button">[\s\S]*?Add recipient<\/button>/);
    expect(html).toContain(`<code class="ux-mono" data-recipient-address="">${RCP_EVM}</code>`);
    expect(html).toContain(`<code class="ux-mono" data-recipient-address="">${RCP_SOL}</code>`);
    expect(html).toContain('aria-label="Carteira da empresa, EVM" data-recipient-status="ACCOUNT_WALLET"');
    expect(html).toContain('aria-label="Maria, Solana" data-recipient-status="EXTERNAL"');
    expect(html).toContain('<span class="ux-tag" data-tone="soon">Your account wallet</span>');
    expect(html).toContain('<span class="ux-tag" data-tone="neutral">External</span>');
    for (const label of ['Copy Maria address', 'Rename Maria', 'Remove Maria', 'More actions for Carteira da empresa']) expect(html).toContain(`aria-label="${label}"`);
    // No shortened address, no secret affordance, no inline editing until asked.
    expect(html).not.toMatch(/0x5290…|private key|seed phrase|type="password"|<input/i);
  });

  it('an empty list explains what saving does; a refused read keeps a retry, not an empty list', () => {
    recipientsFixture.state = { status: 'READY', recipients: [], code: null };
    const empty = section(state(true, true));
    expect(empty).toContain('<span class="ux-count">0</span>');
    expect(empty).toContain('Save the addresses you send to under a name you recognize. Review still shows the full address.');
    recipientsFixture.state = { status: 'ERROR', recipients: [], code: 'RECIPIENTS_REQUEST_FAILED' };
    const failed = section(state(true, true));
    expect(failed).toContain('role="alert">Saved recipients could not be reached. Nothing changed. Try again.');
    expect(failed).toContain('>Try again</button>');
    expect(failed).not.toMatch(/ux-count|Add recipient/);
  });
});
