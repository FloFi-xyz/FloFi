// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (completion, §3.1/§3.6): collection of the FloFi platform fee.
 *
 * Rail: after an execution completed and its ledger row is DUE, the owner explicitly authorizes ONE plain transfer per fee asset from their own
 * wallet to the owner-configured FloFi treasury, on the asset's own network, through FloFi's existing reviewed transfer flows (EVM native/ERC-20
 * on Ethereum, Base, Arbitrum One and Robinhood Chain; SOL/USDC/USDT on Solana). Nothing is custodial, no allowance is granted, no contract is
 * deployed, FloFi never signs, and nothing is charged before the execution completed (the ledger only holds DUE for completed executions).
 *
 * The server composes each transfer (recipient = the configured treasury, amount = the settled fee), simulates and binds its Review; the client
 * can only sign that exact Review (the transfer flow refuses any other workflow at begin). The amount is `settledFee(authorized, final)` per asset:
 * never more than the fee the owner's Review disclosed and recorded (0038), never more than the final basis, never an asset not authorized.
 *
 * Ledger lifecycle (0037 trigger, compare-and-set on `version`):
 *   DUE | COLLECTION_FAILED → COLLECTION_PENDING   one attempt: the planned transfers and their run ids (`collection`)
 *   COLLECTION_PENDING → COLLECTED                every fee asset is proven by a RECONCILED transfer to the recorded treasury
 *   COLLECTION_PENDING → COLLECTION_FAILED        every transfer of the attempt is final and at least one asset is not collected
 * A transfer that may have reached a network (submitting, unknown outcome, pending) keeps the attempt pending: a new attempt never starts while
 * any earlier transfer could still settle, so a retry, a duplicate request, a restarted worker or a closed browser can never pay twice. An
 * unsubmitted attempt expires only after its transfers were invalidated by their own flow. A divergent transfer stops automatic retries (attention).
 * Collected amounts come only from reconciled transfer evidence; the accrued estimate is never reported as collected.
 */
