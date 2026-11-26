// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { WalletPendingNotice } from '../components/wallet-pending-notice';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { useWorkflow } from './workflow-store';
import { injected, useBuild009Wallet } from './build009-wallet-store';
import { uniswapLiquidityChainHex, uniswapLiquidityWalletTransactionMatches } from '../wallet/uniswap-liquidity-eip1193';
import { uniswapLiquidityBegin, uniswapLiquidityHandoff, uniswapLiquidityInvalidate, uniswapLiquidityMode, uniswapLiquidityObserve, uniswapLiquidityPrice,
  uniswapLiquidityRefresh, uniswapLiquidityReport, uniswapLiquidityReview, uniswapLiquiditySimulate, uniswapLiquidityStatus, uniswapLiquidityWalletFailure,
  uniswapLiquidityInfo, catalogLiquidityInfo, catalogLiquidityMode } from '../app/uniswap-liquidity-action';
import { CATALOG_NETWORK_IDENTITIES, networkIdentity } from '../domain/network-registry';
import type { UniswapLiquidityPrice, UniswapLiquidityRecord, UniswapWalletDiagnostic } from '../server/uniswap-liquidity-service';
import { observeWalletNonce, walletNonceRefusal } from '../domain/wallet-nonce';
import { UNISWAP_REFRESH_IN_PLACE, uniswapRunResumable } from '../domain/uniswap-liquidity-continuation';
import { OBSERVATION_TIMEOUT_MS, observeUntilSettled } from '../domain/observation-schedule';

const KEY = 'flofi:uniswap-liquidity:run';
const REFUSALS = [4001, 4100, 4200];
type Store = { available: boolean; executionEnabled: boolean; record: UniswapLiquidityRecord | null; busy: boolean; signing: boolean; error: string | null;
  retired: boolean; recovered: boolean; price: UniswapLiquidityPrice | null; priceChain: 'eip155:84532' | 'eip155:11155111' | null;
  /**
   * BUILD-FLOFI-LIQUIDITY-EXECUTION-UX-FIX-001 (EXEC-01): the run's Review stopped standing before the next wallet request (it expired, or the
   * pool or fees moved) and was refreshed in place: `code` says why; the updated Review of the same run waits for the owner's authorization.
   * The same contract as the bridges' in-place re-quote, so the Review, the chat and the Canvas present it the same way.
   */
  requoted: { readonly code: string; readonly runId: string } | null;
  simulate(): Promise<void>; refresh(): Promise<void>; review(): Promise<void>; execute(): Promise<void>; observe(): Promise<void>;
  switchNetwork(): Promise<void>; fetchPrice(chain?: 'eip155:84532' | 'eip155:11155111'): Promise<UniswapLiquidityPrice | null> };
const Context = createContext<Store | null>(null);
function errorValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 512) : value ?? null;
  const v = value as { code?: unknown; message?: unknown };
  return { code: typeof v.code === 'number' || typeof v.code === 'string' ? v.code : null, message: typeof v.message === 'string' ? v.message.slice(0, 512) : null };
}
const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; code: string }): T => { if (!result.ok) throw new Error(result.code); return result.value; };

