// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import type { SolanaWalletChange } from '@defi-workflow-engine/reference-compiler';
import { useWorkflow } from './workflow-store';
import { useJupiter } from './jupiter-store';
import { solanaLiquidityDetails } from '../domain/solana-liquidity-authoring';
import { createPositionMintSigner, signOrcaLiquidityTransaction, type PositionMintSigner } from '../wallet/position-mint-signer';
import { solanaLiquidityBegin, solanaLiquidityInfo, solanaLiquidityInvalidate, solanaLiquidityObserve, solanaLiquidityPositions, solanaLiquidityPrice,
  solanaLiquidityReview, solanaLiquiditySimulate, solanaLiquidityStatus, solanaLiquiditySubmit, solanaLiquidityWalletFailure } from '../app/solana-liquidity-action';
import { solanaMainnetLiquidityBegin, solanaMainnetLiquidityInfo, solanaMainnetLiquidityInvalidate, solanaMainnetLiquidityObserve, solanaMainnetLiquidityPositions,
  solanaMainnetLiquidityPrice, solanaMainnetLiquidityReview, solanaMainnetLiquiditySimulate, solanaMainnetLiquidityStatus, solanaMainnetLiquiditySubmit,
  solanaMainnetLiquidityWalletFailure } from '../app/solana-mainnet-liquidity-action';
import { JUPITER_SOLANA_MAINNET } from '@defi-workflow-engine/action-registry';
import type { SolanaWalletChain } from '../wallet/solana-wallet';
import type { OrcaLiquidityRecord, OrcaPositionEntry } from '../server/orca-liquidity-service';

/**
 * BUILD-015 Orca liquidity on Solana Devnet; BUILD-SOLANA-MAINNET-001: the same flow on Solana mainnet-beta (real funds). The authored position's
 * cluster selects the runtime (server actions, storage, wallet chain); the wallet session is shared with the Solana swap (one wallet experience).
 * The OPEN position-mint key lives only in this tab's memory as a non-extractable CryptoKey; it is never persisted, and
 * a reload makes an unsigned OPEN unexecutable (the server then records it as not submitted).
 */
export type LiquidityOperation = 'OPEN' | 'DECREASE_PARTIAL' | 'EXIT';
export type PoolPrice = { price: string; lowerPrice: string; upperPrice: string; tickLower: number; tickUpper: number; tickCurrentIndex: number; slot: number;
  /** BUILD-SOLANA-MAINNET-001: the cluster whose pool this price was read from; a price is only ever used for that cluster. */ network?: 'Solana Devnet' | 'Solana' };
export type SolanaLiquidityNetwork = 'Solana Devnet' | 'Solana';
type Store = { record: OrcaLiquidityRecord | null; positions: OrcaPositionEntry[] | null; busy: boolean; error: string | null; retired: boolean; recovered: boolean;
  executionEnabled: boolean; signing: boolean; owner: string | null; price: PoolPrice | null;
  /** The cluster of the authored position (or of the recovered run); its wallet chain is the only one this flow signs on. */
  network: SolanaLiquidityNetwork; walletChain: SolanaWalletChain;
  refreshPositions(): Promise<void>; fetchPrice(network?: SolanaLiquidityNetwork): Promise<PoolPrice | null>; simulate(operation: LiquidityOperation, positionMint?: string, partBps?: number): Promise<void>;
  review(): Promise<void>; execute(): Promise<void>; observe(): Promise<void> };
