// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Passkeys and Credentials → Automatic execution reuse the connected wallet's server-verified session (the shell's `useWalletProof`, real here):
 * a valid, unexpired session of exactly that wallet opens the manager without a click or any wallet request; otherwise the explicit proof stays.
 * While the session is read, the page is neutral (neither the proof button nor the manager). Passkey registration and revocation stay explicit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { deferred, HookHarness } from '../test-utils/hook-harness';
import { ExecutionCredentials, PasskeysPanel } from './delegation-credentials';
import { WalletProof, useWalletProof } from './wallet-proof';
import type { DelegationOverviewView } from '../delegation/views';

type Session = { account: string; expiresAt: string } | null;
const w = vi.hoisted(() => ({ evm: { account: null as string | null, restoring: false, connectWith: vi.fn() },
  solana: { session: null, restoring: false, connectWith: vi.fn(), switchClusterTo: vi.fn() },
  privy: null as { ready: boolean; userId: string | null } | null, enabled: true as boolean,
  evmStatus: vi.fn(), solanaStatus: vi.fn(), evmChallenge: vi.fn(), evmSignIn: vi.fn(), solanaChallenge: vi.fn(), solanaSignIn: vi.fn(),
  walletRequest: vi.fn(), signMessage: vi.fn(), choose: vi.fn(), overview: vi.fn(), passkeyOptions: vi.fn(), passkeyRegister: vi.fn(), passkeyRevoke: vi.fn(),
  createPasskey: vi.fn(), credentialRevoke: vi.fn(), signDelegation: vi.fn(), signSolanaWith: vi.fn(), sendRevocation: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
vi.mock('../app/delegation-action', () => ({ delegationEnabled: async () => ({ enabled: w.enabled }), delegationOverview: w.overview, passkeyOptions: w.passkeyOptions,
  passkeyRegister: w.passkeyRegister, passkeyRevoke: w.passkeyRevoke, credentialRevoke: w.credentialRevoke, credentialComplete: vi.fn(), credentialPrepare: vi.fn(),
  credentialReverify: vi.fn(), credentialRevocationComplete: vi.fn() }));
vi.mock('./delegation-browser', () => ({ createPasskey: w.createPasskey, passkeysSupported: () => true, sendRevocation: w.sendRevocation, signDelegation: w.signDelegation,
  signSolanaWith: w.signSolanaWith }));
vi.mock('./delegated-automations', () => ({ DELEGATION_ERROR_TEXT: {} }));
vi.mock('./wallet-authority-epoch', () => ({ useWalletAuthorityEpoch: () => ({ epoch: '0:0', read: () => '0:0' }) }));
vi.mock('../state/build009-wallet-store', () => ({ useBuild009Wallet: () => w.evm, useOptionalBuild009Wallet: () => w.evm }));
vi.mock('../state/jupiter-store', () => ({ useJupiter: () => w.solana, useOptionalJupiter: () => w.solana }));
vi.mock('./wallet-selector', () => ({ useWalletSelector: () => ({ choose: w.choose }) }));
vi.mock('../app/wallet-session-action', () => ({ walletSessionStatus: w.evmStatus, solanaSessionStatus: w.solanaStatus, walletSignIn: w.evmSignIn,
  walletSignInChallenge: w.evmChallenge, solanaSignIn: w.solanaSignIn, solanaSignInChallenge: w.solanaChallenge }));
vi.mock('../wallet/evm-discovery', () => ({ injected: () => ({ request: w.walletRequest }), chooseEvmWallet: () => ({ request: w.walletRequest }) }));
vi.mock('../wallet/solana-wallet', () => ({ signSolanaMessage: w.signMessage, connectSolanaWallet: vi.fn() }));
vi.mock('../wallet/wallet-registry', () => ({ updateWalletPreference: vi.fn() }));
vi.mock('../accounts/privy-context', () => ({ useFloFiPrivy: () => w.privy }));
vi.mock('../i18n/locale', () => ({ useLocale: () => ({ language: 'EN', t: (value: string, ...args: unknown[]) => value.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)])) }) }));

