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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { PrivyProvider, useCreateWallet, useExportWallet, useImportWallet, useLogin, useLoginWithEmail, useLoginWithOAuth, useLogout, usePrivy,
  useSignMessage, useSignTransaction, type PrivyClientConfig, type User } from '@privy-io/react-auth';
import { defaultSolanaRpcsPlugin, toSolanaWalletConnectors, useCreateWallet as useCreateSolanaWallet, useExportWallet as useExportSolanaWallet,
  useImportWallet as useImportSolanaWallet, useSignMessage as useSignSolanaMessage, useSignTransaction as useSignSolanaTransaction,
  useWallets as useSolanaWallets } from '@privy-io/react-auth/solana';
import type { PrivyBrowserConfig } from './privy-server';
import { signerPolicy } from './signer-pages';
import { usePathname } from 'next/navigation';
import { createLoginChannel, FloFiAccountsContext as AccountsContext, FloFiPrivyContext as Context, privyErrorCode, Registrar, useFloFiPrivy, type FloFiPrivy, type PrivyEmbedded, type PrivyLoginEvent,
  type PrivyReview } from './privy-context';
export { currentFloFiPrivy, FloFiPrivyContext, privyErrorCode, useAccountsOffered, useFloFiPrivy, type FloFiPrivy, type PrivyEmbedded, type PrivyEvmTransaction,
  type PrivyLoginEvent, type PrivyReview } from './privy-context';
import type { WalletEcosystem } from '../wallet/wallet-registry';

/** The four mainnets FloFi signs on (privy-client.test.ts checks them against the action registry). Base is the default. */
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
export function floFiPrivyConfig(config: Pick<PrivyBrowserConfig, 'apple'>): PrivyClientConfig {
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
  };
}

const fail = (code: string): never => { throw new Error(code); };
/** Privy's confirmation screen, always shown, with FloFi's server summary of the reviewed attempt when there is one. */
const uiOptions = (review?: PrivyReview) => ({ showWalletUIs: true, buttonText: 'Sign',
  ...review ? { description: review.description, transactionInfo: { title: review.title, action: review.action } } : {} });

/** Embedded wallets of a Privy user (client view). */
export function embeddedWallets(user: User | null): PrivyEmbedded[] {
  return (user?.linkedAccounts ?? []).flatMap(account => {
    const wallet = account as { type?: string; walletClientType?: string; connectorType?: string; chainType?: string; address?: string; imported?: boolean };
    if (wallet.type !== 'wallet' || wallet.walletClientType !== 'privy' || (wallet.chainType !== 'ethereum' && wallet.chainType !== 'solana') || typeof wallet.address !== 'string') return [];
    const ecosystem: WalletEcosystem = wallet.chainType === 'ethereum' ? 'evm' : 'solana';
    return [{ ecosystem, address: ecosystem === 'evm' ? wallet.address.toLowerCase() : wallet.address, imported: wallet.imported === true }];
  });
}

/**
 * Privy's own embedded Solana wallets among the connected ones: their Wallet Standard wallet carries `isPrivyWallet` (Privy's SDK uses the
 * same flag). An external wallet connected through Privy (Phantom, …) never counts, even when it holds the same imported key.
 */
export function privyOwnSolanaWallets<T extends { readonly standardWallet?: unknown }>(wallets: readonly T[]): T[] {
  return wallets.filter(wallet => (wallet.standardWallet as { readonly isPrivyWallet?: unknown } | undefined)?.isPrivyWallet === true);
}

