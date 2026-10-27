// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { UNIVERSAL_NETWORKS, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { useWorkflow } from './workflow-store';
import { injected, useBuild009Wallet } from './build009-wallet-store';
import { useJupiter } from './jupiter-store';
import { signSolanaMessage, signWithSolanaWallet } from '../wallet/solana-wallet';
import { universalBegin, universalDiscover, universalHandoff, universalInfo, universalInvalidate, universalObserve, universalRefresh, universalReport, universalReview,
  universalRouterAvailability, universalRuns, universalSimulate, universalStatus, universalSubmit, universalWalletFailure, type UniversalEcosystem,
  type UniversalRunSummary } from '../app/universal-router-action';
import { solanaSessionStatus, solanaSignIn, solanaSignInChallenge, walletSessionStatus, walletSignIn, walletSignInChallenge } from '../app/wallet-session-action';
import { universalBridgeOfWorkflow, type UniversalBridgeDetails } from '../domain/universal-bridge-authoring';
import type { DiscoveryResult } from '../server/universal-router/discovery';
import type { UniversalRecord, UniversalWalletDiagnostic } from '../server/universal-router/types';

/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001 browser state for the universal Cross-chain Router. The server-held run is authoritative; this store keeps a
 * pointer (run id, ecosystem, owner and the last EVM hash) so a reload resumes observation. The source wallet signs: an EVM wallet (Sign-In With
 * Ethereum session; it sends each reviewed call) or a Solana wallet (Sign-In With Solana session; it signs the reviewed message, which FloFi
 * verifies and broadcasts once). Across ecosystems the destination wallet is the connected wallet of the other ecosystem, or an explicit
 * recipient. The only submission point is the owner's Execute click, after a durable handoff and fresh account/chain checks.
 */
const KEY = 'flofi:crosschain-universal:run';
const REFUSALS = [4001, 4100, 4200];
const OBSERVABLE = ['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING'];
type Pointer = { id: string; ecosystem: UniversalEcosystem; owner: string; hash?: string };
type Store = { available: boolean; executionEnabled: boolean; details: UniversalBridgeDetails | null; ecosystem: UniversalEcosystem | null;
  owner: string | null; destinationWallet: string | null; record: UniversalRecord | null; discovery: DiscoveryResult | null; busy: boolean; signing: boolean;
  error: string | null; correlationId: string | null; retired: boolean; recovered: boolean; runs: readonly UniversalRunSummary[]; signedIn: boolean;
  connect(): Promise<void>; signIn(): Promise<void>; discover(): Promise<void>; simulate(): Promise<void>; refresh(): Promise<void>; review(): Promise<void>;
  execute(): Promise<void>; observe(): Promise<void>; open(runId: string): Promise<void>; loadRuns(): Promise<void>; switchNetwork(): Promise<void> };
const Context = createContext<Store | null>(null);
const unwrap = <T,>(result: { ok: true; value: T } | { ok: false; code: string; correlationId?: string }): T => { if (!result.ok) throw Object.assign(new Error(result.code), { correlationId: result.correlationId }); return result.value; };
const utf8Hex = (text: string) => '0x' + Array.from(new TextEncoder().encode(text), b => b.toString(16).padStart(2, '0')).join('');
const ecosystemOfRecord = (record: UniversalRecord): UniversalEcosystem => record.review.source.ecosystem;
function errorValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 512) : value ?? null;
  const v = value as { code?: unknown; message?: unknown };
  return { code: typeof v.code === 'number' || typeof v.code === 'string' ? v.code : null, message: typeof v.message === 'string' ? v.message.slice(0, 512) : null };
}
function readPointer(): Pointer | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Pointer | null;
    return value && typeof value.id === 'string' && /^xuni-[a-f0-9]{32}$/.test(value.id) && (value.ecosystem === 'EVM' || value.ecosystem === 'SOLANA') ? value : null;
  } catch { return null; }
}

