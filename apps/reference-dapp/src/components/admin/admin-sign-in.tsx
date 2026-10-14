// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-ADMIN-001: administrator sign-in. The operator picks an injected EVM wallet (EIP-6963 announcements, or the legacy injected
 * provider), which signs the admin-only EIP-4361 statement with `personal_sign`. The server recovers the signer and admits it only if
 * an operator granted that wallet; the browser never holds a session token (HttpOnly cookie). The product's wallet preference is not
 * read or written, and nothing here signs a transaction.
 */
import { useEffect, useState } from 'react';
import { evmWalletEntries, requestEvmAnnouncements, subscribeEvmDiscovery, type EvmWalletEntry } from '../../wallet/evm-discovery';
import { adminPost } from './admin-client';

const utf8Hex = (text: string) => '0x' + Array.from(new TextEncoder().encode(text), b => b.toString(16).padStart(2, '0')).join('');
const MESSAGES: Record<string, string> = {
  ADMIN_NOT_GRANTED: 'This wallet is not an administrator of this deployment. Access is granted only by an operator with database access.',
  WALLET_SIGNATURE_INVALID: 'The signature did not match the selected account. Try again.',
  ADMIN_SIGN_IN_CHALLENGE_INVALID: 'The sign-in request expired. Try again.',
  ADMIN_STORE_UNAVAILABLE: 'The admin store is unavailable. Try again shortly.',
  WALLET_REQUEST_REJECTED: 'The wallet request was declined.',
};
export function AdminSignIn() {
  const [wallets, setWallets] = useState<EvmWalletEntry[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const refresh = () => setWallets(evmWalletEntries());
    const unsubscribe = subscribeEvmDiscovery(refresh);
    refresh(); requestEvmAnnouncements();
    return unsubscribe;
  }, []);
  async function signIn(entry: EvmWalletEntry) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const accounts = await entry.provider.request({ method: 'eth_requestAccounts' }), chain = await entry.provider.request({ method: 'eth_chainId' });
      const address = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0].toLowerCase() : null;
      if (!address || typeof chain !== 'string') throw new Error('EVM_WALLET_NOT_FOUND');
      const chainId = Number.parseInt(chain, 16);
      const challenge = await adminPost<{ message: string }>('/admin/api/session/challenge', { address, chainId });
      if (!challenge.ok) throw new Error(challenge.code);
      let signature: unknown;
      try { signature = await entry.provider.request({ method: 'personal_sign', params: [utf8Hex(challenge.message), address] }); }
      catch { throw new Error('WALLET_REQUEST_REJECTED'); }
      if (typeof signature !== 'string') throw new Error('WALLET_SIGNATURE_INVALID');
      const session = await adminPost('/admin/api/session', { address, chainId, signature });
      if (!session.ok) throw new Error(session.code);
      window.location.assign('/admin');
    } catch (cause) {
      const code = cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'ADMIN_SIGN_IN_FAILED';
      setError(code);
      setBusy(false);
    }
  }
  return <div className="admin-card">
    <h2>Sign in with an administrator wallet</h2>
    <p className="admin-diff">Your wallet signs a sign-in message for this console only. It authorizes no transaction and moves no funds.</p>
    {wallets.length ? <div className="admin-wallets" role="list">
      {wallets.map(entry => <button key={entry.choice.id} type="button" role="listitem" className="admin-button" disabled={busy} onClick={() => void signIn(entry)}>
        {entry.choice.icon ? <img src={entry.choice.icon} alt=""/> : null}<span>{entry.choice.name}</span>
      </button>)}
    </div> : <p className="admin-note">No browser wallet was detected. Install or unlock an EVM wallet extension, then reload this page.</p>}
    {busy ? <p role="status">Waiting for the wallet…</p> : null}
    {error ? <p className="admin-alert" data-tone="bad" role="alert">{MESSAGES[error] ?? `Sign-in failed (${error}).`}</p> : null}
  </div>;
}
