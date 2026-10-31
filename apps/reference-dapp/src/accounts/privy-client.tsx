// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-PRIVY-UX-001: FloFi's browser side of Privy (sign-in, embedded wallets, signing).
 *
 * FloFi's pages talk to Privy only through `useFloFiPrivy()`, one small interface: sign in (Google, email code, Web3 wallet), read the
 * person's embedded wallets, create one, import one, export one, sign, log out. Its implementation is the official Privy React SDK
 * (`@privy-io/react-auth`). Only the MOCKED loopback browser suite replaces it, with a driver the test injects into the page (see
 * `EmulatedPrivy`); FloFi itself contains no emulator.
 *
 * Guarantees kept here, whatever the caller does:
 * - Every wallet operation shows Privy's own confirmation screen (`showWalletUIs: true`, never overridden): a signature always needs the
 *   person's click in Privy's frame, after FloFi's Review and Strategy Manifest.
 * - No session signer, delegated action or authorization key is ever added: creating or importing a wallet authorizes nothing.
 * - Keys live in Privy's isolated frame (`auth.privy.io`); an imported private key is handed to Privy's `importWallet` and nowhere else.
 * - Wallet login is offered for injected browser wallets only; WalletConnect stays off (and is not shipped; pnpm-workspace.yaml).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PrivyProvider, useCreateWallet, useExportWallet, useImportWallet, useLogin, useLoginWithEmail, useLoginWithOAuth, useLogout, usePrivy,
  useSignMessage, useSignTransaction, type PrivyClientConfig, type User } from '@privy-io/react-auth';
import { defaultSolanaRpcsPlugin, toSolanaWalletConnectors, useCreateWallet as useCreateSolanaWallet, useExportWallet as useExportSolanaWallet,
  useImportWallet as useImportSolanaWallet, useSignMessage as useSignSolanaMessage, useSignTransaction as useSignSolanaTransaction,
  useWallets as useSolanaWallets } from '@privy-io/react-auth/solana';
import type { PrivyBrowserConfig } from './privy-server';
import type { WalletEcosystem } from '../wallet/wallet-registry';

export type PrivyEmbedded = { readonly ecosystem: WalletEcosystem; readonly address: string; readonly imported: boolean };
export type PrivyLoginEvent = { readonly wasAlreadyAuthenticated: boolean };
/** An unsigned EIP-1559 transaction FloFi asks Privy to sign (every field already checked against the reviewed attempt). */
export type PrivyEvmTransaction = { readonly to: string; readonly value: string; readonly data: string; readonly chainId: number; readonly nonce: string;
  readonly gas: string; readonly maxFeePerGas: string; readonly maxPriorityFeePerGas: string };
export type FloFiPrivy = {
  readonly ready: boolean;
  readonly authenticated: boolean;
  /** The Privy user id (public DID), or null while signed out. */
  readonly userId: string | null;
  /** The person's embedded wallets as Privy reports them in this browser (public addresses). */
  readonly embedded: readonly PrivyEmbedded[];
  readonly getAccessToken: () => Promise<string | null>;
  /** Called after each completed Privy sign-in in this page (also after Google's redirect back). */
  readonly onLogin: (listener: (event: PrivyLoginEvent) => void) => () => void;
  readonly onLoginError: (listener: (code: string) => void) => () => void;
  readonly loginWithOAuth: (provider: 'google' | 'apple') => Promise<void>;
  readonly sendEmailCode: (email: string) => Promise<void>;
  readonly loginWithEmailCode: (code: string) => Promise<void>;
  /** Opens Privy's wallet chooser (injected EVM and Solana wallets) for Sign-In With Ethereum / Solana. */
  readonly loginWithWallet: () => void;
  readonly createWallet: (ecosystem: WalletEcosystem) => Promise<{ readonly address: string }>;
  readonly importWallet: (ecosystem: WalletEcosystem, privateKey: string) => Promise<{ readonly address: string }>;
  /** Opens Privy's own export screen (the key is shown in Privy's frame, never to FloFi). */
  readonly exportWallet: (ecosystem: WalletEcosystem, address: string) => Promise<void>;
  readonly signEvmTransaction: (address: string, tx: PrivyEvmTransaction) => Promise<string>;
  readonly signEvmMessage: (address: string, message: string) => Promise<string>;
  readonly signSolanaTransaction: (address: string, transaction: Uint8Array) => Promise<Uint8Array>;
  readonly signSolanaMessage: (address: string, message: Uint8Array) => Promise<Uint8Array>;
  readonly logout: () => Promise<void>;
};