type Props = Record<string, unknown> & { children?: ReactNode };
type Element = ReactElement<Props>;
function nodes(value: ReactNode): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  return [value as Element, ...nodes((value as Element).props.children)];
}
const textOf = (value: ReactNode): string => Array.isArray(value) ? value.map(textOf).join('') : isValidElement(value) ? textOf((value as Element).props.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const A = '0x52908400098527886e0f7030069857d2e4169ee7', CHECKSUMMED = '0x52908400098527886E0F7030069857D2E4169EE7', B = '0x' + 'b'.repeat(40);
const later = (ms = 60_000) => new Date(Date.now() + ms).toISOString();
const overview: DelegationOverviewView = { passkeys: [{ passkeyId: 'pk-1', label: 'Laptop', revoked: false, createdAt: '2026-11-01T00:00:00.000Z' }], credentials: [],
  availability: {} } as unknown as DelegationOverviewView;

let host: HookHarness;
/** The product shell's wiring (app-shell.tsx): the owner is the connected EVM wallet, the proof is the shell's `useWalletProof` of its namespace. */
function page(workspace: 'passkeys' | 'credentials'): { tree: ReactNode; text: string; proof: ReturnType<typeof useWalletProof> } {
  let proof!: ReturnType<typeof useWalletProof>;
  const tree = host.render(() => {
    const owner = w.evm.account ? { namespace: 'eip155' as const, address: w.evm.account } : null;
    proof = useWalletProof(owner?.namespace ?? null);
    const outer = (workspace === 'passkeys' ? PasskeysPanel({ access: { owner, proof }, placeholder: 'Coming soon' }) : ExecutionCredentials({ access: { owner, proof } })) as Element;
    return (outer.type as (props: Props) => ReactNode)(outer.props);
  });
  return { tree, text: textOf(tree), proof };
}
const proveButton = (tree: ReactNode) => nodes(tree).some(e => e.type === WalletProof);
const manager = (tree: ReactNode) => nodes(tree).some(e => e.type === 'form' && e.props['aria-label'] === 'Add a passkey');
/** Nothing in the automatic path asks a wallet, a passkey or the server to sign, register or revoke anything. */
function nothingAsked() {
  for (const spy of [w.walletRequest, w.evmChallenge, w.evmSignIn, w.solanaChallenge, w.solanaSignIn, w.signMessage, w.choose, w.evm.connectWith, w.solana.connectWith,
    w.passkeyOptions, w.passkeyRegister, w.passkeyRevoke, w.createPasskey, w.credentialRevoke, w.signDelegation, w.signSolanaWith, w.sendRevocation]) expect(spy).not.toHaveBeenCalled();
}

beforeEach(() => {
  host = new HookHarness(); vi.resetAllMocks(); vi.stubGlobal('window', new EventTarget());
  Object.assign(w.evm, { account: A, restoring: false }); Object.assign(w.solana, { session: null, restoring: false }); w.privy = null; w.enabled = true;
  w.evmStatus.mockResolvedValue(null); w.solanaStatus.mockResolvedValue(null); w.overview.mockResolvedValue({ ok: true, value: overview });
});
afterEach(() => { host.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Passkeys reuses the connected wallet\'s server-verified session', () => {
  it('opens the manager with a valid session: no proof button, no click, no signature; neutral while the session is read', async () => {
    const read = deferred<Session>(); w.evmStatus.mockReturnValueOnce(read.promise);
    page('passkeys'); await flush(); let view = page('passkeys');
    expect(view.text).toContain('Checking passkeys…'); expect(proveButton(view.tree)).toBe(false); expect(manager(view.tree)).toBe(false);
    // The session answers; the manager then reads its overview (one render each).
    read.resolve({ account: A, expiresAt: later() }); await flush(); page('passkeys'); await flush(); view = page('passkeys');
    expect(manager(view.tree)).toBe(true); expect(proveButton(view.tree)).toBe(false); expect(view.text).toContain('Laptop');
    expect(view.text).not.toContain('Verify wallet ownership to manage passkeys.');
    expect(w.overview).toHaveBeenCalledWith({ namespace: 'eip155', address: A });
    nothingAsked();
  });
  it('keeps the explicit proof when no server-verified session exists (connection alone is never proof)', async () => {
    page('passkeys'); await flush(); const view = page('passkeys');
    expect(proveButton(view.tree)).toBe(true); expect(view.text).toContain('Verify wallet ownership to manage passkeys.'); expect(manager(view.tree)).toBe(false);
    expect(w.overview).not.toHaveBeenCalled(); nothingAsked();
  });
  it('keeps the proof button for an expired session and returns to it when a valid session expires', async () => {
    w.evmStatus.mockResolvedValue({ account: A, expiresAt: new Date(Date.now() - 1).toISOString() });
    page('passkeys'); await flush(); expect(proveButton(page('passkeys').tree)).toBe(true);
    host.unmount(); host = new HookHarness(); vi.useFakeTimers();
    w.evmStatus.mockResolvedValue({ account: A, expiresAt: later(1_000) }); page('passkeys'); await flush(); expect(manager(page('passkeys').tree)).toBe(true);
    w.evmStatus.mockResolvedValue(null); await vi.advanceTimersByTimeAsync(1_000);
    const view = page('passkeys'); expect(manager(view.tree)).toBe(false); expect(proveButton(view.tree)).toBe(true); nothingAsked();
  });
  it('matches a checksummed wallet to its lowercase session, but never a session of another address', async () => {
    w.evm.account = CHECKSUMMED; w.evmStatus.mockResolvedValue({ account: A, expiresAt: later() });
    page('passkeys'); await flush(); expect(manager(page('passkeys').tree)).toBe(true);
    host.unmount(); host = new HookHarness(); w.evm.account = B;
    page('passkeys'); await flush(); const view = page('passkeys'); expect(manager(view.tree)).toBe(false); expect(proveButton(view.tree)).toBe(true); nothingAsked();
  });
  it('a FloFi account switch hides the manager at once and reads the session again', async () => {
    w.privy = { ready: true, userId: 'did:privy:alice' }; w.evmStatus.mockResolvedValue({ account: A, expiresAt: later() });
    page('passkeys'); await flush(); expect(manager(page('passkeys').tree)).toBe(true);
    const again = deferred<Session>(); w.evmStatus.mockReturnValueOnce(again.promise); w.privy = { ready: true, userId: 'did:privy:bob' };
    let view = page('passkeys'); expect(manager(view.tree)).toBe(false); expect(proveButton(view.tree)).toBe(false); expect(view.text).toContain('Checking passkeys…');
    again.resolve(null); await flush(); view = page('passkeys'); expect(proveButton(view.tree)).toBe(true); nothingAsked();
  });
  it('a slow session read for wallet A that answers after the switch to wallet B never unlocks B', async () => {
    const forA = deferred<Session>(), forB = deferred<Session>(); w.evmStatus.mockReturnValueOnce(forA.promise).mockReturnValueOnce(forB.promise);
    page('passkeys'); await flush(); w.evm.account = B; page('passkeys');
    forA.resolve({ account: B, expiresAt: later() }); await flush();
    let view = page('passkeys'); expect(manager(view.tree)).toBe(false); expect(proveButton(view.tree)).toBe(false); expect(view.text).toContain('Checking passkeys…');
    forB.resolve(null); await flush(); view = page('passkeys'); expect(manager(view.tree)).toBe(false); expect(proveButton(view.tree)).toBe(true); nothingAsked();
  });
  it('a disconnect closes the manager (no wallet: the workspace placeholder)', async () => {
    w.evmStatus.mockResolvedValue({ account: A, expiresAt: later() }); page('passkeys'); await flush(); expect(manager(page('passkeys').tree)).toBe(true);
    w.evm.account = null; const view = page('passkeys'); expect(manager(view.tree)).toBe(false); expect(view.text).toBe('Coming soon'); nothingAsked();
  });
  it('waits for a remembered wallet being read back instead of claiming "Coming soon"', async () => {
    Object.assign(w.evm, { account: null, restoring: true }); page('passkeys'); await flush();
    expect(page('passkeys').text).toContain('Checking passkeys…');
    w.evm.restoring = false; expect(page('passkeys').text).toBe('Coming soon');
    expect(w.evmStatus).not.toHaveBeenCalled(); nothingAsked();
  });
});

describe('Credentials → Automatic execution reuses the same session', () => {
  it('opens with a valid session (no click, no signature), is neutral while it is read, and keeps the explicit proof without one', async () => {
    const read = deferred<Session>(); w.evmStatus.mockReturnValueOnce(read.promise);
    page('credentials'); await flush(); let view = page('credentials');
    expect(view.text).toContain('Checking wallet ownership…'); expect(proveButton(view.tree)).toBe(false); expect(view.text).not.toContain('Enrollment is retired');
    read.resolve({ account: A, expiresAt: later() }); await flush(); view = page('credentials');
    expect(view.text).toContain('Enrollment is retired'); expect(proveButton(view.tree)).toBe(false); expect(view.text).not.toContain('Verify wallet ownership');
    host.unmount(); host = new HookHarness(); w.evmStatus.mockResolvedValue(null);
    page('credentials'); await flush(); view = page('credentials');
    expect(proveButton(view.tree)).toBe(true); expect(view.text).toContain('Verify wallet ownership to manage automatic execution.'); expect(view.text).not.toContain('Enrollment is retired');
    nothingAsked();
  });
});