function PrivyBridge({ children }: { children: ReactNode }) {
  const privy = usePrivy();
  const logins = useRef(createLoginChannel()), errorListeners = useRef(new Set<(code: string) => void>());
  const emit = useCallback((event: PrivyLoginEvent) => logins.current.emit(event), []);
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
  const { wallets: connectedSolana, ready: solanaReady } = useSolanaWallets();
  // Only Privy's own embedded Solana wallet (its standard wallet carries `isPrivyWallet`, as Privy's SDK checks): never an external wallet
  // (Phantom, …) connected through Privy, even one holding the same imported key.
  const solanaWallets = useMemo(() => privyOwnSolanaWallets(connectedSolana), [connectedSolana]);
  const solanaWallet = useCallback((address: string) => solanaWallets.find(wallet => wallet.address === address)
    ?? fail('FLOFI_WALLET_ACCOUNT_MISMATCH'), [solanaWallets]);

  const value = useMemo<FloFiPrivy>(() => {
    const embedded = embeddedWallets(privy.user);
    const listed = (ecosystem: WalletEcosystem, address: string) => embedded.some(wallet => wallet.ecosystem === ecosystem
      && wallet.address === (ecosystem === 'evm' ? address.toLowerCase() : address));
    const own = (ecosystem: WalletEcosystem, address: string) => listed(ecosystem, address) || fail('FLOFI_WALLET_ACCOUNT_MISMATCH');
    // Solana signing also needs Privy's Solana wallet object, which loads separately (`useWallets().ready`).
    const canSign = (ecosystem: WalletEcosystem, address: string) => privy.ready && privy.authenticated && listed(ecosystem, address)
      && (ecosystem === 'evm' || solanaReady && solanaWallets.some(wallet => wallet.address === address));
    const wrap = async <T,>(run: () => Promise<T>, fallback: string): Promise<T> => { try { return await run(); } catch (cause) { throw new Error(privyErrorCode(cause, fallback), { cause }); } };
    return {
      ready: privy.ready, authenticated: privy.ready && privy.authenticated, userId: privy.user?.id ?? null, embedded, canSign,
      getAccessToken: () => privy.getAccessToken().catch(() => null),
      onLogin: listener => logins.current.subscribe(listener),
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
      signEvmTransaction: (address, tx, review) => wrap(async () => {
        own('evm', address);
        const { signature } = await signEvm({ from: address, to: tx.to, value: tx.value, data: tx.data, chainId: tx.chainId, nonce: tx.nonce, gasLimit: tx.gas,
          maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, type: 2 }, { address, uiOptions: uiOptions(review) });
        return signature;
      }, 'FLOFI_WALLET_SIGNATURE_UNKNOWN'),
      signEvmMessage: (address, message) => wrap(async () => { own('evm', address); return (await signEvmText({ message }, { address })).signature; }, 'FLOFI_WALLET_SIGNATURE_UNKNOWN'),
      signSolanaTransaction: (address, transaction, review) => wrap(async () => {
        own('solana', address);
        return (await signSolana({ transaction, wallet: solanaWallet(address), chain: 'solana:mainnet', options: { uiOptions: uiOptions(review) } })).signedTransaction;
      }, 'FLOFI_WALLET_SIGNATURE_UNKNOWN'),
      signSolanaMessage: (address, message) => wrap(async () => { own('solana', address); return (await signSolanaText({ message, wallet: solanaWallet(address) })).signature; },
        'FLOFI_WALLET_SIGNATURE_UNKNOWN'),
      logout: () => logout().catch(() => undefined),
    };
  }, [privy, oauth, email, login, logout, createEvm, createSolana, importEvm, importSolana, exportEvm, exportSolana, signEvm, signEvmText, signSolana,
    signSolanaText, solanaWallet, solanaWallets, solanaReady]);
  return <Context.Provider value={value}><Registrar/>{children}</Context.Provider>;
}

/**
 * The MOCKED loopback browser suite's stand-in for Privy (e2e/privy-emulator-client.js, injected by the test into the page). FloFi uses it
 * only when the server itself runs in MOCKED loopback mode (`FLOFI_PRIVY_E2E`, refused on every hosted deployment) and the page is served
 * from a loopback host; otherwise there is no Privy at all (fail closed). The implementation lives in the test harness, not in FloFi.
 */
export type PrivyDriver = Omit<FloFiPrivy, 'ready' | 'authenticated' | 'userId' | 'embedded' | 'canSign'> & {
  readonly snapshot: () => { readonly ready: boolean; readonly authenticated: boolean; readonly userId: string | null; readonly embedded: readonly PrivyEmbedded[] };
  readonly subscribe: (listener: () => void) => () => void;
  /** Test only: receives FloFi's own signing request function (src/wallet/flofi-privy-signer.ts). */
  readonly attachFloFi?: (flofi: { readonly request: (request: never) => Promise<unknown> }) => void;
};
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost']);
function loopbackDriver(): PrivyDriver | null {
  if (typeof window === 'undefined' || !LOOPBACK_HOSTS.has(window.location.hostname)) return null;
  const driver = (window as { __FLOFI_PRIVY_E2E__?: PrivyDriver }).__FLOFI_PRIVY_E2E__;
  return driver && typeof driver.snapshot === 'function' && typeof driver.subscribe === 'function' ? driver : null;
}
const NO_DRIVER = Object.freeze({ ready: false, authenticated: false, userId: null, embedded: Object.freeze([]) as readonly PrivyEmbedded[] });
/** Stub FloFiPrivy while the loopback driver has not attached yet (SSR and the first client paint). Non-null so sign-in SSR matches
 * PrivyBridge: methods unavailable-but-configured, never the false "not configured on this deployment" status. */