const Context = createContext<FloFiPrivy | null>(null);
/** The page's current FloFi Privy interface, for the wallet providers (they live outside React; src/wallet/flofi-privy-signer.ts). */
let current: FloFiPrivy | null = null;
export const currentFloFiPrivy = () => current;
function Registrar() {
  const value = useContext(Context);
  useEffect(() => { current = value; return () => { if (current === value) current = null; }; }, [value]);
  return null;
}
/** Whether this deployment offers FloFi accounts (then Disconnect always ends the account session and returns to `/login`). */
const AccountsContext = createContext(false);
export const useAccountsOffered = () => useContext(AccountsContext);
/** FloFi's Privy interface, or null on a deployment without Privy (pages then say what is unavailable). */
export const useFloFiPrivy = () => useContext(Context);

/** The four mainnets FloFi signs on (privy-chains.test.ts checks them against the action registry). Base is the default. */
export const PRIVY_EVM_CHAINS = Object.freeze([
  { id: 8453, name: 'Base', rpc: 'https://base-mainnet.rpc.privy.systems' },
  { id: 1, name: 'Ethereum', rpc: 'https://mainnet.rpc.privy.systems' },
  { id: 42161, name: 'Arbitrum One', rpc: 'https://arbitrum-mainnet.rpc.privy.systems' },
  { id: 4663, name: 'Robinhood Chain', rpc: 'https://rpc.mainnet.chain.robinhood.com' },
] as const);
type Chain = NonNullable<PrivyClientConfig['supportedChains']>[number];
const chains = PRIVY_EVM_CHAINS.map(chain => ({ id: chain.id, name: chain.name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [chain.rpc] } } }) as unknown as Chain);

/** Privy's configuration for FloFi. Exported for its unit test: these choices are security properties, not styling. */
export function floFiPrivyConfig(config: Pick<PrivyBrowserConfig, 'apple'>, nonce?: string): PrivyClientConfig {
  return {
    loginMethods: config.apple ? ['google', 'apple', 'email', 'wallet'] : ['google', 'email', 'wallet'],
    appearance: { theme: 'dark', accentColor: '#2343D9', logo: '/brand/flofi-wordmark-dark.png', landingHeader: 'Sign in to FloFi',
      walletChainType: 'ethereum-and-solana', showWalletLoginFirst: false,
      walletList: ['detected_ethereum_wallets', 'detected_solana_wallets', 'metamask', 'phantom', 'rabby_wallet', 'coinbase_wallet', 'solflare', 'backpack'] },
    // Wallets are created only when the person clicks Create wallet; Privy's confirmation screens are always shown.
    embeddedWallets: { ethereum: { createOnLogin: 'off' }, solana: { createOnLogin: 'off' }, showWalletUIs: true },
    externalWallets: { walletConnect: { enabled: false }, solana: { connectors: toSolanaWalletConnectors({ shouldAutoConnect: false }) } },
    supportedChains: chains, defaultChain: chains[0]!,
    plugins: [defaultSolanaRpcsPlugin()],
    legal: { privacyPolicyUrl: '/privacy' },
    ...nonce ? { scriptNonce: nonce } : {},
  };
}

const PRIVY_CODES: readonly [RegExp, string][] = [
  [/exited|closed|cancel|rejected|denied|user_exited/i, 'PRIVY_USER_CANCELLED'],
  [/already has (an )?(embedded|imported)/i, 'PRIVY_WALLET_LIMIT'],
  [/invalid.*(private )?key|private key/i, 'PRIVY_PRIVATE_KEY_INVALID'],
  [/code|otp/i, 'PRIVY_EMAIL_CODE_INVALID'],
  [/not (logged|authenticated)|must be authenticated|no user/i, 'PRIVY_SESSION_REQUIRED'],
  [/network|fetch|timeout|unavailable/i, 'PRIVY_UNAVAILABLE'],
];
/** A stable FloFi code for a Privy error (never the provider's own text, which could echo input). */
export function privyErrorCode(cause: unknown, fallback = 'PRIVY_REQUEST_FAILED'): string {
  const text = cause instanceof Error ? `${cause.message} ${(cause as { privyErrorCode?: string }).privyErrorCode ?? ''}` : typeof cause === 'string' ? cause : '';
  if (/^[A-Z][A-Z0-9_]{2,80}$/.test(text.trim())) return text.trim();
  return PRIVY_CODES.find(([pattern]) => pattern.test(text))?.[1] ?? fallback;
}
const fail = (code: string): never => { throw new Error(code); };

/** Embedded wallets of a Privy user (client view). */
export function embeddedWallets(user: User | null): PrivyEmbedded[] {
  return (user?.linkedAccounts ?? []).flatMap(account => {
    const wallet = account as { type?: string; walletClientType?: string; connectorType?: string; chainType?: string; address?: string; imported?: boolean };
    if (wallet.type !== 'wallet' || wallet.walletClientType !== 'privy' || (wallet.chainType !== 'ethereum' && wallet.chainType !== 'solana') || typeof wallet.address !== 'string') return [];
    const ecosystem: WalletEcosystem = wallet.chainType === 'ethereum' ? 'evm' : 'solana';
    return [{ ecosystem, address: ecosystem === 'evm' ? wallet.address.toLowerCase() : wallet.address, imported: wallet.imported === true }];
  });
}

