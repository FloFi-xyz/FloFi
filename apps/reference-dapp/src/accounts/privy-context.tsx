// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-PRIVY-UX-001: the light half of FloFi's Privy browser side: the `useFloFiPrivy()` interface, its React context and the
 * page registry the wallet providers read, plus Privy's error-code mapping. It imports no Privy SDK and no server action, so components that
 * only need to know whether Privy is ready (Authorize, Disconnect, the top bar) stay small and independent of the provider. The provider
 * itself (official `@privy-io/react-auth`, or the MOCKED loopback stand-in) is `privy-client.tsx`.
 */
import { createContext, useContext, useEffect } from 'react';
import type { WalletEcosystem } from '../wallet/wallet-registry';

export type PrivyEmbedded = { readonly ecosystem: WalletEcosystem; readonly address: string; readonly imported: boolean };
export type PrivyLoginEvent = { readonly wasAlreadyAuthenticated: boolean };
/** An unsigned EIP-1559 transaction FloFi asks Privy to sign (every field already checked against the reviewed attempt). */
export type PrivyEvmTransaction = { readonly to: string; readonly value: string; readonly data: string; readonly chainId: number; readonly nonce: string;
  readonly gas: string; readonly maxFeePerGas: string; readonly maxPriorityFeePerGas: string };
/** What Privy's confirmation screen states about a transaction: FloFi's server-built summary of the reviewed attempt. */
export type PrivyReview = { readonly title: string; readonly action: string; readonly description: string };
export type FloFiPrivy = {
  readonly ready: boolean;
  readonly authenticated: boolean;
  /** The Privy user id (public DID), or null while signed out. */
  readonly userId: string | null;
  /** The person's embedded wallets as Privy reports them in this browser (public addresses). */
  readonly embedded: readonly PrivyEmbedded[];
  /** Whether this page can ask Privy to sign with this embedded wallet now (it is one of the person's and Privy has loaded it). */
  readonly canSign: (ecosystem: WalletEcosystem, address: string) => boolean;
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
  readonly signEvmTransaction: (address: string, tx: PrivyEvmTransaction, review?: PrivyReview) => Promise<string>;
  readonly signEvmMessage: (address: string, message: string) => Promise<string>;
  readonly signSolanaTransaction: (address: string, transaction: Uint8Array, review?: PrivyReview) => Promise<Uint8Array>;
  readonly signSolanaMessage: (address: string, message: Uint8Array) => Promise<Uint8Array>;
  readonly logout: () => Promise<void>;
};

const Context = createContext<FloFiPrivy | null>(null);
/** The page's current FloFi Privy interface, for the wallet providers (they live outside React; src/wallet/flofi-privy-signer.ts). */
let current: FloFiPrivy | null = null;
export const currentFloFiPrivy = () => current;
export function Registrar() {
  const value = useContext(Context);
  useEffect(() => { current = value; return () => { if (current === value) current = null; }; }, [value]);
  return null;
}
/** Whether this deployment offers FloFi accounts (then Disconnect always ends the account session and returns to `/login`). */
const AccountsContext = createContext(false);
export const useAccountsOffered = () => useContext(AccountsContext);
/** FloFi's Privy interface, or null on a deployment without Privy (pages then say what is unavailable). */
export const useFloFiPrivy = () => useContext(Context);
export { Context as FloFiPrivyContext, AccountsContext as FloFiAccountsContext };

/** Why this page cannot sign with `address` now: not one of the person's Privy wallets here, or Privy has not finished loading it. */
export function floFiPrivyWalletIssue(privy: FloFiPrivy | null, ecosystem: WalletEcosystem, address: string): string {
  if (!privy?.ready || !privy.authenticated) return 'FLOFI_WALLET_SIGN_IN_REQUIRED';
  const listed = privy.embedded.some(wallet => wallet.ecosystem === ecosystem && wallet.address === (ecosystem === 'evm' ? address.toLowerCase() : address));
  return listed ? 'FLOFI_WALLET_NOT_READY' : 'FLOFI_WALLET_ACCOUNT_MISMATCH';
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
