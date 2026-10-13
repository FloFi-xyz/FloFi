// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { isBoundComposition } from '@defi-workflow-engine/action-registry';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import type { SolanaWalletChange } from '@defi-workflow-engine/reference-compiler';
import { useWorkflow } from './workflow-store';
import { useJupiter } from './jupiter-store';
import { signWithSolanaWallet } from '../wallet/solana-wallet';
import { createPositionMintSigner, signOrcaLiquidityTransaction, type PositionMintSigner } from '../wallet/position-mint-signer';
import { solanaCompositionBeginLiquidity, solanaCompositionBeginSwap, solanaCompositionEnd, solanaCompositionInfo, solanaCompositionInvalidate, solanaCompositionObserve,
  solanaCompositionPrepareLiquidity, solanaCompositionReview, solanaCompositionReviewLiquidity, solanaCompositionSimulate, solanaCompositionStatus, solanaCompositionSubmitLiquidity,
  solanaCompositionSubmitSwap, solanaCompositionWalletFailure } from '../app/solana-composition-action';
import type { SolanaCompositionView } from '../server/solana-composition-service';

/**
 * Solana Devnet Swap → Orca liquidity in the browser. Each method is one explicit owner action: `simulate` prepares the next
 * read-only Review (the composed plan, or after the swap the position with the reconciled amount and a fresh position key),
 * `review` accepts the current Review, `execute` asks the wallet for the current step's one transaction. The position-mint key
 * lives only in this tab's memory; nothing is signed or sent without the owner's click and wallet confirmation.
 */
type Store = { record: SolanaCompositionView | null; busy: boolean; error: string | null; retired: boolean; recovered: boolean; executionEnabled: boolean; signing: boolean;
  owner: string | null;
  /** The current step's Review has been accepted and its transaction may be requested. */ authorized: boolean;
  simulate(): Promise<void>; review(): Promise<void>; execute(): Promise<void>; observe(): Promise<void>; end(): Promise<void> };
const Context = createContext<Store | null>(null);
const key = 'gryloo:solana-composition';
const X = 'SOLANA_COMPOSITION';
const pendingStep = (view: SolanaCompositionView | null) => {
  if (!view) return false;
  const attempt = view.phase === 'PRODUCING' ? view.swap.attempt : view.phase === 'CONSUMING' ? view.liquidity?.attempt : null;
  return Boolean(attempt && ['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING'].includes(attempt.state));
};
/** Whether the owner accepted the Review of the step that would run next. */
export function compositionAuthorized(view: SolanaCompositionView | null): boolean {
  if (!view) return false;
  if (view.phase === 'AUTHORIZED') return view.record.authorization === view.record.review.commitment && view.swap.authorization === view.swap.review.commitment;
  return view.phase === 'CONSUMING' && Boolean(view.liquidity && !view.liquidity.attempt && view.liquidity.authorization === view.liquidity.review.commitment);
}
function walletCode(cause: unknown, prefix: string): string {
  const value = cause as { code?: unknown; name?: unknown; message?: unknown } | null;
  return value && (value.code === 4001 || /reject|declin|denied|cancel/i.test(String(value.name ?? '') + String(value.message ?? ''))) ? `${prefix}_WALLET_REJECTED` : `${prefix}_WALLET_SIGN_FAILED`;
}
const bounded = (cause: unknown) => { try { const v = cause as Record<string, unknown>; return { name: String(v?.name ?? ''), code: typeof v?.code === 'number' ? v.code : null, message: String(v?.message ?? cause).slice(0, 500) }; } catch { return { message: 'unreadable' }; } };
/** The wallet-change summary a refusal may carry (ORCA_LIQUIDITY_TRANSACTION_CHANGED from the position signer). */
const walletChange = (cause: unknown) => { const change = (cause as { change?: { format?: unknown } } | null)?.change; return change?.format === 'flofi.solana-wallet-change.v1' ? { change: change as SolanaWalletChange } : {}; };