export function UniswapLiquidityProvider({ children }: { children: ReactNode }) {
  const { runtimeWorkflow, sequenceRestore, restoreLiquidityCanvas, trackCanvasRestoration } = useWorkflow(), wallet = useBuild009Wallet();
  const [record, setRecord] = useState<UniswapLiquidityRecord | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  // BUILD-RH-002: the testnet pools and each catalog network (real funds: Robinhood Chain, BUILD-BASE-001 Base) are enabled separately; the
  // authored position (else the run) selects one.
  type Availability = { available: boolean; executionEnabled: boolean };
  const [signing, setSigning] = useState(false), [networks, setNetworks] = useState<Readonly<Record<string, Availability>>>({ testnet: { available: false, executionEnabled: false } });
  const [recovered, setRecovered] = useState(false), [price, setPrice] = useState<UniswapLiquidityPrice | null>(null);
  const [priceChain, setPriceChain] = useState<'eip155:84532' | 'eip155:11155111' | null>(null);
  const [requoted, setRequoted] = useState<Store['requoted']>(null);
  // PR #254 follow-up (production: Swap → Bridge → Pool refused at simulation, ROUTER_ISOLATED_ONLY): a pool step of a step-by-step sequence is
  // simulated, reviewed and executed ALONE, like every other sequence runtime (`SEQUENCE_RUNTIMES`): the store's `runtimeWorkflow` is that step
  // (its amount bound to what the earlier step delivered) and, outside a sequence, the canonical workflow itself. It used the whole workflow, so the
  // server linted the swap and the bridge with the pool and refused them together.
  const workflow = runtimeWorkflow as unknown as SemanticWorkflow;
  const authoredChain = workflow.nodes.find(n => n.actionType === 'asset.liquidity.concentrated')?.chainId;
  const servedCatalog = networkIdentity(authoredChain ?? (record ? `eip155:${record.review.chainId}` : null));
  const { available, executionEnabled } = (servedCatalog?.catalog ? networks[servedCatalog.chain] : networks.testnet) ?? { available: false, executionEnabled: false };
  const latest = useRef(workflow); latest.current = workflow;
  const latestWallet = useRef(wallet); latestWallet.current = wallet;
  const busyRef = useRef(false), operationEpoch = useRef(0);
  // The run currently shown (set with every record the store shows) and whether the provider is mounted: a follow applies only to its own run.
  const shownRun = useRef<string | null>(null), mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  // A recovered run stays visible on the untouched template; any other workflow change retires its Review.
  const retired = Boolean(record && JSON.stringify(record.workflow) !== JSON.stringify(workflow) &&
    !(recovered && workflow.revision === 0 && workflow.nodes.every(n => n.actionType.startsWith('mock-'))));
  function accept(value: UniswapLiquidityRecord) {
    shownRun.current = value.id; setRecord(value);
    const hash = value.attempts.at(-1)?.transactionHash;
    try { window.localStorage.setItem(KEY, JSON.stringify({ id: value.id, ...hash ? { hash } : {} })); } catch { /* The server run remains authoritative. */ }
  }
  useEffect(() => {
    let mounted = true;
    const sources: readonly (readonly [string, () => Promise<string>, () => Promise<{ ok: true; value: { executionEnabled: boolean } } | { ok: false; code: string }>])[] = [
      ['testnet', uniswapLiquidityMode, uniswapLiquidityInfo],
      ...CATALOG_NETWORK_IDENTITIES.map(network => [network.chain, () => catalogLiquidityMode(network.chain), () => catalogLiquidityInfo(network.chain)] as const)];
    for (const [network, mode, info] of sources)
      mode().then(value => {
        if (!mounted) return;
        setNetworks(current => ({ ...current, [network]: { executionEnabled: false, ...current[network], available: value !== 'off' } }));
        if (value !== 'off') info().then(result => { if (mounted && result.ok) setNetworks(current => ({ ...current, [network]: { available: true, ...current[network], executionEnabled: result.value.executionEnabled } })); })
          .catch(() => undefined);
      }).catch(() => undefined);
    try {
      const pointer = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as { id?: unknown; hash?: unknown } | null;
      if (pointer && typeof pointer.id === 'string' && /^(?:unilp|rhlp|balp|arlp|etlp)-[a-f0-9]{32}$/.test(pointer.id)) (async () => {
        // A hash saved before the browser closed reaches the server first; it is never resent to a wallet.
        if (typeof pointer.hash === 'string' && /^0x[0-9a-f]{64}$/.test(pointer.hash))
          await uniswapLiquidityReport(pointer.id as string, { kind: 'HASH', hash: pointer.hash }).catch(() => undefined);
        return trackCanvasRestoration(uniswapLiquidityStatus(pointer.id as string));
      })().then(result => {
        if (!mounted || !result.ok) return;
        shownRun.current = result.value.id; setRecord(result.value); setRecovered(true);
        // EXEC-01: a started run that still needs the owner (a confirmed approval, the rest not sent) shows its own workflow on the untouched
        // Canvas again, so the owner can refresh its Review and continue it after a reload. Finished runs stay in the Dashboard.
        if (result.value.verdict === 'PENDING' && result.value.attempts.length > 0) restoreLiquidityCanvas(result.value.workflow);
      }).catch(() => undefined);
    } catch { setError('UNISWAP_RECOVERY_POINTER_INVALID'); }
    return () => { mounted = false; };
  }, [restoreLiquidityCanvas, trackCanvasRestoration]);
  useEffect(() => {
    // While a sequence's completed steps are being re-proven after a reload the runtime step is not settled yet: nothing is invalidated then.
    // Post-#254 hotfix: a settled run keeps its authorization on the server (nothing more can run from it); that unchanged run is not shown again,
    // which would only ask again. An in-flight attempt keeps its state, error and evidence; only its authorization ends.
    if (record && retired && record.authorization && !sequenceRestore) uniswapLiquidityInvalidate(record.id).then(r => { if (r.ok && r.value.authorization === null) setRecord(r.value); })
      .catch(() => setError('UNISWAP_AUTHORIZATION_INVALIDATION_FAILED'));
  }, [record, retired, sequenceRestore]);
  async function operation(action: () => Promise<void>) {
    if (busyRef.current) return; const epoch = ++operationEpoch.current; busyRef.current = true; setBusy(true); setError(null);
    // EXEC-01: a refusal refreshed in place leaves no error (its updated Review is valid; `requoted` explains it).
    try { await action(); } catch (cause) { const code = cause instanceof Error ? cause.message : 'UNISWAP_OPERATION_FAILED'; setError(code === 'UNISWAP_REFRESHED_REVIEW_REQUIRED' ? null : code); }
    finally { if (operationEpoch.current === epoch) { busyRef.current = false; setBusy(false); } }
  }
  async function ownerSession() {
    let session = await wallet.session(); if (!session) session = await wallet.connect();
    if (!session) throw new Error('UNISWAP_WALLET_REQUIRED');
    return session;
  }
  /** The pool price of a liquidity network (Base Sepolia unless the form names Ethereum Sepolia). */
  async function fetchPrice(chain?: 'eip155:84532' | 'eip155:11155111'): Promise<UniswapLiquidityPrice | null> {
    let value: UniswapLiquidityPrice | null = null;
    await operation(async () => { value = unwrap(await uniswapLiquidityPrice(chain)); setPrice(value); setPriceChain(chain ?? 'eip155:84532'); });
    return value;
  }
  /** The reviewed run's chain (else the authored position's) is the only network the wallet may be on. */
  const chainHexOf = uniswapLiquidityChainHex;
  async function simulate() { await operation(async () => {
    // HOTFIX-WORKFLOW-CONCURRENCY-001: a pending transaction never blocks a new, separate simulation; the earlier run keeps being observed
    // server-side and stays listed in Dashboard.
    const session = await ownerSession(), snapshot = latest.current;
    const value = unwrap(await uniswapLiquiditySimulate(snapshot, session.account));
    if (latest.current !== snapshot) throw new Error('UNISWAP_SEMANTIC_REVISION_CHANGED');
    setRecovered(false); setRequoted(null); accept(value);
  }); }
  /** A fresh simulation and Review of the same run (read-only); its earlier confirmed steps stay, the updated Review needs a new authorization. */
  async function refresh() { await operation(async () => { if (!record) throw new Error('UNISWAP_RUN_MISSING'); setRequoted(null); accept(unwrap(await uniswapLiquidityRefresh(record.id))); }); }
  async function review() { await operation(async () => {
    if (!record || retired) throw new Error('UNISWAP_SIMULATION_REQUIRED');
    const result = await uniswapLiquidityReview(record.id, record.review.commitment, record.workflow);
    // EXEC-01: a Review authorized in its last seconds (too close to expiry to reach the wallet) is refused by the server; the same run is then
    // refreshed in place, as after Execute, and the owner authorizes the updated Review. Nothing is authorized by itself.
    if (!result.ok && result.code === 'UNISWAP_REVIEW_EXPIRED' && uniswapRunResumable(record)) {
      const refreshed = unwrap(await uniswapLiquidityRefresh(record.id));
      accept(refreshed); setRequoted({ code: result.code, runId: record.id });
      throw new Error('UNISWAP_REFRESHED_REVIEW_REQUIRED');
    }
    accept(unwrap(result));
    setRequoted(null);
  }); }
  async function observe() { await operation(async () => { if (!record) throw new Error('UNISWAP_RUN_MISSING'); accept(unwrap(await uniswapLiquidityObserve(record.id))); }); }
  async function switchNetwork() { await operation(async () => {
    const target = chainHexOf(record?.review.chainId ?? latest.current.nodes.find(n => n.actionType === 'asset.liquidity.concentrated')?.chainId);
    if (!target) throw new Error('UNISWAP_REVIEW_REQUIRED');
    // The profile registry supplies the chain; the shared wallet revalidates it against its switchable network registry.
    await wallet.switchTo(target as Parameters<typeof wallet.switchTo>[0]);
  }); }
  /** One Execute click = one exact wallet request (the next approval or the mint). */
  async function execute() { await operation(async () => {
    const reviewed = record;
    try { await request(); }
    catch (cause) {
      // EXEC-01 (incident balp-ae7ef0ce…): the server refused before any wallet request because the Review no longer stands (expired, or the
      // pool, fees or gas moved). Nothing was sent: the SAME run is refreshed in place (read-only), keeping every confirmed step, and its updated
      // Review — only the requests still needed — waits for the owner's explicit authorization. Never a silent extension, never a new run.
      const code = cause instanceof Error ? cause.message : '';
      if (reviewed && UNISWAP_REFRESH_IN_PLACE.test(code)) {
        // No interim record is shown while the run is refreshed: its concluded attempt would read "partially completed" and end the chat's
        // follow-up before the updated Review arrives (as the universal bridge store does). Only the refreshed run, else the latest record.
        const interim = (cause as { interim?: UniswapLiquidityRecord | null }).interim ?? null;
        const current = await uniswapLiquidityStatus(reviewed.id).catch(() => null);
        const latestRecord = current?.ok ? current.value : interim;
        if (latestRecord && uniswapRunResumable(latestRecord)) {
          const refreshed = await uniswapLiquidityRefresh(reviewed.id).catch(() => null);
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
    const reviewedChain = chainHexOf(record.review.chainId);
    if (!reviewedChain) throw new Error('UNISWAP_WRONG_CHAIN');
    const session = await ownerSession();
    if (session.chainId !== reviewedChain) throw new Error('UNISWAP_WRONG_CHAIN');
    if (session.account !== record.owner) throw new Error('UNISWAP_WRONG_OWNER');
    const provider = injected(); if (!provider) throw new Error('UNISWAP_WALLET_REQUIRED');
    // The reviewed IR is the server-held run's (it survives reloads; `begin` re-validates it). The editor must not change mid-operation.
    const snapshot = record.workflow, editing = latest.current, id = record.id;
    const diagnostic: UniswapWalletDiagnostic = { invoked: false, calls: [], code: 'UNISWAP_WALLET_PREFLIGHT' };
    const request = async (method: string, params: unknown[] = []) => {
      const call: UniswapWalletDiagnostic['calls'][number] = { method, ...method === 'eth_sendTransaction' ? { submission: true } : {} }; diagnostic.calls.push(call);
      try { const result = await provider.request({ method, ...params.length ? { params } : {} }); call.result = typeof result === 'string' ? result.slice(0, 200) : null; return result; }
      catch (cause) { call.error = errorValue(cause); throw cause; }
    };
    // Read-only session checks before and after the durable preparation; any change fails closed.
    const validateSession = async (nonce: string | null) => {
      const accounts = await request('eth_accounts'), chain = await request('eth_chainId');
      if (latest.current !== editing) throw new Error('UNISWAP_SEMANTIC_REVISION_CHANGED');
      if (injected() !== provider) throw new Error('UNISWAP_WALLET_PROVIDER_CHANGED');
      if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== record.owner) throw new Error('UNISWAP_WRONG_OWNER');
      if (typeof chain !== 'string' || chain.toLowerCase() !== reviewedChain) throw new Error('UNISWAP_WRONG_CHAIN');
      // BUILD-P0-MAINNET-EXECUTION-RELIABILITY: the wallet's pending count must equal the reviewed nonce; a lagging wallet view is re-read (bounded).
      if (nonce !== null) {
        const evidence = await observeWalletNonce({ reviewed: BigInt(nonce), read: () => request('eth_getTransactionCount', [record.owner, 'pending']), stillCurrent: async () => {
          if (latest.current !== editing) throw new Error('UNISWAP_SEMANTIC_REVISION_CHANGED');
          if (injected() !== provider) throw new Error('UNISWAP_WALLET_PROVIDER_CHANGED');
          // The owner and network are read again from the wallet before every re-read (wallet-execution review).
          const accounts = await request('eth_accounts'), chain = await request('eth_chainId');
          if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== record.owner) throw new Error('UNISWAP_WRONG_OWNER');
          if (typeof chain !== 'string' || chain.toLowerCase() !== reviewedChain) throw new Error('UNISWAP_WRONG_CHAIN');
        } });
        const refusal = walletNonceRefusal('UNISWAP', evidence, 'RESPONSE_INVALID'); if (refusal) throw new Error(refusal);
      }
    };
    let prepared = false;
    try {
      await validateSession(null);
      const begun = unwrap(await uniswapLiquidityBegin(id, session.account, snapshot)); accept(begun.record); prepared = true;
      const tx = begun.transaction;
      if (!uniswapLiquidityWalletTransactionMatches(record.review, begun.attempt.step, tx)) throw new Error('UNISWAP_TRANSACTION_ARTIFACT_CHANGED');
      await validateSession(begun.attempt.nonce);
      accept(unwrap(await uniswapLiquidityHandoff(id)));
      if (latestWallet.current.account !== session.account || latestWallet.current.chainId !== session.chainId) throw new Error('UNISWAP_WRONG_OWNER');
      // Post-#254 hotfix (flofi-liquidity and flofi-security reviews): an edit made after the last session check (while the wallet answered its
      // nonce read, or during the hand-off) stops the request here, before the wallet is asked; the attempt is concluded unsent below.
      if (latest.current !== editing) throw new Error('UNISWAP_SEMANTIC_REVISION_CHANGED');
      // The sole submission point, reachable only from the owner's Execute click. The wallet assigns the reviewed nonce.
      setSigning(true); diagnostic.invoked = true; busyRef.current = false; setBusy(false);
      let hash: unknown;
      try { hash = await request('eth_sendTransaction', [tx]); } finally { setSigning(false); }
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('UNISWAP_SUBMISSION_UNKNOWN');
      try { window.localStorage.setItem(KEY, JSON.stringify({ id, hash: hash.toLowerCase() })); } catch { /* Reported to the server next. */ }
      accept(unwrap(await uniswapLiquidityReport(id, { kind: 'HASH', hash: hash.toLowerCase() })));
    } catch (cause) {
      const send = diagnostic.calls.find(c => c.submission), sendError = send?.error as { code?: unknown } | undefined;
      const refused = Boolean(send) && send!.result === undefined && typeof sendError?.code === 'number' && REFUSALS.includes(sendError.code);
      if (refused) diagnostic.rejectionCode = sendError!.code as number;
      diagnostic.code = refused ? 'UNISWAP_REJECTED' : !diagnostic.invoked ? (cause instanceof Error && /^UNISWAP_[A-Z0-9_]+$/.test(cause.message) ? cause.message : 'UNISWAP_RPC_ERROR_BEFORE_WALLET_SUBMISSION') : 'UNISWAP_SUBMISSION_UNKNOWN';
      if (prepared && (!diagnostic.invoked || refused)) {
        // BUILD-FLOFI-LIQUIDITY-RELIABILITY-GLOBAL-PRECISION-001: a hand-off refusal is concluded by the server itself (its attempt is provably
        // unsent), so the report is then refused; the run's current record (CANCELLED, authorization cleared) replaces the stale PREPARED one.
        const reported = await uniswapLiquidityWalletFailure(id, diagnostic);
        const failure = reported.ok ? reported : await uniswapLiquidityStatus(id).catch(() => reported);
        // A refusal that execute() refreshes in place hands its record over instead of showing it (see execute()).
        if (!diagnostic.invoked && UNISWAP_REFRESH_IN_PLACE.test(diagnostic.code)) throw Object.assign(new Error(diagnostic.code, { cause }), { interim: failure.ok ? failure.value : null });
        if (failure.ok) accept(failure.value);
        throw new Error(diagnostic.code, { cause });
      }
      if (diagnostic.invoked) {
        // The request may have reached the network: never resend, only observe.
        const report = await uniswapLiquidityReport(id, { kind: 'UNKNOWN', code: diagnostic.code }); if (report.ok) accept(report.value);
        throw new Error('UNISWAP_SUBMISSION_UNKNOWN_OBSERVE_EXISTING', { cause });
      }
      // A refusal that execute() refreshes in place is not shown on its own (see execute()); any other stale-state refusal shows the latest record.
      if (cause instanceof Error && /STATE_CHANGED|REVIEW_EXPIRED/.test(cause.message) && !UNISWAP_REFRESH_IN_PLACE.test(cause.message)) {
        const current = await uniswapLiquidityStatus(id); if (current.ok) accept(current.value);
      }
      throw cause;
    }
    // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: the shared observation schedule (domain/observation-schedule.ts: about four and a half minutes
    // instead of 20 × 2 s) with the same stopping rule, so a slow confirmation no longer ends in a manual check. Read-only (observe only); a result
    // is applied only while this run is still the one shown (a newer run is never replaced) and the follow stops on unmount. As before, an
    // unanswered observation ends it quietly and the manual check stays.
    const shown = () => mountedRef.current && shownRun.current === id;
    // A thrown observation (a lost response, a network failure) ends the follow quietly too: the submitted request is never called "not sent"
    // and the manual check stays; each observation is bounded (`OBSERVATION_TIMEOUT_MS`).
    await observeUntilSettled(async () => {
      const observed = await uniswapLiquidityObserve(id).catch(() => null);
      if (!observed?.ok) return null;
      if (shown()) accept(observed.value);
      return observed.value;
    }, value => { const last = value?.attempts.at(-1); return !value || !last || !['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING'].includes(last.state) || value.verdict !== 'PENDING'; },
    { active: shown, timeoutMs: OBSERVATION_TIMEOUT_MS }).catch(() => undefined);
  }
  return <Context.Provider value={{ available, executionEnabled, record, busy, signing, error, retired, recovered, price, priceChain,
    requoted: requoted && requoted.runId === record?.id ? requoted : null, simulate, refresh, review, execute, observe, switchNetwork, fetchPrice }}>
    {signing && <WalletPendingNotice/>}
    <div data-uniswap-wallet-pending={signing ? 'true' : undefined}>{children}</div></Context.Provider>;
}
export function useUniswapLiquidity() { const value = useContext(Context); if (!value) throw new Error('UNISWAP_LIQUIDITY_PROVIDER_MISSING'); return value; }
