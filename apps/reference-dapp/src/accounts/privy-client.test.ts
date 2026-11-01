// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: the Privy configuration choices that are security properties, not styling: wallets are created only on an
 * explicit click, Privy's own confirmation screens are always on, WalletConnect is off, no session signer is configured, and FloFi signs
 * on exactly its four EVM mainnets (the action registry's chain ids).
 */
import { describe, expect, it } from 'vitest';
import { ARBITRUM_ONE, ETHEREUM_MAINNET, ROBINHOOD_CHAIN_MAINNET } from '@defi-workflow-engine/action-registry';
import { embeddedWallets, floFiPrivyConfig, PRIVY_EVM_CHAINS, privyErrorCode, privyOwnSolanaWallets } from './privy-client';
import { PRIVY_CONNECT_SOURCES } from './privy-hosts';

describe('FloFi’s Privy configuration', () => {
  it('creates no wallet at sign-in, always shows Privy’s confirmation screens and offers no WalletConnect', () => {
    const config = floFiPrivyConfig({ apple: false });
    expect(config.embeddedWallets).toMatchObject({ ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' }, showWalletUIs: true });
    expect(config.externalWallets?.walletConnect).toEqual({ enabled: false });
    expect(config.loginMethods).toEqual(['google', 'email', 'wallet']);
    expect(floFiPrivyConfig({ apple: true }).loginMethods).toEqual(['google', 'apple', 'email', 'wallet']);
    expect(JSON.stringify(config)).not.toMatch(/signers|delegat|walletConnectCloudProjectId|sms|passkey/i);
    // No nonce is handed to Privy (Privy 3.51.0 has no such option): what Privy loads must match the page policy's hosts.
    expect(Object.keys(config)).not.toContain('scriptNonce');
  });
  it('signs on exactly Base, Ethereum, Arbitrum One and Robinhood Chain mainnet, each reachable under the CSP', () => {
    expect(PRIVY_EVM_CHAINS.map(chain => chain.id)).toEqual([8453, ETHEREUM_MAINNET.chainId, ARBITRUM_ONE.chainId, ROBINHOOD_CHAIN_MAINNET.chainId]);
    const robinhood = PRIVY_EVM_CHAINS.find(chain => chain.id === 4663)!;
    expect(robinhood.rpc).toBe(ROBINHOOD_CHAIN_MAINNET.rpc);
    const config = floFiPrivyConfig({ apple: false });
    expect(config.defaultChain?.id).toBe(8453);
    for (const chain of PRIVY_EVM_CHAINS) {
      const host = new URL(chain.rpc).hostname;
      expect(PRIVY_CONNECT_SOURCES.some(source => source === `https://${host}` || (source.startsWith('https://*.') && host.endsWith(source.slice('https://*'.length))))).toBe(true);
    }
  });
});

describe('Privy errors and wallets', () => {
  it('maps provider errors to FloFi codes without ever echoing the provider’s text', () => {
    expect(privyErrorCode(new Error('User exited the modal before submitting'))).toBe('PRIVY_USER_CANCELLED');
    expect(privyErrorCode(new Error('User already has an embedded wallet'))).toBe('PRIVY_WALLET_LIMIT');
    expect(privyErrorCode(new Error('Invalid private key provided: 0xdeadbeef…'))).toBe('PRIVY_PRIVATE_KEY_INVALID');
    expect(privyErrorCode(new Error('FLOFI_WALLET_ACCOUNT_MISMATCH'))).toBe('FLOFI_WALLET_ACCOUNT_MISMATCH');
    expect(privyErrorCode(new Error('something odd 0xabc'))).toBe('PRIVY_REQUEST_FAILED');
    expect(privyErrorCode('weird', 'PRIVY_SIGN_IN_FAILED')).toBe('PRIVY_SIGN_IN_FAILED');
  });
  it('lists only Privy embedded wallets (not external wallets) with canonical EVM addresses', () => {
    const user = { linkedAccounts: [
      { type: 'wallet', walletClientType: 'privy', connectorType: 'embedded', chainType: 'ethereum', address: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01', imported: false },
      { type: 'wallet', walletClientType: 'privy', connectorType: 'embedded', chainType: 'solana', address: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', imported: true },
      { type: 'wallet', walletClientType: 'metamask', connectorType: 'injected', chainType: 'ethereum', address: '0x1111111111111111111111111111111111111111' },
      { type: 'email', address: 'a@example.com' },
    ] } as unknown as Parameters<typeof embeddedWallets>[0];
    expect(embeddedWallets(user)).toEqual([
      { ecosystem: 'evm', address: '0xabcdef0123456789abcdef0123456789abcdef01', imported: false },
      { ecosystem: 'solana', address: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', imported: true },
    ]);
    expect(embeddedWallets(null)).toEqual([]);
  });
});

describe('Privy login events', () => {
  it('keeps an event that came before anyone listened for the first subscriber, once, and otherwise delivers live', async () => {
    const { createLoginChannel } = await import('./privy-context');
    const channel = createLoginChannel(), first: unknown[] = [], second: unknown[] = [];
    channel.emit({ wasAlreadyAuthenticated: true });
    const off = channel.subscribe(event => first.push(event));
    channel.subscribe(event => second.push(event));
    await Promise.resolve();
    expect(first).toEqual([{ wasAlreadyAuthenticated: true }]);
    expect(second).toEqual([]);
    channel.emit({ wasAlreadyAuthenticated: false });
    expect(first).toEqual([{ wasAlreadyAuthenticated: true }, { wasAlreadyAuthenticated: false }]);
    expect(second).toEqual([{ wasAlreadyAuthenticated: false }]);
    off();
    channel.emit({ wasAlreadyAuthenticated: false });
    expect(first).toHaveLength(2);
  });
});

describe('Privy Solana wallets', () => {
  it('signs only with Privy’s own embedded wallet, never an external wallet holding the same address, and tolerates odd entries', () => {
    const address = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
    const own = { address, standardWallet: { name: 'Privy', isPrivyWallet: true } }, phantom = { address, standardWallet: { name: 'Phantom' } };
    expect(privyOwnSolanaWallets([phantom, own, { address }, { address, standardWallet: null }, { address, standardWallet: { isPrivyWallet: 'yes' } }])).toEqual([own]);
  });
});
