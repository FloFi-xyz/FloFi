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
import { activeNetworkScope } from '../domain/network-scope';
import { solanaWalletErrorMessage } from '../wallet/wallet-errors';

export type Namespace = 'eip155' | 'solana';
/** One proof attempt: the account the server verified (null when cancelled or failed), the error code, and the wallet chosen. */
export type ProofOutcome = { readonly account: string | null; readonly error: string | null; readonly wallet: { readonly key: string; readonly name: string } | null };
import { LEARNING_CHANGED, WALLET_PROOF_CHANGED } from '../domain/wallet-proof-events';
export { LEARNING_CHANGED, WALLET_PROOF_CHANGED };
/** The cluster a Solana proof reuses a session on: mainnet-beta in the public product (engineering certification keeps Devnet). */
export const defaultProofChain = (): SolanaWalletChain => activeNetworkScope() === 'ENGINEERING' ? 'solana:devnet' : 'solana:mainnet';
/** Owner-facing text for a proof failure code (wallet F): never a raw code. */
export function walletProofMessage(code: string, namespace: Namespace | null): string {
  if (code === 'EMBEDDED_WALLET_SESSION_UNAVAILABLE') return 'This browser or host could not keep the isolated wallet session inside the chat. Nothing was authorized. Opening FloFi is an optional external fallback.';
  if (/_WALLET_REJECTED$|^WALLET_REQUEST_REJECTED$/.test(code)) return 'You declined the request in your wallet. Nothing was signed. Choose the button again when you are ready.';
  if (code === 'EVM_WALLET_NOT_FOUND') return 'No wallet answered. Unlock your wallet (for example MetaMask), make sure it is enabled for this site, and try again.';
  if (code === 'WALLET_SIGNATURE_INVALID' || code === 'WALLET_RESPONSE_INVALID') return 'Your wallet returned an invalid signature. Nothing was signed in. Try again.';
  if (code === 'WALLET_SIGN_IN_FAILED' || /CHALLENGE/.test(code)) return 'FloFi could not verify the sign-in. Try again.';
  if (namespace === 'solana' || code.startsWith('SOLANA_') || code.startsWith('WALLET_SOLANA_')) return solanaWalletErrorMessage(code, null);
  return 'The wallet request did not complete. Check your wallet and try again.';
}
const utf8Hex = (text: string) => '0x' + Array.from(new TextEncoder().encode(text), b => b.toString(16).padStart(2, '0')).join('');
function unwrap<T>(result: { ok: true; value: T } | { ok: false; code: string }): T { if (!result.ok) throw new Error(result.code); return result.value; }
const codeOf = (cause: unknown) => cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message
  : (cause as { code?: unknown } | null)?.code === 4001 || cause instanceof Error && /reject|declin|denied|cancel/i.test(cause.message + cause.name) ? 'WALLET_REQUEST_REJECTED'
  : 'WALLET_REQUEST_FAILED';