export function SolanaCompositionProvider({ children }: { children: ReactNode }) {
  const { state } = useWorkflow();
  const jupiter = useJupiter();
  const session = jupiter.session && jupiter.session.chain === 'solana:devnet' ? jupiter.session : null;
  const owner = session?.account.address ?? null;
  const [record, setRecord] = useState<SolanaCompositionView | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(false), [enabled, setEnabled] = useState(false), [signing, setSigning] = useState(false);
  const mintSigner = useRef<PositionMintSigner | null>(null), busyRef = useRef(false);
  const workflow = state.workflow as unknown as SemanticWorkflow;
  const latest = useRef(workflow); latest.current = workflow;
  const composed = isBoundComposition(workflow);
  const pristineRecovery = recovered && workflow.revision === 0;
  const retired = Boolean(record && JSON.stringify(record.record.review.workflow) !== JSON.stringify(workflow) && !pristineRecovery);
  // A run recovered into the visit's untouched draft continues with its own authorized workflow (the server checks it byte for byte);
  // an edited Canvas never does: it retires the run's plan instead.
  const authorizedWorkflow = (): SemanticWorkflow => record && pristineRecovery ? record.record.review.workflow : latest.current;
  function accept(value: SolanaCompositionView) { setRecord(value); try { window.localStorage.setItem(key, JSON.stringify({ id: value.record.id })); } catch { /* the server journal is authoritative */ } }
  useEffect(() => {
    let mounted = true;
    solanaCompositionInfo().then(result => { if (mounted && result.ok) setEnabled(result.value.executionEnabled); }).catch(() => undefined);
    try {
      const pointer = JSON.parse(window.localStorage.getItem(key) ?? 'null') as { id?: unknown } | null;
      if (pointer && typeof pointer.id === 'string' && /^solcomp-[a-f0-9]{32}$/.test(pointer.id))
        solanaCompositionStatus(pointer.id).then(result => { if (mounted && result.ok) { setRecord(result.value); setRecovered(true); } }).catch(() => undefined);
    } catch { setError(`${X}_RECOVERY_POINTER_INVALID`); }
    return () => { mounted = false; };
  }, []);
  // An edit before the swap starts retires the composed Review; after it starts, the run is only followed (never re-planned).
  useEffect(() => {
    if (record && retired && ['SIMULATED', 'AUTHORIZED'].includes(record.phase))
      solanaCompositionInvalidate(record.record.id).then(result => { if (result.ok) setRecord(result.value); }).catch(() => setError(`${X}_AUTHORIZATION_INVALIDATION_FAILED`));
  }, [record, retired]);
  useEffect(() => {
    if (!signing) return;
    const prevent = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    window.addEventListener('keydown', prevent, true);
    return () => window.removeEventListener('keydown', prevent, true);
  }, [signing]);
  async function operation(action: () => Promise<void>) {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : `${X}_OPERATION_FAILED`); } finally { busyRef.current = false; setBusy(false); }
  }
  async function poll(id: string) {
    for (let i = 0; i < 30; i++) {
      const observed = await solanaCompositionObserve(id); if (!observed.ok) throw new Error(observed.code);
      accept(observed.value);
      if (!pendingStep(observed.value)) return;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  const requireOwner = () => owner ?? (() => { throw new Error(`${X}_SOLANA_WALLET_SELECTION_REQUIRED`); })();
  async function simulate() { await operation(async () => {
    if (pendingStep(record)) throw new Error(`${X}_EXISTING_ATTEMPT_OBSERVE_ONLY`);
    const address = requireOwner(), snapshot = authorizedWorkflow();
    // After the swap: the position step, with the reconciled amount, fresh pool state and a fresh position key.
    if (record && !retired && (record.phase === 'BOUND' || record.phase === 'CONSUMING' && !record.liquidity?.attempt)) {
      mintSigner.current = await createPositionMintSigner();
      const result = await solanaCompositionPrepareLiquidity(record.record.id, address, snapshot, mintSigner.current.address);
      if (!result.ok) throw new Error(result.code);
      accept(result.value); setRecovered(false); return;
    }
    if (!composed) throw new Error('COMPOSITION_GRAPH_INVALID');
    const result = await solanaCompositionSimulate(snapshot, address); if (!result.ok) throw new Error(result.code);
    if (authorizedWorkflow() !== snapshot) throw new Error(`${X}_SEMANTIC_REVISION_CHANGED`);
    accept(result.value); setRecovered(false);
  }); }
  async function review() { await operation(async () => {
    if (!record || retired) throw new Error(`${X}_SIMULATION_REQUIRED`);
    const result = record.phase === 'CONSUMING' && record.liquidity
      ? await solanaCompositionReviewLiquidity(record.record.id, record.liquidity.review.commitment, authorizedWorkflow())
      : await solanaCompositionReview(record.record.id, record.record.review.commitment, authorizedWorkflow());
    if (!result.ok) throw new Error(result.code);
    accept(result.value);
  }); }
  async function execute() { await operation(async () => {
    if (!record || retired || !compositionAuthorized(record)) throw new Error(`${X}_REVIEW_REQUIRED`);
    if (!session) throw new Error(`${X}_SOLANA_WALLET_SELECTION_REQUIRED`);
    if (session.account.address !== record.record.review.owner) throw new Error(`${X}_WRONG_OWNER`);
    const id = record.record.id, snapshot = authorizedWorkflow(), swap = record.phase === 'AUTHORIZED';
    // Refuse before any durable attempt: a position reviewed in another tab or before a reload cannot be completed here.
    if (!swap && mintSigner.current?.address !== record.liquidity?.review.accounts.positionMint) throw new Error('ORCA_LIQUIDITY_POSITION_KEY_UNAVAILABLE');
    let unsigned: string, walletChain: string, signers: string[] = [], message = '';
    if (swap) {
      const begin = await solanaCompositionBeginSwap(id, session.account.address, snapshot); if (!begin.ok) throw new Error(begin.code);
      accept(begin.value.view); unsigned = begin.value.unsignedTransaction; walletChain = begin.value.walletChain;
    } else {
      const begin = await solanaCompositionBeginLiquidity(id, session.account.address, snapshot); if (!begin.ok) throw new Error(begin.code);
      accept(begin.value.view); unsigned = begin.value.unsignedTransaction; walletChain = begin.value.walletChain; signers = begin.value.signers;
      message = begin.value.view.liquidity?.review.message ?? '';
    }
    const prefix = swap ? 'DEVNET_SWAP' : 'ORCA_LIQUIDITY';
    let signed: string;
    setSigning(true);
    try {
      if (walletChain !== session.chain) throw new Error(`${prefix}_WRONG_CLUSTER`);
      if (JSON.stringify(authorizedWorkflow()) !== JSON.stringify(snapshot)) throw new Error(`${prefix}_SEMANTIC_REVISION_CHANGED`);
      // The one owner-signature request of this step, reachable only from the owner's click.
      signed = swap ? await signWithSolanaWallet(session, unsigned, prefix) : await signOrcaLiquidityTransaction(session, unsigned, message, signers, mintSigner.current);
    } catch (cause) {
      const failure = cause instanceof Error && new RegExp(`^${prefix}_[A-Z_]+$`).test(cause.message) ? cause.message : walletCode(cause, prefix);
      const diagnostic = { stage: 'SIGN' as const, code: failure, error: bounded(cause), ...walletChange(cause) };
      const recorded = await solanaCompositionWalletFailure(id, swap ? { step: 'SWAP', diagnostic } : { step: 'LIQUIDITY', diagnostic });
      if (recorded.ok) accept(recorded.value);
      throw new Error(failure, { cause });
    } finally { setSigning(false); if (!swap) mintSigner.current = null; }
    const submitted = swap ? await solanaCompositionSubmitSwap(id, signed) : await solanaCompositionSubmitLiquidity(id, signed);
    if (!submitted.ok) throw new Error(submitted.code);
    accept(submitted.value);
    await poll(id);
  }); }
  async function observe() { await operation(async () => { if (!record) throw new Error(`${X}_RUN_MISSING`); await poll(record.record.id); }); }
  async function end() { await operation(async () => {
    if (!record) throw new Error(`${X}_RUN_MISSING`);
    const result = await solanaCompositionEnd(record.record.id); if (!result.ok) throw new Error(result.code);
    accept(result.value);
  }); }
  return <Context.Provider value={{ record, busy, error, retired, recovered, executionEnabled: enabled, signing, owner, authorized: compositionAuthorized(record),
    simulate, review, execute, observe, end }}>
    {signing && <p role="status">Confirm or reject the pending request in your Solana wallet.</p>}
    <div inert={signing} data-solana-composition-wallet-pending={signing ? 'true' : undefined}>{children}</div></Context.Provider>;
}
export function useSolanaComposition() { const value = useContext(Context); if (!value) throw new Error('SOLANA_COMPOSITION_PROVIDER_MISSING'); return value; }
