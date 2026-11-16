// SPDX-License-Identifier: AGPL-3.0-only
/**
 * RH-DEMO-001 coordinator for one owner-signed native self-transfer on a public test network with a transfer profile
 * (Robinhood Testnet; BUILD-ETHEREUM-001 adds Ethereum Sepolia). It never holds a key, never signs and never sends:
 * the owner's wallet does, after this service has durably recorded PREPARED and then SUBMITTING. An owner+nonce lease
 * is never released by uncertainty, so a reload or restart cannot create a second economic attempt. Unknown results
 * are observation-only. The reviewed chain selects the profile and its own read client; no chain falls back to another.
 *
 * BUILD-RH-002: the same coordinator serves Robinhood Chain mainnet transfers (`rht-` runs, real funds): native ETH or a catalog
 * ERC-20 (USDG, WETH, Stock Tokens), to the owner or an explicit recipient. A token's identity is re-checked against the freshly
 * validated official catalog at Simulate, and `begin` needs the deployment's real-funds owner-execution opt-in.
 *
 * BUILD-FLOFI-7702-TRANSFER-001: MetaMask Smart Accounts (EIP-7702 owners delegated to the reviewed DeleGator) transfer on the same
 * coordinator. Their wallet may send the reviewed transaction itself (direct: owner nonce and fee) or hand it to MetaMask's relayer, which
 * redeems the owner's single-use delegation through the Delegation Manager and pays the fee (token transfers only; the owner's nonce stays
 * unused). The relay rules are the owner-bound swap's own (`verifyOwnerSubmission`, `singleUseRelayedDelegation`, `relayedExecutions`,
 * create-once transaction claims), never a second implementation. Because a relay does not move the owner's nonce, the nonce cannot prove a
 * single execution for such an owner: a relayed hash is credited to one run only, every relayed execution of the reviewed call since
 * preparation is looked for before a receipt becomes evidence (and before a refused attempt is reviewed again), and a lost wallet result is
 * also searched among relayed executions. A reservation is handed to a newer Review of the same unused nonce only with the holder's own
 * reconciled relayed evidence.
 */
import { randomBytes } from 'node:crypto';
import { catalogAsset, transferEnvironment, type AssetCatalog } from '@defi-workflow-engine/action-registry';
import { isAbsolute } from 'node:path';
import { createBaseSepoliaReviewContext, validateAuthoringWorkflow } from '@defi-workflow-engine/reference-linter';
import { assertNativeTransferReview, assertTransferOwnerAccount, erc7710, readTransferState, simulateNativeTransfer, nativeTransferProfile, ROBINHOOD_TESTNET_TRANSFER,
  transferNextNonce, transferToken, type NativeTransferReview, type NativeTransferTransaction, type TransferRpc } from '@defi-workflow-engine/reference-compiler';
import { createTransferRun, discoverTransferByNonce, prepareTransferAttempt, transferTransition, validateTransferRun, createFileExecutionStorage,
  logMissing, utf8, TRANSFER_RUN_ID, type ExecutionStorage, type TransferRun } from '@defi-workflow-engine/reference-executor';
import { buildNativeTransferEvidence, reconcileNativeTransfer, type NativeTransferEvidence, type TransferObservation,
  type TransferRelayVerifier } from '@defi-workflow-engine/reference-reconciler';
import { transferL1FeeOracle } from '@defi-workflow-engine/action-registry';
import { RELAY_DUPLICATE_SCAN_REQUESTS, RELAY_FRAMEWORK_LOGGERS, relayedExecutions, singleUseRelayedDelegation, transactionClaims,
  verifyOwnerSubmission } from './public-testnet-service.ts';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';

export type TransferWalletDiagnostic = { invoked: boolean; rejectionCode?: number; code: string;
  calls: { method: string; submission?: boolean; result?: unknown; error?: unknown }[] };
export type TransferRecord = TransferRun & { observations: TransferObservation[]; evidence: NativeTransferEvidence | null; error: string | null;
  notSubmitted?: boolean; recoveryOf?: string; walletDiagnostic?: TransferWalletDiagnostic };