export function useWalletProof(namespace: Namespace | null, chain: SolanaWalletChain = defaultProofChain()) {
  const [proven, setProven] = useState<string | null>(null);
  const [provenNamespace, setProvenNamespace] = useState<Namespace | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** BUILD-FLOFI-AUTH-WALLETS-001: the wallet the owner chose for the last proof (display metadata only, never an identity). */
  const [wallet, setWalletState] = useState<{ readonly key: string; readonly name: string } | null>(null);
  const walletRef = useRef<{ readonly key: string; readonly name: string } | null>(null);
  const setWallet = (value: { readonly key: string; readonly name: string }) => { walletRef.current = value; setWalletState(value); };
  const requestLock = useRef(false), namespaceRef = useRef(namespace); namespaceRef.current = namespace;
  const origin = useRef<object>({});
  const embedded = typeof window !== 'undefined' && window.location?.pathname === '/mcp/approve';
  const proofContext: [boolean?] = embedded ? [true] : [];
  const selector = useWalletSelector(), solana = useOptionalJupiter(), evm = useOptionalBuild009Wallet();
  /** Connection is a selection guard, never ownership proof. A switched wallet immediately stops exposing the previous proof. */
  const connected = namespace === 'solana' ? solana?.session?.chain === chain ? solana.session.account.address : null : namespace === 'eip155' ? evm?.account ?? null : null;
  const scope = `${namespace}:${connected ?? ''}:${chain}`, scopeRef = useRef(scope), connectedRef = useRef(connected), epoch = useRef(0);
  scopeRef.current = scope; connectedRef.current = connected;
  const matches = (account: string, selected: string | null) => !selected || (namespace === 'eip155' ? account.toLowerCase() === selected.toLowerCase() : account === selected);
  const refresh = useCallback(async () => {
    const current = ++epoch.current;
    try {
      const session = namespace === 'solana' ? await solanaSessionStatus() : namespace === 'eip155' ? await walletSessionStatus() : null;
      if (scopeRef.current !== scope || epoch.current !== current) return;
      setProven(session?.account ?? null);
      setProvenNamespace(namespace);
      const expiry = session?.expiresAt ? Date.parse(session.expiresAt) : NaN;
      setExpiresAt(Number.isFinite(expiry) ? expiry : null);
    } catch {
      if (scopeRef.current === scope && epoch.current === current) { setProven(null); setExpiresAt(null); }
    }
  }, [namespace, scope]);
  useEffect(() => { setProven(null); setExpiresAt(null); void refresh(); }, [refresh]);
  useEffect(() => {
    const focused = () => { void refresh(); };
    window.addEventListener('focus', focused);
    return () => window.removeEventListener('focus', focused);
  }, [refresh]);
  useEffect(() => {
    if (expiresAt === null) return;
    const timeout = setTimeout(() => { setProven(null); void refresh(); }, Math.min(Math.max(0, expiresAt - Date.now()), 2_147_483_647));
    return () => clearTimeout(timeout);
  }, [expiresAt, refresh]);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ namespace?: string; origin?: object }>).detail;
      if (detail?.namespace === namespace && detail.origin !== origin.current) void refresh().catch(() => undefined);
    };
    window.addEventListener(WALLET_PROOF_CHANGED, changed);
    return () => window.removeEventListener(WALLET_PROOF_CHANGED, changed);
  }, [namespace, refresh]);
  /**
   * BUILD-FLOFI-AUTH-WALLETS-001: resolves with this attempt's outcome (the proven account, or the error / null when the owner closed the
   * chooser), so a caller acts on exactly this proof and never on an earlier session. Existing callers ignore the value.
   */
  async function run(action: () => Promise<string | null>): Promise<ProofOutcome> {
    if (requestLock.current) return { account: null, error: null, wallet: null }; requestLock.current = true; setBusy(true); setError(null);
    const requestedNamespace = namespace;
    ++epoch.current;
    walletRef.current = null;
    try {
      const account = await action();
      // BUILD-CHAT-LEARNING-002: a newly proven wallet changes whose Copilot memory applies; the Copilot reloads its learning context.
      if (account && namespaceRef.current === requestedNamespace && matches(account, connectedRef.current)) {
        ++epoch.current;
        setProven(account); setProvenNamespace(requestedNamespace); window.dispatchEvent(new Event(LEARNING_CHANGED));
        window.dispatchEvent(new CustomEvent(WALLET_PROOF_CHANGED, { detail: { namespace: requestedNamespace, origin: origin.current } }));
      }
      const accepted = account && namespaceRef.current === requestedNamespace && matches(account, connectedRef.current) ? account : null;
      return { account: accepted, error: null, wallet: accepted ? walletRef.current : null };
    } catch (cause) {
      const code = codeOf(cause);
      if (namespaceRef.current === requestedNamespace) setError(code);
      return { account: null, error: code, wallet: null };
    } finally { requestLock.current = false; setBusy(false); }
  }
  /** `another`: the owner asked to prove a different wallet, so the selector opens even when one is connected. */
  const proveEvm = (another = false) => run(async () => {
    let account = another ? null : evm?.account ?? null, provider: EvmProvider | null = null;
    if (!account) {
      const choice = await selector.choose({ ecosystems: ['evm'], title: 'Choose a wallet to prove ownership' });
      if (!choice) return null;
      setWallet({ key: choice.key, name: choice.name });
      if (evm) account = (await evm.connectWith(choice.id))?.account ?? null;
      else {
        provider = chooseEvmWallet(choice.id); if (!provider) throw new Error('EVM_WALLET_NOT_FOUND');
        const accounts = await provider.request({ method: 'eth_requestAccounts' });
        account = Array.isArray(accounts) && typeof accounts[0] === 'string' ? accounts[0].toLowerCase() : null;
      }
    }
    else if (evm?.provider) setWallet({ key: evm.provider.key, name: evm.provider.name });
    provider ??= injected();
    if (!account || !provider) throw new Error('EVM_WALLET_NOT_FOUND');
    const chainId = await provider.request({ method: 'eth_chainId' });
    if (typeof chainId !== 'string') throw new Error('EVM_WALLET_NOT_FOUND');
    const { message } = unwrap(await walletSignInChallenge(account, Number.parseInt(chainId, 16), ...proofContext));
    const signature = await provider.request({ method: 'personal_sign', params: [utf8Hex(message), account] });
    if (typeof signature !== 'string') throw new Error('WALLET_SIGNATURE_INVALID');
    const verified = unwrap(await walletSignIn(account, Number.parseInt(chainId, 16), signature, ...proofContext));
    if (verified.expiresAt && namespaceRef.current === namespace && matches(verified.account, connectedRef.current)) setExpiresAt(Date.parse(verified.expiresAt));
    if (embedded && (await walletSessionStatus())?.account !== verified.account) throw new Error('EMBEDDED_WALLET_SESSION_UNAVAILABLE');
    return verified.account;
  });
  const proveSolana = (another = false) => run(async () => {
    let session: SolanaSession | null = !another && solana?.session?.chain === chain ? solana.session : null;
    // Wallet E: the operational wallet on the other cluster is asked for this one (same wallet, same account, no wallet chooser) before anything else.
    if (!session && !another && solana?.session) {
      const moved = await solana.switchClusterTo(chain);
      if (moved.ok) session = moved.session;
    }
    if (!session) {
      const choice = await selector.choose({ ecosystems: ['solana'], solanaChain: chain, title: 'Choose a Solana wallet to prove ownership' });
      if (!choice) return null;
      setWallet({ key: choice.key, name: choice.name });
      if (solana) session = await solana.connectWith(choice.key, chain);
      else { session = await connectSolanaWallet(choice.key, chain, 'WALLET'); updateWalletPreference({ solana: choice.key }); }
      if (!session) throw new Error('SOLANA_WALLET_REQUIRED');
    } else setWallet({ key: session.wallet.name, name: session.wallet.name });
    const { message } = unwrap(await solanaSignInChallenge(session.account.address, ...proofContext));
    const signature = await signSolanaMessage(session, message, 'WALLET');
    const verified = unwrap(await solanaSignIn(session.account.address, signature, ...proofContext));
    if (verified.expiresAt && namespaceRef.current === namespace && matches(verified.account, connectedRef.current)) setExpiresAt(Date.parse(verified.expiresAt));
    if (embedded && (await solanaSessionStatus())?.account !== verified.account) throw new Error('EMBEDDED_WALLET_SESSION_UNAVAILABLE');
    return verified.account;
  });
  /** The connected operational account of this namespace, if any (connection only: never treated as proof). */
  const valid = proven && provenNamespace === namespace && matches(proven, connected) && (expiresAt === null || expiresAt > Date.now()) ? proven : null;
  return { proven: valid, busy, error, connected, wallet, proveEvm, proveSolana, refresh };
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
