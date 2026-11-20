// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the browser side of managing an existing Uniswap v3 position from the owner's wallet (collect, partial
 * withdrawal, full exit, explicit close) on a catalog mainnet. Simulate → Review (the owner's explicit authorization) → Execute: `begin`
 * (fresh re-verification, nonce reservation, PREPARED) → `handoff` (durable SUBMITTING) → the owner's wallet `eth_sendTransaction` after the
 * exact envelope check → `report` → observation until the run is reconciled (or divergent). One wallet request per run; nothing is ever
 * resent: an unknown wallet outcome is only observed.
 *
 * A Review that stopped standing before that one request (expired, the position, pool or fees moved) is refreshed in place on the SAME run,
 * exactly like the mint store's `requoted` contract: nothing was sent, the reason is kept for the Review, the chat and the Canvas, and the
 * refreshed Review needs the owner's explicit authorization again. FloFi never signs and never sends.
 *
 * The store serves the current workflow when a Uniswap position choice is staged for it (`MANAGE_LIQUIDITY_POSITION`), or when it holds its
 * own run of exactly that workflow (`engaged`). Otherwise the mint store keeps serving the pool node, unchanged.
 */
import { WalletPendingNotice } from '../components/wallet-pending-notice';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { useWorkflow } from './workflow-store';
import { injected, useBuild009Wallet } from './build009-wallet-store';
import { uniswapLiquidityChainHex } from '../wallet/uniswap-liquidity-eip1193';
import { uniswapPositionWalletTransactionMatches } from '../wallet/uniswap-position-eip1193';
import { catalogLiquidityInfo, catalogLiquidityMode, uniswapPositionBegin, uniswapPositionHandoff, uniswapPositionInvalidate, uniswapPositionObserve,
  uniswapPositionRefresh, uniswapPositionReport, uniswapPositionReview, uniswapPositionSimulate, uniswapPositionStatus,
  uniswapPositionWalletFailure } from '../app/uniswap-liquidity-action';
import { CATALOG_NETWORK_IDENTITIES } from '../domain/network-registry';
import type { UniswapWalletDiagnostic } from '../server/uniswap-liquidity-service';
import type { UniswapPositionRecord, UniswapPositionRequest } from '../server/uniswap-position-service';
import { observeWalletNonce, walletNonceRefusal } from '../domain/wallet-nonce';
import { UNISWAP_POSITION_REFRESH_IN_PLACE, uniswapPositionRunResumable } from '../domain/uniswap-liquidity-continuation';
import { uniswapPositionRequestOf, uniswapPositionRequestOfMarker, workflowPositionManagement } from '../domain/liquidity-positions';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from '../domain/execution-lifecycle';
import { projectExecutionRecovery, type ExecutionRecovery } from '../domain/execution-recovery';
import { projectExecutionStepEvidence } from '../domain/execution-step-evidence';
import { projectExecutionEvidence } from '../domain/execution-evidence';
import type { ReviewWallet } from '../domain/review-presentation';

export const UNISWAP_POSITION_RUN_KEY = 'flofi:uniswap-position:run';
const REFUSALS = [4001, 4100, 4200];
const RUN_ID = /^(?:unilp|rhlp|balp|arlp|etlp)-[a-f0-9]{32}$/;
type Store = { available: boolean; executionEnabled: boolean; record: UniswapPositionRecord | null; busy: boolean; signing: boolean; error: string | null;
  retired: boolean; recovered: boolean;
  /** The same in-place refresh contract as the mint store: why the run's Review was refreshed before its wallet request (nothing was sent). */
  requoted: { readonly code: string; readonly runId: string } | null;
  /** This store serves the current workflow: a staged Uniswap position choice for it, or its own run of exactly this workflow. */
  engaged: boolean;
  /** The request a simulation of the current workflow would make: the staged choice's, else the attached run's own. */
  request: UniswapPositionRequest | null;
  simulate(): Promise<void>; refresh(): Promise<void>; review(): Promise<void>; execute(): Promise<void>; observe(): Promise<void>; switchNetwork(): Promise<void> };
const Context = createContext<Store | null>(null);
function errorValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 512) : value ?? null;
  const v = value as { code?: unknown; message?: unknown };
  return { code: typeof v.code === 'number' || typeof v.code === 'string' ? v.code : null, message: typeof v.message === 'string' ? v.message.slice(0, 512) : null };
}
const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; code: string }): T => { if (!result.ok) throw new Error(result.code); return result.value; };
const sameRequest = (a: UniswapPositionRequest, b: UniswapPositionRequest) =>
  a.operation === b.operation && a.tokenId === b.tokenId && a.partBps === b.partBps && a.close === b.close;

