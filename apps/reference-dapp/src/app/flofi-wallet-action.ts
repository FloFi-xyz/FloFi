// SPDX-License-Identifier: AGPL-3.0-only
'use server';
/**
 * The product origin's server actions for the person's FloFi wallets (BUILD-FLOFI-AUTH-WALLETS-001; Privy since BUILD-FLOFI-PRIVY-UX-001).
 * Each one derives the account from the verified HttpOnly account session, never from an argument.
 *
 * - `floFiWalletInfo`: the public addresses of the account's Privy-managed wallets (the only managed wallets FloFi signs with), and the
 *   legacy FloFi Wallet origin when this deployment still offers the export of wallets created there (Turnkey) before Privy.
 * - `floFiSigningGate`: before Privy is asked to show a transaction, FloFi's server resolves the reviewed attempt it belongs to
 *   (`{flow, runId}`, server/managed-signing.ts): its PREPARED/SUBMITTING attempt must belong to one of this account's Privy wallets and
 *   carry exactly these bytes; then it claims the attempt's single signature and returns the summary built from its own Review.
 * - `floFiMessageGate`: Privy is asked to sign a message only when it is FloFi's own sign-in message for this host and that wallet.
 * - `floFiWalletHandoff`: a sealed, single-use handoff for the legacy FloFi Wallet window (export of pre-Privy wallets only).
 * - `floFiEvmPendingNonce` / `floFiEvmFees`: the reads the EVM provider needs, for the account's own Privy wallets on the four mainnets.
 * - `floFiEvmBroadcast`: FloFi broadcasts an owner-signed transaction only after re-resolving the reviewed attempt it is bound to: the
 *   signed bytes are decoded here, their sender must be that attempt's owner and a Privy wallet of this account, every field must equal
 *   the attempt's, and each attempt is broadcast at most once. An unclear outcome is UNKNOWN, never a refusal.
 * None of these actions signs anything or holds a key: signatures happen in Privy's frame, after the person confirms there.
 */
import { accountHost, currentAccountSession, type AccountHost } from '../accounts/account-host';
import type { AccountSessionToken } from '../accounts/account-session';
import { sealWalletHandoff } from '../accounts/wallet-session';
import { managedWalletsAvailable, walletOrigin } from '../accounts/wallet-origin';
import { canonicalAddress } from '../accounts/account-model';
import { floFiSignInMessage } from '../accounts/wallet-relay';
import { decodeSignedEip1559, parseSigningRequest, resolveManagedSigning } from '../server/managed-signing';
import { expectedBroadcast, managedEvmNetwork, type ManagedEvmBroadcast, type ManagedEvmFees } from '../server/managed-wallet-evm';
import { requestOrigin } from '../server/session-principal';
import { isSigningFlow, parseSigningContext, type SigningSummary } from '../wallet/flofi-signing';
import { claimAttempt, managedEvmBroadcast, managedEvmFees, managedEvmPendingNonce, managedWallets, signingDeps, signingGate } from './flofi-wallet-signing';

type Result<T> = { ok: true; value: T } | { ok: false; code: string };
export type FloFiManagedWallet = { readonly ecosystem: 'evm' | 'solana'; readonly address: string; readonly label: string };
/** `null` when no FloFi account session exists in this browser. `walletOrigin`: the legacy FloFi Wallet (export only), or null. */
export type FloFiWalletInfo = { readonly walletOrigin: string | null; readonly wallets: readonly FloFiManagedWallet[] } | null;
const CODE = /^[A-Z][A-Z0-9_]{2,80}$/;
const failure = (cause: unknown, fallback: string): { ok: false; code: string } =>
  ({ ok: false, code: cause instanceof Error && CODE.test(cause.message) ? cause.message : fallback });
const fail = (code: string): never => { throw new Error(code); };
async function signedIn(): Promise<{ host: AccountHost; session: AccountSessionToken }> {
  let host: AccountHost | null;
  try { host = await accountHost(); } catch { host = null; }
  const session = await currentAccountSession(host);
  return host && session ? { host, session } : fail('FLOFI_WALLET_ACCOUNT_REQUIRED');
}
/** The account's Privy-managed wallets (legacy Turnkey wallets never sign). */
async function accountManagedWallets(host: AccountHost, session: AccountSessionToken) {
  const account = await host.store.account(session.accountId) ?? fail('FLOFI_WALLET_ACCOUNT_REQUIRED');
  return managedWallets(account!.wallets);
}
const legacyOrigin = () => { const origin = walletOrigin(process.env); return origin && managedWalletsAvailable(process.env) ? origin : null; };

export async function floFiWalletInfo(): Promise<Result<FloFiWalletInfo>> {
  try {
    let host: AccountHost | null;
    try { host = await accountHost(); } catch { host = null; }
    const session = await currentAccountSession(host);
    if (!host || !session) return { ok: true, value: null };
    const wallets = host.privy ? (await accountManagedWallets(host, session)).map(wallet => ({ ecosystem: wallet.ecosystem, address: wallet.address, label: wallet.label })) : [];
    return { ok: true, value: { walletOrigin: legacyOrigin()?.origin ?? null, wallets } };
  } catch (cause) { return failure(cause, 'FLOFI_WALLET_UNAVAILABLE'); }
}

/**
 * Resolves and claims the reviewed attempt a Privy signing request belongs to. `request` is the operation exactly as the wallet provider
 * built it (`{op, address, signing, tx}` or `{op, address, chain, transaction, signing}`). Every refusal precedes any signature.
 */
