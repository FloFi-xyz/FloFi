// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRIVY-UX-001: what FloFi's own wallet providers (flofi-evm-provider.ts, flofi-solana-wallet.ts) ask when the person's Privy
 * wallet must sign. It replaces the FloFi Wallet pop-up (Turnkey) and keeps every gate of the reviewed flow:
 * 1. a transaction reaches Privy only after FloFi's server matched it to its reviewed attempt and claimed that attempt's single signature
 *    (`floFiSigningGate`: Review → Strategy Manifest → this exact attempt, this account's own Privy wallet, mainnet only); a message only
 *    when it is FloFi's own sign-in message for this host and wallet (`floFiMessageGate`);
 * 2. Privy then shows its own confirmation screen and signs only if the person confirms there (`showWalletUIs` is always on);
 * 3. FloFi alone broadcasts, after re-checking the signed bytes (`floFiEvmBroadcast`; Solana: the flow's own submit).
 * Errors keep the providers' contract (flofi-signing.ts): a cancel in Privy is FLOFI_WALLET_REJECTED (4001: nothing signed); a refusal
 * before Privy was asked is that refusal's code (4100); anything after Privy was asked is unknown and is reconciled, never retried blindly.
 */
import { floFiMessageGate, floFiSigningGate } from '../app/flofi-wallet-action';
import { currentFloFiPrivy, floFiPrivyWalletIssue, privyErrorCode, type PrivyReview } from '../accounts/privy-context';
import type { SigningSummary } from './flofi-signing';
import type { FloFiWalletRequest } from './flofi-wallet-channel';
import type { WalletResult } from '../wallet-app/protocol';

const fromBase64 = (text: string) => Uint8Array.from(atob(text), char => char.charCodeAt(0));
const toBase64 = (bytes: Uint8Array) => { let text = ''; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
const toHex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
/** What Privy's confirmation screen states: FloFi's server summary of the reviewed attempt (built from its own Review, never from the page). */
export function privyReview(summary: SigningSummary): PrivyReview {
  // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: the Review's own deadline, so the person knows how long the confirmation stays valid (a confirmation
  // after it is refused at broadcast and reconciled, never sent).
  const expires = summary.expiresAt && Number.isFinite(Date.parse(summary.expiresAt)) ? `Confirm before ${new Date(summary.expiresAt).toISOString().slice(11, 19)} UTC` : null;
  const lines = [`${summary.network}${summary.realFunds ? ' (real funds)' : ''}`, ...expires ? [expires] : [], ...summary.lines.map(line => `${line.label}: ${line.value}`),
    `FloFi run ${summary.runId}`];
  return { title: 'FloFi reviewed strategy', action: summary.action.slice(0, 80), description: lines.join(' · ').slice(0, 600) };
}
/** After Privy was asked: a cancel there signed nothing; anything else may have signed. */
const afterPrivy = (cause: unknown, unknown: string) => new Error(privyErrorCode(cause) === 'PRIVY_USER_CANCELLED' ? 'FLOFI_WALLET_REJECTED' : unknown);

export async function requestThroughPrivy(request: FloFiWalletRequest): Promise<WalletResult> {
  const privy = currentFloFiPrivy();
  // Without a Privy session in this page nothing can be shown or signed: a refusal before any signature.
  if (!privy?.ready || !privy.authenticated) throw new Error('FLOFI_WALLET_SIGN_IN_REQUIRED');
  // The wallet must be usable in this page before the reviewed attempt's single signature is claimed: otherwise the claim would be spent on
  // a request Privy can never show (an address Privy does not list for this person, or a Solana wallet Privy has not loaded yet).
  const ecosystem = request.op === 'evm_sign_transaction' || request.op === 'evm_sign_message' ? 'evm' : 'solana';
  if ('address' in request && !privy.canSign(ecosystem, request.address)) throw new Error(floFiPrivyWalletIssue(privy, ecosystem, request.address));
  switch (request.op) {
    case 'evm_sign_transaction': case 'solana_sign_transaction': {
      const gate = await floFiSigningGate(request).catch(() => ({ ok: false as const, code: 'FLOFI_WALLET_REVIEW_UNAVAILABLE' }));
      if (!gate.ok) throw new Error(gate.code);
      if (request.op === 'evm_sign_transaction') {
        const tx = request.tx;
        try {
          return { signedTransaction: await privy.signEvmTransaction(request.address, { to: tx.to, value: tx.value, data: tx.data, chainId: Number(BigInt(tx.chainId)),
            nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas }, privyReview(gate.value)) };
        } catch (cause) { throw afterPrivy(cause, 'FLOFI_WALLET_SUBMISSION_UNKNOWN'); }
      }
      try { return { signedTransaction: toBase64(await privy.signSolanaTransaction(request.address, fromBase64(request.transaction), privyReview(gate.value))) }; }
      catch (cause) { throw afterPrivy(cause, 'FLOFI_WALLET_SIGNATURE_UNKNOWN'); }
    }
    case 'evm_sign_message': case 'solana_sign_message': {
      const gate = await floFiMessageGate(ecosystem, request.address, request.message).catch(() => ({ ok: false as const, code: 'FLOFI_WALLET_MESSAGE_UNSUPPORTED' }));
      if (!gate.ok) throw new Error(gate.code);
      try {
        return { signature: ecosystem === 'evm' ? await privy.signEvmMessage(request.address, request.message)
          : toHex(await privy.signSolanaMessage(request.address, new TextEncoder().encode(request.message))) };
      } catch (cause) { throw afterPrivy(cause, 'FLOFI_WALLET_SIGNATURE_UNKNOWN'); }
    }
    default: throw new Error('FLOFI_WALLET_METHOD_UNSUPPORTED');
  }
}
