// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: managing an existing Uniswap v3 position from the owner's wallet — collect, partial withdrawal, full
 * exit and (only when the owner explicitly asks) closing the emptied position NFT — on the catalog mainnets (Base, Arbitrum One, Ethereum,
 * Robinhood Chain). This is part of the canonical Uniswap liquidity runtime, not a second engine: the same service instance, storage port,
 * run namespace (`balp-`, `arlp-`, `etlp-`, `rhlp-`), verified pool runtime, owner-nonce reservation, fee policy, wallet handoff,
 * observation and PR #218 confirmation depth. A position-management run has its own record and Review formats, so a mint run's
 * invariants never change.
 *
 * One operation per run, one wallet request per operation: the Position Manager's own `multicall` wraps decrease + collect (+ burn), so a
 * withdrawal lands whole or not at all and there is never a half-executed position operation to resume. FloFi never signs or sends.
 *
 * Fee accounting: `collect` with uint128-max bounds pays everything owed at execution, including fees accrued after the Review (a fixed bound
 * would leave them behind). The Review therefore states a lower bound for what is collected and the exact principal minimums the
 * `decreaseLiquidity` call enforces. Owed tokens a position already carries may include principal withdrawn earlier without collecting, so
 * they are never presented as trading yield.
 */
import { createHash } from 'node:crypto';
import type { UniswapPoolProfile } from '@defi-workflow-engine/action-registry';
import { decodeUniswapAmounts, decodeUniswapCollect, decodeUniswapDecreaseLiquidity, decodeUniswapMulticallResult, decodeUniswapPosition,
  decodeUniswapPositionRequest, uniswapAmountsForLiquidity, uniswapMinimum, uniswapPositionPlan, uniswapQuotePriceAtSqrt, uniswapQuotePriceAtTick,
  uniswapRangeState, UNISWAP_POSITION_TOPICS as PTOPIC, UNISWAP_SELECTORS as SEL, UNISWAP_TOPICS as TOPIC, type UniswapPositionInnerKind,
  type UniswapPositionOperation, type UniswapRangeState } from '@defi-workflow-engine/reference-compiler';