function PrivyBridge({ children }: { children: ReactNode }) {
  const privy = usePrivy();
  const loginListeners = useRef(new Set<(event: PrivyLoginEvent) => void>()), errorListeners = useRef(new Set<(code: string) => void>());
  const emit = useCallback((event: PrivyLoginEvent) => { for (const listener of [...loginListeners.current]) listener(event); }, []);
  const emitError = useCallback((cause: unknown) => { const code = privyErrorCode(cause, 'PRIVY_SIGN_IN_FAILED'); for (const listener of [...errorListeners.current]) listener(code); }, []);
  const callbacks = useMemo(() => ({ onComplete: (params: { wasAlreadyAuthenticated: boolean }) => emit({ wasAlreadyAuthenticated: params.wasAlreadyAuthenticated }),
    onError: (cause: unknown) => emitError(cause) }), [emit, emitError]);
  const { login } = useLogin(callbacks);
  const oauth = useLoginWithOAuth(callbacks);
  const email = useLoginWithEmail(callbacks);
  const { logout } = useLogout();
  const { createWallet: createEvm } = useCreateWallet();
  const { createWallet: createSolana } = useCreateSolanaWallet();
  const { importWallet: importEvm } = useImportWallet();
  const { importWallet: importSolana } = useImportSolanaWallet();
  const { exportWallet: exportEvm } = useExportWallet();
  const { exportWallet: exportSolana } = useExportSolanaWallet();
  const { signTransaction: signEvm } = useSignTransaction();
  const { signMessage: signEvmText } = useSignMessage();
  const { signTransaction: signSolana } = useSignSolanaTransaction();
  const { signMessage: signSolanaText } = useSignSolanaMessage();
  const { wallets: solanaWallets } = useSolanaWallets();
  const solanaWallet = useCallback((address: string) => solanaWallets.find(wallet => wallet.address === address)
    ?? fail('FLOFI_WALLET_ACCOUNT_MISMATCH'), [solanaWallets]);

  const value = useMemo<FloFiPrivy>(() => {
    const embedded = embeddedWallets(privy.user);
    const own = (ecosystem: WalletEcosystem, address: string) => embedded.some(wallet => wallet.ecosystem === ecosystem
      && wallet.address === (ecosystem === 'evm' ? address.toLowerCase() : address)) || fail('FLOFI_WALLET_ACCOUNT_MISMATCH');
    const wrap = async <T,>(run: () => Promise<T>, fallback: string): Promise<T> => { try { return await run(); } catch (cause) { throw new Error(privyErrorCode(cause, fallback), { cause }); } };
    return {
      ready: privy.ready, authenticated: privy.ready && privy.authenticated, userId: privy.user?.id ?? null, embedded,
      getAccessToken: () => privy.getAccessToken().catch(() => null),
      onLogin: listener => { loginListeners.current.add(listener); return () => { loginListeners.current.delete(listener); }; },
      onLoginError: listener => { errorListeners.current.add(listener); return () => { errorListeners.current.delete(listener); }; },
      loginWithOAuth: provider => wrap(() => oauth.initOAuth({ provider }), 'PRIVY_SIGN_IN_FAILED'),
      sendEmailCode: address => wrap(() => email.sendCode({ email: address }), 'PRIVY_EMAIL_CODE_FAILED'),
      loginWithEmailCode: code => wrap(() => email.loginWithCode({ code }), 'PRIVY_EMAIL_CODE_INVALID'),
      loginWithWallet: () => login({ loginMethods: ['wallet'], walletChainType: 'ethereum-and-solana' }),
      createWallet: ecosystem => wrap(async () => {
        const wallet = ecosystem === 'evm' ? await createEvm() : (await createSolana()).wallet;
        return { address: ecosystem === 'evm' ? wallet.address.toLowerCase() : wallet.address };
      }, 'PRIVY_WALLET_CREATE_FAILED'),
      importWallet: (ecosystem, privateKey) => wrap(async () => {
        const wallet = ecosystem === 'evm' ? await importEvm({ privateKey }) : await importSolana({ privateKey });
        return { address: ecosystem === 'evm' ? wallet.address.toLowerCase() : wallet.address };
      }, 'PRIVY_WALLET_IMPORT_FAILED'),
      exportWallet: (ecosystem, address) => wrap(async () => { own(ecosystem, address); await (ecosystem === 'evm' ? exportEvm({ address }) : exportSolana({ address })); },
        'PRIVY_WALLET_EXPORT_FAILED'),
      signEvmTransaction: (address, tx) => wrap(async () => {
        own('evm', address);
        const { signature } = await signEvm({ from: address, to: tx.to, value: tx.value, data: tx.data, chainId: tx.chainId, nonce: tx.nonce, gasLimit: tx.gas,
          maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, type: 2 }, { address });
        return signature;
      }, 'FLOFI_WALLET_SIGNATURE_UNKNOWN'),
      signEvmMessage: (address, message) => wrap(async () => { own('evm', address); return (await signEvmText({ message }, { address })).signature; }, 'FLOFI_WALLET_SIGNATURE_UNKNOWN'),
      signSolanaTransaction: (address, transaction) => wrap(async () => {
        own('solana', address);
        return (await signSolana({ transaction, wallet: solanaWallet(address), chain: 'solana:mainnet' })).signedTransaction;
      }, 'FLOFI_WALLET_SIGNATURE_UNKNOWN'),
      signSolanaMessage: (address, message) => wrap(async () => { own('solana', address); return (await signSolanaText({ message, wallet: solanaWallet(address) })).signature; },
        'FLOFI_WALLET_SIGNATURE_UNKNOWN'),
      logout: () => logout().catch(() => undefined),
    };
  }, [privy, oauth, email, login, logout, createEvm, createSolana, importEvm, importSolana, exportEvm, exportSolana, signEvm, signEvmText, signSolana,
    signSolanaText, solanaWallet]);
  return <Context.Provider value={value}><Registrar/>{children}</Context.Provider>;
}