const Context = createContext<Store | null>(null);
const key = 'gryloo:build015:orca-liquidity';
const runtimes = {
  'Solana Devnet': { walletChain: 'solana:devnet' as SolanaWalletChain, info: solanaLiquidityInfo, price: solanaLiquidityPrice, positions: solanaLiquidityPositions,
    simulate: solanaLiquiditySimulate, review: solanaLiquidityReview, invalidate: solanaLiquidityInvalidate, begin: solanaLiquidityBegin,
    walletFailure: solanaLiquidityWalletFailure, submit: solanaLiquiditySubmit, observe: solanaLiquidityObserve, status: solanaLiquidityStatus },
  Solana: { walletChain: 'solana:mainnet' as SolanaWalletChain, info: solanaMainnetLiquidityInfo, price: solanaMainnetLiquidityPrice, positions: solanaMainnetLiquidityPositions,
    simulate: solanaMainnetLiquiditySimulate, review: solanaMainnetLiquidityReview, invalidate: solanaMainnetLiquidityInvalidate, begin: solanaMainnetLiquidityBegin,
    walletFailure: solanaMainnetLiquidityWalletFailure, submit: solanaMainnetLiquiditySubmit, observe: solanaMainnetLiquidityObserve, status: solanaMainnetLiquidityStatus },
} as const;
const networkOfRecord = (record: OrcaLiquidityRecord): SolanaLiquidityNetwork => record.review.chain === JUPITER_SOLANA_MAINNET.chain ? 'Solana' : 'Solana Devnet';
const unresolved = (r: OrcaLiquidityRecord | null) => Boolean(r?.attempt && r.verdict === 'PENDING' && ['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING'].includes(r.attempt.state));
function walletCode(cause: unknown): string {
  const value = cause as { code?: unknown; name?: unknown; message?: unknown } | null;
  return value && (value.code === 4001 || /reject|declin|denied|cancel/i.test(String(value.name ?? '') + String(value.message ?? ''))) ? 'ORCA_LIQUIDITY_WALLET_REJECTED' : 'ORCA_LIQUIDITY_WALLET_SIGN_FAILED';
}
const bounded = (cause: unknown) => { try { const v = cause as Record<string, unknown>; return { name: String(v?.name ?? ''), code: typeof v?.code === 'number' ? v.code : null, message: String(v?.message ?? cause).slice(0, 500) }; } catch { return { message: 'unreadable' }; } };
/** The wallet-change summary a refusal may carry (ORCA_LIQUIDITY_TRANSACTION_CHANGED from the position signer). */
const walletChange = (cause: unknown) => { const change = (cause as { change?: { format?: unknown } } | null)?.change; return change?.format === 'flofi.solana-wallet-change.v1' ? { change: change as SolanaWalletChange } : {}; };