import { hashArtifactBytes, type ConcentratedLiquidityManagement, type EvidenceBundle, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { validateArtifact } from '@defi-workflow-engine/workflow-contracts/schemas';
import { utf8, type ExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { sameEvmIntent } from './evm-submission-discovery.ts';
import { verifyOwnerSubmission, type Rpc, type StockQuoteState } from './public-testnet-service.ts';
import { readNotAnswered } from './public-testnet-rpc.ts';
import { recordLiquidityOutcome, type LiquidityOutcome } from './liquidity-lifecycle-telemetry.ts';
import type { UniswapAttemptState, UniswapReceipt, UniswapTokenView, UniswapTx, UniswapWalletDiagnostic } from './uniswap-liquidity-service.ts';

export type { UniswapPositionOperation };
/** What the owner asked for. `partBps` is a share of the selected position's liquidity (DECREASE only); `close` burns the emptied NFT (EXIT only). */
export type UniswapPositionRequest = { readonly operation: UniswapPositionOperation; readonly tokenId: string; readonly partBps: number | null; readonly close: boolean };
export type UniswapPositionCall = { readonly step: UniswapPositionOperation; readonly to: string; readonly data: string; readonly gasUsed: string; readonly gasLimit: string;
  readonly l1FeeUpperBoundWei: string | null };
export type UniswapPositionReview = {
  readonly format: 'flofi.uniswap-position-review.v1'; readonly commitment: string;
  readonly operation: UniswapPositionOperation; readonly partBps: number | null; readonly close: boolean;
  readonly network: string; readonly chainId: number; readonly owner: string; readonly recipient: string;
  readonly workflowHash: string; readonly revision: number; readonly nodeId: string;
  readonly observedAt: string; readonly expiresAt: string;
  readonly block: { readonly number: number; readonly hash: string; readonly timestamp: number };
  readonly contracts: { readonly factory: string; readonly positionManager: string; readonly pool: string; readonly codeSha256: Readonly<Record<string, string>> };
  readonly token0: UniswapTokenView; readonly token1: UniswapTokenView;
  readonly pool: { readonly fee: number; readonly tickSpacing: number; readonly sqrtPriceX96: string; readonly tick: number; readonly liquidity: string; readonly price: string };
  /** The position at the Review block. `tokensOwed*` are the manager's checkpointed owed tokens (fees, or principal withdrawn earlier and not collected). */
  readonly position: { readonly tokenId: string; readonly owner: string; readonly tickLower: number; readonly tickUpper: number; readonly lowerPrice: string;
    readonly upperPrice: string; readonly state: UniswapRangeState; readonly liquidity: string; readonly tokensOwed0: string; readonly tokensOwed1: string };
  readonly liquidityToRemove: string; readonly liquidityAfter: string;
  /** Simulated at the Review block: principal the decrease releases, everything collect pays, and the difference (owed tokens and fees). */
  readonly expected: { readonly principal0: string; readonly principal1: string; readonly collect0: string; readonly collect1: string;
    readonly owedAndFees0: string; readonly owedAndFees1: string };
  /** The decrease reverts below these (0 when nothing is decreased). */ readonly minimums: { readonly amount0Min: string; readonly amount1Min: string };
  readonly slippageBps: number;
  /** Unix seconds; only a decrease carries an on-chain deadline. */ readonly deadline: string | null;
  readonly innerCalls: readonly UniswapPositionInnerKind[];
  readonly calls: readonly [UniswapPositionCall];
  readonly fees: { readonly maxFeePerGas: string; readonly maxPriorityFeePerGas: string; readonly gasLimitTotal: string; readonly executionFeeUpperBoundWei: string;
    readonly l1FeeUpperBoundWei: string | null; readonly totalUpperBoundWei: string | null };
  readonly simulation: { readonly method: 'eth_simulateV1'; readonly block: number; readonly gasUsed: string;
    readonly localEstimate: { readonly amount0: string; readonly amount1: string } | null };
  readonly balances: { readonly token0: string; readonly token1: string; readonly native: string };
  readonly nonce: string;
  readonly stocks?: readonly StockQuoteState[];
};
export type UniswapPositionAttempt = { readonly attemptId: string; readonly step: UniswapPositionOperation; readonly state: UniswapAttemptState;
  readonly reviewCommitment: string; readonly nonce: string; readonly preparedAtBlock: number; readonly createdAt: string; readonly tx: UniswapTx;
  readonly transactionHash: string | null; readonly replacementHash: string | null; readonly conflictingTransactionHash?: string;
  readonly receipt: UniswapReceipt | null; readonly reconciled: boolean; readonly note: string | null };
/** What the confirmed transaction did, proven from its receipt events and the chain state at its block. */
export type UniswapPositionResult = { readonly tokenId: string; readonly operation: UniswapPositionOperation; readonly liquidityRemoved: string;
  readonly liquidityAfter: string | null; readonly principal0: string; readonly principal1: string; readonly collected0: string; readonly collected1: string;
  readonly burned: boolean; readonly blockNumber: number; readonly transactionHash: string; readonly reconciliationScope?: 'TRANSACTION' };
export type UniswapPositionEvidence = { readonly bundle: EvidenceBundle; readonly bundleHash: string; readonly evidenceClass: 'MAINNET_EXECUTED' | 'MOCKED';
  readonly network: string; readonly chainId: number; readonly owner: string; readonly positionManager: string; readonly pool: string;
  readonly token0: UniswapTokenView; readonly token1: UniswapTokenView; readonly result: UniswapPositionResult; readonly minimums: UniswapPositionReview['minimums'];
  readonly transaction: { readonly transactionHash: string; readonly blockNumber: number; readonly blockHash: string; readonly status: 0 | 1; readonly gasCostWei: string;
    readonly submissionKind: string; readonly reviewCommitment: string; readonly explorer: string };
  readonly balancesAfter: { readonly token0: string; readonly token1: string }; readonly reconciliation: 'RECONCILED'; readonly observedAt: string };
export type UniswapPositionProvenance = 'PUBLIC_MAINNET' | 'MOCKED';
export type UniswapPositionRecord = { readonly format: 'flofi.uniswap-position-run.v1'; readonly id: string; readonly provenance: UniswapPositionProvenance;
  readonly workflow: SemanticWorkflow; readonly owner: string; readonly request: UniswapPositionRequest; readonly review: UniswapPositionReview;
  readonly authorization: string | null; readonly attempts: readonly UniswapPositionAttempt[]; readonly result: UniswapPositionResult | null;
  readonly evidence: UniswapPositionEvidence | null; readonly verdict: 'PENDING' | 'RECONCILED' | 'DIVERGENT'; readonly error: string | null };
export type UniswapPositionBegin = { readonly record: UniswapPositionRecord; readonly attempt: UniswapPositionAttempt; readonly transaction: UniswapTx };

const ADDRESS = /^0x[0-9a-f]{40}$/, HASH = /^0x[0-9a-f]{64}$/, TOKEN_ID = /^[1-9][0-9]{0,77}$/;
const ACTIVE: readonly UniswapAttemptState[] = ['PREPARED', 'SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING'];
const OBSERVABLE: readonly UniswapAttemptState[] = ['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING'];
const TERMINAL: readonly UniswapAttemptState[] = ['CANCELLED', 'NOT_FOUND', 'CONFIRMED', 'REVERTED', 'RECONCILIATION_REQUIRED'];
const REFUSALS = [4001, 4100, 4200];
const OPERATIONS: readonly UniswapPositionOperation[] = ['COLLECT', 'DECREASE', 'EXIT'];
export const UNISWAP_POSITION_RUN_FORMAT = 'flofi.uniswap-position-run.v1';
/** The same margin the mint path uses (EXEC-01): a request is prepared only while its Review still covers the wallet handoff after it. */
const HANDOFF_MARGIN_MS = 10_000;
/** A Review whose decrease amounts moved more than half the reviewed slippage, or whose position changed, needs a new Review. */
const MATERIAL = /^UNISWAP_(?:POSITION_(?:STATE_CHANGED|OWNER_MISMATCH|POOL_MISMATCH|RANGE_MISMATCH|NOT_FOUND)|UNEXPECTED_CONTRACT|DEPLOYMENT_MISMATCH|POOL_MISMATCH|TOKEN_MISMATCH|FEE_TIER_UNSUPPORTED|SIMULATION_POSITION_REVERTED|.*_REVIEW_REQUIRED)$|^(STOCK_[A-Z_]+|CATALOG_ASSET_IDENTITY_CHANGED)$/;
const DIVERGENT = /^UNISWAP_POSITION_(?:RECEIPT_MISMATCH|EVENT_MISMATCH|TRANSFER_MISMATCH|BALANCE_DELTA_MISMATCH|STATE_MISMATCH|BURN_MISMATCH|MINIMUM_VIOLATED|REQUEST_INVALID)$|^UNISWAP_(?:DECREASE|COLLECT|BURN|MULTICALL)_INVALID$/;

function fail(code: string): never { throw new Error(code); }
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function hex(value: unknown): string { if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) fail('UNISWAP_RPC_INVALID'); return value.toLowerCase(); }
function quantity(value: unknown): bigint { const h = hex(value); if (h === '0x') fail('UNISWAP_RPC_INVALID'); return BigInt(h); }
const tag = (n: number | bigint) => '0x' + n.toString(16);
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addrWord = (a: string) => a.slice(2).padStart(64, '0');
function wordAt(data: string, index: number): bigint {
  if (!/^0x[0-9a-f]*$/.test(data) || data.length < 66 + index * 64) fail('UNISWAP_RPC_INVALID');
  return BigInt('0x' + data.slice(2 + index * 64, 66 + index * 64));
}
function addressAt(data: string, index = 0): string { const v = wordAt(data, index); if (v >> 160n) fail('UNISWAP_RPC_INVALID'); return '0x' + v.toString(16).padStart(40, '0'); }
function topicAddress(value: unknown): string {
  const raw = hex(value);
  if (!/^0x0{24}[0-9a-f]{40}$/.test(raw)) fail('UNISWAP_POSITION_EVENT_MISMATCH');
  return '0x' + raw.slice(-40);
}
function topicInt24(value: unknown): number {
  const v = BigInt(hex(value)) & 0xffffffn;
  return Number(v >= 0x800000n ? v - 0x1000000n : v);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
    .map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
}
const digest = (value: unknown) => '0x' + createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export function uniswapPositionReviewCommitment(review: UniswapPositionReview): string {
  const rest: Record<string, unknown> = { ...review };
  delete rest.commitment;
  return digest(rest);
}
const stockEconomics = (stocks: readonly StockQuoteState[] | undefined) =>
  canonical((stocks ?? []).map(stock => [stock.officialId, stock.multiplierWad, stock.scheduledMultiplierWad, stock.scheduledEffectiveAt]));

/** Strict transport validation of a position request (server actions, cloud flow and MCP all pass through it). */
export function parseUniswapPositionRequest(value: unknown): UniswapPositionRequest {
  if (!isObject(value) || Object.keys(value).some(key => !['operation', 'tokenId', 'partBps', 'close'].includes(key)) ||
      !OPERATIONS.includes(value.operation as UniswapPositionOperation) || typeof value.tokenId !== 'string' || !TOKEN_ID.test(value.tokenId) ||
      typeof value.close !== 'boolean' || (value.close && value.operation !== 'EXIT')) fail('UNISWAP_POSITION_REQUEST_INVALID');
  const partBps = value.partBps ?? null;
  if (value.operation === 'DECREASE' ? !Number.isSafeInteger(partBps) || (partBps as number) < 1 || (partBps as number) > 9_999 : partBps !== null)
    fail('UNISWAP_POSITION_REQUEST_INVALID');
  return { operation: value.operation as UniswapPositionOperation, tokenId: value.tokenId, partBps: partBps as number | null, close: value.close };
}

/** The per-pool runtime the liquidity service already verifies (code pins, pool identity, catalog tokens, fees, nonces). */
export type UniswapPositionChainState = { readonly block: { readonly number: number; readonly hash: string; readonly timestamp: number; readonly baseFee: bigint };
  readonly codeSha256: Record<string, string>; readonly sqrtPriceX96: bigint; readonly tick: number; readonly liquidity: bigint; readonly balance0: bigint;
  readonly balance1: bigint; readonly native: bigint; readonly nonce: bigint; readonly pendingNonce: bigint; readonly stocks: StockQuoteState[] };
export type UniswapPositionPoolRuntime = {
  readonly profile: UniswapPoolProfile; readonly rpc: Rpc;
  readState(owner: string, assets: unknown): Promise<UniswapPositionChainState>;
  feeEnvelope(owner: string, calls: readonly { to: string; data: string }[], gasUsed: readonly bigint[], at: string, native: bigint, baseFee: bigint): Promise<{
    calls: { gasUsed: string; gasLimit: string; l1FeeUpperBoundWei: string | null }[]; fees: UniswapPositionReview['fees'] }>;
  assertRequestFees(review: { readonly calls: readonly { to: string; data: string; gasLimit: string; l1FeeUpperBoundWei?: string | null }[]; readonly owner: string;
    readonly fees: UniswapPositionReview['fees'] }, tx: UniswapTx, at: string): Promise<void>;
  reserveNonce(record: { readonly id: string; readonly owner: string }, attemptId: string, nonce: bigint): Promise<void>;
  discoverByNonce(attempt: UniswapPositionAttempt): Promise<{ consumed: true; tx: Record<string, unknown> } | { consumed: false; pendingTx: Record<string, unknown> | null }>;
  sameIntent(attempt: UniswapPositionAttempt, tx: Record<string, unknown>): boolean;
  view(token: UniswapPoolProfile['token0'], asset: unknown): UniswapTokenView;
  head(): Promise<{ number: number; hash: string; timestamp: number }>;
};
export type UniswapPositionDeps = {
  readonly provenance: UniswapPositionProvenance; readonly executionEnabled: boolean; readonly now: () => Date; readonly idPrefix: string;
  /** The served catalog network's chain id (its run id prefix names it); null only for a testnet service, which refuses position runs. */
  readonly chainId: number | null;
  readonly storage: ExecutionStorage;
  /** The run log validator of the shared namespace (mint and position runs): every run name is checked by the liquidity service. */
  readonly runName: (id: string) => string;
  readonly newRunId: () => string;
  /** The confirmation depth a mainnet settlement waits for (PR #218); MOCKED tests may use a smaller one. */ readonly depth: (chainId: number) => number;
  /** The pool runtime and catalog assets of a workflow's isolated liquidity node (the same resolution a mint uses). */
  readonly runtimeOfWorkflow: (workflow: SemanticWorkflow) => Promise<{ runtime: UniswapPositionPoolRuntime; assets: unknown }>;
  readonly runtimeOfReview: (review: UniswapPositionReview) => Promise<{ runtime: UniswapPositionPoolRuntime; assets: unknown }>;
  /** The node fields of an isolated, capability-checked Uniswap liquidity workflow. */
  readonly intentOf: (workflow: SemanticWorkflow, runtime: UniswapPositionPoolRuntime) => { readonly nodeId: string; readonly tickLower: number; readonly tickUpper: number;
    readonly feeTier: number; readonly slippageBps: number; readonly token0: { readonly address: string }; readonly token1: { readonly address: string };
    /** The canonical node's management marker (BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001): which position and operation the workflow authorizes. */
    readonly management: ConcentratedLiquidityManagement | null };
  readonly explorerTx: (hash: string, profile: UniswapPoolProfile) => string;
};

/** Append-only run history: identity, request, reviewed call, hashes, terminal states, result and evidence never change. */
export function validateUniswapPositionLog(bytes: Uint8Array, idPattern: RegExp, chainId: number | null = null): void {
  try { validatePositionLines(bytes, idPattern, chainId); } catch { fail('UNISWAP_LIQUIDITY_STORE_CORRUPT'); }
}
/** Every collect inside a reviewed request pays the owner, and nobody else (flofi-liquidity #7). */
const collectsToOwner = (data: string, owner: string) => decodeUniswapPositionRequest(data).every(c => c.kind !== 'COLLECT' || decodeUniswapCollect(c.data).recipient === owner);
function validatePositionLines(bytes: Uint8Array, idPattern: RegExp, chainId: number | null): void {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n') || bytes.length > 16_777_216) fail('UNISWAP_LIQUIDITY_STORE_CORRUPT');
  let prior: UniswapPositionRecord | null = null;
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  for (const line of text.trimEnd().split('\n')) {
    let run: UniswapPositionRecord;
    try { run = JSON.parse(line) as UniswapPositionRecord; } catch { fail('UNISWAP_LIQUIDITY_STORE_CORRUPT'); }
    const review = isObject(run) ? run.review : null;
    if (!isObject(run) || run.format !== UNISWAP_POSITION_RUN_FORMAT || !idPattern.test(String(run.id)) || !['PUBLIC_MAINNET', 'MOCKED'].includes(run.provenance) ||
        !ADDRESS.test(String(run.owner)) || !isObject(run.workflow) || !isObject(review) || review.format !== 'flofi.uniswap-position-review.v1' ||
        review.owner !== run.owner || review.recipient !== run.owner || review.position.owner !== run.owner || review.commitment !== uniswapPositionReviewCommitment(review) ||
        canonical(parseUniswapPositionRequest(run.request)) !== canonical(run.request) || run.request.operation !== review.operation ||
        run.request.tokenId !== review.position.tokenId || run.request.partBps !== review.partBps || run.request.close !== review.close ||
        // The namespace's network (the run id prefix names it), the request's own collect recipient, and every attempt's chain (F4 parity).
        (chainId !== null && review.chainId !== chainId) || !Number.isSafeInteger(review.chainId) ||
        !Array.isArray(review.calls) || review.calls.length !== 1 || review.calls[0].to !== review.contracts.positionManager ||
        !collectsToOwner(review.calls[0].data, run.owner) ||
        canonical(decodeUniswapPositionRequest(review.calls[0].data).map(c => c.kind)) !== canonical(review.innerCalls) ||
        (run.authorization !== null && run.authorization !== review.commitment) || !Array.isArray(run.attempts) || run.attempts.length > 16 ||
        !['PENDING', 'RECONCILED', 'DIVERGENT'].includes(run.verdict) || new Set(run.attempts.map(a => a.attemptId)).size !== run.attempts.length ||
        run.attempts.some(a => !isObject(a as unknown) || !a.attemptId.startsWith(run.id + '.') || a.step !== run.request.operation || a.tx.from !== run.owner ||
          a.tx.to !== review.contracts.positionManager || decodeUniswapPositionRequest(a.tx.data).length < 1 || !collectsToOwner(a.tx.data, run.owner) ||
          BigInt(a.tx.chainId) !== BigInt(review.chainId) ||
          (a.transactionHash !== null && !HASH.test(a.transactionHash)) || (a.replacementHash !== null && !HASH.test(a.replacementHash)) ||
          (a.reconciled && (a.state !== 'CONFIRMED' || a.transactionHash === null))) ||
        run.attempts.filter(a => ACTIVE.includes(a.state)).length > 1 ||
        // One operation executes at most once per run: a confirmed withdrawal or collection is never repeated.
        run.attempts.filter(a => a.state === 'CONFIRMED').length > 1 ||
        (run.verdict === 'RECONCILED') !== (run.evidence !== null) || (run.evidence !== null) !== (run.result !== null))
      fail('UNISWAP_LIQUIDITY_STORE_CORRUPT');
    if (prior) {
      if (run.id !== prior.id || run.owner !== prior.owner || run.provenance !== prior.provenance || run.review.chainId !== prior.review.chainId ||
          !same(run.workflow, prior.workflow) || !same(run.request, prior.request) || run.attempts.length < prior.attempts.length ||
          (prior.evidence && !same(run.evidence, prior.evidence)) || (prior.result && !same(run.result, prior.result)) ||
          (prior.verdict !== 'PENDING' && run.verdict !== prior.verdict)) fail('UNISWAP_LIQUIDITY_STORE_CORRUPT');
      for (const [index, before] of prior.attempts.entries()) {
        const after = run.attempts[index]!;
        if (after.attemptId !== before.attemptId || after.step !== before.step || after.nonce !== before.nonce || !same(after.tx, before.tx) ||
            after.reviewCommitment !== before.reviewCommitment || after.preparedAtBlock !== before.preparedAtBlock ||
            (before.transactionHash !== null && after.transactionHash !== before.transactionHash) ||
            (before.replacementHash !== null && after.replacementHash !== before.replacementHash) ||
            (TERMINAL.includes(before.state) && (after.state !== before.state || !same(after.receipt, before.receipt))))
          fail('UNISWAP_LIQUIDITY_STORE_CORRUPT');
      }
    }
    prior = run;
  }
}
export const isUniswapPositionLog = (bytes: Uint8Array | null) => {
  if (!bytes) return false;
  // `format` is always the record's first serialized key: a workflow value elsewhere on the line can never make a mint log look like a position log.
  return utf8(bytes.subarray(0, 64)).startsWith(`{"format":"${UNISWAP_POSITION_RUN_FORMAT}",`);
};
export function uniswapPositionNeedsObservation(value: unknown): boolean {
  const record = value as UniswapPositionRecord, last = record.attempts.at(-1);
  return record.verdict === 'PENDING' && !!last && OBSERVABLE.includes(last.state);
}

type Simulated = { gasUsed: bigint; decreased: { amount0: bigint; amount1: bigint } | null; collected: { amount0: bigint; amount1: bigint } };

export function createUniswapPositionRuntime(deps: UniswapPositionDeps) {
  const { provenance, now, storage: { log, leases } } = deps;
  const validate = (bytes: Uint8Array) => validateUniswapPositionLog(bytes, new RegExp(`^${deps.idPrefix}-[a-f0-9]{32}$`), deps.chainId);
  async function load(id: string): Promise<UniswapPositionRecord> {
    const bytes = await log.read(deps.runName(id));
    if (!bytes) fail('UNISWAP_LIQUIDITY_RUN_NOT_FOUND');
    if (!isUniswapPositionLog(bytes)) fail('UNISWAP_POSITION_RUN_NOT_FOUND');
    try { validate(bytes); } catch { fail('UNISWAP_LIQUIDITY_STORE_CORRUPT'); }
    const record = JSON.parse(utf8(bytes).trimEnd().split('\n').at(-1)!) as UniswapPositionRecord;
    if (record.id !== id || record.provenance !== provenance) fail('UNISWAP_LIQUIDITY_STORE_CORRUPT');
    return record;
  }
  async function save(record: UniswapPositionRecord): Promise<UniswapPositionRecord> {
    const name = deps.runName(record.id), prior = await log.read(name);
    await log.extend(name, new TextEncoder().encode(utf8(prior) + JSON.stringify(record) + '\n'), validate);
    return record;
  }
  const locked = <T,>(id: string, action: () => Promise<T>): Promise<T> => leases.hold(deps.runName(id).slice(0, -6), action);
  const sameWorkflow = (a: SemanticWorkflow, b: SemanticWorkflow) => canonical(a) === canonical(b);
  const active = (record: UniswapPositionRecord) => record.attempts.find(a => ACTIVE.includes(a.state)) ?? null;
  const replaceAttempt = (record: UniswapPositionRecord, attempt: UniswapPositionAttempt): UniswapPositionRecord =>
    ({ ...record, attempts: record.attempts.map(a => a.attemptId === attempt.attemptId ? attempt : a) });
  const evidenceClass = provenance === 'PUBLIC_MAINNET' ? 'MAINNET_EXECUTED' as const : 'MOCKED' as const;
  /** Content-free operational outcome (no address, token id, amount or hash; off unless the deployment opted in). */
  const outcome = (kind: LiquidityOutcome, network: string, request: Pick<UniswapPositionRequest, 'operation' | 'close'> | null, code: string | null = null) =>
    recordLiquidityOutcome({ outcome: kind, protocol: 'UNISWAP_V3', network, operation: request ? request.close ? 'CLOSE' : request.operation : null, code, provenance });
  const settled = (record: UniswapPositionRecord) => {
    if (record.verdict === 'RECONCILED') outcome('RECONCILED', record.review.network, record.request);
    else if (record.verdict === 'DIVERGENT') outcome('RECONCILIATION_REQUIRED', record.review.network, record.request, record.error);
    return record;
  };

  async function ethCall(R: UniswapPositionPoolRuntime, to: string, data: string, at: string, from?: string): Promise<string> {
    return hex(await R.rpc('eth_call', [from ? { from, to, data } : { to, data }, at]));
  }
  /** The position's owner and on-chain state at one block, bound to the runtime's verified pool. */
  async function readPosition(R: UniswapPositionPoolRuntime, tokenId: bigint, at: string) {
    const { profile } = R;
    let owner: string;
    // Only the manager's own answer (a revert: no such token) means "not found"; a read the node never answered is retried, never a Review
    // change, so a transient RPC failure can never clear the owner's authorization (flofi-liquidity #4).
    try { owner = addressAt(await ethCall(R, profile.positionManager, SEL.ownerOf + word(tokenId), at)); }
    catch (cause) { if (readNotAnswered(cause)) throw cause; return fail('UNISWAP_POSITION_NOT_FOUND'); }
    const position = decodeUniswapPosition(await ethCall(R, profile.positionManager, SEL.positions + word(tokenId), at));
    if (position.token0 !== profile.token0.address || position.token1 !== profile.token1.address || position.fee !== profile.feeTier) fail('UNISWAP_POSITION_POOL_MISMATCH');
    if (position.liquidity >= 1n << 128n || position.tokensOwed0 >= 1n << 128n || position.tokensOwed1 >= 1n << 128n) fail('UNISWAP_RPC_INVALID');
    return { owner, ...position };
  }
  /** Real public-network simulation of the exact reviewed request, from the owner, at the observed block. */
  async function simulate(R: UniswapPositionPoolRuntime, owner: string, data: string, kinds: readonly UniswapPositionInnerKind[], at: number): Promise<Simulated> {
    let result: unknown;
    try {
      result = await R.rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: [{ from: owner, to: R.profile.positionManager, data, value: '0x0' }] }],
        validation: false, traceTransfers: false }, tag(at)]);
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'PUBLIC_RPC_METHOD_DENIED') throw cause;
      fail('UNISWAP_SIMULATION_UNAVAILABLE');
    }
    const blocks = Array.isArray(result) ? result : null, outputs = blocks && isObject(blocks[0]) && Array.isArray(blocks[0].calls) ? blocks[0].calls : null;
    if (!outputs || blocks!.length !== 1 || outputs.length !== 1 || !isObject(outputs[0])) fail('UNISWAP_SIMULATION_INVALID');
    const output = outputs[0] as Record<string, unknown>;
    if (quantity(output.status) !== 1n) fail('UNISWAP_SIMULATION_POSITION_REVERTED');
    const returned = hex(output.returnData);
    const results = kinds.length === 1 ? [returned] : decodeUniswapMulticallResult(returned, kinds.length);
    let decreased: Simulated['decreased'] = null, collected: Simulated['collected'] | null = null;
    kinds.forEach((kind, index) => {
      if (kind === 'DECREASE_LIQUIDITY') decreased = decodeUniswapAmounts(results[index]!);
      else if (kind === 'COLLECT') collected = decodeUniswapAmounts(results[index]!);
      else if (results[index] !== '0x') fail('UNISWAP_SIMULATION_INVALID');
    });
    if (!collected) fail('UNISWAP_SIMULATION_INVALID');
    return { gasUsed: quantity(output.gasUsed), decreased, collected };
  }
  const drift = (a: bigint, b: bigint, bps: number) => (a > b ? a - b : b - a) * 20_000n > b * BigInt(bps);
  const minus = (a: bigint, b: bigint) => a > b ? a - b : 0n;

  /** Fresh state, the exact request planned from the owner's selection, two-pass simulation (expected principal → minimums → exact request), fees, commitment. */
  async function buildReview(workflow: SemanticWorkflow, owner: string, request: UniswapPositionRequest): Promise<UniswapPositionReview> {
    const { runtime: R, assets } = await deps.runtimeOfWorkflow(workflow), profile = R.profile;
    const f = deps.intentOf(workflow, R);
    // The operation is part of the canonical workflow: the request must be exactly the one its node names, so a Review (bound to the workflow
    // hash) always authorizes the operation the owner chose last; a deposit workflow is never a position operation.
    const m = f.management;
    if (!m || m.positionId !== request.tokenId || m.operation !== request.operation || m.partBps !== request.partBps || m.close !== request.close)
      fail('UNISWAP_POSITION_REQUEST_MISMATCH');
    if (f.token0.address !== profile.token0.address || f.token1.address !== profile.token1.address || f.feeTier !== profile.feeTier) fail('UNISWAP_POSITION_POOL_MISMATCH');
    const tokenId = BigInt(request.tokenId);
    const state = await R.readState(owner, assets), at = tag(state.block.number);
    const position = await readPosition(R, tokenId, at);
    // The connected wallet must be the NFT's owner: an approved operator, a former owner or another account never manages the position here.
    if (position.owner !== owner) fail('UNISWAP_POSITION_OWNER_MISMATCH');
    if (position.tickLower !== f.tickLower || position.tickUpper !== f.tickUpper) fail('UNISWAP_POSITION_RANGE_MISMATCH');
    const again = await R.rpc('eth_getBlockByNumber', [at, false]);
    if (!isObject(again) || hex(again.hash) !== state.block.hash) fail('UNISWAP_BLOCK_REORG');
    if (request.operation === 'DECREASE' && position.liquidity === 0n) fail('UNISWAP_POSITION_EMPTY');
    const deadline = BigInt(state.block.timestamp + profile.mintDeadlineSeconds);
    const plan = (amount0Min: bigint, amount1Min: bigint) => uniswapPositionPlan({ operation: request.operation, tokenId, recipient: owner,
      positionLiquidity: position.liquidity, partBps: request.partBps, close: request.close, amount0Min, amount1Min, deadline });
    const probePlan = plan(0n, 0n), kinds = probePlan.calls.map(c => c.kind);
    const probe = await simulate(R, owner, probePlan.data, kinds, state.block.number);
    const min0 = probe.decreased ? uniswapMinimum(probe.decreased.amount0, f.slippageBps) : 0n;
    const min1 = probe.decreased ? uniswapMinimum(probe.decreased.amount1, f.slippageBps) : 0n;
    const final = plan(min0, min1);
    const simulated = await simulate(R, owner, final.data, kinds, state.block.number);
    let local: { amount0: bigint; amount1: bigint } | null = null;
    if (final.liquidityToRemove > 0n) {
      const decreased = simulated.decreased ?? fail('UNISWAP_SIMULATION_INVALID');
      // Independent cross-check of the public simulation (tolerance covers the independent sqrt-ratio rounding only).
      local = uniswapAmountsForLiquidity(state.sqrtPriceX96, position.tickLower, position.tickUpper, final.liquidityToRemove);
      const close = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= b / 1_000_000n + 2n;
      if (!close(decreased.amount0, local.amount0) || !close(decreased.amount1, local.amount1) || decreased.amount0 < min0 || decreased.amount1 < min1)
        fail('UNISWAP_SIMULATION_DIVERGENT');
    }
    const principal0 = simulated.decreased?.amount0 ?? 0n, principal1 = simulated.decreased?.amount1 ?? 0n;
    // Collect pays at least the released principal (it is credited to the position's owed tokens first).
    if (simulated.collected.amount0 < principal0 || simulated.collected.amount1 < principal1) fail('UNISWAP_SIMULATION_DIVERGENT');
    // Never ask the owner to pay a network fee for an operation that moves nothing.
    if (final.liquidityToRemove === 0n && simulated.collected.amount0 === 0n && simulated.collected.amount1 === 0n && !request.close)
      fail(request.operation === 'COLLECT' ? 'UNISWAP_POSITION_NOTHING_TO_COLLECT' : 'UNISWAP_POSITION_EMPTY');
    const call = { to: profile.positionManager, data: final.data };
    const envelope = await R.feeEnvelope(owner, [call], [simulated.gasUsed], at, state.native, state.block.baseFee);
    const observed = now();
    const token0 = R.view(profile.token0, isObject(assets) ? assets.token0 : undefined), token1 = R.view(profile.token1, isObject(assets) ? assets.token1 : undefined);
    const review: Omit<UniswapPositionReview, 'commitment'> = {
      format: 'flofi.uniswap-position-review.v1', operation: request.operation, partBps: request.partBps, close: request.close,
      network: profile.network, chainId: profile.chainId, owner, recipient: owner,
      workflowHash: hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow))), revision: workflow.revision, nodeId: f.nodeId,
      observedAt: observed.toISOString(), expiresAt: new Date(observed.getTime() + profile.reviewTtlSeconds * 1000).toISOString(),
      block: { number: state.block.number, hash: state.block.hash, timestamp: state.block.timestamp },
      contracts: { factory: profile.factory, positionManager: profile.positionManager, pool: profile.pool, codeSha256: state.codeSha256 },
      token0, token1,
      pool: { fee: profile.feeTier, tickSpacing: profile.tickSpacing, sqrtPriceX96: state.sqrtPriceX96.toString(), tick: state.tick, liquidity: state.liquidity.toString(),
        price: uniswapQuotePriceAtSqrt(state.sqrtPriceX96, profile.token0.decimals, profile.token1.decimals) },
      position: { tokenId: tokenId.toString(), owner, tickLower: position.tickLower, tickUpper: position.tickUpper,
        lowerPrice: uniswapQuotePriceAtTick(position.tickUpper, profile.token0.decimals, profile.token1.decimals),
        upperPrice: uniswapQuotePriceAtTick(position.tickLower, profile.token0.decimals, profile.token1.decimals),
        state: uniswapRangeState(state.tick, position.tickLower, position.tickUpper), liquidity: position.liquidity.toString(),
        tokensOwed0: position.tokensOwed0.toString(), tokensOwed1: position.tokensOwed1.toString() },
      liquidityToRemove: final.liquidityToRemove.toString(), liquidityAfter: (position.liquidity - final.liquidityToRemove).toString(),
      expected: { principal0: principal0.toString(), principal1: principal1.toString(), collect0: simulated.collected.amount0.toString(),
        collect1: simulated.collected.amount1.toString(), owedAndFees0: (simulated.collected.amount0 - principal0).toString(),
        owedAndFees1: (simulated.collected.amount1 - principal1).toString() },
      minimums: { amount0Min: min0.toString(), amount1Min: min1.toString() }, slippageBps: f.slippageBps,
      deadline: final.liquidityToRemove > 0n ? deadline.toString() : null, innerCalls: kinds,
      calls: [{ step: request.operation, ...call, ...envelope.calls[0]! }], fees: envelope.fees,
      simulation: { method: 'eth_simulateV1', block: state.block.number, gasUsed: simulated.gasUsed.toString(),
        localEstimate: local ? { amount0: local.amount0.toString(), amount1: local.amount1.toString() } : null },
      balances: { token0: state.balance0.toString(), token1: state.balance1.toString(), native: state.native.toString() },
      nonce: state.nonce.toString(),
      ...state.stocks.length ? { stocks: state.stocks } : {},
    };
    return { ...review, commitment: uniswapPositionReviewCommitment(review as UniswapPositionReview) };
  }

  /** Fresh reads before a wallet request: the reviewed position, owner, pool code and exact request must still hold (fees may only have grown). */
  async function assertStillReviewed(record: UniswapPositionRecord, R: UniswapPositionPoolRuntime, assets: unknown): Promise<UniswapPositionChainState> {
    const { review } = record;
    const state = await R.readState(record.owner, assets), at = tag(state.block.number);
    if (canonical(state.codeSha256) !== canonical(review.contracts.codeSha256)) fail('UNISWAP_POSITION_STATE_CHANGED_REVIEW_REQUIRED');
    if (stockEconomics(state.stocks) !== stockEconomics(review.stocks)) fail('STOCK_MULTIPLIER_CHANGED_REVIEW_REQUIRED');
    const position = await readPosition(R, BigInt(review.position.tokenId), at);
    if (position.owner !== record.owner) fail('UNISWAP_POSITION_OWNER_MISMATCH');
    // Bound to the reviewed liquidity: a decrease that already landed (or any other change) never re-applies to the new state.
    if (position.liquidity.toString() !== review.position.liquidity || position.tickLower !== review.position.tickLower || position.tickUpper !== review.position.tickUpper)
      fail('UNISWAP_POSITION_STATE_CHANGED_REVIEW_REQUIRED');
    let fresh: Simulated;
    try { fresh = await simulate(R, record.owner, review.calls[0].data, review.innerCalls, state.block.number); }
    catch (cause) { if (cause instanceof Error && cause.message === 'UNISWAP_SIMULATION_POSITION_REVERTED') fail('UNISWAP_POSITION_STATE_CHANGED_REVIEW_REQUIRED'); throw cause; }
    const p0 = fresh.decreased?.amount0 ?? 0n, p1 = fresh.decreased?.amount1 ?? 0n;
    const e = review.expected;
    if (drift(p0, BigInt(e.principal0), review.slippageBps) || drift(p1, BigInt(e.principal1), review.slippageBps) ||
        minus(fresh.collected.amount0, p0) < BigInt(e.owedAndFees0) || minus(fresh.collected.amount1, p1) < BigInt(e.owedAndFees1) ||
        uniswapRangeState(state.tick, review.position.tickLower, review.position.tickUpper) !== review.position.state)
      fail('UNISWAP_POSITION_STATE_CHANGED_REVIEW_REQUIRED');
    return state;
  }

  /**
   * Position claims: while any run of this position may still execute or awaits reconciliation, no other run of it prepares a request. The
   * position lease is held across the claim, the owner-nonce reservation and the durable PREPARED attempt (`action`), so two runs of one
   * position can never both pass the claim (flofi-liquidity #2).
   *
   * An uncertain attempt whose reserved nonce another transaction consumed is never concluded as "not executed" (the wallet may have used
   * another nonce), but it stops blocking the position once it provably cannot change the position's liquidity any more: a collect-only request
   * (it can only pay owed tokens to the owner; every later Review re-reads them), or a request whose on-chain deadline has passed (`checkDeadline`
   * reverts it at any nonce). Every later run still re-verifies the exact liquidity at begin and hand-off (flofi-liquidity #1, flofi-workflow F2).
   */
  function releasable(other: UniswapPositionRecord, attempt: UniswapPositionAttempt, chainSeconds: number): boolean {
    if (attempt.state !== 'SUBMISSION_RESULT_UNKNOWN' || !attempt.conflictingTransactionHash) return false;
    // No decrease (collect alone, or collect + burn of an empty position): it cannot change the position's liquidity (flofi-liquidity P3-3).
    return !other.review.innerCalls.includes('DECREASE_LIQUIDITY') || other.review.deadline !== null && chainSeconds > Number(other.review.deadline);
  }
  /**
   * A PREPARED attempt whose Review lapsed can never reach a wallet (hand-off refuses a lapsed Review) and workers never observe PREPARED: it is
   * concluded not submitted under that run's own lease, exactly as its owner's observation would, so an abandoned tab (or a run someone else
   * prepared for this owner's public position) never blocks the position or the owner's nonce (flofi-security P3, flofi-workflow P3).
   */
  async function concludeLapsedPrepared(holder: string): Promise<UniswapPositionRecord> {
    return locked(holder, async () => {
      const fresh = await load(holder), attempt = fresh.attempts.at(-1);
      if (attempt?.state !== 'PREPARED' || now().getTime() < Date.parse(fresh.review.expiresAt)) return fresh;
      return save(replaceAttempt({ ...fresh, authorization: null, error: 'UNISWAP_WALLET_NOT_SUBMITTED' },
        { ...attempt, state: 'CANCELLED', note: 'UNISWAP_WALLET_NOT_SUBMITTED' }));
    });
  }
  async function withPositionClaim<T>(record: UniswapPositionRecord, chainSeconds: number, action: () => Promise<T>): Promise<T> {
    const key = `${record.review.chainId}-${record.review.contracts.positionManager}-${record.review.position.tokenId}`, name = key + '.unipm-position';
    return leases.hold(key, async () => {
      const existing = utf8(await log.read(name));
      const holders = [...new Set(existing.trimEnd().split('\n').filter(Boolean).map(line => (JSON.parse(line) as { runId: string }).runId))];
      for (const holder of holders) {
        if (holder === record.id) continue;
        let other: UniswapPositionRecord;
        try { other = await load(holder); } catch { fail('UNISWAP_POSITION_OPERATION_IN_PROGRESS'); }
        if (other.attempts.at(-1)?.state === 'PREPARED' && now().getTime() >= Date.parse(other.review.expiresAt)) other = await concludeLapsedPrepared(holder);
        if (other.verdict === 'PENDING' && other.attempts.some(a => a.state === 'CONFIRMED' || ACTIVE.includes(a.state) && !releasable(other, a, chainSeconds)))
          fail('UNISWAP_POSITION_OPERATION_IN_PROGRESS');
      }
      if (!holders.includes(record.id)) {
        const entry = JSON.stringify({ runId: record.id }) + '\n';
        if (existing === '') { if (!await log.create(name, new TextEncoder().encode(entry))) fail('UNISWAP_POSITION_OPERATION_IN_PROGRESS'); }
        else await log.extend(name, new TextEncoder().encode(existing + entry), () => undefined);
      }
      return action();
    });
  }

  async function reconcile(record: UniswapPositionRecord, R: UniswapPositionPoolRuntime, attempt: UniswapPositionAttempt, raw: Record<string, unknown>,
    blockNumber: number, hash: string): Promise<UniswapPositionResult> {
    const { review } = record, profile = R.profile, NPM = profile.positionManager, POOL = profile.pool, owner = record.owner;
    if (attempt.tx.data !== review.calls[0].data) fail('UNISWAP_POSITION_REQUEST_INVALID');
    const kinds = decodeUniswapPositionRequest(attempt.tx.data).map(c => c.kind);
    const tokenId = BigInt(review.position.tokenId);
    const logs = Array.isArray(raw.logs) ? raw.logs.filter(isObject) : fail('UNISWAP_RECEIPT_INVALID');
    const of = (target: string, topic: string) => logs.filter(l => typeof l.address === 'string' && l.address.toLowerCase() === target && Array.isArray(l.topics) && l.topics[0] === topic);
    const ofToken = (l: Record<string, unknown>) => quantity((l.topics as unknown[])[1]) === tokenId;
    const ticks = (l: Record<string, unknown>) => { const t = l.topics as unknown[]; return t.length === 4 && topicAddress(t[1]) === NPM &&
      topicInt24(t[2]) === review.position.tickLower && topicInt24(t[3]) === review.position.tickUpper; };
    let principal0 = 0n, principal1 = 0n;
    const decreases = of(NPM, PTOPIC.decreaseLiquidity).filter(ofToken);
    const burns = of(POOL, PTOPIC.poolBurn).filter(ticks);
    const removing = BigInt(review.liquidityToRemove);
    if (kinds.includes('DECREASE_LIQUIDITY')) {
      const params = decodeUniswapDecreaseLiquidity(decodeUniswapPositionRequest(attempt.tx.data)[0]!.data);
      if (decreases.length !== 1 || params.liquidity !== removing || params.tokenId !== tokenId) fail('UNISWAP_POSITION_EVENT_MISMATCH');
      const data = hex(decreases[0]!.data);
      if (wordAt(data, 0) !== removing) fail('UNISWAP_POSITION_EVENT_MISMATCH');
      principal0 = wordAt(data, 1); principal1 = wordAt(data, 2);
      if (principal0 < params.amount0Min || principal1 < params.amount1Min) fail('UNISWAP_POSITION_MINIMUM_VIOLATED');
      // The pool burn of exactly the removed liquidity (a later zero-liquidity poke by collect is the only other burn allowed).
      const real = burns.filter(l => wordAt(hex(l.data), 0) !== 0n);
      if (real.length !== 1 || wordAt(hex(real[0]!.data), 0) !== removing || wordAt(hex(real[0]!.data), 1) !== principal0 || wordAt(hex(real[0]!.data), 2) !== principal1)
        fail('UNISWAP_POSITION_EVENT_MISMATCH');
    } else if (decreases.length || burns.some(l => wordAt(hex(l.data), 0) !== 0n)) fail('UNISWAP_POSITION_EVENT_MISMATCH');
    // Exactly one collection, to the owner; the pool's own event carries the amounts actually transferred.
    const collects = of(NPM, PTOPIC.collect).filter(ofToken), poolCollects = of(POOL, PTOPIC.poolCollect).filter(ticks);
    if (collects.length !== 1 || poolCollects.length !== 1 || addressAt(hex(collects[0]!.data), 0) !== owner || addressAt(hex(poolCollects[0]!.data), 0) !== owner)
      fail('UNISWAP_POSITION_EVENT_MISMATCH');
    const collect = decodeUniswapCollect(decodeUniswapPositionRequest(attempt.tx.data).find(c => c.kind === 'COLLECT')!.data);
    if (collect.recipient !== owner || collect.tokenId !== tokenId) fail('UNISWAP_POSITION_REQUEST_INVALID');
    const collected0 = wordAt(hex(poolCollects[0]!.data), 1), collected1 = wordAt(hex(poolCollects[0]!.data), 2);
    if (collected0 < principal0 || collected1 < principal1) fail('UNISWAP_POSITION_EVENT_MISMATCH');
    // Token movements: only pool → owner transfers of the collected amounts; nothing leaves the owner.
    for (const [token, amount] of [[profile.token0.address, collected0], [profile.token1.address, collected1]] as const) {
      const transfers = of(token, TOPIC.transfer);
      const toOwner = transfers.filter(l => topicAddress((l.topics as unknown[])[2]) === owner);
      const fromOwner = transfers.filter(l => topicAddress((l.topics as unknown[])[1]) === owner);
      if (fromOwner.length || (amount === 0n ? toOwner.length !== 0 : toOwner.length !== 1 || topicAddress((toOwner[0]!.topics as unknown[])[1]) !== POOL ||
          quantity(toOwner[0]!.data) !== amount)) fail('UNISWAP_POSITION_TRANSFER_MISMATCH');
    }
    const at = tag(blockNumber), before = tag(blockNumber - 1);
    const burned = kinds.includes('BURN');
    const nftTransfers = of(NPM, TOPIC.transfer).filter(l => (l.topics as unknown[]).length === 4 && quantity((l.topics as unknown[])[3]) === tokenId);
    let liquidityAfter: string | null = null;
    if (burned) {
      if (nftTransfers.length !== 1 || topicAddress((nftTransfers[0]!.topics as unknown[])[1]) !== owner || quantity((nftTransfers[0]!.topics as unknown[])[2]) !== 0n)
        fail('UNISWAP_POSITION_BURN_MISMATCH');
      let stillOwned: boolean;
      // The burn is proven by the NFT Transfer to zero in the verified receipt; the read-back must be the manager's own revert, never a transport failure.
      try { await ethCall(R, NPM, SEL.ownerOf + word(tokenId), at); stillOwned = true; } catch (cause) { if (readNotAnswered(cause)) throw cause; stillOwned = false; }
      if (stillOwned) fail('UNISWAP_POSITION_BURN_MISMATCH');
    }
    const balance = async (token: string, block: string) => wordAt(await ethCall(R, token, SEL.balanceOf + addrWord(owner), block), 0);
    const [b0, a0, b1, a1, nonceBefore, nonceAfter] = await Promise.all([balance(profile.token0.address, before), balance(profile.token0.address, at),
      balance(profile.token1.address, before), balance(profile.token1.address, at), R.rpc('eth_getTransactionCount', [owner, before]).then(quantity),
      R.rpc('eth_getTransactionCount', [owner, at]).then(quantity)]);
    // HOTFIX-WORKFLOW-CONCURRENCY-001 precedent: other owner transactions in the same block also move balances; the receipt then proves the effects alone.
    const shared = nonceAfter - nonceBefore > 1n;
    let touched = false;
    if (!burned) {
      if (nftTransfers.length) fail('UNISWAP_POSITION_BURN_MISMATCH');
      // The decrease removes exactly the reviewed liquidity from whatever the position held just before it: anyone may add liquidity to any
      // position between the Review and inclusion, so the expectation starts from the previous block, not from the Review (flofi-liquidity P3-1).
      const [after, prior] = await Promise.all([readPosition(R, tokenId, at), readPosition(R, tokenId, before)]);
      const expectedAfter = prior.liquidity - removing;
      // Collect at uint128-max leaves nothing owed; the decrease left exactly the reviewed remainder.
      if (after.owner !== owner || after.liquidity !== expectedAfter || after.tokensOwed0 !== 0n || after.tokensOwed1 !== 0n) {
        // The read is at the END of the block. Anyone may add liquidity to any position (increaseLiquidity), and the owner or an approved operator
        // may act on it later in the same block: then the end-of-block state is not this transaction's, and its own verified receipt (exact events,
        // transfers and minimums above) is the proof — scoped to the transaction, as for shared-block balances. Otherwise the run diverged.
        // (flofi-liquidity #3: a third party can no longer turn a correct withdrawal into DIVERGENT.)
        touched = shared || await touchedByOthersInBlock(R, raw, at, tokenId);
        if (!touched) fail('UNISWAP_POSITION_STATE_MISMATCH');
      }
      liquidityAfter = touched ? expectedAfter.toString() : after.liquidity.toString();
    }
    if (!shared && (a0 - b0 !== collected0 || a1 - b1 !== collected1)) fail('UNISWAP_POSITION_BALANCE_DELTA_MISMATCH');
    return { tokenId: tokenId.toString(), operation: review.operation, liquidityRemoved: removing.toString(), liquidityAfter,
      principal0: principal0.toString(), principal1: principal1.toString(), collected0: collected0.toString(), collected1: collected1.toString(), burned,
      blockNumber, transactionHash: hash, ...shared || touched ? { reconciliationScope: 'TRANSACTION' as const } : {} };
  }
  /** Whether another transaction of the same block (before or after this one) emitted a position-manager event for this token id. */
  async function touchedByOthersInBlock(R: UniswapPositionPoolRuntime, receipt: Record<string, unknown>, at: string, tokenId: bigint): Promise<boolean> {
    const index = quantity(receipt.transactionIndex), NPM = R.profile.positionManager;
    const logs = await R.rpc('eth_getLogs', [{ fromBlock: at, toBlock: at, address: NPM }]);
    if (!Array.isArray(logs)) fail('UNISWAP_RPC_INVALID');
    const byId = new Set<string>([TOPIC.increaseLiquidity, PTOPIC.decreaseLiquidity, PTOPIC.collect]);
    return (logs as unknown[]).filter(isObject).some(l => {
      const topics = Array.isArray(l.topics) ? l.topics : [];
      if (typeof l.address !== 'string' || l.address.toLowerCase() !== NPM || quantity(l.transactionIndex) === index) return false;
      return byId.has(String(topics[0])) && topics.length >= 2 && quantity(topics[1]) === tokenId
        || topics[0] === TOPIC.transfer && topics.length === 4 && quantity(topics[3]) === tokenId;
    });
  }
  async function buildEvidence(record: UniswapPositionRecord, R: UniswapPositionPoolRuntime, attempt: UniswapPositionAttempt, result: UniswapPositionResult): Promise<UniswapPositionEvidence> {
    const profile = R.profile, at = tag(result.blockNumber), receipt = attempt.receipt!;
    const [balance0, balance1] = await Promise.all([profile.token0.address, profile.token1.address]
      .map(token => ethCall(R, token, SEL.balanceOf + addrWord(record.owner), at).then(d => wordAt(d, 0))));
    const asset0 = { chainId: profile.chain, address: profile.token0.address, decimals: profile.token0.decimals };
    const asset1 = { chainId: profile.chain, address: profile.token1.address, decimals: profile.token1.decimals };
    const reconciliation = { balances: [{ asset: asset0, amount: balance0!.toString() }, { asset: asset1, amount: balance1!.toString() }], allowances: [], debt: [],
      positions: result.burned ? [] : [{ asset: { chainId: profile.chain, address: profile.positionManager, decimals: 0 }, amount: '1' }],
      fees: [{ asset: { chainId: profile.chain, nativeId: 'ETH', decimals: 18 }, amount: receipt.gasCostWei }],
      residualAssets: [{ asset: asset0, amount: balance0!.toString() }, { asset: asset1, amount: balance1!.toString() }],
      ownership: [{ chainId: profile.chain, address: record.owner }],
      limitations: [provenance === 'PUBLIC_MAINNET' ? 'OWNER_WALLET_MAINNET' : 'MOCKED_CHAIN_ONLY',
        ...result.reconciliationScope === 'TRANSACTION' ? ['OWNER_TRANSACTIONS_IN_BLOCK_RECEIPT_RECONCILED'] : []] };
    const explorer = deps.explorerTx(receipt.transactionHash, profile);
    const transaction = { transactionHash: receipt.transactionHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status,
      gasCostWei: receipt.gasCostWei, submissionKind: receipt.submissionKind, reviewCommitment: attempt.reviewCommitment, explorer };
    const bundle = validateArtifact('evidence-bundle', { schemaVersion: '1.0.0', evidenceBundleId: record.id + '.evidence', version: 1, supersedes: null,
      semanticWorkflowHash: record.review.workflowHash, artifactSetHash: digest(record.review), simulationHash: digest(record.review.simulation),
      policyHash: digest({ request: record.request, minimums: record.review.minimums, deadline: record.review.deadline, slippageBps: record.review.slippageBps }),
      manifestHash: attempt.reviewCommitment, executionPlanHash: digest(attempt.tx), journalHeadHash: digest(record),
      observedAt: now().toISOString(), environment: evidenceClass, outcome: 'RECONCILED',
      receipts: [{ receiptId: receipt.transactionHash, contentHash: receipt.contentHash }], differences: [], reconciliation,
      evidence: [{ evidenceId: 'position-readback', kind: 'EXTERNAL_REFERENCE', contentHash: digest(result) },
        { evidenceId: 'public-explorer', kind: 'EXTERNAL_REFERENCE', contentHash: digest(explorer) },
        { evidenceId: 'balance-reconciliation', kind: 'EXTERNAL_REFERENCE', contentHash: digest(reconciliation) }],
    }) as EvidenceBundle;
    return { bundle, bundleHash: hashArtifactBytes('evidence-bundle', new TextEncoder().encode(JSON.stringify(bundle))), evidenceClass, network: profile.network,
      chainId: profile.chainId, owner: record.owner, positionManager: profile.positionManager, pool: profile.pool, token0: record.review.token0, token1: record.review.token1,
      result, minimums: record.review.minimums, transaction, balancesAfter: { token0: balance0!.toString(), token1: balance1!.toString() }, reconciliation: 'RECONCILED',
      observedAt: now().toISOString() };
  }
  /** Receipt → reconciled effects at the network's confirmation depth. Wrong transaction or effects freeze the run for the owner's attention (never resend). */
  async function settle(record: UniswapPositionRecord, R: UniswapPositionPoolRuntime, attempt: UniswapPositionAttempt, hash: string, raw: Record<string, unknown>) {
    const profile = R.profile, tx = await R.rpc('eth_getTransactionByHash', [hash]);
    let verified: Awaited<ReturnType<typeof verifyOwnerSubmission>>;
    try { verified = await verifyOwnerSubmission(R.rpc, { txHash: hash, account: record.owner, target: attempt.tx.to, data: attempt.tx.data, preBlock: attempt.preparedAtBlock },
      tx, raw, profile.chainId, profile.gasPriceOracle !== null); }
    catch (cause) {
      if (cause instanceof Error && cause.message === 'RECEIPT_NOT_CANONICAL') return save({ ...record, error: 'UNISWAP_RECEIPT_NOT_CANONICAL' });
      if (cause instanceof Error && /^(TRANSACTION_MISMATCH|RECEIPT_INVALID)$/.test(cause.message))
        return save(replaceAttempt({ ...record, verdict: 'DIVERGENT', authorization: null, error: 'UNISWAP_TRANSACTION_MISMATCH' },
          { ...attempt, state: 'RECONCILIATION_REQUIRED', note: 'UNISWAP_TRANSACTION_MISMATCH' }));
      throw cause;
    }
    // BUILD-FLOFI-FINOPS-AUTOMATED-SYNC-002 P0: inclusion is not settlement; a mainnet withdrawal or collection is recorded only at the network's depth.
    const depth = deps.depth(profile.chainId);
    if (depth > 1 && Number(quantity(await R.rpc('eth_blockNumber', []))) - verified.blockNumber + 1 < depth)
      return record.error === 'UNISWAP_AWAITING_CONFIRMATIONS' ? record : save({ ...record, error: 'UNISWAP_AWAITING_CONFIRMATIONS' });
    const execution = verified.gasUsed * verified.effectiveGasPrice;
    const receipt: UniswapReceipt = { transactionHash: hash, status: verified.status, blockNumber: verified.blockNumber, blockHash: hex(raw.blockHash),
      from: verified.txFrom, gasUsed: verified.gasUsed.toString(), effectiveGasPrice: verified.effectiveGasPrice.toString(), l1FeeWei: verified.l1Fee.toString(),
      gasCostWei: (execution + verified.l1Fee).toString(), submissionKind: verified.delegated ? 'DELEGATED_SINGLE' : 'DIRECT', contentHash: digest(raw) };
    const l1Bound = record.review.calls[0].l1FeeUpperBoundWei;
    if (verified.direct && (!isObject(tx) || quantity(tx.nonce) !== BigInt(attempt.nonce) || quantity(tx.gas) > quantity(attempt.tx.gas) ||
        quantity(tx.maxFeePerGas ?? tx.gasPrice) > quantity(attempt.tx.maxFeePerGas) || quantity(tx.maxPriorityFeePerGas ?? '0x0') > quantity(attempt.tx.maxPriorityFeePerGas) ||
        verified.gasUsed > quantity(attempt.tx.gas) || verified.effectiveGasPrice > quantity(attempt.tx.maxFeePerGas) || l1Bound === null || verified.l1Fee > BigInt(l1Bound)))
      return save(replaceAttempt({ ...record, verdict: 'DIVERGENT', authorization: null, error: 'UNISWAP_RECEIPT_BOUNDS_VIOLATED' },
        { ...attempt, state: 'RECONCILIATION_REQUIRED', receipt, note: 'UNISWAP_RECEIPT_BOUNDS_VIOLATED' }));
    if (verified.status === 0)
      return save(replaceAttempt({ ...record, authorization: null, error: 'UNISWAP_TRANSACTION_REVERTED' }, { ...attempt, state: 'REVERTED', receipt, note: 'UNISWAP_TRANSACTION_REVERTED' }));
    try {
      const result = await reconcile(record, R, attempt, raw, verified.blockNumber, hash);
      const confirmed = replaceAttempt({ ...record, authorization: null, error: null }, { ...attempt, state: 'CONFIRMED', receipt, reconciled: true });
      const evidence = await buildEvidence(confirmed, R, { ...attempt, state: 'CONFIRMED', receipt, reconciled: true }, result);
      return save({ ...confirmed, result, evidence, verdict: 'RECONCILED' });
    } catch (cause) {
      const code = cause instanceof Error && DIVERGENT.test(cause.message) ? cause.message : null;
      if (!code) throw cause;
      return save(replaceAttempt({ ...record, verdict: 'DIVERGENT', authorization: null, error: code }, { ...attempt, state: 'RECONCILIATION_REQUIRED', receipt, note: code }));
    }
  }

  return {
    load,
    /** Read-only: a new run with a fresh public simulation of the owner's selected operation on one verified position. */
    async simulate(workflowInput: unknown, ownerInput: string, requestInput: unknown): Promise<UniswapPositionRecord> {
      const workflow = workflowInput as SemanticWorkflow, request = parseUniswapPositionRequest(requestInput);
      if (typeof ownerInput !== 'string' || !ADDRESS.test(ownerInput.toLowerCase())) fail('UNISWAP_ADDRESS_INVALID');
      const owner = ownerInput.toLowerCase();
      let review: UniswapPositionReview;
      try { review = await buildReview(workflow, owner, request); }
      catch (cause) {
        const node = isObject(workflow) && Array.isArray(workflow.nodes) ? workflow.nodes.find(n => n.actionType === 'asset.liquidity.concentrated') : undefined;
        const network = ({ 'eip155:8453': 'Base', 'eip155:42161': 'Arbitrum One', 'eip155:1': 'Ethereum', 'eip155:4663': 'Robinhood Chain' } as Record<string, string>)[node?.chainId ?? ''];
        if (network) outcome('SIMULATION_REJECTED', network, request, cause instanceof Error ? cause.message : null);
        throw cause;
      }
      outcome(request.operation === 'COLLECT' ? 'COLLECTION_PREPARED' : request.operation === 'DECREASE' ? 'WITHDRAWAL_PREPARED' : 'EXIT_PREPARED', review.network, request);
      return save({ format: UNISWAP_POSITION_RUN_FORMAT, id: deps.newRunId(), provenance, workflow, owner, request, review, authorization: null, attempts: [],
        result: null, evidence: null, verdict: 'PENDING', error: null });
    },
    /** A new simulation and Review of the same request on the same run (after an expiry, a refusal or a proven-unsent attempt). */
    async refresh(id: string): Promise<UniswapPositionRecord> { return locked(id, async () => {
      const record = await load(id);
      if (record.verdict !== 'PENDING' || active(record)) fail('UNISWAP_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
      if (record.attempts.some(a => a.state === 'CONFIRMED')) fail('UNISWAP_POSITION_OPERATION_ALREADY_CONFIRMED');
      return save({ ...record, review: await buildReview(record.workflow, record.owner, record.request), authorization: null, error: null });
    }); },
    async review(id: string, commitment: string, workflow: SemanticWorkflow): Promise<UniswapPositionRecord> { return locked(id, async () => {
      const record = await load(id);
      if (!sameWorkflow(workflow, record.workflow)) fail('UNISWAP_SEMANTIC_REVISION_CHANGED');
      if (record.verdict !== 'PENDING' || active(record)) fail('UNISWAP_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
      if (record.attempts.some(a => a.state === 'CONFIRMED')) fail('UNISWAP_POSITION_OPERATION_ALREADY_CONFIRMED');
      if (commitment !== record.review.commitment) fail('UNISWAP_REVIEW_CHANGED');
      if (now().getTime() >= Date.parse(record.review.expiresAt) - HANDOFF_MARGIN_MS) fail('UNISWAP_REVIEW_EXPIRED');
      return save({ ...record, authorization: commitment, error: null });
    }); },
    async invalidate(id: string): Promise<UniswapPositionRecord> { return locked(id, async () => {
      const record = await load(id);
      return record.authorization ? save({ ...record, authorization: null, error: 'UNISWAP_SEMANTIC_EDIT_REQUIRES_REVIEW' }) : record;
    }); },
    /** Re-verifies the reviewed position against fresh public state, re-simulates the exact request, reserves the owner's nonce and persists PREPARED. */
    async begin(id: string, ownerInput: string, workflow: SemanticWorkflow): Promise<UniswapPositionBegin> { return locked(id, async () => {
      let record = await load(id);
      const owner = typeof ownerInput === 'string' ? ownerInput.toLowerCase() : '';
      if (!deps.executionEnabled) fail('UNISWAP_EXECUTION_NOT_ENABLED');
      if (owner !== record.owner) fail('UNISWAP_WRONG_OWNER');
      if (!sameWorkflow(workflow, record.workflow)) fail('UNISWAP_SEMANTIC_REVISION_CHANGED');
      if (record.verdict !== 'PENDING') fail(record.verdict === 'RECONCILED' ? 'UNISWAP_POSITION_OPERATION_ALREADY_CONFIRMED' : 'UNISWAP_RECONCILIATION_REQUIRED');
      if (active(record)) fail('UNISWAP_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
      if (record.attempts.some(a => a.state === 'CONFIRMED')) fail('UNISWAP_POSITION_OPERATION_ALREADY_CONFIRMED');
      if (record.authorization !== record.review.commitment) fail('UNISWAP_REVIEW_REQUIRED');
      const expiring = () => now().getTime() >= Date.parse(record.review.expiresAt) - HANDOFF_MARGIN_MS;
      const expired = async (): Promise<never> => {
        if (record.error !== 'UNISWAP_REVIEW_EXPIRED' || record.authorization !== null) await save({ ...record, authorization: null, error: 'UNISWAP_REVIEW_EXPIRED' });
        return fail('UNISWAP_REVIEW_EXPIRED');
      };
      if (expiring()) return expired();
      const changed = async (code: string): Promise<never> => { await save({ ...record, authorization: null, error: code }); return fail(code); };
      const { runtime: R, assets } = await deps.runtimeOfReview(record.review);
      let state: UniswapPositionChainState;
      try { state = await assertStillReviewed(record, R, assets); }
      catch (cause) { if (cause instanceof Error && MATERIAL.test(cause.message)) return changed(cause.message); throw cause; }
      const nonce = state.pendingNonce;
      if (nonce < state.nonce) fail('UNISWAP_RPC_INVALID');
      const call = record.review.calls[0];
      const attemptId = `${id}.${record.request.operation.toLowerCase()}.${record.attempts.length + 1}`;
      const tx: UniswapTx = { nonce: tag(nonce), chainId: R.profile.chainHex, from: owner, to: call.to, data: call.data, value: '0x0', gas: tag(BigInt(call.gasLimit)),
        maxFeePerGas: tag(BigInt(record.review.fees.maxFeePerGas)), maxPriorityFeePerGas: tag(BigInt(record.review.fees.maxPriorityFeePerGas)) };
      try { await R.assertRequestFees(record.review, tx, tag(state.block.number)); }
      catch (cause) { if (cause instanceof Error && /^UNISWAP_.*_REVIEW_REQUIRED$/.test(cause.message)) return changed(cause.message); throw cause; }
      if (expiring()) return expired();
      if (record.attempts.length >= 16) fail('UNISWAP_ATTEMPT_LIMIT_SIMULATE_AGAIN');
      const attempt: UniswapPositionAttempt = { attemptId, step: record.request.operation, state: 'PREPARED', reviewCommitment: record.review.commitment,
        nonce: nonce.toString(), preparedAtBlock: state.block.number, createdAt: now().toISOString(), tx, transactionHash: null, replacementHash: null, receipt: null,
        reconciled: false, note: null };
      const claimed = record;
      record = await withPositionClaim(claimed, state.block.timestamp, async () => {
        await R.reserveNonce(claimed, attemptId, nonce);
        return save({ ...claimed, attempts: [...claimed.attempts, attempt], error: null });
      });
      return { record, attempt, transaction: tx };
    }); },
    /** The handoff boundary: SUBMITTING is durable before the browser calls the wallet. */
    async handoff(id: string): Promise<UniswapPositionRecord> { return locked(id, async () => {
      const record = await load(id), attempt = record.attempts.at(-1);
      if (!deps.executionEnabled || attempt?.state !== 'PREPARED' || record.authorization !== attempt.reviewCommitment) fail('UNISWAP_WALLET_HANDOFF_NOT_AUTHORIZED');
      const expired = async (): Promise<never> => {
        await save(replaceAttempt({ ...record, authorization: null, error: 'UNISWAP_REVIEW_EXPIRED' }, { ...attempt, state: 'CANCELLED', note: 'UNISWAP_REVIEW_EXPIRED' }));
        return fail('UNISWAP_REVIEW_EXPIRED');
      };
      const lapsed = () => now().getTime() >= Date.parse(record.review.expiresAt);
      if (lapsed()) return expired();
      const { runtime: R, assets } = await deps.runtimeOfReview(record.review);
      try {
        const state = await assertStillReviewed(record, R, assets);
        await R.assertRequestFees(record.review, attempt.tx, tag(state.block.number));
      } catch (cause) {
        if (cause instanceof Error && MATERIAL.test(cause.message)) await save({ ...record, authorization: null, error: cause.message });
        throw cause;
      }
      const [latest, pending] = await Promise.all([R.rpc('eth_getTransactionCount', [record.owner, 'latest']).then(quantity),
        R.rpc('eth_getTransactionCount', [record.owner, 'pending']).then(quantity)]);
      if (pending !== BigInt(attempt.nonce) || latest > pending) fail('UNISWAP_NONCE_CHANGED');
      if (lapsed()) return expired();
      return save(replaceAttempt(record, { ...attempt, state: 'SUBMITTING' }));
    }); },
    /** Wallet result. A hash is recorded once; ambiguity is observed, never resent. */
    async report(id: string, result: { kind: 'HASH'; hash: string } | { kind: 'UNKNOWN' | 'REJECTED'; code?: string }): Promise<UniswapPositionRecord> { return locked(id, async () => {
      const record = await load(id), attempt = record.attempts.at(-1);
      if (!attempt) fail('UNISWAP_ATTEMPT_MISSING');
      if (result.kind === 'HASH') {
        const hash = String(result.hash).toLowerCase();
        if (!HASH.test(hash)) fail('UNISWAP_HASH_INVALID');
        if (attempt.transactionHash) { if (attempt.transactionHash !== hash) fail('UNISWAP_HASH_DIVERGENT'); return record; }
        if (!['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN'].includes(attempt.state)) fail('UNISWAP_ATTEMPT_STATE_INVALID');
        return save(replaceAttempt({ ...record, error: null }, { ...attempt, state: 'PENDING', transactionHash: hash }));
      }
      if (attempt.state !== 'SUBMITTING') return record;
      return save(replaceAttempt({ ...record, error: 'UNISWAP_SUBMISSION_UNKNOWN' }, { ...attempt, state: 'SUBMISSION_RESULT_UNKNOWN',
        note: result.kind === 'REJECTED' ? 'UNISWAP_REPORTED_REJECTED_UNPROVEN' : 'UNISWAP_SUBMISSION_UNKNOWN' }));
    }); },
    /** Records a proven pre-broadcast failure or refusal (the mint path's exact rule). Anything that may have reached the network stays observation-only. */
    async walletFailure(id: string, diagnostic: UniswapWalletDiagnostic): Promise<UniswapPositionRecord> { return locked(id, async () => {
      const record = await load(id), attempt = record.attempts.at(-1);
      if (JSON.stringify(diagnostic).length > 65_536 || typeof diagnostic.invoked !== 'boolean' || !Array.isArray(diagnostic.calls) ||
          !/^UNISWAP_[A-Z0-9_]{2,70}$/.test(diagnostic.code)) fail('UNISWAP_DIAGNOSTIC_INVALID');
      const send = diagnostic.calls.find(c => c.submission === true), error = send?.error as { code?: unknown } | undefined;
      const refused = diagnostic.invoked && send !== undefined && send.result === undefined && typeof error?.code === 'number' &&
        error.code === diagnostic.rejectionCode && REFUSALS.includes(error.code);
      if ((diagnostic.invoked || send) && !refused || !attempt || attempt.transactionHash ||
          !['PREPARED', 'SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN'].includes(attempt.state)) fail('UNISWAP_DIAGNOSTIC_NOT_PRE_SUBMISSION');
      if (!diagnostic.invoked && attempt.state === 'SUBMISSION_RESULT_UNKNOWN') fail('UNISWAP_DIAGNOSTIC_NOT_PRE_SUBMISSION');
      const note = refused ? 'UNISWAP_REJECTED' : diagnostic.code;
      // Telemetry carries a closed FloFi code, never the browser-reported diagnostic text (flofi-data-privacy #2).
      outcome('WALLET_HANDOFF_FAILED', record.review.network, record.request, refused ? 'UNISWAP_REJECTED' : 'UNISWAP_WALLET_NOT_SUBMITTED');
      return save(replaceAttempt({ ...record, authorization: null, error: note }, { ...attempt, state: 'CANCELLED', note }));
    }); },
    /** Read-only observation and reconciliation (API and worker). There is no send path here. */
    async observe(id: string): Promise<UniswapPositionRecord> { return locked(id, async () => {
      const record = await load(id), attempt = record.attempts.at(-1);
      if (!attempt || record.verdict !== 'PENDING' || !ACTIVE.includes(attempt.state)) return record;
      if (attempt.state === 'PREPARED')
        return save(replaceAttempt({ ...record, authorization: null, error: 'UNISWAP_WALLET_NOT_SUBMITTED' }, { ...attempt, state: 'CANCELLED', note: 'UNISWAP_WALLET_NOT_SUBMITTED' }));
      const { runtime: R } = await deps.runtimeOfReview(record.review);
      let hash = attempt.replacementHash ?? attempt.transactionHash;
      let raw = hash ? await R.rpc('eth_getTransactionReceipt', [hash]) : null;
      if (raw === null) {
        const found = await R.discoverByNonce(attempt);
        if (!found.consumed) {
          // Only a decrease carries a deadline; a request past it can never execute. Collect alone stays observation-only.
          const latest = await R.head();
          if (record.review.deadline !== null && latest.timestamp > Number(record.review.deadline))
            return save(replaceAttempt({ ...record, authorization: null, error: 'UNISWAP_SUBMISSION_EXPIRED_NOT_EXECUTED' },
              { ...attempt, state: 'NOT_FOUND', note: 'UNISWAP_SUBMISSION_EXPIRED_NOT_EXECUTED' }));
          // An observation that learns nothing new appends nothing: polling a long-uncertain request never grows the log (flofi-liquidity P3-4).
          const unchanged = (next: UniswapPositionRecord) => canonical(next) === canonical(record) ? record : save(next);
          if (found.pendingTx && sameEvmIntent(found.pendingTx, attempt.tx, attempt.nonce)) {
            const h = hex(found.pendingTx.hash);
            return unchanged(replaceAttempt({ ...record, error: 'UNISWAP_TRANSACTION_PENDING' }, { ...attempt, state: 'PENDING', transactionHash: attempt.transactionHash ?? h,
              replacementHash: attempt.transactionHash && attempt.transactionHash !== h ? h : attempt.replacementHash }));
          }
          return unchanged({ ...record, error: hash ? 'UNISWAP_TRANSACTION_PENDING' : 'UNISWAP_TRANSACTION_NOT_OBSERVED' });
        }
        const foundHash = hex(found.tx.hash);
        if (!R.sameIntent(attempt, found.tx)) {
          // Already recorded: observing it again appends nothing (the log never grows with unchanged snapshots).
          if (attempt.state === 'SUBMISSION_RESULT_UNKNOWN' && attempt.conflictingTransactionHash === foundHash && record.authorization === null &&
              record.error === 'UNISWAP_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION') return record;
          return save(replaceAttempt({ ...record, authorization: null, error: 'UNISWAP_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION' },
            { ...attempt, state: 'SUBMISSION_RESULT_UNKNOWN', conflictingTransactionHash: foundHash, note: 'UNISWAP_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION' }));
        }
        const replaced = attempt.transactionHash !== null && attempt.transactionHash !== foundHash;
        const current: UniswapPositionAttempt = { ...attempt, state: 'PENDING', transactionHash: attempt.transactionHash ?? foundHash, replacementHash: replaced ? foundHash : attempt.replacementHash };
        hash = foundHash;
        raw = await R.rpc('eth_getTransactionReceipt', [hash]);
        const saved = await save(replaceAttempt(record, current));
        if (raw === null) return save({ ...saved, error: 'UNISWAP_TRANSACTION_PENDING' });
        if (!isObject(raw)) fail('UNISWAP_RECEIPT_INVALID');
        return settled(await settle(saved, R, current, hash, raw));
      }
      if (!isObject(raw)) fail('UNISWAP_RECEIPT_INVALID');
      return settled(await settle(record, R, attempt, hash!, raw));
    }); },
  };
}
export type UniswapPositionRuntime = ReturnType<typeof createUniswapPositionRuntime>;