export async function floFiSigningGate(request: unknown): Promise<Result<SigningSummary>> {
  try {
    const parsed = parseSigningRequest(request) ?? fail('FLOFI_WALLET_REQUEST_INVALID');
    if (!isSigningFlow(parsed!.context.flow)) fail('FLOFI_WALLET_FLOW_NOT_SUPPORTED');
    const { host, session } = await signedIn();
    if (!host.privy) fail('FLOFI_WALLET_UNAVAILABLE');
    const resolved = await signingGate(host.store, await accountManagedWallets(host, session), { claim: true })(parsed!.context, parsed!.request);
    return resolved.ok ? { ok: true, value: resolved.value.summary } : { ok: false, code: resolved.code };
  } catch (cause) { return failure(cause, 'FLOFI_WALLET_REVIEW_UNAVAILABLE'); }
}

/** Whether Privy may sign this message: only FloFi's own sign-in message for this host, naming one of this account's Privy wallets. */
export async function floFiMessageGate(ecosystem: unknown, address: unknown, message: unknown): Promise<Result<null>> {
  try {
    if ((ecosystem !== 'evm' && ecosystem !== 'solana') || typeof message !== 'string' || message.length > 4_000) fail('FLOFI_WALLET_MESSAGE_UNSUPPORTED');
    const eco = ecosystem as 'evm' | 'solana', owner = canonicalAddress(eco, address) ?? fail('FLOFI_WALLET_ACCOUNT_MISMATCH');
    const { host, session } = await signedIn();
    if (!(await accountManagedWallets(host, session)).some(wallet => wallet.ecosystem === eco && wallet.address === owner)) fail('FLOFI_WALLET_ACCOUNT_MISMATCH');
    const origin = await requestOrigin();
    if (!floFiSignInMessage(message as string, eco, owner!, { host: origin.domain, origin: origin.uri })) fail('FLOFI_WALLET_MESSAGE_UNSUPPORTED');
    return { ok: true, value: null };
  } catch (cause) { return failure(cause, 'FLOFI_WALLET_MESSAGE_UNSUPPORTED'); }
}

/** A single-use handoff for the legacy FloFi Wallet window (export of wallets created there before Privy). */
export async function floFiWalletHandoff(): Promise<Result<{ readonly token: string; readonly walletOrigin: string }>> {
  try {
    const origin = legacyOrigin() ?? fail('FLOFI_WALLET_UNAVAILABLE');
    const { session } = await signedIn();
    return { ok: true, value: { token: sealWalletHandoff(process.env, session, origin!.host, new Date()), walletOrigin: origin!.origin } };
  } catch (cause) { return failure(cause, 'FLOFI_WALLET_UNAVAILABLE'); }
}

export async function floFiEvmPendingNonce(chainId: string, address: string): Promise<Result<string>> {
  try {
    const network = managedEvmNetwork(chainId) ?? fail('FLOFI_WALLET_NETWORK_UNSUPPORTED');
    const owner = canonicalAddress('evm', address) ?? fail('FLOFI_WALLET_REQUEST_INVALID');
    const { host, session } = await signedIn();
    if (!(await accountManagedWallets(host, session)).some(wallet => wallet.ecosystem === 'evm' && wallet.address === owner)) fail('FLOFI_WALLET_ACCOUNT_MISMATCH');
    return { ok: true, value: await managedEvmPendingNonce(network!.chainId, owner!) };
  } catch (cause) { return failure(cause, 'FLOFI_WALLET_NETWORK_READ_FAILED'); }
}

export async function floFiEvmFees(chainId: string): Promise<Result<ManagedEvmFees>> {
  try {
    const network = managedEvmNetwork(chainId) ?? fail('FLOFI_WALLET_NETWORK_UNSUPPORTED');
    const { host, session } = await signedIn();
    if (!(await accountManagedWallets(host, session)).some(wallet => wallet.ecosystem === 'evm')) fail('FLOFI_WALLET_ACCOUNT_MISMATCH');
    return { ok: true, value: await managedEvmFees(network!.chainId) };
  } catch (cause) { return failure(cause, 'FLOFI_WALLET_NETWORK_READ_FAILED'); }
}

/**
 * Broadcasts the owner-signed transaction of one reviewed attempt. Any refusal here happens after FloFi Wallet signed, so the caller must
 * report the attempt UNKNOWN and discard the bytes; a HASH may still be pending.
 */
export async function floFiEvmBroadcast(signing: unknown, raw: unknown): Promise<Result<ManagedEvmBroadcast>> {
  try {
    const context = parseSigningContext(signing) ?? fail('FLOFI_WALLET_SIGNING_CONTEXT_REQUIRED');
    const decoded = typeof raw === 'string' ? decodeSignedEip1559(raw) : null;
    if (!decoded) fail('FLOFI_WALLET_SIGNED_TRANSACTION_INVALID');
    const { host, session } = await signedIn(), wallets = await accountManagedWallets(host, session);
    // The same resolution FloFi Wallet's relay applied before signing, now on the signed bytes and their recovered sender.
    const resolved = await resolveManagedSigning(context!, { ecosystem: 'evm', tx: decoded!.tx }, { ...signingDeps(wallets), filledBoundedAtSigning: true });
    if (!resolved.ok) fail(resolved.code);
    const match = (resolved as Extract<typeof resolved, { ok: true }>).value;
    if (!match.evm || match.owner !== decoded!.tx.from) fail('FLOFI_WALLET_SIGNER_MISMATCH');
    if (!await claimAttempt(host.store, 'broadcast', match.attempt, match.expiresAtMs)) fail('FLOFI_WALLET_ALREADY_SIGNED');
    return { ok: true, value: await managedEvmBroadcast(match.evm!.chainId, (raw as string).toLowerCase(), expectedBroadcast(decoded!.tx, decoded!.hash)) };
  } catch (cause) { return failure(cause, 'FLOFI_WALLET_SUBMISSION_UNKNOWN'); }
}