import type { Database, Queryable } from '@defi-workflow-engine/cloud-runtime';
import { SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import { composeStrategy, semanticWorkflowHash } from '../engine/strategy-engine';
import { resolveNetworkAsset } from '../domain/asset-catalogs';
import { sameAsset } from '../engine/workflow-bindings';
import { collectionBlocker, type Env } from './activation';
import { feeAuthorizationsActive, loadFeeAuthorization, type FeeAuthorizationTarget } from './authorization';
import { settledFee, type FeeLine } from './principal';

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
/** The transfer flow and strategy network of each collectable chain. Test networks are never collected. */
export const SETTLEMENT_NETWORKS: Readonly<Record<string, { readonly flow: string; readonly network: string; readonly namespace: 'eip155' | 'solana' }>> = Object.freeze({
  'eip155:1': { flow: 'ethereum-mainnet-transfer', network: 'ethereum', namespace: 'eip155' },
  'eip155:8453': { flow: 'base-mainnet-transfer', network: 'base', namespace: 'eip155' },
  'eip155:42161': { flow: 'arbitrum-mainnet-transfer', network: 'arbitrum-one', namespace: 'eip155' },
  'eip155:4663': { flow: 'robinhood-mainnet-transfer', network: 'robinhood', namespace: 'eip155' },
  [SOLANA_MAINNET]: { flow: 'solana-transfer', network: 'solana', namespace: 'solana' },
});
/** A settlement transfer's workflow id: never a user workflow, so analytics and the ledger can tell it apart from executions. */
export const SETTLEMENT_WORKFLOW_PREFIX = 'flofi-fee-settlement.';
/** An unsubmitted attempt the owner never signed is invalidated after this long and may be retried. */
export const SETTLEMENT_UNSIGNED_TTL_MS = 30 * 60_000;
export const SETTLEMENT_MAX_ATTEMPTS = 5;

export type PlannedTransfer = { readonly chainId: string; readonly address: string; readonly decimals: number; readonly amount: string; readonly flow: string;
  readonly network: string; readonly namespace: 'eip155' | 'solana'; readonly recipient: string; readonly asset: string; readonly decimal: string };
export type AttemptTransfer = Pick<PlannedTransfer, 'chainId' | 'address' | 'decimals' | 'amount' | 'flow' | 'recipient'> & { readonly runId: string; readonly workflowHash: string };
export type CollectedTransaction = { readonly chainId: string; readonly address: string; readonly decimals: number; readonly amount: string; readonly hash: string; readonly runId: string };
/** The ledger row's `collection` (≤ 4 KiB): the current attempt, every collected transaction so far, and the last closed failure code. */
export type Collection = { readonly v: 1; readonly attempt: number; readonly startedAt: string; readonly transfers: readonly AttemptTransfer[];
  readonly transactions: readonly CollectedTransaction[]; readonly code: string | null; readonly attention?: true };

const units = (value: bigint, decimals: number) => {
  const raw = value.toString().padStart(decimals + 1, '0'), whole = raw.slice(0, raw.length - decimals), fraction = raw.slice(raw.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
};
const collectedOf = (collection: Collection | null, line: Pick<FeeLine, 'chainId' | 'address' | 'decimals'>) =>
  (collection?.transactions ?? []).filter(t => sameAsset(t, line)).reduce((sum, t) => sum + BigInt(t.amount), 0n);

/** The strategy asset of a fee line on its network (native, a catalog token of the exact identity, or a Solana mainnet token), or null. */
export function settlementAsset(line: Pick<FeeLine, 'chainId' | 'address' | 'decimals'>): string | null {
  if (line.chainId === SOLANA_MAINNET) return Object.values(SOLANA_MAINNET_TOKENS).find(t => t.mint === line.address && t.decimals === line.decimals)?.symbol ?? null;
  if (!SETTLEMENT_NETWORKS[line.chainId]) return null;
  if (line.address === NATIVE) return line.decimals === 18 ? 'ETH' : null;
  const asset = resolveNetworkAsset(line.chainId, { address: line.address });
  return asset && asset.decimals === line.decimals && asset.assetClass !== 'STOCK_TOKEN' ? asset.symbol : null;
}

/**
 * What remains to collect (pure): per authorized asset, `settledFee(authorized, final)` minus what reconciled transfers already collected. Each line
 * names its transfer flow and the treasury of its namespace. Refuses (code) instead of planning anything it cannot collect exactly.
 */
export function planSettlement(input: { readonly authorized: { readonly status: string; readonly lines: readonly FeeLine[] }; readonly final: readonly FeeLine[];
  readonly collection: Collection | null; readonly treasury: { readonly evm: string; readonly solana: string } }):
  { readonly ok: true; readonly transfers: readonly PlannedTransfer[] } | { readonly ok: false; readonly code: string } {
  if (input.authorized.status !== 'FEEABLE') return { ok: false, code: 'PLATFORM_FEE_NOT_AUTHORIZED' };
  const settled = settledFee({ status: 'FEEABLE', lines: input.authorized.lines }, { status: 'FEEABLE', lines: input.final });
  const transfers: PlannedTransfer[] = [];
  for (const line of settled) {
    const remaining = BigInt(line.fee) - collectedOf(input.collection, line);
    if (remaining <= 0n) continue;
    const network = SETTLEMENT_NETWORKS[line.chainId], asset = settlementAsset(line);
    if (!network) return { ok: false, code: 'PLATFORM_FEE_SETTLEMENT_NETWORK_UNSUPPORTED' };
    if (!asset) return { ok: false, code: 'PLATFORM_FEE_SETTLEMENT_ASSET_UNSUPPORTED' };
    transfers.push({ chainId: line.chainId, address: line.address, decimals: line.decimals, amount: remaining.toString(), flow: network.flow, network: network.network,
      namespace: network.namespace, recipient: network.namespace === 'solana' ? input.treasury.solana : input.treasury.evm.toLowerCase(), asset,
      decimal: units(remaining, line.decimals) });
  }
  return { ok: true, transfers };
}

/** The server-composed transfer of one planned line: the treasury as recipient, the exact remaining fee, its own settlement workflow id. */
export function settlementWorkflow(transfer: PlannedTransfer, executionId: string, attempt: number, index: number) {
  const composed = composeStrategy({ version: 1, action: 'transfer', network: transfer.network, asset: transfer.asset, amount: transfer.decimal, recipient: transfer.recipient });
  if (!composed.ok) throw new Error(composed.code === 'STRATEGY_SCHEMA_INVALID' ? 'PLATFORM_FEE_SETTLEMENT_UNCOMPOSABLE' : composed.code);
  const workflow = { ...composed.workflow, workflowId: `${SETTLEMENT_WORKFLOW_PREFIX}${executionId}.${attempt}.${index}` };
  return { workflow, workflowHash: semanticWorkflowHash(workflow) };
}

export type TransferOutcome = { readonly kind: 'COLLECTED'; readonly hash: string } | { readonly kind: 'PENDING' }
  | { readonly kind: 'FAILED'; readonly code: string; readonly attention?: true } | { readonly kind: 'UNSIGNED' };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const EVM_HASH = /^0x[0-9a-f]{64}$/, SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/**
 * How one settlement transfer's durable record settles (pure). COLLECTED needs the transfer flow's own RECONCILED verdict (receipt, finality,
 * exact balance and log deltas) for exactly the Review the server composed (workflow hash and recipient). Anything that may still reach or be on
 * a network is PENDING; a proven pre-broadcast refusal, a cancellation, a revert or an expired Solana blockhash is FAILED (retryable); a
 * divergent or inconclusive reconciliation is FAILED with attention (never retried automatically).
 */
export function transferOutcome(record: unknown, expected: Pick<AttemptTransfer, 'workflowHash' | 'recipient'>): TransferOutcome {
  if (!object(record) || !object(record.review)) return { kind: 'PENDING' };
  const review = record.review, attempt = object(record.attempt) ? record.attempt : null;
  if (!object(review.workflow) || semanticWorkflowHash(review.workflow as never) !== expected.workflowHash) return { kind: 'FAILED', code: 'PLATFORM_FEE_SETTLEMENT_REVIEW_MISMATCH', attention: true };
  const recipient = typeof review.recipient === 'string' ? review.recipient : '';
  if ((expected.recipient.startsWith('0x') ? recipient.toLowerCase() : recipient) !== expected.recipient) return { kind: 'FAILED', code: 'PLATFORM_FEE_SETTLEMENT_RECIPIENT_MISMATCH', attention: true };
  const verdict = record.verdict, state = typeof attempt?.state === 'string' ? attempt.state : null;
  if (verdict === 'RECONCILED') {
    const hash = typeof attempt?.transactionHash === 'string' ? attempt.transactionHash : typeof attempt?.signature === 'string' ? attempt.signature : '';
    return attempt?.reconciled === true && (EVM_HASH.test(hash) || SOLANA_SIGNATURE.test(hash)) ? { kind: 'COLLECTED', hash } : { kind: 'PENDING' };
  }
  if (verdict === 'DIVERGENT' || verdict === 'INCONCLUSIVE') return { kind: 'FAILED', code: 'PLATFORM_FEE_SETTLEMENT_DIVERGENT', attention: true };
  if (verdict === 'NOT_EXECUTED') return { kind: 'FAILED', code: 'PLATFORM_FEE_SETTLEMENT_NOT_EXECUTED' };
  if (record.notSubmitted === true) return { kind: 'FAILED', code: 'PLATFORM_FEE_SETTLEMENT_REJECTED' };
  if (state === 'CANCELLED' || state === 'EXPIRED') return { kind: 'FAILED', code: 'PLATFORM_FEE_SETTLEMENT_CANCELLED' };
  if (state === 'REVERTED') return { kind: 'FAILED', code: 'PLATFORM_FEE_SETTLEMENT_REVERTED' };
  if (state === null || state === 'PREPARED') return { kind: 'UNSIGNED' };
  return { kind: 'PENDING' };
}

/** The execution a ledger row or a request names. */
export type ExecutionRef = FeeAuthorizationTarget;
const columnOf = (ref: ExecutionRef) => 'runId' in ref ? 'run_id' : 'workflow_run_id';
const idOf = (ref: ExecutionRef) => 'runId' in ref ? ref.runId : ref.workflowRunId;
export type LedgerRow = { state: string; version: string; lines: FeeLine[]; collection: Collection | null; network_environment: string };
export async function loadLedgerRow(db: Queryable, tenantId: string, ref: ExecutionRef): Promise<LedgerRow | null> {
  return (await db.query<LedgerRow>(`SELECT state, version::text AS version, lines, collection, network_environment FROM platform_fee_ledger
    WHERE tenant_id = $1 AND ${columnOf(ref)} = $2`, [tenantId, idOf(ref)])).rows[0] ?? null;
}
/** One compare-and-set transition on the ledger (the 0037 trigger re-checks the edge). False when another writer moved the row first. */
async function transition(db: Queryable, tenantId: string, ref: ExecutionRef, from: LedgerRow, to: string, collection: Collection): Promise<boolean> {
  const encoded = JSON.stringify(collection);
  if (Buffer.byteLength(encoded) > 4096) throw new Error('PLATFORM_FEE_COLLECTION_RECORD_TOO_LARGE');
  const { rowCount } = await db.query(`UPDATE platform_fee_ledger SET state = $4, collection = $5::jsonb, version = version + 1
    WHERE tenant_id = $1 AND ${columnOf(ref)} = $2 AND version = $3::bigint AND state = $6`, [tenantId, idOf(ref), from.version, to, encoded, from.state]);
  return rowCount === 1;
}

/** The collaborators settlement needs: the transfer flows (bound to the tenant and the owner's verified principal) and the owner's wallets. */
export type SettlementDeps = {
  readonly env: Env;
  /** One call of a transfer flow method as the owner (the API's `callFlow`: same validation, ownership and refusal rules as the app). */
  readonly call: (flow: string, method: string, args: readonly unknown[]) => Promise<{ ok: true; value: unknown } | { ok: false; code: string }>;
  /** The durable record of a transfer run (read-only). */
  readonly load: (flow: string, runId: string) => Promise<unknown>;
  readonly now?: () => Date;
};
export type StartResult = { readonly ok: true; readonly state: 'COLLECTION_PENDING' | 'COLLECTED'; readonly transfers: readonly (AttemptTransfer & { readonly workflow?: unknown })[] }
  | { readonly ok: false; readonly code: string };

/**
 * Starts (or returns the open) collection attempt of one execution for its owner. `owner`: the verified wallet of each namespace the request may
 * pay from (the API passes the wallet session principal; a workflow run's other namespace is paid from that namespace's own session).
 */
export async function startSettlement(db: Database, deps: SettlementDeps, tenantId: string, ref: ExecutionRef,
  owner: { readonly namespace: 'eip155' | 'solana'; readonly account: string }): Promise<StartResult> {
  const blocker = collectionBlocker(deps.env);
  if (blocker !== null) return { ok: false, code: blocker };
  if (!await feeAuthorizationsActive(db)) return { ok: false, code: 'PLATFORM_FEE_AUTHORIZATIONS_NOT_MIGRATED' };
  const row = await loadLedgerRow(db, tenantId, ref);
  if (!row) return { ok: false, code: 'PLATFORM_FEE_NOT_DUE' };
  if (row.state === 'COLLECTED') return { ok: true, state: 'COLLECTED', transfers: [] };
  if (row.state === 'COLLECTION_PENDING') return { ok: true, state: 'COLLECTION_PENDING', transfers: row.collection?.transfers ?? [] };
  if (row.state !== 'DUE' && row.state !== 'COLLECTION_FAILED') return { ok: false, code: 'PLATFORM_FEE_NOT_DUE' };
  if (row.network_environment !== 'MAINNET' && row.network_environment !== 'MOCKED') return { ok: false, code: 'PLATFORM_FEE_SETTLEMENT_NETWORK_UNSUPPORTED' };
  if (row.collection?.attention) return { ok: false, code: 'PLATFORM_FEE_SETTLEMENT_ATTENTION' };
  const attempt = (row.collection?.attempt ?? 0) + 1;
  if (attempt > SETTLEMENT_MAX_ATTEMPTS) return { ok: false, code: 'PLATFORM_FEE_SETTLEMENT_ATTEMPTS_EXHAUSTED' };
  const authorized = await loadFeeAuthorization(db, tenantId, ref);
  if (!authorized) return { ok: false, code: 'PLATFORM_FEE_AUTHORIZATION_MISSING' };
  const plan = planSettlement({ authorized, final: row.lines, collection: row.collection,
    treasury: { evm: deps.env.FLOFI_PLATFORM_FEE_TREASURY_EVM!.trim(), solana: deps.env.FLOFI_PLATFORM_FEE_TREASURY_SOLANA!.trim() } });
  if (!plan.ok) return plan;
  const mine = plan.transfers.filter(t => t.namespace === owner.namespace);
  if (!mine.length) return { ok: false, code: plan.transfers.length ? 'PLATFORM_FEE_SETTLEMENT_OTHER_WALLET' : 'PLATFORM_FEE_NOT_DUE' };
  const created: (AttemptTransfer & { workflow: unknown })[] = [];
  for (const [index, transfer] of mine.entries()) {
    const { workflow, workflowHash } = settlementWorkflow(transfer, idOf(ref), attempt, index);
    const simulated = await deps.call(transfer.flow, 'simulate', [workflow, owner.account]);
    if (!simulated.ok) { await invalidateAll(deps, created); return { ok: false, code: simulated.code }; }
    const record = simulated.value as { id?: unknown; review?: { commitment?: unknown } };
    if (typeof record.id !== 'string' || typeof record.review?.commitment !== 'string') { await invalidateAll(deps, created); return { ok: false, code: 'PLATFORM_FEE_SETTLEMENT_UNAVAILABLE' }; }
    const reviewed = await deps.call(transfer.flow, 'review', [record.id, record.review.commitment, workflow]);
    if (!reviewed.ok) { await invalidateAll(deps, [...created, { ...transfer, runId: record.id, workflowHash, workflow }]); return { ok: false, code: reviewed.code }; }
    created.push({ chainId: transfer.chainId, address: transfer.address, decimals: transfer.decimals, amount: transfer.amount, flow: transfer.flow,
      recipient: transfer.recipient, runId: record.id, workflowHash, workflow });
  }
  const collection: Collection = { v: 1, attempt, startedAt: (deps.now?.() ?? new Date()).toISOString(),
    transfers: created.map(({ workflow: _workflow, ...transfer }) => transfer), transactions: row.collection?.transactions ?? [], code: null };
  if (!await transition(db, tenantId, ref, row, 'COLLECTION_PENDING', collection)) {
    // Another request opened the attempt first: these transfers are never offered and can never be signed.
    await invalidateAll(deps, created);
    const current = await loadLedgerRow(db, tenantId, ref);
    return current?.state === 'COLLECTION_PENDING' ? { ok: true, state: 'COLLECTION_PENDING', transfers: current.collection?.transfers ?? [] }
      : { ok: false, code: 'PLATFORM_FEE_SETTLEMENT_BUSY' };
  }
  return { ok: true, state: 'COLLECTION_PENDING', transfers: created };
}

async function invalidateAll(deps: SettlementDeps, transfers: readonly Pick<AttemptTransfer, 'flow' | 'runId'>[]): Promise<boolean> {
  let all = true;
  for (const t of transfers) { try { const r = await deps.call(t.flow, 'invalidate', [t.runId]); if (!r.ok) all = false; } catch { all = false; } }
  return all;
}

export type ReconcileReport = { readonly examined: number; readonly collected: number; readonly failed: number; readonly pending: number };
/**
 * Advances every open collection attempt of the tenant from its transfers' durable records (worker pass; idempotent; concurrent passes are safe:
 * every write is a compare-and-set). Never submits, signs or replays anything; the transfer flows' own observation reconciles each transfer.
 */
export async function reconcileSettlements(db: Database, deps: Omit<SettlementDeps, 'call'> & { readonly invalidate: SettlementDeps['call'] }, tenantId: string,
  limit = 100): Promise<ReconcileReport> {
  if (!await feeAuthorizationsActive(db)) return { examined: 0, collected: 0, failed: 0, pending: 0 };
  const rows = (await db.query<LedgerRow & { run_id: string | null; workflow_run_id: string | null }>(`SELECT run_id, workflow_run_id, state, version::text AS version,
      lines, collection, network_environment FROM platform_fee_ledger WHERE tenant_id = $1 AND state = 'COLLECTION_PENDING' ORDER BY updated_at LIMIT $2`,
    [tenantId, limit])).rows;
  const now = (deps.now?.() ?? new Date()).getTime();
  let collected = 0, failed = 0, pending = 0;
  for (const row of rows) {
    const ref: ExecutionRef = row.run_id ? { runId: row.run_id } : { workflowRunId: row.workflow_run_id! };
    const collection = row.collection!;
    const outcomes = await Promise.all(collection.transfers.map(async t => {
      try { return transferOutcome(await deps.load(t.flow, t.runId), t); } catch { return { kind: 'PENDING' } as const; }
    }));
    const expired = now - Date.parse(collection.startedAt) > SETTLEMENT_UNSIGNED_TTL_MS;
    // An unsigned transfer past its time is invalidated by its own flow first; only a transfer proven unsubmitted can close the attempt.
    const settled = await Promise.all(outcomes.map(async (outcome, i) => {
      if (outcome.kind !== 'UNSIGNED') return outcome;
      if (!expired) return { kind: 'PENDING' } as const;
      const t = collection.transfers[i]!;
      try { await deps.invalidate(t.flow, 'invalidate', [t.runId]); } catch { return { kind: 'PENDING' } as const; }
      try { const after = transferOutcome(await deps.load(t.flow, t.runId), t); return after.kind === 'UNSIGNED' ? { kind: 'PENDING' } as const : after; }
      catch { return { kind: 'PENDING' } as const; }
    }));
    if (settled.some(o => o.kind === 'PENDING')) { pending++; continue; }
    const transactions = [...collection.transactions];
    settled.forEach((o, i) => { if (o.kind === 'COLLECTED') { const t = collection.transfers[i]!;
      if (!transactions.some(x => x.runId === t.runId)) transactions.push({ chainId: t.chainId, address: t.address, decimals: t.decimals, amount: t.amount, hash: o.hash, runId: t.runId }); } });
    const authorized = await loadFeeAuthorization(db, tenantId, ref);
    const due = authorized ? settledFee({ status: authorized.status === 'FEEABLE' ? 'FEEABLE' : 'NOT_APPLICABLE', lines: authorized.lines }, { status: 'FEEABLE', lines: row.lines }) : [];
    const complete = due.length > 0 && due.every(line => (transactions.filter(t => sameAsset(t, line)).reduce((s, t) => s + BigInt(t.amount), 0n)) >= BigInt(line.fee));
    const failure = settled.find((o): o is Extract<TransferOutcome, { kind: 'FAILED' }> => o.kind === 'FAILED');
    const next: Collection = { ...collection, transactions, code: complete ? null : failure?.code ?? 'PLATFORM_FEE_PARTIALLY_COLLECTED',
      ...settled.some(o => o.kind === 'FAILED' && o.attention) ? { attention: true as const } : {} };
    if (await transition(db, tenantId, ref, row, complete ? 'COLLECTED' : 'COLLECTION_FAILED', next)) { if (complete) collected++; else failed++; }
  }
  return { examined: rows.length, collected, failed, pending };
}