/**
 * The MOCKED loopback browser suite's stand-in for Privy (e2e/privy-emulator-client.js, injected by the test into the page). FloFi uses it
 * only when the server itself runs in MOCKED loopback mode (`FLOFI_PRIVY_E2E`, refused on every hosted deployment) and the page is served
 * from a loopback host; otherwise there is no Privy at all (fail closed). The implementation lives in the test harness, not in FloFi.
 */
export type PrivyDriver = Omit<FloFiPrivy, 'ready' | 'authenticated' | 'userId' | 'embedded'> & {
  readonly snapshot: () => { readonly ready: boolean; readonly authenticated: boolean; readonly userId: string | null; readonly embedded: readonly PrivyEmbedded[] };
  readonly subscribe: (listener: () => void) => () => void;
};
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);
function loopbackDriver(): PrivyDriver | null {
  if (typeof window === 'undefined' || !LOOPBACK_HOSTS.has(window.location.hostname)) return null;
  const driver = (window as { __FLOFI_PRIVY_E2E__?: PrivyDriver }).__FLOFI_PRIVY_E2E__;
  return driver && typeof driver.snapshot === 'function' && typeof driver.subscribe === 'function' ? driver : null;
}
const NO_DRIVER = Object.freeze({ ready: false, authenticated: false, userId: null, embedded: Object.freeze([]) as readonly PrivyEmbedded[] });
function EmulatedPrivy({ children }: { children: ReactNode }) {
  const [driver, setDriver] = useState<PrivyDriver | null>(null);
  useEffect(() => { setDriver(loopbackDriver()); }, []);
  const subscribe = useCallback((listener: () => void) => driver?.subscribe(listener) ?? (() => undefined), [driver]);
  const snapshot = useSyncExternalStore(subscribe, () => driver?.snapshot() ?? NO_DRIVER, () => NO_DRIVER);
  const value = useMemo<FloFiPrivy | null>(() => driver ? { ...driver, ...snapshot } : null, [driver, snapshot]);
  return <Context.Provider value={value}><Registrar/>{children}</Context.Provider>;
}

/**
 * Wraps a page in FloFi's Privy context. `config` comes from the server (`accountState().privy`): null means Privy is not configured here.
 * `nonce` is the page's CSP nonce (account pages), passed to Privy for the scripts it adds.
 */
export function FloFiPrivyProvider({ config, accounts = false, nonce, children }: { config: PrivyBrowserConfig | null; accounts?: boolean; nonce?: string;
  children: ReactNode }) {
  const settings = useMemo(() => config ? floFiPrivyConfig(config, nonce) : null, [config, nonce]);
  const inner = !config || !settings ? <Context.Provider value={null}>{children}</Context.Provider>
    : config.e2e ? <EmulatedPrivy>{children}</EmulatedPrivy>
      : <PrivyProvider appId={config.appId} config={settings}><PrivyBridge>{children}</PrivyBridge></PrivyProvider>;
  return <AccountsContext.Provider value={accounts}>{inner}</AccountsContext.Provider>;
}
export { Context as FloFiPrivyContext };
/** Re-renders when Privy finishes loading (for effects that must wait for `ready`). */
export function useWhenPrivyReady(run: (privy: FloFiPrivy) => void | (() => void)) {
  const privy = useFloFiPrivy();
  const ready = privy?.ready ?? false;
  useEffect(() => { if (privy && ready) return run(privy) ?? undefined; }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
}
