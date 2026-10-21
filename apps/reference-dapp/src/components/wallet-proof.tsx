// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-MCP-002: chain-neutral wallet proof in the browser. The owner picks the wallet in the canonical wallet selector; only
 * that wallet is asked. EVM: it signs the EIP-4361 sign-in message (`personal_sign`). Solana: it signs the Sign-In With
 * Solana message (`solana:signMessage`). The
 * server verifies the signature and sets the HttpOnly session; the browser never holds a session token. Nothing here signs a
 * transaction or moves funds.
 *
 * BUILD-SOLANA-TRANSFER-UX-001: one wallet connection per ecosystem. The proof uses the product's operational session (the shared
 * Solana session of the Solana flows, the EVM wallet of the EVM flows): an already connected wallet is proven without a second
 * connection, and a wallet connected here is the one simulation and signing use. A proof never infers ownership from an address:
 * the connected wallet still signs the server's sign-in message. Outside the product shell (`/connections`) there is no operational
 * session: the proof connects the chosen wallet directly, as before, and that connection is never reused for signing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { solanaSessionStatus, solanaSignIn, solanaSignInChallenge, walletSessionStatus, walletSignIn, walletSignInChallenge } from '../app/wallet-session-action';
import { chooseEvmWallet, injected, type EvmProvider } from '../wallet/evm-discovery';
import { connectSolanaWallet, signSolanaMessage, type SolanaSession, type SolanaWalletChain } from '../wallet/solana-wallet';
import { updateWalletPreference } from '../wallet/wallet-registry';
import { useOptionalBuild009Wallet } from '../state/build009-wallet-store';
import { useOptionalJupiter } from '../state/jupiter-store';
import { useWalletSelector } from './wallet-selector';
import { useLocale } from '../i18n/locale';

export type Namespace = 'eip155' | 'solana';
/** BUILD-CHAT-LEARNING-002: dispatched on `window` when the proven wallet or a Privacy & memory choice changed. */
export const LEARNING_CHANGED = 'flofi:learning-changed';
const utf8Hex = (text: string) => '0x' + Array.from(new TextEncoder().encode(text), b => b.toString(16).padStart(2, '0')).join('');
function unwrap<T>(result: { ok: true; value: T } | { ok: false; code: string }): T { if (!result.ok) throw new Error(result.code); return result.value; }
const codeOf = (cause: unknown) => cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'WALLET_REQUEST_FAILED';

export function useWalletProof(namespace: Namespace | null, chain: SolanaWalletChain = 'solana:devnet') {
  const [proven, setProven] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestLock = useRef(false), namespaceRef = useRef(namespace); namespaceRef.current = namespace;
  const selector = useWalletSelector(), solana = useOptionalJupiter(), evm = useOptionalBuild009Wallet();
  const refresh = useCallback(async () => {
    const account = namespace === 'solana' ? (await solanaSessionStatus())?.account : namespace === 'eip155' ? (await walletSessionStatus())?.account : null;
    if (namespaceRef.current === namespace) setProven(account ?? null);
  }, [namespace]);
  useEffect(() => { setProven(null); void refresh().catch(() => setProven(null)); }, [refresh]);
  async function run(action: () => Promise<string | null>) {
    if (requestLock.current) return; requestLock.current = true; setBusy(true); setError(null);
    const requestedNamespace = namespace;
    try {
      const account = await action();
      // BUILD-CHAT-LEARNING-002: a newly proven wallet changes whose Copilot memory applies; the Copilot reloads its learning context.
      if (account && namespaceRef.current === requestedNamespace) { setProven(account); window.dispatchEvent(new Event(LEARNING_CHANGED)); }
    } catch (cause) { if (namespaceRef.current === requestedNamespace) setError(codeOf(cause)); } finally { requestLock.current = false; setBusy(false); }
  }
  /** `another`: the owner asked to prove a different wallet, so the selector opens even when one is connected. */
  const proveEvm = (another = false) => run(async () => {
    let account = another ? null : evm?.account ?? null, provider: EvmProvider | null = null;
    if (!account) {
      const choice = await selector.choose({ ecosystems: ['evm'], title: 'Choose a wallet to prove ownership' });
      if (!choice) return null;
      if (evm) account = (await evm.connectWith(choice.id))?.account ?? null;
      else {
        provider = chooseEvmWallet(choice.id); if (!provider) throw new Error('EVM_WALLET_NOT_FOUND');
        const accounts = await provider.request({ method: 'eth_requestAccounts' });
        account = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0].toLowerCase() : null;
      }
    }
    provider ??= injected();
    if (!account || !provider) throw new Error('EVM_WALLET_NOT_FOUND');
    const chainId = await provider.request({ method: 'eth_chainId' });
    if (typeof chainId !== 'string') throw new Error('EVM_WALLET_NOT_FOUND');
    const { message } = unwrap(await walletSignInChallenge(account, Number.parseInt(chainId, 16)));
    const signature = await provider.request({ method: 'personal_sign', params: [utf8Hex(message), account] });
    if (typeof signature !== 'string') throw new Error('WALLET_SIGNATURE_INVALID');
    return unwrap(await walletSignIn(account, Number.parseInt(chainId, 16), signature)).account;
  });
  const proveSolana = (another = false) => run(async () => {
    let session: SolanaSession | null = !another && solana?.session?.chain === chain ? solana.session : null;
    if (!session) {
      const choice = await selector.choose({ ecosystems: ['solana'], solanaChain: chain, title: 'Choose a Solana wallet to prove ownership' });
      if (!choice) return null;
      if (solana) session = await solana.connectWith(choice.key, chain);
      else { session = await connectSolanaWallet(choice.key, chain, 'WALLET'); updateWalletPreference({ solana: choice.key }); }
      if (!session) throw new Error('SOLANA_WALLET_REQUIRED');
    }
    const { message } = unwrap(await solanaSignInChallenge(session.account.address));
    const signature = await signSolanaMessage(session, message, 'WALLET');
    return unwrap(await solanaSignIn(session.account.address, signature)).account;
  });
  /** The connected operational account of this namespace, if any (connection only: never treated as proof). */
  const connected = namespace === 'solana' ? solana?.session?.chain === chain ? solana.session.account.address : null : namespace === 'eip155' ? evm?.account ?? null : null;
  return { proven, busy, error, connected, proveEvm, proveSolana, refresh };
}

/** The proof buttons for one namespace, or the proven account. */
export function WalletProof({ namespace, proof }: { namespace: Namespace; proof: ReturnType<typeof useWalletProof> }) {
  const { t: tr } = useLocale();
  if (proof.proven && (!proof.connected || (namespace === 'solana' ? proof.connected === proof.proven : proof.connected.toLowerCase() === proof.proven.toLowerCase())))
    return <p>{tr("Signed in as ")}<code>{proof.proven}</code> ({namespace === 'solana' ? 'Solana' : 'Ethereum'}).</p>;
  if (namespace === 'eip155') return <div className="approval-actions"><button type="button" className="primary" disabled={proof.busy}
    onClick={() => void proof.proveEvm()}>{tr("Connect wallet and prove ownership")}</button></div>;
  return <div className="approval-actions"><button type="button" className="primary" disabled={proof.busy}
    onClick={() => void proof.proveSolana()}>{tr("Connect Solana wallet and prove ownership")}</button></div>;
}