const PENDING: FloFiPrivy = Object.freeze({
  ...NO_DRIVER,
  canSign: () => false,
  getAccessToken: async () => null,
  onLogin: () => () => undefined,
  onLoginError: () => () => undefined,
  loginWithOAuth: async () => fail('PRIVY_UNAVAILABLE'),
  sendEmailCode: async () => fail('PRIVY_UNAVAILABLE'),
  loginWithEmailCode: async () => fail('PRIVY_UNAVAILABLE'),
  loginWithWallet: () => fail('PRIVY_UNAVAILABLE'),
  createWallet: async () => fail('PRIVY_UNAVAILABLE'),
  importWallet: async () => fail('PRIVY_UNAVAILABLE'),
  exportWallet: async () => fail('PRIVY_UNAVAILABLE'),
  signEvmTransaction: async () => fail('PRIVY_UNAVAILABLE'),
  signEvmMessage: async () => fail('PRIVY_UNAVAILABLE'),
  signSolanaTransaction: async () => fail('PRIVY_UNAVAILABLE'),
  signSolanaMessage: async () => fail('PRIVY_UNAVAILABLE'),
  logout: async () => undefined,
});
function EmulatedPrivy({ children }: { children: ReactNode }) {
  const [driver, setDriver] = useState<PrivyDriver | null>(null);
  const logins = useRef(createLoginChannel());
  useEffect(() => { setDriver(loopbackDriver()); }, []);
  useEffect(() => driver?.onLogin(event => logins.current.emit(event)), [driver]);
  // The suite drives FloFi's own signing path (gate → Privy → result) the way a wallet store does, through FloFi's real function.
  useEffect(() => { if (driver?.attachFloFi) void import('../wallet/flofi-privy-signer').then(module => driver.attachFloFi!({ request: module.requestThroughPrivy })); }, [driver]);
  const subscribe = useCallback((listener: () => void) => driver?.subscribe(listener) ?? (() => undefined), [driver]);
  const snapshot = useSyncExternalStore(subscribe, () => driver?.snapshot() ?? NO_DRIVER, () => NO_DRIVER);
  const value = useMemo<FloFiPrivy>(() => {
    if (!driver) return PENDING;
    // The stand-in's errors go through the same mapping as Privy's (PrivyBridge): FloFi only ever sees its own codes.
    const wrap = <A extends unknown[], R>(run: (...args: A) => Promise<R>, fallback: string) => async (...args: A): Promise<R> => {
      try { return await run(...args); } catch (cause) { throw new Error(privyErrorCode(cause, fallback), { cause }); }
    };
    const canSign = (ecosystem: WalletEcosystem, address: string) => snapshot.ready && snapshot.authenticated && snapshot.embedded.some(wallet =>
      wallet.ecosystem === ecosystem && wallet.address === (ecosystem === 'evm' ? address.toLowerCase() : address));
    return { ...snapshot, canSign, getAccessToken: driver.getAccessToken, onLogin: listener => logins.current.subscribe(listener), onLoginError: driver.onLoginError, loginWithWallet: driver.loginWithWallet,
      logout: driver.logout, loginWithOAuth: wrap(driver.loginWithOAuth, 'PRIVY_SIGN_IN_FAILED'), sendEmailCode: wrap(driver.sendEmailCode, 'PRIVY_EMAIL_CODE_FAILED'),
      loginWithEmailCode: wrap(driver.loginWithEmailCode, 'PRIVY_EMAIL_CODE_INVALID'), createWallet: wrap(driver.createWallet, 'PRIVY_WALLET_CREATE_FAILED'),
      importWallet: wrap(driver.importWallet, 'PRIVY_WALLET_IMPORT_FAILED'), exportWallet: wrap(driver.exportWallet, 'PRIVY_WALLET_EXPORT_FAILED'),
      signEvmTransaction: wrap(driver.signEvmTransaction, 'FLOFI_WALLET_SIGNATURE_UNKNOWN'), signEvmMessage: wrap(driver.signEvmMessage, 'FLOFI_WALLET_SIGNATURE_UNKNOWN'),
      signSolanaTransaction: wrap(driver.signSolanaTransaction, 'FLOFI_WALLET_SIGNATURE_UNKNOWN'), signSolanaMessage: wrap(driver.signSolanaMessage, 'FLOFI_WALLET_SIGNATURE_UNKNOWN') };
  }, [driver, snapshot]);
  return <Context.Provider value={value}><Registrar/>{children}</Context.Provider>;
}