export function UniversalRouterProvider({ children }: { children: ReactNode }) {
  const { state } = useWorkflow(), wallet = useBuild009Wallet(), solana = useJupiter();
  const [record, setRecord] = useState<UniversalRecord | null>(null), [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [busy, setBusy] = useState(false), [signing, setSigning] = useState(false), [error, setError] = useState<string | null>(null);
  const [correlationId, setCorrelationId] = useState<string | null>(null);
  const [available, setAvailable] = useState(false), [executionEnabled, setExecutionEnabled] = useState(false), [recovered, setRecovered] = useState(false);
  const [runs, setRuns] = useState<readonly UniversalRunSummary[]>([]), [sessions, setSessions] = useState<{ EVM: string | null; SOLANA: string | null }>({ EVM: null, SOLANA: null });
  const workflow = state.workflow as unknown as SemanticWorkflow;
  const details = universalBridgeOfWorkflow(workflow);
  const ecosystem: UniversalEcosystem | null = details ? UNIVERSAL_NETWORKS[details.source].ecosystem : record ? ecosystemOfRecord(record) : null;
  const destinationEcosystem = details ? UNIVERSAL_NETWORKS[details.destination].ecosystem : null;
  const solanaAccount = solana.session?.chain === 'solana:mainnet' ? solana.session.account.address : null;
  const owner = ecosystem === 'EVM' ? wallet.account : ecosystem === 'SOLANA' ? solanaAccount : null;
  const destinationWallet = destinationEcosystem && destinationEcosystem !== ecosystem ? destinationEcosystem === 'EVM' ? wallet.account : solanaAccount : null;
  const latest = useRef(workflow); latest.current = workflow;
  const latestSolana = useRef(solana.session); latestSolana.current = solana.session;
  const busyRef = useRef(false);
  const retired = Boolean(record && JSON.stringify(record.workflow) !== JSON.stringify(workflow) &&
    !(recovered && workflow.revision === 0 && workflow.nodes.every(n => n.actionType.startsWith('mock-'))));
  const signedIn = Boolean(ecosystem && owner && sessions[ecosystem] && sessions[ecosystem] === owner);
  function accept(value: UniversalRecord) {
    setRecord(value);
    const last = value.attempts.at(-1), hash = last?.ecosystem === 'EVM' ? last.transactionHash : null;
    try { window.localStorage.setItem(KEY, JSON.stringify({ id: value.id, ecosystem: ecosystemOfRecord(value), owner: value.owner, ...hash ? { hash } : {} })); }
    catch { /* The server run remains authoritative. */ }
  }
  async function refreshRuns(eco: UniversalEcosystem | null = ecosystem) {
    if (!eco) return;
    const listed = await universalRuns(eco).catch(() => null);
    setRuns(listed?.ok ? listed.value : []);
  }
  useEffect(() => {
    let mounted = true;
    universalRouterAvailability().then(mode => { if (mounted) setAvailable(mode !== 'off'); }).catch(() => undefined);
    universalInfo().then(info => { if (mounted && info.ok) setExecutionEnabled(info.value.executionEnabled); }).catch(() => undefined);
    Promise.all([walletSessionStatus().catch(() => null), solanaSessionStatus().catch(() => null)]).then(async ([evm, sol]) => {
      if (!mounted) return;
      setSessions({ EVM: evm?.account ?? null, SOLANA: sol?.account ?? null });
      // Resume the stored pointer of a signed-in wallet: a hash saved before the browser closed reaches the server first (never a wallet).
      const pointer = readPointer();
      if (!pointer || (pointer.ecosystem === 'EVM' ? evm?.account : sol?.account) !== pointer.owner) return;
      if (pointer.ecosystem === 'EVM' && typeof pointer.hash === 'string' && /^0x[0-9a-f]{64}$/.test(pointer.hash))
        await universalReport(pointer.id, { kind: 'HASH', hash: pointer.hash }).catch(() => undefined);
      const result = await universalStatus(pointer.ecosystem, pointer.id).catch(() => null);
      if (mounted && result?.ok) { setRecord(result.value); setRecovered(true); }
    }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);
  // A semantic edit after Review clears the unused authorization (fail closed).
  useEffect(() => {
    if (record && retired && record.phase === 'AUTHORIZED')
      universalInvalidate(ecosystemOfRecord(record), record.id).then(r => { if (r.ok) setRecord(r.value); }).catch(() => setError('UNIVERSAL_AUTHORIZATION_INVALIDATION_FAILED'));
  }, [record, retired]);
  // Another source account after Review clears that unused authorization as well; the new account needs its own Simulate and Review.
  useEffect(() => {
    if (record && owner && record.owner !== owner && record.phase === 'AUTHORIZED' && !record.attempts.some(a => OBSERVABLE.includes(a.state) || a.state === 'PREPARED'))
      universalInvalidate(ecosystemOfRecord(record), record.id, 'WALLET_CHANGED').then(r => { if (r.ok) setRecord(r.value); }).catch(() => undefined);
  }, [owner, record?.id, record?.phase]);
  async function operation(action: () => Promise<void>) {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(null); setCorrelationId(null);
    try { await action(); } catch (cause) { setError(cause instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/.test(cause.message) ? cause.message : 'UNIVERSAL_OPERATION_FAILED'); setCorrelationId(cause instanceof Error && 'correlationId' in cause && typeof cause.correlationId === 'string' && /^[a-f0-9-]{36}$/.test(cause.correlationId) ? cause.correlationId : null); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function connect() { await operation(async () => {
    if (ecosystem === 'SOLANA') await solana.connect('solana:mainnet');
    else { const s = await wallet.session(); if (!s) await wallet.connect(); }
    // Across ecosystems, the destination wallet is the other ecosystem's connected wallet (or an explicit recipient in the form).
    if (destinationEcosystem && destinationEcosystem !== ecosystem) {
      if (destinationEcosystem === 'SOLANA' && !solanaAccount) await solana.connect('solana:mainnet');
      if (destinationEcosystem === 'EVM' && !wallet.account) { const s = await wallet.session(); if (!s) await wallet.connect(); }
    }
  }); }
  /** One sign-in message for the source wallet (no transaction, no funds): the run belongs to this proven account. */
  async function establishSession(): Promise<string> {
    if (!ecosystem) throw new Error('UNIVERSAL_BRIDGE_REQUIRED');
    if (ecosystem === 'EVM') {
      let current = await wallet.session(); if (!current) current = await wallet.connect();
      if (!current) throw new Error('UNIVERSAL_WALLET_REQUIRED');
      if (sessions.EVM === current.account) return current.account;
      const existing = await walletSessionStatus().catch(() => null);
      if (existing?.account === current.account) { setSessions(s => ({ ...s, EVM: existing.account })); return existing.account; }
      const provider = injected(); if (!provider) throw new Error('UNIVERSAL_WALLET_REQUIRED');
      const { message } = unwrap(await walletSignInChallenge(current.account, Number.parseInt(current.chainId, 16)));
      const signature = await provider.request({ method: 'personal_sign', params: [utf8Hex(message), current.account] });
      if (typeof signature !== 'string') throw new Error('WALLET_SIGNATURE_INVALID');
      const established = unwrap(await walletSignIn(current.account, Number.parseInt(current.chainId, 16), signature));
      setSessions(s => ({ ...s, EVM: established.account }));
      return established.account;
    }
    const current = solana.session?.chain === 'solana:mainnet' ? solana.session : null;
    if (!current) throw new Error('UNIVERSAL_SOLANA_WALLET_REQUIRED');
    if (sessions.SOLANA === current.account.address) return current.account.address;
    const existing = await solanaSessionStatus().catch(() => null);
    if (existing?.account === current.account.address) { setSessions(s => ({ ...s, SOLANA: existing.account })); return existing.account; }
    const { message } = unwrap(await solanaSignInChallenge(current.account.address));
    const signature = await signSolanaMessage(current, message, 'WALLET');
    const established = unwrap(await solanaSignIn(current.account.address, signature));
    setSessions(s => ({ ...s, SOLANA: established.account }));
    return established.account;
  }
  async function signIn() { await operation(async () => { await establishSession(); await refreshRuns(); }); }
  async function discover() { await operation(async () => {
    if (!details) throw new Error('UNIVERSAL_BRIDGE_REQUIRED');
    const token = (key: typeof details.source, asset: typeof details.fields.inputAsset, symbol: string) => asset.kind === 'NATIVE' ? { kind: 'NATIVE' as const }
      : { kind: 'TOKEN' as const, address: asset.address, decimals: asset.decimals, ...symbol.includes('@') ? {} : { symbol } };
    const recipient = details.recipient || (destinationEcosystem === ecosystem ? owner : destinationWallet);
    const result = unwrap(await universalDiscover({ source: details.source, destination: details.destination, inputToken: token(details.source, details.fields.inputAsset, details.inputSymbol),
      outputToken: token(details.destination, details.fields.outputAsset, details.outputSymbol), amount: details.amountUnits, slippageBps: details.fields.slippageBps,
      ...owner ? { owner } : {}, ...owner && recipient ? { recipient } : {} }));
    setDiscovery(result);
  }); }
  async function simulate() { await operation(async () => {
    // HOTFIX-WORKFLOW-CONCURRENCY-001: a pending bridge never blocks a new, separate one; earlier runs keep being observed server-side.
    const account = await establishSession(), snapshot = latest.current;
    const value = unwrap(await universalSimulate(snapshot, account, destinationWallet ?? undefined));
    if (latest.current !== snapshot) throw new Error('UNIVERSAL_SEMANTIC_REVISION_CHANGED');
    setRecovered(false); accept(value); void refreshRuns();
  }); }
  async function refresh() { await operation(async () => {
    if (!record) throw new Error('UNIVERSAL_RUN_MISSING');
    accept(unwrap(await universalRefresh(ecosystemOfRecord(record), record.id, record.review.recipientKind === 'CONNECTED_DESTINATION_WALLET' ? destinationWallet ?? undefined : undefined)));
  }); }
  async function review() { await operation(async () => {
    if (!record || retired) throw new Error('UNIVERSAL_SIMULATION_REQUIRED');
    accept(unwrap(await universalReview(ecosystemOfRecord(record), record.id, record.review.commitment, record.workflow)));
  }); }
  async function poll(eco: UniversalEcosystem, id: string) {
    for (let i = 0; i < 20; i++) {
      const observed = await universalObserve(eco, id);
      if (!observed.ok) break;
      accept(observed.value);
      const last = observed.value.attempts.at(-1);
      if (observed.value.verdict !== 'PENDING' || !last || !OBSERVABLE.includes(last.state)) break;
      await new Promise(resolve => setTimeout(resolve, 2_000));
    }
  }
  async function observe() { await operation(async () => {
    if (!record) throw new Error('UNIVERSAL_RUN_MISSING');
    accept(unwrap(await universalObserve(ecosystemOfRecord(record), record.id))); void refreshRuns(ecosystemOfRecord(record));
  }); }
  async function open(runId: string) { await operation(async () => { if (!ecosystem) throw new Error('UNIVERSAL_BRIDGE_REQUIRED'); accept(unwrap(await universalStatus(ecosystem, runId))); setRecovered(true); }); }
  async function loadRuns() { await operation(async () => { await refreshRuns(); }); }
  async function switchNetwork() { await operation(async () => {
    const chainHex = record && record.review.source.ecosystem === 'EVM' ? '0x' + record.review.source.chainId.toString(16)
      : details && UNIVERSAL_NETWORKS[details.source].evmChainId ? '0x' + UNIVERSAL_NETWORKS[details.source].evmChainId!.toString(16) : null;
    if (chainHex) await wallet.switchTo(chainHex as Parameters<typeof wallet.switchTo>[0]);
  }); }
  async function executeEvm(current: UniversalRecord) {
    const src = current.review.source;
    if (src.ecosystem !== 'EVM') throw new Error('UNIVERSAL_WRONG_ECOSYSTEM');
    const chain = '0x' + src.chainId.toString(16);
    const connected = await wallet.session();
    if (!connected) throw new Error('UNIVERSAL_WALLET_REQUIRED');
    if (connected.chainId !== chain) throw new Error('UNIVERSAL_WRONG_CHAIN');
    if (connected.account !== current.owner || sessions.EVM !== current.owner) throw new Error('UNIVERSAL_WRONG_OWNER');
    const provider = injected(); if (!provider) throw new Error('UNIVERSAL_WALLET_REQUIRED');
    const snapshot = current.workflow, editing = latest.current, id = current.id;
    const diagnostic: UniversalWalletDiagnostic = { invoked: false, calls: [], code: 'UNIVERSAL_WALLET_PREFLIGHT' };
    const request = async (method: string, params: unknown[] = []) => {
      const call: UniversalWalletDiagnostic['calls'][number] = { method, ...method === 'eth_sendTransaction' ? { submission: true } : {} }; diagnostic.calls.push(call);
      try { const result = await provider.request({ method, ...params.length ? { params } : {} }); call.result = typeof result === 'string' ? result.slice(0, 200) : null; return result; }
      catch (cause) { call.error = errorValue(cause); throw cause; }
    };
    const validateSession = async () => {
      const accounts = await request('eth_accounts'), chainId = await request('eth_chainId');
      if (latest.current !== editing) throw new Error('UNIVERSAL_SEMANTIC_REVISION_CHANGED');
      if (injected() !== provider) throw new Error('UNIVERSAL_WALLET_PROVIDER_CHANGED');
      if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== current.owner) throw new Error('UNIVERSAL_WRONG_OWNER');
      if (typeof chainId !== 'string' || chainId.toLowerCase() !== chain) throw new Error('UNIVERSAL_WRONG_CHAIN');
    };
    let prepared = false;
    try {
      await validateSession();
      const begun = unwrap(await universalBegin('EVM', id, connected.account, snapshot)); accept(begun.record); prepared = true;
      if (begun.ecosystem !== 'EVM') throw new Error('UNIVERSAL_TRANSACTION_ARTIFACT_CHANGED');
      const tx = begun.transaction;
      // The wallet request must be one of the reviewed calls, byte for byte (target, data, value).
      if (tx.from !== current.owner || tx.chainId !== chain || !src.calls.some(c => c.to === tx.to && c.data === tx.data && BigInt(c.value) === BigInt(tx.value)))
        throw new Error('UNIVERSAL_TRANSACTION_ARTIFACT_CHANGED');
      await validateSession();
      accept(unwrap(await universalHandoff(id)));
      setSigning(true); diagnostic.invoked = true;
      let hash: unknown;
      try { hash = await request('eth_sendTransaction', [tx]); } finally { setSigning(false); }
      if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('UNIVERSAL_SUBMISSION_UNKNOWN');
      try { window.localStorage.setItem(KEY, JSON.stringify({ id, ecosystem: 'EVM', owner: current.owner, hash: hash.toLowerCase() })); } catch { /* Reported next. */ }
      accept(unwrap(await universalReport(id, { kind: 'HASH', hash: hash.toLowerCase() })));
    } catch (cause) {
      const send = diagnostic.calls.find(c => c.submission), sendError = send?.error as { code?: unknown } | undefined;
      const refused = Boolean(send) && send!.result === undefined && typeof sendError?.code === 'number' && REFUSALS.includes(sendError.code);
      if (refused) diagnostic.rejectionCode = sendError!.code as number;
      diagnostic.code = refused ? 'UNIVERSAL_REJECTED' : !diagnostic.invoked ? (cause instanceof Error && /^UNIVERSAL_[A-Z0-9_]+$/.test(cause.message) ? cause.message
        : 'UNIVERSAL_RPC_ERROR_BEFORE_WALLET_SUBMISSION') : 'UNIVERSAL_SUBMISSION_UNKNOWN';
      if (prepared && (!diagnostic.invoked || refused)) {
        const failure = await universalWalletFailure('EVM', id, diagnostic); if (failure.ok) accept(failure.value);
        throw new Error(diagnostic.code, { cause });
      }
      if (diagnostic.invoked) {
        // The request may have reached the network: never resend, only observe.
        const report = await universalReport(id, { kind: 'UNKNOWN', code: diagnostic.code }); if (report.ok) accept(report.value);
        throw new Error('UNIVERSAL_SUBMISSION_UNKNOWN_OBSERVE_EXISTING', { cause });
      }
      if (cause instanceof Error && /ROUTE_CHANGED|STATE_CHANGED|REVIEW_EXPIRED/.test(cause.message)) { const r = await universalStatus('EVM', id); if (r.ok) accept(r.value); }
      throw cause;
    }
    await poll('EVM', id);
  }
  async function executeSolana(current: UniversalRecord) {
    const session = solana.session;
    if (!session || session.chain !== 'solana:mainnet') throw new Error('UNIVERSAL_SOLANA_WALLET_REQUIRED');
    if (session.account.address !== current.owner || sessions.SOLANA !== current.owner) throw new Error('UNIVERSAL_WRONG_OWNER');
    const snapshot = current.workflow;
    const begun = unwrap(await universalBegin('SOLANA', current.id, session.account.address, snapshot)); accept(begun.record);
    if (begun.ecosystem !== 'SOLANA' || begun.walletChain !== session.chain) throw new Error('UNIVERSAL_WRONG_CLUSTER');
    let signed: string;
    setSigning(true);
    try {
      // The sole owner-signature request, reachable only from the owner's Execute click. Phantom may append verified Lighthouse assertions.
      signed = await signWithSolanaWallet(session, begun.unsignedTransaction, 'UNIVERSAL', () => {
        if (latestSolana.current !== session) throw new Error('UNIVERSAL_WALLET_CHANGED');
        if (JSON.stringify(latest.current) !== JSON.stringify(snapshot)) throw new Error('UNIVERSAL_SEMANTIC_REVISION_CHANGED');
      });
    } catch (cause) {
      const value = cause as { code?: unknown; name?: unknown; message?: unknown } | null;
      const code = cause instanceof Error && /^UNIVERSAL_[A-Z_]+$/.test(cause.message) ? cause.message
        : value && (value.code === 4001 || /reject|declin|denied|cancel/i.test(String(value.name ?? '') + String(value.message ?? ''))) ? 'UNIVERSAL_WALLET_REJECTED' : 'UNIVERSAL_WALLET_SIGN_FAILED';
      const recorded = await universalWalletFailure('SOLANA', current.id, { invoked: true, calls: [{ method: 'solana:signTransaction', error: errorValue(cause) }], code });
      if (recorded.ok) accept(recorded.value);
      throw new Error(code, { cause });
    } finally { setSigning(false); }
    accept(unwrap(await universalSubmit(current.id, signed)));
    await poll('SOLANA', current.id);
  }
  async function execute() { await operation(async () => {
    if (!record || retired || record.phase !== 'AUTHORIZED' || record.authorization !== record.review.commitment) throw new Error('UNIVERSAL_REVIEW_REQUIRED');
    await (ecosystemOfRecord(record) === 'EVM' ? executeEvm(record) : executeSolana(record));
    void refreshRuns(ecosystemOfRecord(record));
  }); }
  return <Context.Provider value={{ available, executionEnabled, details, ecosystem, owner, destinationWallet, record, discovery, busy, signing, error, correlationId, retired, recovered, runs,
    signedIn, connect, signIn, discover, simulate, refresh, review, execute, observe, open, loadRuns, switchNetwork }}>
    {signing && <p role="status">Confirm or reject the pending request in your wallet.</p>}
    <div inert={signing} data-universal-wallet-pending={signing ? 'true' : undefined}>{children}</div></Context.Provider>;
}
export function useUniversalRouter() { const value = useContext(Context); if (!value) throw new Error('UNIVERSAL_ROUTER_PROVIDER_MISSING'); return value; }
