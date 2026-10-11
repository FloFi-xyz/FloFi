// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { catalogSwapAvailability, publicAvailability, publicBegin, publicObserve, publicPrepare, publicRefresh, publicReport, publicReview, publicStatus } from '../app/public-testnet-action';
import { CATALOG_NETWORK_IDENTITIES } from '../domain/network-registry';
import type { PublicRun } from '../server/public-testnet-service';
import { swapProfile } from '../domain/public-testnet-swap';
import { injected, useBuild009Wallet } from './build009-wallet-store';
import { useWorkflow } from './workflow-store';

const KEY = 'gryloo:public-testnet-execution-id';
type Store = { readonly available: boolean;
  /** BUILD-BASE-001: whether this instance serves a catalog network's mainnet swaps (live or the MOCKED loopback harness). */
  readonly catalogAvailable: (chain: string) => boolean;
  readonly run: PublicRun | null; readonly recoveryOnly: boolean;
  readonly retired: boolean; readonly busy: string | null; readonly error: string | null;
  simulate(): void; review(): void; execute(): void; observe(): void; switchNetwork(): void };
const Context = createContext<Store | null>(null);
function unwrap<T>(result: { ok: true; value: T } | { ok: false; code: string }): T {
  if (!result.ok) throw new Error(result.code);
  return result.value;
}
function message(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  const messages: Record<string, string> = {
    PUBLIC_RECORDING_OFF: 'Public testnet recording is not enabled on this app instance.',
    ROBINHOOD_MAINNET_NOT_ENABLED: 'Robinhood Chain is not enabled on this app instance.',
    BASE_MAINNET_NOT_ENABLED: 'Base mainnet is not enabled on this app instance.', BASE_STORAGE_NOT_CONFIGURED: 'Base mainnet is not enabled on this app instance.',
    BASE_TOKEN_LIST_UNAVAILABLE: 'The Base token list is unavailable. Try again later.',
    ASSET_CATALOG_UNAVAILABLE: 'The network\'s official asset catalog is unavailable. Try again later.',
    TOKEN_METADATA_MISMATCH: 'A token\'s decimals on chain differ from its catalog entry. Nothing was prepared.',
    TOKEN_DEPLOYMENT_MISMATCH: 'A token\'s deployment could not be verified. Nothing was prepared.',
    ROBINHOOD_STORAGE_NOT_CONFIGURED: 'Robinhood Chain is not enabled on this app instance.',
    OWNER_EXECUTION_NOT_ENABLED: 'Real-funds execution is not enabled on this app instance. Review is available; nothing was sent.',
    STOCK_REGISTRY_UNAVAILABLE: 'The official Robinhood asset registry is unavailable. Try again later.',
    STOCK_MULTIPLIER_CHANGED_REVIEW_REQUIRED: 'A corporate action changed the shares per token. Review the updated swap before executing.',
    STOCK_MULTIPLIER_CHANGE_PENDING: 'A corporate action will change the shares per token before this Review could be used. Try again after it takes effect.',
    STOCK_MULTIPLIER_MISMATCH: 'The Robinhood registry and the chain disagree on the shares per token. Nothing was prepared.',
    CATALOG_ASSET_IDENTITY_CHANGED: 'The official asset registry no longer matches this workflow\'s asset. Build it again.',
    STOCK_TOKEN_NOT_ACQUIRABLE: 'This Stock Token is not tradable now.', INSUFFICIENT_GAS_FUNDS: 'Insufficient ETH for network fees on this network.',
    QUOTE_CHANGED_REVIEW_REQUIRED: 'The quote changed. Review the updated amounts before executing.',
    QUOTE_EXPIRED_REVIEW_REQUIRED: 'Quote expired. Review a fresh quote.',
    REVIEW_EXPIRED: 'Quote expired. Simulate again.', REVIEW_REQUIRED: 'Review the current swap first.',
    INSUFFICIENT_INPUT: 'Insufficient test token balance.', INSUFFICIENT_TEST_ETH: 'Insufficient test ETH for network fees on this network.',
    POOL_UNUSABLE: 'The selected pool is unavailable. Try again later.', POOL_FACTORY_MISMATCH: 'The selected pool could not be verified.',
    WRONG_PROVIDER_CHAIN: 'The provider is not on the reviewed network.', PUBLIC_NETWORK_UNAVAILABLE: 'This network is not enabled on this app instance.',
    ATTEMPT_ALREADY_ACTIVE: 'A transaction is already in progress. Check its result before trying again.',
    SWAP_ALREADY_ATTEMPTED: 'This swap was already submitted. Check its result before trying again.',
    RECONCILIATION_MISMATCH: 'The transaction needs manual review. The observed balances did not match the swap bounds.',
  };
  return messages[code] ?? (code.startsWith('PUBLIC_') ? 'The public testnet request could not be completed. Try again.' : code || 'Could not continue. Try again.');
}
function rejected(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error.code === 4001 || error.code === 'ACTION_REJECTED');
}
async function calldataDigest(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return '0x' + Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
}
export function PublicTestnetProvider({ children }: { children: ReactNode }) {
  const { state, restoreWorkflow } = useWorkflow();
  const wallet = useBuild009Wallet();
  const [availability, setAvailability] = useState<{ testnet: boolean; catalogs: Readonly<Record<string, boolean>> }>({ testnet: false, catalogs: {} });
  const [run, setRun] = useState<PublicRun | null>(null);
  const [source, setSource] = useState<SemanticWorkflow | null>(null);
  const [recoveryOnly, setRecoveryOnly] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const workflowRef = useRef(state.workflow);
  workflowRef.current = state.workflow;
  const initialWorkflow = useRef(state.workflow);
  const restoreRef = useRef(restoreWorkflow); restoreRef.current = restoreWorkflow;
  const retired = Boolean(run && (recoveryOnly || source !== state.workflow));
  // BUILD-RH-002: the authored (else quoted) swap's network decides which deployment gate applies (BUILD-BASE-001: each catalog network its own).
  const authoredChain = state.workflow.nodes.find(node => node.actionType === 'asset.swap.exact-input')?.chainId ?? null;
  const authoredProfile = swapProfile(authoredChain ?? run?.quote.chainId);
  const catalogAvailable = useCallback((chain: string) => availability.catalogs[chain] === true, [availability]);
  const available = authoredProfile?.kind === 'CATALOG' ? catalogAvailable(authoredProfile.chainRef) : availability.testnet;
  const guarded = useCallback((label: string, action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError(null);
    action().catch(cause => setError(message(cause))).finally(() => { busyRef.current = false; setBusy(null); });
  }, []);
  useEffect(() => {
    let cancelled = false;
    Promise.all([publicAvailability(), ...CATALOG_NETWORK_IDENTITIES.map(network => catalogSwapAvailability(network.chain))]).then(([testnet, ...catalogs]) => {
      if (!cancelled) setAvailability({ testnet, catalogs: Object.fromEntries(CATALOG_NETWORK_IDENTITIES.map((network, index) => [network.chain, catalogs[index] === true])) });
    });
    const id = localStorage.getItem(KEY);
    if (id) publicStatus(id).then(async result => {
      if (cancelled || !result.ok) return;
      let recovered = result.value;
      const last = recovered.attempts.at(-1);
      if (last?.state === 'PREPARED') {
        const hash = localStorage.getItem(KEY + ':' + last.attemptId);
        if (hash && /^0x[0-9a-f]{64}$/.test(hash)) {
          const reported = await publicReport(id, last.attemptId, { kind: 'HASH', txHash: hash });
          if (reported.ok) recovered = reported.value;
        }
      }
      if (!cancelled) {
        // Recover the canonical workflow only over the untouched initial template.
        // Recovery remains observation-only until fresh simulation and owner Review.
        if (workflowRef.current === initialWorkflow.current && initialWorkflow.current.revision === 0 &&
            initialWorkflow.current.nodes.every(node => node.actionType.startsWith('mock-'))) restoreRef.current(recovered.workflow);
        setRun(recovered); setRecoveryOnly(true);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  const simulate = useCallback(() => guarded(`Reading ${swapProfile(authoredChain)?.network ?? 'Base Sepolia'}`, async () => {
    const profile = swapProfile(authoredChain);
    if (!available) throw new Error(profile?.kind === 'CATALOG' ? profile.runPrefix === 'bas' ? 'BASE_MAINNET_NOT_ENABLED' : 'ROBINHOOD_MAINNET_NOT_ENABLED' : 'PUBLIC_RECORDING_OFF');
    if (run?.attempts.some(a => ['PREPARED', 'HASH', 'PENDING', 'UNKNOWN'].includes(a.state))) throw new Error('ATTEMPT_ALREADY_ACTIVE');
    const workflow = workflowRef.current;
    const approval = run?.attempts.at(-1);
    const resumeApproval = Boolean(run && !run.outcome && approval?.step === 'approval' &&
      approval.state === 'CONFIRMED' && (recoveryOnly || source === workflow));
    const prepared = unwrap(resumeApproval ? await publicRefresh(run!.quote.executionId) :
      await publicPrepare(workflow as unknown as SemanticWorkflow));
    localStorage.setItem(KEY, prepared.quote.executionId);
    setSource(workflow as unknown as SemanticWorkflow); setRecoveryOnly(false); setRun(prepared);
  }), [guarded, available, run, recoveryOnly, source, authoredChain]);
  const review = useCallback(() => guarded('Reviewing swap', async () => {
    if (!run || retired) throw new Error('REVIEW_REQUIRED');
    setRun(unwrap(await publicReview(run.quote.executionId, run.quote.manifestHash)));
  }), [guarded, run, retired]);
  const observe = useCallback(() => guarded('Checking transaction', async () => {
    if (!run) throw new Error('EXECUTION_NOT_FOUND');
    setRun(unwrap(await publicObserve(run.quote.executionId)));
  }), [guarded, run]);
  // Switching only asks the wallet to move to the quoted (else the authored) swap's chain; it never signs or sends.
  const switchNetwork = useCallback(() => guarded('Switching wallet network', async () => {
    const profile = swapProfile(run?.quote.chainId ?? workflowRef.current.nodes.find(n => n.actionType === 'asset.swap.exact-input')?.chainId);
    if (!profile) throw new Error('REVIEW_REQUIRED');
    await wallet.switchTo(profile.chainHex);
  }), [guarded, wallet, run]);
  const execute = useCallback(() => guarded('Preparing transaction', async () => {
    if (!run || retired) throw new Error('REVIEW_REQUIRED');
    if (run.reviewedManifestHash !== run.quote.manifestHash) throw new Error('REVIEW_REQUIRED');
    const provider = injected();
    if (!provider) throw new Error('WALLET_NOT_FOUND');
    // The quoted chain fixes the only chain the wallet may be on; it is read again just before the single send.
    const profile = swapProfile(run.quote.chainId);
    if (!profile) throw new Error('WRONG_WALLET_CHAIN');
    let session = await wallet.session();
    if (!session) session = await wallet.connect();
    if (!session) throw new Error('WALLET_CONNECTION_REJECTED');
    if (session.chainId !== profile.chainHex) throw new Error('WRONG_WALLET_CHAIN');
    const begun = await publicBegin(run.quote.executionId, session.account);
    if (!begun.ok) {
      const current = await publicStatus(run.quote.executionId);
      if (current.ok) setRun(current.value);
      throw new Error(begun.code);
    }
    const { attempt, tx } = begun.value;
    setRun(unwrap(await publicStatus(run.quote.executionId)));
    if (tx.chainId !== profile.chainHex || tx.from !== session.account || tx.value !== '0x0' ||
        tx.to !== (attempt.step === 'approval' ? run.quote.inputToken : profile.router) ||
        await calldataDigest(tx.data) !== attempt.calldataDigest) {
      unwrap(await publicReport(run.quote.executionId, attempt.attemptId, { kind: 'UNKNOWN' }));
      throw new Error('TRANSACTION_ARTIFACT_CHANGED');
    }
    const actualChain = await provider.request({ method: 'eth_chainId' });
    const accounts = await provider.request({ method: 'eth_accounts' });
    if (typeof actualChain !== 'string' || actualChain.toLowerCase() !== profile.chainHex ||
        !Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== session.account) {
      unwrap(await publicReport(run.quote.executionId, attempt.attemptId, { kind: 'UNKNOWN' }));
      throw new Error('WRONG_WALLET_CHAIN');
    }
    let hash: unknown;
    try { hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] }); }
    catch (cause) {
      setRun(unwrap(await publicReport(run.quote.executionId, attempt.attemptId, { kind: rejected(cause) ? 'REJECTED' : 'UNKNOWN' })));
      if (rejected(cause)) throw new Error('WALLET_AUTHORIZATION_REJECTED', { cause });
      throw new Error('SUBMISSION_RESULT_UNKNOWN', { cause });
    }
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      setRun(unwrap(await publicReport(run.quote.executionId, attempt.attemptId, { kind: 'UNKNOWN' })));
      throw new Error('SUBMISSION_RESULT_UNKNOWN');
    }
    const txHash = hash.toLowerCase();
    localStorage.setItem(KEY + ':' + attempt.attemptId, txHash);
    setRun(unwrap(await publicReport(run.quote.executionId, attempt.attemptId, { kind: 'HASH', txHash })));
    for (let i = 0; i < 30; i++) {
      const observed = unwrap(await publicObserve(run.quote.executionId));
      setRun(observed);
      const state = observed.attempts.at(-1)?.state;
      if (state !== 'PENDING') break;
      await new Promise<void>(resolve => setTimeout(resolve, 2_000));
    }
  }), [guarded, run, retired, wallet]);
  return <Context.Provider value={{ available, catalogAvailable, run, recoveryOnly, retired, busy, error,
    simulate, review, execute, observe, switchNetwork }}>{children}</Context.Provider>;
}
export function usePublicTestnet(): Store { const value = useContext(Context); if (!value) throw new Error('PUBLIC_TESTNET_PROVIDER_MISSING'); return value; }