export function UniswapPositionProvider({ children }: { children: ReactNode }) {
  const { state, stagedPosition, restoreLiquidityCanvas, trackCanvasRestoration } = useWorkflow(), wallet = useBuild009Wallet();
  const [record, setRecord] = useState<UniswapPositionRecord | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false), [recovered, setRecovered] = useState(false);
  const [networks, setNetworks] = useState<Readonly<Record<string, { available: boolean; executionEnabled: boolean }>>>({});
  const [requoted, setRequoted] = useState<Store['requoted']>(null);
  const workflow = state.workflow as unknown as SemanticWorkflow;
  // The workflow store keeps a staged choice only while the workflow is exactly the one it prepared (and clears it on any other command).
  const staged = stagedPosition?.choice?.position.protocol === 'UNISWAP_V3' ? stagedPosition.choice : null;
  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 (F1): the canonical node names the operation; with no staged choice (a reload, a restored or shared workflow)
  // the marker alone engages this store, so a position workflow is never served by the deposit store.
  const marked = workflowPositionManagement(workflow), marker = !staged && marked?.protocol === 'UNISWAP_V3' ? marked : null;
  const stagedRequest = staged ? uniswapPositionRequestOf(staged) : marker ? uniswapPositionRequestOfMarker(marker.management) : null;
  const latest = useRef(workflow); latest.current = workflow;
  const latestWallet = useRef(wallet); latestWallet.current = wallet;
  const busyRef = useRef(false), operationEpoch = useRef(0);
  const attaches = Boolean(record && JSON.stringify(record.workflow) === JSON.stringify(workflow));
  // A run of another workflow, of another staged operation or of another owner never stands for the current choice.
  const retired = Boolean(record && (!attaches || stagedRequest && !sameRequest(stagedRequest, record.request) || staged && staged.position.owner !== record.owner));
  const engaged = Boolean(staged) || attaches || Boolean(marker);
  const chain = staged?.position.chain ?? (record ? `eip155:${record.review.chainId}` : marker?.chain ?? null);
  const { available, executionEnabled } = (chain ? networks[chain] : undefined) ?? { available: false, executionEnabled: false };
  function accept(value: UniswapPositionRecord) {
    setRecord(value);
    const hash = value.attempts.at(-1)?.transactionHash;
    try { window.localStorage.setItem(UNISWAP_POSITION_RUN_KEY, JSON.stringify({ id: value.id, ...hash ? { hash } : {} })); } catch { /* The server run remains authoritative. */ }
  }
  useEffect(() => {
    let mounted = true;
    for (const network of CATALOG_NETWORK_IDENTITIES)
      catalogLiquidityMode(network.chain).then(mode => {
        if (!mounted) return;
        setNetworks(current => ({ ...current, [network.chain]: { executionEnabled: false, ...current[network.chain], available: mode !== 'off' } }));
        if (mode !== 'off') catalogLiquidityInfo(network.chain).then(result => {
          if (mounted && result.ok) setNetworks(current => ({ ...current, [network.chain]: { available: true, ...current[network.chain], executionEnabled: result.value.executionEnabled } }));
        }).catch(() => undefined);
      }).catch(() => undefined);
    try {
      const pointer = JSON.parse(window.localStorage.getItem(UNISWAP_POSITION_RUN_KEY) ?? 'null') as { id?: unknown; hash?: unknown } | null;
      if (pointer && typeof pointer.id === 'string' && RUN_ID.test(pointer.id)) (async () => {
        // A hash saved before the browser closed reaches the server first; it is never resent to a wallet.
        if (typeof pointer.hash === 'string' && /^0x[0-9a-f]{64}$/.test(pointer.hash))
          await uniswapPositionReport(pointer.id as string, { kind: 'HASH', hash: pointer.hash }).catch(() => undefined);
        return trackCanvasRestoration(uniswapPositionStatus(pointer.id as string));
      })().then(result => {
        if (!mounted || !result.ok) return;
        setRecord(result.value); setRecovered(true);
        // An unresolved run shows its own workflow on the untouched Canvas again, so its request keeps being observed after a reload.
        if (result.value.verdict === 'PENDING' && result.value.attempts.length > 0) restoreLiquidityCanvas(result.value.workflow);
      }).catch(() => undefined);
    } catch { setError('UNISWAP_RECOVERY_POINTER_INVALID'); }
    return () => { mounted = false; };
  }, [restoreLiquidityCanvas, trackCanvasRestoration]);
  // A semantic edit (or another staged operation) after Review invalidates the authorization; any existing transaction stays observable.
  useEffect(() => {
    if (record && retired && record.authorization) uniswapPositionInvalidate(record.id).then(r => { if (r.ok) setRecord(r.value); }).catch(() => setError('UNISWAP_AUTHORIZATION_INVALIDATION_FAILED'));
  }, [record, retired]);
  async function operation(action: () => Promise<void>) {
    if (busyRef.current) return; const epoch = ++operationEpoch.current; busyRef.current = true; setBusy(true); setError(null);
    // A refusal refreshed in place leaves no error (its updated Review is valid; `requoted` explains it).
    try { await action(); } catch (cause) { const code = cause instanceof Error ? cause.message : 'UNISWAP_OPERATION_FAILED'; setError(code === 'UNISWAP_REFRESHED_REVIEW_REQUIRED' ? null : code); }
    finally { if (operationEpoch.current === epoch) { busyRef.current = false; setBusy(false); } }
  }
  async function ownerSession() {
    let session = await wallet.session(); if (!session) session = await wallet.connect();
    if (!session) throw new Error('UNISWAP_WALLET_REQUIRED');
    return session;
  }
  /** Read-only: a new run with a fresh public simulation of exactly the staged operation (never a deposit). */
  async function simulate() { await operation(async () => {
    const request = stagedRequest ?? (attaches ? record?.request ?? null : null);
    if (!request) throw new Error('UNISWAP_POSITION_CHOICE_REQUIRED');
    const session = await ownerSession(), snapshot = latest.current;
    // The verified owner of the staged position is the only wallet that may manage it here (the server checks the NFT owner again).
    if (staged && session.account.toLowerCase() !== staged.position.owner) throw new Error('UNISWAP_POSITION_OWNER_MISMATCH');
    const value = unwrap(await uniswapPositionSimulate(snapshot, session.account, request));
    if (latest.current !== snapshot) throw new Error('UNISWAP_SEMANTIC_REVISION_CHANGED');
    setRecovered(false); setRequoted(null); accept(value);
  }); }
  /** A fresh simulation and Review of the same run (read-only); the updated Review needs a new authorization. */
  async function refresh() { await operation(async () => { if (!record) throw new Error('UNISWAP_RUN_MISSING'); setRequoted(null); accept(unwrap(await uniswapPositionRefresh(record.id))); }); }
  async function review() { await operation(async () => {
    if (!record || retired) throw new Error('UNISWAP_SIMULATION_REQUIRED');
    const result = await uniswapPositionReview(record.id, record.review.commitment, record.workflow);
    // A Review authorized in its last seconds is refused by the server; the same run is refreshed in place and authorized again explicitly.
    if (!result.ok && result.code === 'UNISWAP_REVIEW_EXPIRED' && uniswapPositionRunResumable(record)) {
      const refreshed = unwrap(await uniswapPositionRefresh(record.id));
      accept(refreshed); setRequoted({ code: result.code, runId: record.id });
      throw new Error('UNISWAP_REFRESHED_REVIEW_REQUIRED');
    }
    accept(unwrap(result));
    setRequoted(null);
  }); }
  async function observe() { await operation(async () => { if (!record) throw new Error('UNISWAP_RUN_MISSING'); accept(unwrap(await uniswapPositionObserve(record.id))); }); }
  async function switchNetwork() { await operation(async () => {
    const target = uniswapLiquidityChainHex(record?.review.chainId ?? staged?.position.chain);
    if (!target) throw new Error('UNISWAP_REVIEW_REQUIRED');
    await wallet.switchTo(target as Parameters<typeof wallet.switchTo>[0]);
  }); }
  /** One Execute click = the run's one exact wallet request. */
  async function execute() { await operation(async () => {
    const reviewed = record;
    try { await request(); }
    catch (cause) {
      // Refused before any wallet request because the Review no longer stands: the SAME run is refreshed in place (read-only) and its updated
      // Review waits for the owner's explicit authorization. Never a silent extension, never a resend.
      const code = cause instanceof Error ? cause.message : '';
      if (reviewed && UNISWAP_POSITION_REFRESH_IN_PLACE.test(code)) {
        const interim = (cause as { interim?: UniswapPositionRecord | null }).interim ?? null;
        const current = await uniswapPositionStatus(reviewed.id).catch(() => null);
        const latestRecord = current?.ok ? current.value : interim;
        if (latestRecord && uniswapPositionRunResumable(latestRecord)) {
          const refreshed = await uniswapPositionRefresh(reviewed.id).catch(() => null);
          if (refreshed?.ok) {
            accept(refreshed.value); setRequoted({ code, runId: reviewed.id });
            throw new Error('UNISWAP_REFRESHED_REVIEW_REQUIRED', { cause });
          }
        }
        if (latestRecord) accept(latestRecord);
      }
      throw cause;
    }
  }); }
  async function request() {
    if (!record || retired || record.authorization !== record.review.commitment) throw new Error('UNISWAP_REVIEW_REQUIRED');
    // Expiry is the server's to decide (its clock, before any nonce reservation or hand-off); an expired Review is refreshed in place by
    // execute(), never stretched here.
    const reviewedChain = uniswapLiquidityChainHex(record.review.chainId);
    if (!reviewedChain) throw new Error('UNISWAP_WRONG_CHAIN');
    const session = await ownerSession();
    if (session.chainId !== reviewedChain) throw new Error('UNISWAP_WRONG_CHAIN');
    if (session.account.toLowerCase() !== record.owner) throw new Error('UNISWAP_WRONG_OWNER');
    const provider = injected(); if (!provider) throw new Error('UNISWAP_WALLET_REQUIRED');
    const snapshot = record.workflow, editing = latest.current, id = record.id, reviewedRecord = record;
    const diagnostic: UniswapWalletDiagnostic = { invoked: false, calls: [], code: 'UNISWAP_WALLET_PREFLIGHT' };
    const call = async (method: string, params: unknown[] = []) => {
      const entry: UniswapWalletDiagnostic['calls'][number] = { method, ...method === 'eth_sendTransaction' ? { submission: true } : {} }; diagnostic.calls.push(entry);
      try { const result = await provider.request({ method, ...params.length ? { params } : {} }); entry.result = typeof result === 'string' ? result.slice(0, 200) : null; return result; }
      catch (cause) { entry.error = errorValue(cause); throw cause; }
    };
    // Read-only session checks before and after the durable preparation; any change fails closed.
    const sameSession = async () => {
      if (latest.current !== editing) throw new Error('UNISWAP_SEMANTIC_REVISION_CHANGED');
      if (injected() !== provider) throw new Error('UNISWAP_WALLET_PROVIDER_CHANGED');
      const accounts = await call('eth_accounts'), chain = await call('eth_chainId');
      if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== reviewedRecord.owner) throw new Error('UNISWAP_WRONG_OWNER');
      if (typeof chain !== 'string' || chain.toLowerCase() !== reviewedChain) throw new Error('UNISWAP_WRONG_CHAIN');
    };
    const validateSession = async (nonce: string | null) => {
      await sameSession();
      if (nonce !== null) {
        const evidence = await observeWalletNonce({ reviewed: BigInt(nonce), read: () => call('eth_getTransactionCount', [reviewedRecord.owner, 'pending']), stillCurrent: sameSession });
        const refusal = walletNonceRefusal('UNISWAP', evidence, 'RESPONSE_INVALID'); if (refusal) throw new Error(refusal);
      }
    };
    let prepared = false;
    try {
      await validateSession(null);
      const begun = unwrap(await uniswapPositionBegin(id, session.account, snapshot)); accept(begun.record); prepared = true;
      const tx = begun.transaction;
      // The exact reviewed envelope: network, owner, no value, the reviewed Position Manager and call data, the reviewed gas and fee caps.
      if (begun.record.review.commitment !== reviewedRecord.review.commitment || begun.attempt.reviewCommitment !== reviewedRecord.review.commitment ||
          !uniswapPositionWalletTransactionMatches(reviewedRecord.review, tx, begun.attempt.nonce)) throw new Error('UNISWAP_TRANSACTION_ARTIFACT_CHANGED');
      await validateSession(begun.attempt.nonce);
      accept(unwrap(await uniswapPositionHandoff(id)));
      if (latestWallet.current.account?.toLowerCase() !== session.account.toLowerCase() || latestWallet.current.chainId !== session.chainId) throw new Error('UNISWAP_WRONG_OWNER');
      // The sole submission point, reachable only from the owner's Execute click. The wallet assigns the reviewed nonce.
      setSigning(true); diagnostic.invoked = true; busyRef.current = false; setBusy(false);
      let hash: unknown;
      try { hash = await call('eth_sendTransaction', [tx]); } finally { setSigning(false); }
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('UNISWAP_SUBMISSION_UNKNOWN');
      try { window.localStorage.setItem(UNISWAP_POSITION_RUN_KEY, JSON.stringify({ id, hash: hash.toLowerCase() })); } catch { /* Reported to the server next. */ }
      accept(unwrap(await uniswapPositionReport(id, { kind: 'HASH', hash: hash.toLowerCase() })));
    } catch (cause) {
      const send = diagnostic.calls.find(c => c.submission), sendError = send?.error as { code?: unknown } | undefined;
      const refused = Boolean(send) && send!.result === undefined && typeof sendError?.code === 'number' && REFUSALS.includes(sendError.code);
      if (refused) diagnostic.rejectionCode = sendError!.code as number;
      diagnostic.code = refused ? 'UNISWAP_REJECTED' : !diagnostic.invoked ? (cause instanceof Error && /^UNISWAP_[A-Z0-9_]+$/.test(cause.message) ? cause.message : 'UNISWAP_RPC_ERROR_BEFORE_WALLET_SUBMISSION') : 'UNISWAP_SUBMISSION_UNKNOWN';
      if (prepared && (!diagnostic.invoked || refused)) {
        // BUILD-FLOFI-LIQUIDITY-RELIABILITY-GLOBAL-PRECISION-001: a hand-off refusal is concluded by the server itself (its attempt is provably
        // unsent), so the report is then refused; the run's current record (CANCELLED, authorization cleared) replaces the stale PREPARED one.
        const reported = await uniswapPositionWalletFailure(id, diagnostic);
        const failure = reported.ok ? reported : await uniswapPositionStatus(id).catch(() => reported);
        // A refusal that execute() refreshes in place hands its record over instead of showing it.
        if (!diagnostic.invoked && UNISWAP_POSITION_REFRESH_IN_PLACE.test(diagnostic.code)) throw Object.assign(new Error(diagnostic.code, { cause }), { interim: failure.ok ? failure.value : null });
        if (failure.ok) accept(failure.value);
        throw new Error(diagnostic.code, { cause });
      }
      if (diagnostic.invoked) {
        // The request may have reached the network: never resend, only observe (read-only).
        const report = await uniswapPositionReport(id, { kind: 'UNKNOWN', code: diagnostic.code }); if (report.ok) accept(report.value);
        const observed = await uniswapPositionObserve(id).catch(() => null); if (observed?.ok) accept(observed.value);
        throw new Error('UNISWAP_SUBMISSION_UNKNOWN_OBSERVE_EXISTING', { cause });
      }
      if (cause instanceof Error && /STATE_CHANGED|REVIEW_EXPIRED|OWNER_MISMATCH/.test(cause.message) && !UNISWAP_POSITION_REFRESH_IN_PLACE.test(cause.message)) {
        const current = await uniswapPositionStatus(id); if (current.ok) accept(current.value);
      }
      throw cause;
    }
    for (let i = 0; i < 20; i++) {
      const observed = await uniswapPositionObserve(id);
      if (!observed.ok) break;
      accept(observed.value);
      const last = observed.value.attempts.at(-1);
      if (!last || !['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING'].includes(last.state) || observed.value.verdict !== 'PENDING') break;
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
  }
  return <Context.Provider value={{ available, executionEnabled, record, busy, signing, error, retired, recovered, engaged,
    request: stagedRequest ?? (attaches ? record?.request ?? null : null),
    requoted: requoted && requoted.runId === record?.id ? requoted : null, simulate, refresh, review, execute, observe, switchNetwork }}>
    {signing && <WalletPendingNotice/>}
    <div data-uniswap-position-wallet-pending={signing ? 'true' : undefined}>{children}</div></Context.Provider>;
}
export function useUniswapPosition() { const value = useContext(Context); if (!value) throw new Error('UNISWAP_POSITION_PROVIDER_MISSING'); return value; }
/** The mounted position store, or null outside its provider (engineering pages and tests that mount only the mint store). */
export function useOptionalUniswapPosition() { return useContext(Context); }

/**
 * The execution lifecycle of the position run, exactly as `useExecutionLifecycle` projects the mint run (same projections, same
 * observation-only recovery): the shell uses it while this store serves the workflow. No effect, polling loop or execution callback.
 */
export function useUniswapPositionExecutionLifecycle(wallet: ReviewWallet) {
  const { runtimeWorkflow, context, newWorkflow } = useWorkflow(), position = useUniswapPosition();
  const source = { kind: 'uniswap-pool', state: position } as ExecutionLifecycleSource;
  const progress = projectExecutionLifecycle(runtimeWorkflow, context, source, { freshWorkflow: newWorkflow });
  const view = projectExecutionRecovery(source, progress, wallet);
  const recovery: ExecutionRecovery = { ...view, check: view.action === null ? null : position.observe };
  return { ...progress, stepEvidence: projectExecutionStepEvidence(source, progress), evidence: projectExecutionEvidence(source, progress), recovery };
}