export type TransferBegin = { record: TransferRecord; transaction: NativeTransferTransaction };
/** Wallet error codes that prove the request was refused before any broadcast. */
const REFUSALS = [4001, 4100, 4200];
const idCheck = (id: string) => { if (!TRANSFER_RUN_ID.test(id)) throw new Error('TRANSFER_ID_INVALID'); return id; };
/** The official catalog must still map the reviewed token exactly (address, decimals, official id and multiplier). */
function assertCatalogToken(catalog: AssetCatalog, review: NativeTransferReview): void {
  if (catalog.chain !== review.chain || catalog.chainId !== review.chainId) throw new Error('TRANSFER_CATALOG_NETWORK_MISMATCH');
  const token = review.asset!;
  const asset = catalogAsset(catalog, { address: token.token });
  if (!asset || asset.chain !== catalog.chain || asset.chainId !== catalog.chainId || asset.kind !== 'ERC20' || asset.decimals !== token.decimals || (asset.stock?.officialId ?? null) !== token.officialId) throw new Error('TRANSFER_ASSET_IDENTITY_CHANGED');
  if (asset.stock && asset.stock.multiplierWad !== token.multiplierWad) throw new Error('TRANSFER_STOCK_MULTIPLIER_MISMATCH');
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** BUILD-FLOFI-7702-TRANSFER-001: the reviewed MetaMask DeleGator, the only delegate whose owners can have a reviewed call relayed. */
const DELEGATOR = erc7710.DELEGATION_FRAMEWORK_V1_3.eip7702StatelessDeleGator;
const relayCapable = (review: NativeTransferReview) => review.state.ownerDelegation === DELEGATOR;
const relayChain = (review: NativeTransferReview) => { const profile = nativeTransferProfile(review.chain);
  return { chainId: profile.chainId, l1DataFee: transferL1FeeOracle(profile) !== null }; };
/**
 * BUILD-FLOFI-7702-TRANSFER-001: the relay verifier the reconciler uses for a transaction the owner did not send itself — the owner-bound swap's
 * Delegation Framework rules, unchanged: canonical inclusion; a type-2 `redeemDelegations` by a third party of exactly the reviewed call (one
 * call, default mode, depth 1, no native value) from the owner's reviewed delegation, unchanged from preparation to inclusion; one
 * `RedeemedDelegation` naming the owner and the relayer; only the token and the reviewed framework (which moves no funds) logging; and the
 * single-use proof (LimitedCalls(1) counted for exactly that delegation).
 */
function relayVerifier(rpc: TransferRpc): TransferRelayVerifier {
  return async ({ review, transactionHash, preparedAtBlock, transaction, receipt }) => {
    const { chainId, l1DataFee } = relayChain(review);
    let verified: Awaited<ReturnType<typeof verifyOwnerSubmission>>;
    try {
      verified = await verifyOwnerSubmission(rpc, { txHash: transactionHash, account: review.account, target: review.transaction.to, data: review.transaction.data,
        preBlock: preparedAtBlock, value: review.transaction.value }, transaction, receipt, chainId, l1DataFee);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : '';
      // A mismatch (wrong call, sender, inclusion or receipt shape) is divergence; a receipt that is not final, or a provider failure, keeps the
      // attempt observable.
      throw new Error(code === 'TRANSACTION_MISMATCH' || code === 'ADDRESS_INVALID' ? 'TRANSFER_TRANSACTION_MISMATCH' : code === 'RECEIPT_INVALID' ? 'TRANSFER_RECEIPT_MISMATCH'
        : code === 'RECEIPT_NOT_CANONICAL' ? 'TRANSFER_RECEIPT_NOT_CANONICAL' : 'TRANSFER_RPC_INVALID', { cause });
    }
    if (verified.direct || !verified.delegated || verified.submission !== 'DELEGATED_EXISTING' || verified.delegationDepth !== 1 || !relayCapable(review))
      throw new Error('TRANSFER_SUBMISSION_UNSUPPORTED');
    const logs = Array.isArray(receipt.logs) ? receipt.logs as unknown[] : [];
    const loggers = new Set([...RELAY_FRAMEWORK_LOGGERS, ...review.asset ? [review.asset.token] : []]);
    if (verified.status === 1 && logs.some(log => !log || typeof log !== 'object' || !loggers.has(String((log as { address?: unknown }).address).toLowerCase())))
      throw new Error('TRANSFER_LOGS_MISMATCH');
    return { relayer: verified.txFrom, status: verified.status, singleUse: verified.status === 1 && singleUseRelayedDelegation(logs, review.account, verified.txFrom),
      frameworkLoggers: [...RELAY_FRAMEWORK_LOGGERS] };
  };
}
/**
 * BUILD-FLOFI-7702-TRANSFER-001: whether the run holding the reservation of an owner nonce provably never used it, so a newer Review of the same
 * owner, chain and nonce may take the reservation over. Only when the holder reconciled its reviewed transfer from a verified relayed redemption
 * (sent and paid by a relayer, the owner's nonce untouched), with evidence. A pending, unknown, divergent or direct holder keeps it.
 */
export function relayedTransferNonceRelease(holder: TransferRecord, next: Pick<NativeTransferReview, 'account' | 'chain' | 'nonce'>): { id: string; txHash: string } | null {
  const attempt = holder.attempt, observation = holder.observations.at(-1);
  if (holder.verdict !== 'RECONCILED' || !holder.evidence || !attempt?.reconciled || attempt.state !== 'CONFIRMED' || !attempt.transactionHash ||
      holder.review.account !== next.account || holder.review.chain !== next.chain || attempt.nonce !== next.nonce || !relayCapable(holder.review) ||
      observation?.verdict !== 'RECONCILED' || observation.facts?.submission !== 'RELAYED' || !observation.facts.gasPayer ||
      observation.facts.gasPayer === holder.review.account || String(observation.receipt?.transactionHash).toLowerCase() !== attempt.transactionHash) return null;
  return { id: holder.id, txHash: attempt.transactionHash };
}
type NonceIntent = { id: string; transaction: NativeTransferTransaction; supersedes?: string; release?: { id: string; txHash: string } };
/** The intent log: a reservation, then recovery re-reservations or evidence-carrying hand-overs (each superseding the line before it). */
function intentLines(bytes: Uint8Array): NonceIntent[] {
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split('\n').map(line => JSON.parse(line) as NonceIntent);
  const ids = lines.map(line => line.id);
  if (ids.some(id => !TRANSFER_RUN_ID.test(id)) || new Set(ids).size !== ids.length || lines.some((line, index) => line.supersedes !== undefined &&
      (index === 0 || line.supersedes !== lines[index - 1]!.id || !line.release || line.release.id !== line.supersedes || !/^0x[0-9a-f]{64}$/.test(line.release.txHash))))
    throw new Error('TRANSFER_STORE_CORRUPT');
  return lines;
}
const prefix = (before: readonly unknown[], after: readonly unknown[]) => after.length >= before.length && same(after.slice(0, before.length), before);

/**
 * `rpc` is the Robinhood Testnet read client; `rpcs` adds one chain-bound read client per further transfer profile (CAIP-2
 * keyed). A network without a client is not enabled in this deployment, and its runs fail closed.
 */
export function createRobinhoodTransferService(input: { rpc?: TransferRpc; rpcs?: Readonly<Partial<Record<string, TransferRpc>>>; journalDir?: string;
  storage?: ExecutionStorage; provenance: 'PUBLIC_TESTNET' | 'PUBLIC_MAINNET' | 'MOCKED'; now?: () => number;
  /** BUILD-RH-002: `rht` for the Robinhood Chain mainnet deployment, BUILD-BASE-001 `bat` for Base mainnet (default `rhx`, the public-testnet runs). */ idPrefix?: 'rhx' | 'rht' | 'bat' | 'art' | 'ett';
  /** The official catalog of a catalog network; token transfers there fail closed without it. */ catalogFor?: (chain: string) => Promise<AssetCatalog>;
  /** Real-funds owner execution (mainnet only); Simulate and Review stay available without it. */ executionEnabled?: boolean }) {
  const idPrefix = input.idPrefix ?? 'rhx';
  // Local mode keeps the original journal directory; cloud mode supplies shared durable storage instead.
  if (!input.storage && (!input.journalDir || !isAbsolute(input.journalDir) || input.journalDir.includes('/.git/'))) throw new Error('TRANSFER_STORAGE_INVALID');
  const storage = input.storage ?? createFileExecutionStorage(input.journalDir!, 'TRANSFER_BUSY');
  // BUILD-FLOFI-7702-TRANSFER-001: create-once claims credit one relayed transaction to one run (a relay carries no owner nonce).
  const { log, leases } = storage, claims = transactionClaims(storage);
  const now = input.now ?? Date.now, at = () => new Date(now());
  const rpcFor = (chain: string): TransferRpc => {
    const rpc = input.rpcs?.[chain] ?? (chain === ROBINHOOD_TESTNET_TRANSFER.chain ? input.rpc : undefined);
    if (!rpc) throw new Error('TRANSFER_NETWORK_UNAVAILABLE');
    return rpc;
  };
  const stateOf = (review: NativeTransferReview, account: string) => readTransferState(rpcFor(review.chain), nativeTransferProfile(review.chain), account, now(),
    review.asset ? { address: review.asset.token, officialId: review.asset.officialId } : undefined, review.recipient);
  // Nitro posting gas can change independently of the child gas price. Re-estimate the exact reviewed call before handoff.
  const assertFreshGas = async (review: NativeTransferReview, block: number) => {
    const profile = nativeTransferProfile(review.chain);
    if (!('reestimateBeforeSubmission' in profile) || !profile.reestimateBeforeSubmission) return;
    const { from, to, value, data } = review.transaction;
    const gas = await rpcFor(review.chain)('eth_estimateGas', [{ from, to, value, data }, '0x' + block.toString(16)]);
    if (typeof gas !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(gas)) throw new Error('TRANSFER_GAS_INVALID');
    if (BigInt(gas) > BigInt(review.gasLimit)) throw new Error('TRANSFER_GAS_CHANGED_REVIEW_REQUIRED');
  };
  const path = (id: string) => { idCheck(id); if (!id.startsWith(idPrefix + '-')) throw new Error('TRANSFER_ID_INVALID'); return id + '.jsonl'; };
  /** Append-only history: every line is a valid run and never rewrites what an earlier line established. */
  const validate = (bytes: Uint8Array) => {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n') || bytes.length > 16_777_216) throw new Error('TRANSFER_STORE_CORRUPT');
    let prior: TransferRecord | null = null;
    for (const line of text.trimEnd().split('\n')) {
      const record = JSON.parse(line) as TransferRecord; validateTransferRun(record);
      if (record.provenance !== input.provenance || record.recoveryOf !== undefined && idCheck(record.recoveryOf) === record.id) throw new Error('TRANSFER_STORE_CORRUPT');
      if (record.evidence && record.verdict !== 'RECONCILED') throw new Error('TRANSFER_STORE_CORRUPT');
      if (prior) {
        const a = prior.attempt, b = record.attempt;
        if (record.id !== prior.id || record.review.commitment !== prior.review.commitment || record.recoveryOf !== prior.recoveryOf ||
            !prefix(prior.journal.entries, record.journal.entries) || !prefix(prior.observations, record.observations) ||
            prior.ownerInitiated && !record.ownerInitiated || prior.verdict !== 'PENDING' && record.verdict !== prior.verdict ||
            prior.notSubmitted && !record.notSubmitted || prior.evidence && !same(prior.evidence, record.evidence) ||
            a && (!b || a.nonce !== b.nonce || a.preparedAtBlock !== b.preparedAtBlock || !same(a.transaction, b.transaction) ||
              a.transactionHash && a.transactionHash !== b.transactionHash || a.reconciled && !b.reconciled)) throw new Error('TRANSFER_STORE_CORRUPT');
      }
      prior = record;
    }
  };
  const load = async (id: string): Promise<TransferRecord> => {
    const bytes = await log.read(path(id)); if (!bytes) throw logMissing(path(id)); validate(bytes);
    return JSON.parse(utf8(bytes).trimEnd().split('\n').at(-1)!) as TransferRecord;
  };
  const save = async (record: TransferRecord) => {
    const prior = utf8(await log.read(path(record.id)));
    await log.extend(path(record.id), new TextEncoder().encode(prior + JSON.stringify(record) + '\n'), validate);
    return record;
  };
  /** Cross-process exclusive section: the original PID lock directory locally, a fenced lease in shared storage. */
  const locked = <T,>(key: string, action: () => Promise<T>): Promise<T> => leases.hold(key, action);
  /**
   * BUILD-FLOFI-7702-TRANSFER-001: every relayed execution of a run's reviewed call by its owner since `from` (bounded; `complete` says whether the
   * scan reached the head). A transaction another run claimed is that run's, never this one's.
   */
  const relayScan = (record: TransferRecord, from: number, requests?: number) => relayedExecutions(rpcFor(record.review.chain), relayChain(record.review),
    { account: record.review.account, tx: record.review.transaction }, from, async hash => {
      const holder = await claims.holder(relayChain(record.review).chainId, hash);
      return holder !== null && holder.id !== record.id;
    }, requests);
  /**
   * BUILD-FLOFI-7702-TRANSFER-001: the first block from which this run's reviewed call could have executed: its own attempt and every earlier
   * attempt of the refused runs it recovers (the same workflow, owner and call), so no relay landing between them escapes a scan.
   */
  const sameCallFrom = async (record: TransferRecord, own = record.attempt?.preparedAtBlock ?? Number.MAX_SAFE_INTEGER): Promise<number> => {
    let from = own, current = record;
    for (let depth = 0; current.recoveryOf && depth < 64; depth++) {
      current = await load(current.recoveryOf);
      if (current.attempt) from = Math.min(from, current.attempt.preparedAtBlock);
    }
    return from;
  };
  /** BUILD-FLOFI-7702-TRANSFER-001: an EIP-7702 authorization also moves the account nonce without a transaction of its own: a different use of it. */
  const nonceUse = async (attempt: NonNullable<TransferRecord['attempt']>, review: NativeTransferReview) => {
    try { return await discoverTransferByNonce(attempt, rpcFor(review.chain)); }
    catch (cause) {
      if (relayCapable(review) && cause instanceof Error && cause.message === 'TRANSFER_DISCOVERY_INCONSISTENT') return { hash: null, mismatch: true, consumed: true };
      throw cause;
    }
  };
  /** Records an observation-only error once (polling never appends the same line again). */
  const note = (record: TransferRecord, error: string) => record.error === error ? record : save({ ...record, error });
  /** A terminal divergence of the run's attempt, recorded with the observation that established it (when there is one). */
  const diverge = (record: TransferRecord, reason: string, observation?: TransferObservation) => {
    const terminal = transferTransition(record, 'RECONCILIATION_REQUIRED', at());
    return save({ ...record, ...terminal, verdict: 'DIVERGENT', error: reason,
      observations: observation ? [...record.observations, { ...observation, verdict: 'DIVERGENT', reason }] : record.observations });
  };
  /** Permanent economic identity of (owner, nonce). Only a proven pre-broadcast refusal lets a fresh Review reuse it. */
  async function reserveNonce(record: TransferRecord): Promise<void> {
    // Owner nonces are per chain. Robinhood Testnet keeps its original lease names; any other chain is qualified by its CAIP-2 id.
    const owner = `${record.review.account}-${record.review.nonce}`;
    const key = record.review.chain === ROBINHOOD_TESTNET_TRANSFER.chain ? owner : `${record.review.chain.replace(':', '-')}-${owner}`, lease = key + '.intent';
    await locked(key, async () => {
      const entry = JSON.stringify({ id: record.id, transaction: record.review.transaction }) + '\n';
      const existing = await log.read(lease), prior = existing === null ? null : utf8(existing);
      if (prior === null) {
        if (!await log.create(lease, new TextEncoder().encode(entry))) throw new Error('TRANSFER_NONCE_ALREADY_RESERVED');
      } else {
        const last = intentLines(existing!).at(-1)!;
        let line = entry;
        if (!record.recoveryOf || last.id !== record.recoveryOf || !(await load(record.recoveryOf)).notSubmitted) {
          // BUILD-FLOFI-7702-TRANSFER-001: a holder whose reviewed transfer was relayed never used this nonce; its evidence hands the reservation over.
          const holder = await load(last.id).catch(() => null), release = holder ? relayedTransferNonceRelease(holder, record.review) : null;
          if (!release || record.recoveryOf) throw new Error('TRANSFER_NONCE_ALREADY_RESERVED');
          line = JSON.stringify({ id: record.id, transaction: record.review.transaction, supersedes: last.id, release }) + '\n';
        }
        await log.extend(lease, new TextEncoder().encode(prior + line), bytes => { intentLines(bytes); });
      }
    });
  }
  const fresh = async (workflowInput: unknown, account: string, recoveryOf?: { id: string; nonce: string }): Promise<TransferRecord> => {
    const workflow = validateAuthoringWorkflow(workflowInput, createBaseSepoliaReviewContext());
    const chain = workflow.nodes.find(node => node.actionType === 'asset.transfer')?.chainId;
    if (!chain) throw new Error('TRANSFER_ISOLATED_ONLY');
    const review = await simulateNativeTransfer(workflow, account, rpcFor(chain), now());
    if (transferToken(workflow)) {
      if (!input.catalogFor) throw new Error('TRANSFER_NETWORK_UNAVAILABLE');
      assertCatalogToken(await input.catalogFor(chain), review);
    }
    // A fresh Review may only re-authorize the SAME unconsumed nonce; anything else means the chain moved on.
    if (recoveryOf && review.nonce !== recoveryOf.nonce) throw new Error('TRANSFER_RECOVERY_STATE_CHANGED_OBSERVE_EXISTING');
    const record: TransferRecord = { ...createTransferRun(idPrefix + '-' + randomBytes(16).toString('hex'), review, input.provenance, at()),
      observations: [], evidence: null, error: null, ...recoveryOf ? { recoveryOf: recoveryOf.id } : {} };
    return save(record);
  };
  return {
    load,
    /** Read-only: chain state and the exact transaction are simulated; nothing is signed or sent. */
    simulate: (workflowInput: unknown, account: string) => fresh(workflowInput, account),
    async review(id: string, commitment: string, workflow: SemanticWorkflow): Promise<TransferRecord> { return locked(idCheck(id), async () => {
      const record = await load(id);
      if (record.attempt || record.verdict !== 'PENDING' || record.review.commitment !== commitment) throw new Error('TRANSFER_AUTHORIZATION_REPLACED');
      if (now() >= Date.parse(record.review.expiresAt)) throw new Error('TRANSFER_REVIEW_EXPIRED');
      assertNativeTransferReview(record.review, workflow, record.review.account, await stateOf(record.review, record.review.account), now());
      return save({ ...record, authorization: commitment, error: null });
    }); },
    async invalidate(id: string): Promise<TransferRecord> { return locked(idCheck(id), async () => {
      const record = await load(id);
      return record.authorization ? save({ ...record, authorization: null, error: 'TRANSFER_SEMANTIC_EDIT_REQUIRES_REVIEW' }) : record;
    }); },
    /** Re-verifies the Review against fresh state, reserves the nonce, then persists PREPARED before any wallet request. */
    async begin(id: string, account: string, workflow: SemanticWorkflow): Promise<TransferBegin> { return locked(idCheck(id), async () => {
      const record = await load(id);
      if (record.authorization !== record.review.commitment) throw new Error('TRANSFER_REVIEW_REQUIRED');
      if (record.attempt) throw new Error('TRANSFER_EXISTING_ATTEMPT_OBSERVE_ONLY');
      if (now() >= Date.parse(record.review.expiresAt)) throw new Error('TRANSFER_REVIEW_EXPIRED');
      // Real funds: nothing is reserved or prepared unless this deployment explicitly allows owner execution.
      if (input.executionEnabled === false || transferEnvironment(nativeTransferProfile(record.review.chain)) === 'MAINNET' && input.executionEnabled !== true) throw new Error('OWNER_EXECUTION_NOT_ENABLED');
      const state = await stateOf(record.review, account);
      assertNativeTransferReview(record.review, workflow, account, state, now());
      await assertFreshGas(record.review, state.block);
      if (record.review.asset) {
        if (!input.catalogFor) throw new Error('TRANSFER_NETWORK_UNAVAILABLE');
        assertCatalogToken(await input.catalogFor(record.review.chain), record.review);
        const rpc = rpcFor(record.review.chain), token = record.review.asset, block = '0x' + state.block.toString(16);
        if (await rpc('eth_getCode', [token.token, block]) === '0x') throw new Error('TRANSFER_TOKEN_CODE_MISSING');
        if (BigInt(String(await rpc('eth_call', [{ to: token.token, data: '0x313ce567' }, block]))) !== BigInt(token.decimals))
          throw new Error('TRANSFER_TOKEN_METADATA_MISMATCH');
      }
      // BUILD-FLOFI-7702-TRANSFER-001: a recovery Review of a Smart Account's refused transfer checks again, just before it reserves, that no
      // earlier attempt of the same call was relayed in the meantime (a relay leaves the owner nonce unchanged, so `begin` cannot see it).
      if (relayCapable(record.review) && record.recoveryOf) {
        const scan = await relayScan(record, await sameCallFrom(record), RELAY_DUPLICATE_SCAN_REQUESTS);
        if (scan.verified.length || scan.unclassified.length) throw new Error('TRANSFER_REJECTED_ATTEMPT_EXECUTED');
        if (scan.waiting || !scan.complete) throw new Error('TRANSFER_RELAYED_EXECUTION_PENDING');
      }
      await reserveNonce(record);
      const prepared = await save({ ...record, ...prepareTransferAttempt(record, state.block, transferNextNonce(state), at()), error: null });
      return { record: prepared, transaction: prepared.attempt!.transaction };
    }); },
    /** The handoff boundary: SUBMITTING is durable before the browser calls the wallet. */
    async handoff(id: string): Promise<TransferRecord> { return locked(idCheck(id), async () => {
      const record = await load(id);
      if (record.attempt?.state !== 'PREPARED' || record.authorization !== record.review.commitment || now() >= Date.parse(record.review.expiresAt))
        throw new Error('TRANSFER_WALLET_HANDOFF_NOT_AUTHORIZED');
      const state = await stateOf(record.review, record.review.account);
      // The reserved nonce must still be the one the wallet assigns next (the owner's other pending transactions come before it).
      if (transferNextNonce(state) !== record.attempt.nonce) throw new Error('TRANSFER_NONCE_CHANGED');
      if (record.review.state.recipientCodeHash !== undefined) assertNativeTransferReview(record.review, record.review.workflow, record.review.account, state, now());
      // BUILD-FLOFI-7702-TRANSFER-001: the owner account is still the reviewed one (no new delegation, the same reviewed delegate) at the wallet request.
      assertTransferOwnerAccount(record.review, state);
      await assertFreshGas(record.review, state.block);
      return save({ ...record, ...transferTransition(record, 'SUBMITTING', at()) });
    }); },
    async report(id: string, result: { kind: 'HASH'; hash: string } | { kind: 'UNKNOWN' | 'REJECTED'; code?: string }): Promise<TransferRecord> { return locked(idCheck(id), async () => {
      const record = await load(id), attempt = record.attempt;
      if (!attempt) throw new Error('TRANSFER_ATTEMPT_MISSING');
      if (result.kind === 'HASH') {
        if (!/^0x[0-9a-f]{64}$/.test(result.hash)) throw new Error('TRANSFER_HASH_INVALID');
        if (attempt.transactionHash && attempt.transactionHash !== result.hash) throw new Error('TRANSFER_HASH_DIVERGENT');
        if (attempt.transactionHash || !['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN'].includes(attempt.state)) return record;
        const hashed = { ...record, attempt: { ...attempt, transactionHash: result.hash } };
        return save({ ...hashed, ...transferTransition(hashed, 'PENDING', at()), error: null });
      }
      if (attempt.state !== 'SUBMITTING') return record;
      return save({ ...record, ...transferTransition(record, 'SUBMISSION_RESULT_UNKNOWN', at()),
        error: result.kind === 'REJECTED' ? 'TRANSFER_REJECTED' : 'TRANSFER_SUBMISSION_UNKNOWN' });
    }); },
    /** Records a proven pre-broadcast refusal. Anything that may have reached the network stays observation-only. */
    async walletFailure(id: string, diagnostic: TransferWalletDiagnostic): Promise<TransferRecord> { return locked(idCheck(id), async () => {
      const record = await load(id), attempt = record.attempt;
      if (JSON.stringify(diagnostic).length > 65_536 || typeof diagnostic.invoked !== 'boolean' || !Array.isArray(diagnostic.calls) ||
          !/^TRANSFER_[A-Z0-9_]{2,70}$/.test(diagnostic.code)) throw new Error('TRANSFER_DIAGNOSTIC_INVALID');
      const send = diagnostic.calls.find(c => c.submission === true), error = send?.error as { code?: unknown } | undefined;
      const refused = diagnostic.invoked && send !== undefined && send.result === undefined && typeof error?.code === 'number' &&
        error.code === diagnostic.rejectionCode && REFUSALS.includes(error.code);
      if ((diagnostic.invoked || send) && !refused || attempt?.transactionHash || attempt?.reconciled) throw new Error('TRANSFER_DIAGNOSTIC_NOT_PRE_SUBMISSION');
      let next: TransferRecord = record;
      if (attempt) {
        if (attempt.state === 'PREPARED') next = { ...next, ...transferTransition(next, 'CANCELLED', at()) };
        else if (['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN'].includes(attempt.state)) {
          next = { ...next, ...transferTransition(next, 'SUBMISSION_RESULT_UNKNOWN', at()) };
          next = { ...next, ...transferTransition(next, 'NOT_FOUND', at()) };
        } else if (!['CANCELLED', 'NOT_FOUND'].includes(attempt.state)) throw new Error('TRANSFER_DIAGNOSTIC_NOT_PRE_SUBMISSION');
      }
      return save({ ...next, authorization: null, error: diagnostic.code, walletDiagnostic: diagnostic, notSubmitted: Boolean(attempt) || record.notSubmitted === true });
    }); },
    /** Read-only observation and reconciliation. There is no send path here. */
    async observe(id: string): Promise<TransferRecord> { return locked(idCheck(id), async () => {
      let record = await load(id);
      const attempt = record.attempt;
      if (!attempt || record.verdict !== 'PENDING' || record.notSubmitted) return record;
      if (attempt.state === 'PREPARED') {
        // The browser stopped before the durable handoff: no wallet request can have been made for this attempt.
        return save({ ...record, ...transferTransition(record, 'CANCELLED', at()), authorization: null, notSubmitted: true, error: 'TRANSFER_WALLET_NOT_SUBMITTED',
          walletDiagnostic: { invoked: false, calls: [], code: 'TRANSFER_WALLET_NOT_SUBMITTED' } });
      }
      if (!attempt.transactionHash) {
        const found = await nonceUse(attempt, record.review);
        // BUILD-FLOFI-7702-TRANSFER-001: a Smart Account's wallet may have had the call relayed (its nonce unused, or later used by another of its
        // transactions): a verified relayed execution is this attempt's submission. A relayed and a direct execution, or two relayed ones, are a
        // duplicate; a relayed execution in a shape FloFi does not reconcile (e.g. batched with a fee) is recorded, never adopted or ignored.
        const scan = relayCapable(record.review) ? await relayScan(record, await sameCallFrom(record)) : null;
        if (scan?.waiting) return note(record, 'TRANSFER_RELAYED_EXECUTION_PENDING');
        if (scan?.unclassified.length) return diverge(record, 'TRANSFER_RELAYED_EXECUTION_UNSUPPORTED_SHAPE');
        if (scan && (scan.verified.length > 1 || scan.verified.length === 1 && found.consumed && found.hash && !found.mismatch))
          return diverge(record, 'TRANSFER_RELAYED_DUPLICATE_EXECUTION');
        const relayedHash = scan?.verified[0] ?? null;
        if (!relayedHash && scan && found.consumed && found.mismatch) {
          // The owner's nonce went to something else, but a relay needs no nonce: the reviewed transfer may still land. Kept observable until the
          // scan covered its whole window, then recorded without claiming it can never execute.
          return scan.complete ? diverge(record, 'TRANSFER_NONCE_USED_RELAY_NOT_FOUND') : note(record, 'TRANSFER_RELAYED_EXECUTION_PENDING');
        }
        if (!relayedHash && (!found.consumed || !found.hash)) return note(record, 'TRANSFER_TRANSACTION_NOT_OBSERVED');
        record = { ...record, attempt: { ...attempt, transactionHash: relayedHash ?? found.hash } };
        record = { ...record, ...transferTransition(record, 'PENDING', at()), error: null };
        if (!relayedHash && found.mismatch) {
          // The reviewed nonce was consumed by a different transaction; the reviewed transfer can never execute.
          return save({ ...record, ...transferTransition(record, 'RECONCILIATION_REQUIRED', at()), verdict: 'DIVERGENT', error: 'TRANSFER_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION' });
        }
        record = await save(record);
      }
      const current = record.attempt!, rpc = rpcFor(record.review.chain);
      const observation = await reconcileNativeTransfer(record.review, current, rpc, relayCapable(record.review) ? { relayed: relayVerifier(rpc) } : {});
      if (observation.verdict === 'INCONCLUSIVE') return save({ ...record, error: observation.reason });
      const observations = [...record.observations, observation];
      if (observation.verdict === 'DIVERGENT') {
        const terminal = transferTransition(record, observation.reason === 'TRANSFER_REVERTED' ? 'REVERTED' : 'RECONCILIATION_REQUIRED', at());
        return save({ ...record, ...terminal, observations, verdict: 'DIVERGENT', error: observation.reason });
      }
      if (relayCapable(record.review)) {
        // BUILD-FLOFI-7702-TRANSFER-001: one relayed transaction is credited to one run (it carries no owner nonce).
        if (observation.facts?.submission === 'RELAYED' &&
            !await claims.claim(relayChain(record.review).chainId, current.transactionHash!, { id: record.id, attemptId: `${record.id}.TRANSFER` }))
          return diverge(record, 'TRANSFER_RELAYED_TRANSACTION_ALREADY_CLAIMED', observation);
        // No second execution of the same reviewed transfer: for an owner that can relay, its nonce cannot prove it. Every verified relayed
        // execution since preparation, and (for a relayed receipt) a direct one at the reviewed nonce, are looked for before this receipt
        // becomes evidence; a scan that is not final or cannot cover the whole window keeps the attempt pending.
        const scan = await relayScan(record, await sameCallFrom(record), RELAY_DUPLICATE_SCAN_REQUESTS);
        if (scan.waiting || !scan.complete) return note(record, 'TRANSFER_RELAYED_EXECUTION_PENDING');
        const direct = observation.facts?.submission === 'RELAYED' ? await nonceUse({ ...current, transactionHash: null }, record.review) : null;
        if (scan.verified.some(hash => hash !== current.transactionHash) || scan.unclassified.some(hash => hash !== current.transactionHash) ||
            direct?.consumed && direct.hash && !direct.mismatch) return diverge(record, 'TRANSFER_RELAYED_DUPLICATE_EXECUTION', observation);
      }
      const confirmed = transferTransition(record, 'CONFIRMED', at());
      const reconciled: TransferRecord = { ...record, ...confirmed, attempt: { ...confirmed.attempt!, reconciled: true }, observations, verdict: 'RECONCILED', error: null };
      return save({ ...reconciled, evidence: buildNativeTransferEvidence({ id: record.id, review: record.review, journal: reconciled.journal,
        provenance: record.provenance, ownerInitiated: record.ownerInitiated, observation, observedAt: at().toISOString() }) });
    }); },
    /** A fresh explicit Review for the SAME intent and nonce, only after a proven pre-broadcast refusal. */
    async recoverReview(id: string): Promise<TransferRecord> { return locked(idCheck(id), async () => {
      const record = await load(id), attempt = record.attempt;
      if (!record.notSubmitted || record.verdict !== 'PENDING' || !attempt || attempt.transactionHash) throw new Error('TRANSFER_RECOVERY_OBSERVE_ONLY');
      // BUILD-FLOFI-7702-TRANSFER-001: a wallet refusal is trusted for a new Review only after checking that the refused call was not relayed (a
      // relay leaves the owner nonce unchanged, so the same-nonce rule cannot see it): never a second authorization of an executed transfer.
      if (relayCapable(record.review)) {
        const scan = await relayScan(record, await sameCallFrom(record), RELAY_DUPLICATE_SCAN_REQUESTS);
        if (scan.verified.length || scan.unclassified.length) {
          await save({ ...record, verdict: 'DIVERGENT', authorization: null, error: 'TRANSFER_REJECTED_ATTEMPT_EXECUTED' });
          throw new Error('TRANSFER_REJECTED_ATTEMPT_EXECUTED');
        }
        if (scan.waiting || !scan.complete) throw new Error('TRANSFER_RELAYED_EXECUTION_PENDING');
      }
      return fresh(record.review.workflow, record.review.account, { id, nonce: attempt.nonce });
    }); },
  };
}
export type RobinhoodTransferService = ReturnType<typeof createRobinhoodTransferService>;
