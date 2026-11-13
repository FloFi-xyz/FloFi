// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #149: the official Privy bridge reports "can sign" for an embedded EVM wallet only once Privy's own wallet readiness
 * (`useWallets().ready` of `@privy-io/react-auth`) says so, and follows that readiness when it changes. Privy's SDK is replaced by a
 * stand-in exposing only the hook results the bridge reads; nothing here signs, and the signing gate is untouched.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FloFiPrivy } from './privy-context';

const EVM = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01', SOLANA = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const sdk = vi.hoisted(() => ({ ready: true, authenticated: true, evmWalletsReady: false, solanaReady: false,
  solanaWallets: [] as { address: string; standardWallet: unknown }[] }));
const unused = () => { throw new Error('not used by this test'); };
vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: ({ children }: { children: unknown }) => children,
  usePrivy: () => ({ ready: sdk.ready, authenticated: sdk.authenticated, getAccessToken: async () => null, user: { id: 'did:privy:test', linkedAccounts: [
    { type: 'wallet', walletClientType: 'privy', chainType: 'ethereum', address: EVM, imported: false },
    { type: 'wallet', walletClientType: 'privy', chainType: 'solana', address: SOLANA, imported: false }] } }),
  useWallets: () => ({ wallets: [], ready: sdk.evmWalletsReady }),
  useLogin: () => ({ login: unused }), useLoginWithOAuth: () => ({ initOAuth: unused }), useLoginWithEmail: () => ({ sendCode: unused, loginWithCode: unused }),
  useLogout: () => ({ logout: unused }), useCreateWallet: () => ({ createWallet: unused }), useImportWallet: () => ({ importWallet: unused }),
  useExportWallet: () => ({ exportWallet: unused }), useSignTransaction: () => ({ signTransaction: unused }), useSignMessage: () => ({ signMessage: unused }),
  // BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003: the bridge also wires Privy's typed-data signer (0x Gasless).
  useSignTypedData: () => ({ signTypedData: unused }),
}));
vi.mock('@privy-io/react-auth/solana', () => ({
  defaultSolanaRpcsPlugin: () => ({}), toSolanaWalletConnectors: () => ({}),
  useCreateWallet: () => ({ createWallet: unused }), useImportWallet: () => ({ importWallet: unused }), useExportWallet: () => ({ exportWallet: unused }),
  useSignTransaction: () => ({ signTransaction: unused }), useSignMessage: () => ({ signMessage: unused }),
  useWallets: () => ({ wallets: sdk.solanaWallets, ready: sdk.solanaReady }),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/app' }));

/** The FloFi Privy interface the bridge provides for the current stand-in state (server render of `/app`, where Privy mounts). */
async function bridge(): Promise<FloFiPrivy> {
  const { FloFiPrivyProvider, useFloFiPrivy } = await import('./privy-client');
  let seen: FloFiPrivy | null = null;
  const Probe = () => { seen = useFloFiPrivy(); return null; };
  renderToStaticMarkup(createElement(FloFiPrivyProvider, { config: { appId: 'app-test', apple: false, e2e: false }, children: createElement(Probe) }));
  if (!seen) throw new Error('Privy did not mount');
  return seen;
}
afterEach(() => Object.assign(sdk, { ready: true, authenticated: true, evmWalletsReady: false, solanaReady: false, solanaWallets: [] }));

describe('Privy bridge signing readiness (issue #149)', () => {
  it('does not offer EVM signing until Privy reports its wallets ready, then does', async () => {
    const { floFiPrivyWalletIssue } = await import('./privy-context');
    const loading = await bridge();
    expect(loading.ready).toBe(true);
    expect(loading.embedded.map(wallet => wallet.ecosystem)).toEqual(['evm', 'solana']);
    expect(loading.canSign('evm', EVM)).toBe(false);
    expect(floFiPrivyWalletIssue(loading, 'evm', EVM)).toBe('FLOFI_WALLET_NOT_READY');
    sdk.evmWalletsReady = true;
    const ready = await bridge();
    expect(ready.canSign('evm', EVM)).toBe(true);
    expect(ready.canSign('evm', EVM.toLowerCase())).toBe(true);
    expect(ready.canSign('evm', '0x' + '1'.repeat(40))).toBe(false);
    // Wallet readiness never replaces the session.
    sdk.ready = false;
    expect((await bridge()).canSign('evm', EVM)).toBe(false);
  });
  it('keeps Solana on its own readiness and Privy’s own wallet object, never an external wallet', async () => {
    sdk.evmWalletsReady = true;
    sdk.solanaReady = true;
    sdk.solanaWallets = [{ address: SOLANA, standardWallet: { name: 'Phantom' } }];
    expect((await bridge()).canSign('solana', SOLANA)).toBe(false);
    sdk.solanaWallets = [{ address: SOLANA, standardWallet: { name: 'Privy', isPrivyWallet: true } }];
    expect((await bridge()).canSign('solana', SOLANA)).toBe(true);
    sdk.solanaReady = false;
    expect((await bridge()).canSign('solana', SOLANA)).toBe(false);
  });
});
