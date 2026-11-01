// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-AUTH-WALLETS-001: what FloFi Wallet's screens show before any interaction: an honest unavailable page, a server render that
// touches no browser state, unlock methods with their availability, Sign disabled until armed, the legacy wallet list and the export
// warning. Since BUILD-FLOFI-PRIVY-UX-001 FloFi Wallet (Turnkey) is legacy and export-only: it has no signing screens any more (a signing
// request is refused, see wallet-app.test.tsx), and the decoding modules keep their own tests.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExportRequest, WalletList } from './operations';
import type { RequestEnv, WalletAppConfig } from './request-parts';
import { SignControls } from './request-parts';
import { UnlockPanel } from './unlock-panel';
import type { WalletContext } from './wallet-api';
import { WalletApp } from './wallet-app';
import { WalletDone } from './wallet-done';
import { WalletUnavailable } from './wallet-shell';

vi.mock('./provider-client', () => ({ walletPublicKey: vi.fn(), clientSignatureOver: vi.fn(), forgetWalletKey: vi.fn(), createWallet: vi.fn(), openImportFrame: vi.fn(),
  openExportFrame: vi.fn(), signEvmTransaction: vi.fn(), signSolanaMessage: vi.fn(), signSignInMessage: vi.fn(), WalletSigningError: class extends Error {} }));

const EVM = '0x' + 'a'.repeat(40);
const config: WalletAppConfig = { appOrigin: 'https://flofi.xyz', walletOrigin: 'https://wallet.flofi.xyz', otpSignerPublicKey: null,
  frames: { exportIframeUrl: 'https://export.turnkey.com', importIframeUrl: 'https://import.turnkey.com' }, unlock: { email: true, google: false, apple: true } };
const wallet = { id: `evm:${EVM}`, ecosystem: 'evm', address: EVM, origin: 'generated', provider: 'turnkey', providerName: 'FloFi wallet', export: 'recovery-phrase',
  label: 'Main EVM', addedAt: '2026-10-31T10:00:00.000Z' } as const;
const context: WalletContext = { accountId: `acct_${'1'.repeat(32)}`, label: 'ana@example.com', methods: ['email', 'google'], unlocked: true, wallets: [wallet],
  organization: { organizationId: '0b5f2a8e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', userId: '1b5f2a8e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', login: 'email' },
  unlockedAt: null, unlockedUntil: null, unlockedKey: null };
const env = (patch: Partial<RequestEnv> = {}): RequestEnv => ({ id: 'req_12345678', config, appHost: 'flofi.xyz', context, unlocked: true, freshUnlock: true,
  onUnlocked: vi.fn(), onContext: vi.fn(), onLockRequired: vi.fn(), setSigning: vi.fn(), succeed: vi.fn(), refuse: vi.fn(), ...patch });
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('FloFi Wallet screens', () => {
  it('says plainly when this deployment has no FloFi Wallet', () => {
    const html = renderToStaticMarkup(<WalletUnavailable appOrigin="https://flofi.xyz"/>);
    expect(text(html)).toContain('FloFi Wallet isn’t available here');
    expect(html).toContain('href="https://flofi.xyz/app"');
  });
  it('renders on the server without touching the browser, waiting for its opener', () => {
    const html = renderToStaticMarkup(<WalletApp config={config}/>);
    expect(html).toMatch(/role="status"[^>]*>Opening FloFi Wallet…/);
    expect(text(html)).toContain('only here, at wallet.flofi.xyz');
    expect(html).not.toContain('FloFi account');
  });
  it('the sign-in result page reports success or the reason', () => {
    expect(text(renderToStaticMarkup(<WalletDone result="unlocked"/>))).toContain('FloFi Wallet is unlocked');
    expect(renderToStaticMarkup(<WalletDone result="WALLET_UNLOCK_IDENTITY_MISMATCH"/>)).toMatch(/role="alert"[^>]*>That Google or Apple account isn’t the one linked/);
  });
  it('offers the account’s unlock methods, disabling those this deployment cannot run', () => {
    const html = renderToStaticMarkup(<UnlockPanel config={config} context={context} onUnlocked={vi.fn()}/>);
    expect(html).toMatch(/<button type="button" class="[^"]*"[^>]*>.*?Email me a code/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Not available on this deployment yet"[^>]*>.*?Continue with Google/);
    expect(html).not.toContain('Continue with Apple');
    expect(text(renderToStaticMarkup(<UnlockPanel config={config} context={{ ...context, methods: [] }} onUnlocked={vi.fn()}/>)))
      .toContain('This FloFi account has no sign-in that can unlock FloFi Wallet');
  });
  it('keeps Sign disabled until the window has had attention', () => {
    const html = renderToStaticMarkup(<SignControls id="req_12345678" ready busy={false} label="Sign" busyLabel="Signing…" onSign={vi.fn()} onCancel={vi.fn()}/>);
    expect(html).toMatch(/<button type="button" class="[^"]*" disabled="" aria-describedby="req_12345678-arming">Sign<\/button>/);
    expect(text(html)).toContain('Click this window to continue.');
  });
  it('lists the legacy wallets with their addresses, and says plainly when the account has none', () => {
    const listed = text(renderToStaticMarkup(<WalletList wallets={[wallet]}/>));
    expect(listed).toContain('Main EVM');
    expect(listed).toContain(EVM);
    const none = text(renderToStaticMarkup(<WalletList wallets={[]}/>));
    expect(none).toContain('This FloFi account has no wallets from the earlier FloFi Wallet.');
    expect(none).not.toContain(EVM);
  });
  it('asks for a fresh unlock before export, then for an explicit acknowledgement', () => {
    const stale = text(renderToStaticMarkup(<ExportRequest env={env({ freshUnlock: false })} walletId={wallet.id} kind="recovery-phrase"/>));
    expect(stale).toContain('Unlock again to export');
    expect(stale).not.toContain('I understand');
    const fresh = renderToStaticMarkup(<ExportRequest env={env()} walletId={wallet.id} kind="recovery-phrase"/>);
    expect(text(fresh)).toContain('Anyone who sees this recovery phrase can take everything in this wallet');
    expect(fresh).toMatch(/<input type="checkbox"\/>/);
    expect(fresh).toMatch(/disabled=""[^>]*>Show recovery phrase<\/button>/);
    expect(renderToStaticMarkup(<ExportRequest env={env()} walletId={`evm:0x${'c'.repeat(40)}`} kind="recovery-phrase"/>)).toBe('');
  });
});