export function SolanaLiquidityProvider({ children }: { children: ReactNode }) {
  const { state } = useWorkflow();
  const jupiter = useJupiter();
  const [record, setRecord] = useState<OrcaLiquidityRecord | null>(null), [positions, setPositions] = useState<OrcaPositionEntry[] | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [recovered, setRecovered] = useState(false);
  const [enabled, setEnabled] = useState<Record<SolanaLiquidityNetwork, boolean>>({ 'Solana Devnet': false, Solana: false });
  const [signing, setSigning] = useState(false), [price, setPrice] = useState<PoolPrice | null>(null);
  const mintSigner = useRef<PositionMintSigner | null>(null), busyRef = useRef(false);
  const workflow = state.workflow as unknown as SemanticWorkflow;
  const latest = useRef(workflow); latest.current = workflow;
  const authoredNetwork = workflow.nodes.map(node => solanaLiquidityDetails(node)?.network).find(Boolean) ?? null;
  const authored = authoredNetwork !== null;
  const network: SolanaLiquidityNetwork = authoredNetwork ?? (record ? networkOfRecord(record) : 'Solana Devnet');
  const runtime = runtimes[network];
  // Only a session on this position's cluster is its owner; a session on the other cluster signs nothing here.
  const session = jupiter.session && jupiter.session.chain === runtime.walletChain ? jupiter.session : null;
  const owner = session?.account.address ?? null;
  const pristineRecovery = recovered && workflow.revision === 0;
  const retired = Boolean(record && JSON.stringify(record.review.workflow) !== JSON.stringify(workflow) && !pristineRecovery);
  function accept(value: OrcaLiquidityRecord) { setRecord(value); try { window.localStorage.setItem(key, JSON.stringify({ id: value.id, network: networkOfRecord(value) })); } catch { /* the server journal is authoritative */ } }
  useEffect(() => {
    let mounted = true;
    for (const name of ['Solana Devnet', 'Solana'] as const)
      runtimes[name].info().then(result => { if (mounted && result.ok) setEnabled(current => ({ ...current, [name]: result.value.executionEnabled })); }).catch(() => undefined);
    try {
      const pointer = JSON.parse(window.localStorage.getItem(key) ?? 'null') as { id?: unknown; network?: unknown } | null;
      // A pointer written before BUILD-SOLANA-MAINNET-001 has no network: it is a Devnet run.
      const pointed: SolanaLiquidityNetwork = pointer?.network === 'Solana' ? 'Solana' : 'Solana Devnet';
      if (pointer && typeof pointer.id === 'string' && /^orcalp-[a-f0-9]{32}$/.test(pointer.id))
        runtimes[pointed].status(pointer.id).then(result => { if (mounted && result.ok) { setRecord(result.value); setRecovered(true); } }).catch(() => undefined);
    } catch { setError('ORCA_LIQUIDITY_RECOVERY_POINTER_INVALID'); }
    return () => { mounted = false; };
  }, []);
  // A semantic edit after Review invalidates the authorization; any existing transaction stays observable.
  useEffect(() => { if (record && retired && record.authorization) runtimes[networkOfRecord(record)].invalidate(record.id).then(result => { if (result.ok) setRecord(result.value); })
    .catch(() => setError('ORCA_LIQUIDITY_AUTHORIZATION_INVALIDATION_FAILED')); }, [record, retired]);
  useEffect(() => {
    if (!signing) return;
    const prevent = (event: KeyboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    window.addEventListener('keydown', prevent, true);
    return () => window.removeEventListener('keydown', prevent, true);
  }, [signing]);
  async function operation(action: () => Promise<void>) {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'ORCA_LIQUIDITY_OPERATION_FAILED'); } finally { busyRef.current = false; setBusy(false); }
  }
  const refresh = useCallback(async (address: string) => {
    const result = await runtimes[network].positions(address); if (!result.ok) throw new Error(result.code);
    setPositions(result.value);
  }, [network]);
  useEffect(() => { if (owner && authored) refresh(owner).catch(() => undefined); }, [owner, authored, refresh]);
  async function poll(id: string, api: (typeof runtimes)[SolanaLiquidityNetwork]) {
    for (let i = 0; i < 30; i++) {
      const observed = await api.observe(id); if (!observed.ok) throw new Error(observed.code);
      accept(observed.value);
      if (!unresolved(observed.value)) return;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  async function refreshPositions() { await operation(async () => { if (!owner) throw new Error('ORCA_LIQUIDITY_SOLANA_WALLET_SELECTION_REQUIRED'); await refresh(owner); }); }
  /** The current price of a cluster's pool (by default the authored position's): a draft on another cluster asks for its own. */
  async function fetchPrice(of: SolanaLiquidityNetwork = network): Promise<PoolPrice | null> {
    let value: PoolPrice | null = null;
    await operation(async () => { const result = await runtimes[of].price(); if (!result.ok) throw new Error(result.code); value = { ...result.value, network: of }; setPrice(value); });
    return value;
  }
  async function simulate(op: LiquidityOperation, positionMint?: string, partBps?: number) { await operation(async () => {
    // HOTFIX-WORKFLOW-CONCURRENCY-001: a pending transaction never blocks a new, separate simulation; the earlier run keeps being observed
    // server-side and stays listed in Dashboard.
    if (!owner) throw new Error('ORCA_LIQUIDITY_SOLANA_WALLET_SELECTION_REQUIRED');
    const snapshot = latest.current;
    let mint = positionMint;
    if (op === 'OPEN') {
      // A fresh client-side key per OPEN simulation; only its public key leaves the browser.
      mintSigner.current = await createPositionMintSigner();
      mint = mintSigner.current.address;
    }
    if (!mint) throw new Error('ORCA_POSITION_UNKNOWN');
    const result = await runtime.simulate(snapshot, owner, { operation: op, positionMint: mint, ...partBps === undefined ? {} : { partBps } });
    if (!result.ok) throw new Error(result.code);
    if (latest.current !== snapshot) throw new Error('ORCA_LIQUIDITY_SEMANTIC_REVISION_CHANGED');
    accept(result.value); setRecovered(false);
  }); }
  async function review() { await operation(async () => {
    if (!record || retired) throw new Error('ORCA_LIQUIDITY_SIMULATION_REQUIRED');
    const result = await runtimes[networkOfRecord(record)].review(record.id, record.review.commitment, latest.current); if (!result.ok) throw new Error(result.code);
    accept(result.value);
  }); }
  async function execute() { await operation(async () => {
    if (!record || retired || record.authorization !== record.review.commitment) throw new Error('ORCA_LIQUIDITY_REVIEW_REQUIRED');
    if (!session) throw new Error('ORCA_LIQUIDITY_SOLANA_WALLET_SELECTION_REQUIRED');
    if (session.account.address !== record.review.owner) throw new Error('ORCA_LIQUIDITY_WRONG_OWNER');
    const needsKey = record.review.signers.length === 2;
    // Refuse before any durable attempt: an OPEN reviewed in another tab or before a reload cannot be completed here.
    if (needsKey && mintSigner.current?.address !== record.review.accounts.positionMint) throw new Error('ORCA_LIQUIDITY_POSITION_KEY_UNAVAILABLE');
    const snapshot = latest.current, api = runtimes[networkOfRecord(record)];
    // The session must be on the reviewed cluster before any durable attempt exists.
    if (session.chain !== api.walletChain) throw new Error('ORCA_LIQUIDITY_WRONG_CLUSTER');
    const begin = await api.begin(record.id, session.account.address, snapshot); if (!begin.ok) throw new Error(begin.code);
    accept(begin.value.record);
    let signed: string;
    setSigning(true);
    try {
      if (begin.value.walletChain !== session.chain) throw new Error('ORCA_LIQUIDITY_WRONG_CLUSTER');
      if (JSON.stringify(latest.current) !== JSON.stringify(snapshot)) throw new Error('ORCA_LIQUIDITY_SEMANTIC_REVISION_CHANGED');
      // The sole owner-signature request, reachable only from the owner's Execute click; the mint key signs only afterwards.
      signed = await signOrcaLiquidityTransaction(session, begin.value.unsignedTransaction, record.review.message, begin.value.signers, needsKey ? mintSigner.current : null);
    } catch (cause) {
      const failure = cause instanceof Error && /^ORCA_LIQUIDITY_[A-Z_]+$/.test(cause.message) ? cause.message : walletCode(cause);
      const recorded = await api.walletFailure(record.id, { stage: 'SIGN', code: failure, error: bounded(cause), ...walletChange(cause) });
      if (recorded.ok) accept(recorded.value);
      throw new Error(failure, { cause });
    } finally { setSigning(false); if (needsKey) mintSigner.current = null; }
    const submitted = await api.submit(record.id, signed); if (!submitted.ok) throw new Error(submitted.code);
    accept(submitted.value);
    if (submitted.value.attempt?.signature) await poll(record.id, api);
    await refresh(session.account.address).catch(() => undefined);
  }); }
  async function observe() { await operation(async () => {
    if (!record) throw new Error('ORCA_LIQUIDITY_RUN_MISSING');
    await poll(record.id, runtimes[networkOfRecord(record)]);
    if (owner) await refresh(owner).catch(() => undefined);
  }); }
  return <Context.Provider value={{ record, positions, busy, error, retired, recovered, executionEnabled: enabled[network], signing, owner, price, network,
    walletChain: runtime.walletChain, refreshPositions, fetchPrice, simulate, review, execute, observe }}>
    {signing && <p role="status">Confirm or reject the pending request in your Solana wallet.</p>}
    <div inert={signing} data-orca-liquidity-wallet-pending={signing ? 'true' : undefined}>{children}</div></Context.Provider>;
}
export function useSolanaLiquidity() { const value = useContext(Context); if (!value) throw new Error('SOLANA_LIQUIDITY_PROVIDER_MISSING'); return value; }