const NO_CHANGES = () => () => undefined;
/** The path this document was loaded at (Navigation Timing), or null when the browser does not say. */
export function loadedDocumentPath(): string | null {
  try {
    const entry = performance.getEntriesByType('navigation')[0];
    return entry?.name ? new URL(entry.name).pathname : null;
  } catch { return null; }
}
/**
 * Whether Privy may mount for the page at `pathname` in a document loaded at `loaded`, and whether the document must be reloaded first.
 * Privy mounts only when the document was served the same class of signer policy as the page needs (src/accounts/signer-pages.ts); a
 * document that was not (one reached by a client-side navigation) is reloaded once, so it is served that page's own policy. When the
 * browser does not say where the document was loaded, Privy stays unmounted (fails closed, never a reload loop).
 */
export function signerDocument(pathname: string, loaded: string | null): { readonly mount: boolean; readonly reload: boolean } {
  const policy = signerPolicy(pathname);
  if (policy === null || loaded === null) return { mount: false, reload: false };
  const same = signerPolicy(loaded) === policy;
  return { mount: same, reload: !same };
}

/**
 * Wraps a page in FloFi's Privy context. `config` comes from the server (`accountState().privy`): null means Privy is not configured here.
 *
 * Privy is mounted only in a document that was loaded as a page hosting the signer with that page's class of policy (signerDocument).
 * On the server and while hydrating, the document is the page being rendered (the proxy served it its own policy), so a page loaded
 * directly renders Privy from the start and is never remounted; a page reached by a client-side navigation from another class of page is
 * reloaded instead, and renders nothing until then.
 */
export function FloFiPrivyProvider({ config, accounts = false, children }: { config: PrivyBrowserConfig | null; accounts?: boolean; children: ReactNode }) {
  // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: keyed on the configuration's content, not its object identity. A server action that sets a cookie
  // re-renders the layout with an equal but new `config` object; Privy must not receive new settings (and possibly re-initialise) for it.
  const configKey = config ? JSON.stringify(config) : null;
  const settings = useMemo(() => configKey ? floFiPrivyConfig(JSON.parse(configKey) as PrivyBrowserConfig) : null, [configKey]);
  const pathname = usePathname();
  // getServerSnapshot is this page's path (the proxy just served its policy). If the server path still evaluates the
  // client snapshot, Navigation Timing is empty and would leave Privy unmounted in the SSR HTML ("not configured").
  // Fall back to pathname only on the server; keep null on the client so a missing Timing entry stays fail-closed.
  const timed = useSyncExternalStore(NO_CHANGES, loadedDocumentPath, () => pathname);
  const loaded = timed ?? (typeof window === 'undefined' ? pathname : null);
  const { mount, reload } = signerDocument(pathname, loaded);
  useEffect(() => { if (reload) location.reload(); }, [reload]);
  const inner = reload ? null : !config || !settings || !mount ? <Context.Provider value={null}>{children}</Context.Provider>
    : config.e2e ? <EmulatedPrivy>{children}</EmulatedPrivy>
      : <PrivyProvider appId={config.appId} config={settings}><PrivyBridge>{children}</PrivyBridge></PrivyProvider>;
  return <AccountsContext.Provider value={accounts}>{inner}</AccountsContext.Provider>;
}
/** Re-renders when Privy finishes loading (for effects that must wait for `ready`). */
export function useWhenPrivyReady(run: (privy: FloFiPrivy) => void | (() => void)) {
  const privy = useFloFiPrivy();
  const ready = privy?.ready ?? false;
  useEffect(() => { if (privy && ready) return run(privy) ?? undefined; }, [ready]);
}
