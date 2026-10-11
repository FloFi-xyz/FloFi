// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-UNISWAP-LIQUIDITY-PUBLIC: the canonical concentrated-liquidity action on Base Sepolia through Uniswap v3,
 * executed by the owner's browser wallet. BUILD-ETHEREUM-001 adds the same runtime on Ethereum Sepolia (USDC/WETH 0.3%):
 * the authored chain selects the profile and its own chain-bound read client, and every run stays on its reviewed chain. This service never signs or sends: it reads public chain state, simulates
 * the exact call sequence (`eth_simulateV1`), binds a Review, persists each attempt before the wallet is called,
 * and observes/reconciles what the owner's wallet sent. One implementation runs on the `ExecutionStorage` port:
 * the file store locally, PostgreSQL (fenced leases, CAS, outbox) in the cloud.
 *
 * BUILD-RH-002: Robinhood Chain (4663, real funds) on the same runtime: the pool is the node's own pair and fee tier (the CREATE2 pool of the
 * pinned factory); both tokens must be official catalog assets, Stock Tokens are verified as the official beacon proxy with the registry's
 * uid and multiplier (bound into Review), and runs are `rhlp-` with PUBLIC_MAINNET provenance (MAINNET_EXECUTED evidence) or MOCKED.
 *
 * BUILD-BASE-001: Base mainnet (8453, real funds) is a second catalog network on the same runtime: pools of any two Base catalog ERC-20s at a
 * standard tier (the CREATE2 pool of Base's pinned factory), tokens verified on chain against the Base catalog, the OP Stack L1 fee bounded
 * through the GasPriceOracle, and `balp-` runs.
 *
 * BUILD-ARB-001: Arbitrum One (42161) reuses the catalog mint path with `arlp-` runs and the Phase 2 Nitro fee policy.
 * Posting gas is included in the reviewed gas ceiling; receipt cost is gasUsed × effectiveGasPrice, without an OP Stack oracle.
 *
 * Run = append-only snapshot log `unilp-<32 hex>.jsonl` (`rhlp-` on Robinhood Chain, `balp-` on Base, `arlp-` on Arbitrum). Steps: exact finite approval of token0 and/or token1 to the
 * Position Manager when the on-chain allowance is short, then one mint whose NFT recipient is the owner. Each step is
 * its own wallet request; a confirmed approval requires a fresh simulation and Review before the mint.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ARBITRUM_ONE, catalogAsset, catalogPoolOn, resolveWorkflowCapability, UNISWAP_V3_BASE_SEPOLIA_LIQUIDITY as BASE_PROFILE, UNISWAP_V3_ROBINHOOD as ROBINHOOD,
  uniswapCatalogDeployment, uniswapLiquidityProfile, type AssetCatalog, type CanonicalAsset, type UniswapPoolProfile } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext, validateAuthoringWorkflow, validateUniswapLiquidityWorkflow } from '@defi-workflow-engine/reference-linter';
import { UNISWAP_SELECTORS as SEL, UNISWAP_TOPICS as TOPIC, decodeUniswapApprove, decodeUniswapMint, decodeUniswapMintResult, decodeUniswapPosition,
  encodeUniswapApprove, encodeUniswapMint, uniswapComposition, uniswapMinimum, uniswapQuotePriceAtSqrt, uniswapQuotePriceAtTick, uniswapRangeState,
  type UniswapRangeState } from '@defi-workflow-engine/reference-compiler';
import { hashArtifactBytes, readConcentratedLiquidity, type EvidenceBundle, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { validateArtifact } from '@defi-workflow-engine/workflow-contracts/schemas';
import { utf8, type ExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { catalogTokenPolicy, verifyCatalogToken, verifyOwnerSubmission, type Rpc, type StockQuoteState } from './public-testnet-service.ts';
import { swapProfile, type CatalogSwapProfile } from '../domain/public-testnet-swap.ts';
import { nitroGasLimit, nitroMaxFeePerGas, nitroPostingGas } from './arbitrum-fees.ts';

export type UniswapLiquidityStep = 'APPROVE_TOKEN0' | 'APPROVE_TOKEN1' | 'MINT';
export type UniswapAttemptState = 'PREPARED' | 'CANCELLED' | 'SUBMITTING' | 'SUBMISSION_RESULT_UNKNOWN' | 'NOT_FOUND' | 'PENDING' | 'CONFIRMED' |
  'REVERTED' | 'RECONCILIATION_REQUIRED';
export type UniswapTx = { readonly chainId: string; readonly from: string; readonly to: string; readonly data: string; readonly value: '0x0';
  readonly gas: string; readonly maxFeePerGas: string; readonly maxPriorityFeePerGas: string };
export type UniswapReviewCall = { readonly step: UniswapLiquidityStep; readonly to: string; readonly data: string; readonly gasUsed: string; readonly gasLimit: string;
  readonly l1FeeUpperBoundWei?: string | null };
/** `officialId`: catalog networks only — the token's official issuer identity (a Robinhood Stock Token), else null (USDG, WETH, Base tokens). */
export type UniswapTokenView = { readonly symbol: string; readonly address: string; readonly decimals: number; readonly officialId?: string | null };
export type UniswapLiquidityReview = {
  readonly format: 'flofi.uniswap-liquidity-review.v1'; readonly commitment: string;
  readonly network: string; readonly chainId: number; readonly owner: string; readonly recipient: string;
  readonly workflowHash: string; readonly revision: number; readonly nodeId: string;
  readonly observedAt: string; readonly expiresAt: string;
  readonly block: { readonly number: number; readonly hash: string; readonly timestamp: number };
  readonly contracts: { readonly factory: string; readonly positionManager: string; readonly pool: string; readonly codeSha256: Readonly<Record<string, string>> };
  readonly token0: UniswapTokenView; readonly token1: UniswapTokenView;
  readonly pool: { readonly fee: number; readonly tickSpacing: number; readonly sqrtPriceX96: string; readonly tick: number; readonly liquidity: string;
    /** token0 per token1 (USDC per WETH on the testnet profiles). */ readonly price: string };
  readonly range: { readonly tickLower: number; readonly tickUpper: number; /** token0 per token1 (from tickUpper / tickLower). */ readonly lowerPrice: string;
    readonly upperPrice: string; readonly state: UniswapRangeState; readonly description: string };
  readonly intent: { readonly amount0Max: string; readonly amount1Max: string; readonly slippageBps: number };
  readonly expected: { readonly liquidity: string; readonly amount0: string; readonly amount1: string };
  readonly minimums: { readonly amount0Min: string; readonly amount1Min: string };
  /** Unix seconds; the mint cannot land after it. */ readonly deadline: string;
  readonly balances: { readonly token0: string; readonly token1: string; readonly native: string };
  readonly allowances: { readonly token0: string; readonly token1: string };
  readonly approvals: readonly { readonly step: 'APPROVE_TOKEN0' | 'APPROVE_TOKEN1'; readonly token: string; readonly symbol: string;
    readonly spender: string; readonly amount: string; readonly currentAllowance: string; readonly required: boolean }[];
  readonly calls: readonly UniswapReviewCall[];
  readonly fees: { readonly maxFeePerGas: string; readonly maxPriorityFeePerGas: string; readonly gasLimitTotal: string; readonly executionFeeUpperBoundWei: string;
    readonly l1FeeUpperBoundWei: string | null; readonly totalUpperBoundWei: string | null };
  readonly simulation: { readonly method: 'eth_simulateV1'; readonly block: number; readonly calls: readonly { readonly step: UniswapLiquidityStep; readonly gasUsed: string }[];
    readonly mint: { readonly liquidity: string; readonly amount0: string; readonly amount1: string };
    readonly localEstimate: { readonly liquidity: string; readonly amount0: string; readonly amount1: string } };
  readonly nonce: string;
  /** BUILD-RH-002: the Stock Token sides' identity and multiplier state at the Review block (Robinhood Chain only). */
  readonly stocks?: readonly StockQuoteState[];
};
export type UniswapReceipt = { readonly transactionHash: string; readonly status: 0 | 1; readonly blockNumber: number; readonly blockHash: string;
  readonly from: string; readonly gasUsed: string; readonly effectiveGasPrice: string; readonly l1FeeWei: string; readonly gasCostWei: string;
  readonly submissionKind: 'DIRECT' | 'DELEGATED_SINGLE'; readonly contentHash: string };
export type UniswapAttempt = { readonly attemptId: string; readonly step: UniswapLiquidityStep; readonly state: UniswapAttemptState;
  readonly reviewCommitment: string; readonly nonce: string; readonly preparedAtBlock: number; readonly createdAt: string; readonly tx: UniswapTx;
  /** The first hash ever reported or discovered; immutable. A same-intent replacement is recorded separately. */
  readonly transactionHash: string | null; readonly replacementHash: string | null;
  /** Owner's position NFT count when a MINT was prepared (duplicate-position guard). */ readonly positionsBefore: string | null;
  readonly receipt: UniswapReceipt | null; readonly reconciled: boolean; readonly note: string | null };
export type UniswapPosition = { readonly tokenId: string; readonly owner: string; readonly liquidity: string; readonly amount0: string; readonly amount1: string;
  readonly tickLower: number; readonly tickUpper: number; readonly pool: string; readonly blockNumber: number; readonly transactionHash: string };
export type UniswapEvidence = { readonly bundle: EvidenceBundle; readonly bundleHash: string; readonly evidenceClass: 'TESTNET_EXECUTED' | 'MAINNET_EXECUTED' | 'MOCKED';
  readonly network: string; readonly chainId: number; readonly owner: string; readonly positionManager: string; readonly pool: string;
  readonly token0: UniswapTokenView; readonly token1: UniswapTokenView; readonly feeTier: number; readonly tickLower: number; readonly tickUpper: number;
  readonly lowerPrice: string; readonly upperPrice: string; readonly position: UniswapPosition; readonly minimums: UniswapLiquidityReview['minimums'];
  readonly transactions: readonly { readonly step: UniswapLiquidityStep; readonly transactionHash: string; readonly blockNumber: number; readonly blockHash: string;
    readonly status: 0 | 1; readonly gasCostWei: string; readonly submissionKind: string; readonly reviewCommitment: string; readonly explorer: string }[];
  readonly residualAllowances: { readonly token0: string; readonly token1: string }; readonly balancesAfter: { readonly token0: string; readonly token1: string };
  readonly reconciliation: 'RECONCILED'; readonly observedAt: string };
export type UniswapProvenance = 'PUBLIC_TESTNET' | 'PUBLIC_MAINNET' | 'MOCKED';
export type UniswapLiquidityRecord = { readonly format: 'flofi.uniswap-liquidity-run.v1'; readonly id: string; readonly provenance: UniswapProvenance;
  readonly workflow: SemanticWorkflow; readonly owner: string; readonly review: UniswapLiquidityReview; readonly authorization: string | null;
  readonly attempts: readonly UniswapAttempt[]; readonly position: UniswapPosition | null; readonly evidence: UniswapEvidence | null;
  readonly verdict: 'PENDING' | 'RECONCILED' | 'DIVERGENT'; readonly error: string | null };
export type UniswapBegin = { readonly record: UniswapLiquidityRecord; readonly attempt: UniswapAttempt; readonly transaction: UniswapTx };
export type UniswapWalletDiagnostic = { invoked: boolean; calls: { method: string; submission?: boolean; result?: string | null; error?: unknown }[];
  code: string; rejectionCode?: number };
export type UniswapLiquidityPrice = { readonly sqrtPriceX96: string; readonly tick: number; readonly price: string; readonly blockNumber: number };

export const UNISWAP_LIQUIDITY_RUN_ID = /^(?:unilp|rhlp|balp|arlp)-[a-f0-9]{32}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/, HASH = /^0x[0-9a-f]{64}$/;
const ACTIVE: readonly UniswapAttemptState[] = ['PREPARED', 'SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING'];
export const UNISWAP_OBSERVABLE: readonly UniswapAttemptState[] = ['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN', 'PENDING'];
const TERMINAL: readonly UniswapAttemptState[] = ['CANCELLED', 'NOT_FOUND', 'CONFIRMED', 'REVERTED', 'RECONCILIATION_REQUIRED'];
const REFUSALS = [4001, 4100, 4200];
const staleReviewError = (code: string) => /^UNISWAP_(?:.*_REVIEW_REQUIRED|UNEXPECTED_CONTRACT|DEPLOYMENT_MISMATCH|POOL_MISMATCH|TOKEN_MISMATCH|FEE_TIER_UNSUPPORTED|SIMULATION_(?:MINT|APPROVAL)_REVERTED)$/.test(code) ||
  /^(STOCK_[A-Z_]+|CATALOG_ASSET_IDENTITY_CHANGED)$/.test(code);
/** An approval whose nonce was never consumed and nothing is queued is abandoned after this long. */
const APPROVAL_ABANDON_MS = 15 * 60_000;
/**
 * The run's reviewed pool: the chain's fixed profile, or (a catalog network: Robinhood Chain, Base) the CREATE2 pool of its reviewed pair and
 * fee tier. A persisted review whose pool does not reproduce is corrupt.
 */
function profileOfReview(review: UniswapLiquidityReview): UniswapPoolProfile {
  let profile: UniswapPoolProfile | null = uniswapLiquidityProfile(review.chainId);
  if (!profile && uniswapCatalogDeployment(review.chainId)) {
    try { profile = catalogPoolOn(review.chainId, review.token0, review.token1, review.pool.fee); } catch { profile = null; }
  }
  if (!profile || profile.pool !== review.contracts.pool || profile.factory !== review.contracts.factory || profile.positionManager !== review.contracts.positionManager ||
      profile.token0.address !== review.token0.address || profile.token1.address !== review.token1.address || profile.token0.decimals !== review.token0.decimals ||
      profile.token1.decimals !== review.token1.decimals || profile.tickSpacing !== review.pool.tickSpacing) fail('UNISWAP_LIQUIDITY_STORE_CORRUPT');
  return profile;
}
/**
 * Testnet profiles run as `unilp-` with PUBLIC_TESTNET (or MOCKED) provenance; each catalog network has its own mainnet namespace with
 * PUBLIC_MAINNET (or MOCKED): `rhlp-` on Robinhood Chain, `balp-` on Base, `arlp-` on Arbitrum. A namespace never holds another chain's run.
 */
const CATALOG_RUN_PREFIX: Readonly<Record<number, 'rhlp' | 'balp' | 'arlp'>> = Object.freeze({ [ROBINHOOD.chainId]: 'rhlp', 8453: 'balp', [ARBITRUM_ONE.chainId]: 'arlp' });
const catalogRun = (id: string) => Object.values(CATALOG_RUN_PREFIX).some(prefix => id.startsWith(prefix + '-'));
const runChainMatches = (id: string, chainId: number) => catalogRun(id) ? id.startsWith(`${CATALOG_RUN_PREFIX[chainId]}-`) : !uniswapCatalogDeployment(chainId);

function fail(code: string): never { throw new Error(code); }
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function hex(value: unknown): string { if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) fail('UNISWAP_RPC_INVALID'); return value.toLowerCase(); }
function quantity(value: unknown): bigint { const h = hex(value); if (h === '0x') fail('UNISWAP_RPC_INVALID'); return BigInt(h); }
function address(value: unknown): string { if (typeof value !== 'string' || !ADDRESS.test(value.toLowerCase())) fail('UNISWAP_ADDRESS_INVALID'); return value.toLowerCase(); }
const tag = (n: number | bigint) => '0x' + n.toString(16);
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addrWord = (a: string) => a.slice(2).padStart(64, '0');
function wordAt(data: string, index: number): bigint {
  if (!/^0x[0-9a-f]*$/.test(data) || data.length < 66 + index * 64) fail('UNISWAP_RPC_INVALID');
  return BigInt('0x' + data.slice(2 + index * 64, 66 + index * 64));
}
function addressAt(data: string, index = 0): string { const v = wordAt(data, index); if (v >> 160n) fail('UNISWAP_RPC_INVALID'); return '0x' + v.toString(16).padStart(40, '0'); }
function int24At(data: string, index: number): number { const v = wordAt(data, index) & 0xffffffn; return Number(v >= 0x800000n ? v - 0x1000000n : v); }
function topicAddress(value: unknown): string {
  const raw = hex(value);
  if (!/^0x0{24}[0-9a-f]{40}$/.test(raw)) fail('UNISWAP_RECEIPT_INVALID');
  return '0x' + raw.slice(-40);
}
function sha256Hex(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
const digest = (value: unknown) => '0x' + sha256Hex(typeof value === 'string' ? value : canonical(value));
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(k => (value as Record<string, unknown>)[k] !== undefined)
    .map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
}
const explorerTx = (hash: string, profile: Pick<UniswapPoolProfile, 'explorer'> = BASE_PROFILE) => profile.explorer + 'tx/' + hash;
export const uniswapExplorerTx = explorerTx;
function rangeDescription(state: UniswapRangeState, token0 = 'USDC', token1 = 'WETH'): string {
  // Prices are token0 per token1 (USDC per WETH on the testnet profiles). tick < tickLower means that price is ABOVE the range.
  return state === 'IN_RANGE' ? `The current price is inside your range: the position holds ${token0} and ${token1} and earns fees while it stays in range.`
    : state === 'BELOW_RANGE' ? `The current price is above your range: the position would hold only ${token0} and earns no fees until the price falls into the range.`
      : `The current price is below your range: the position would hold only ${token1} and earns no fees until the price rises into the range.`;
}

type ChainState = { block: { number: number; hash: string; timestamp: number; baseFee: bigint }; codeSha256: Record<string, string>;
  sqrtPriceX96: bigint; tick: number; liquidity: bigint; balance0: bigint; balance1: bigint; native: bigint; allowance0: bigint; allowance1: bigint;
  nonce: bigint; pendingNonce: bigint; positionCount: bigint; stocks: StockQuoteState[] };
/** BUILD-RH-002: the official catalog assets of a Robinhood Chain pool's two tokens (fresh for every Review and begin). */
type PoolAssets = { readonly token0: CanonicalAsset; readonly token1: CanonicalAsset };
/** The economically material Stock Token state: a change of any of it needs a new Review. */
const stockEconomics = (stocks: readonly StockQuoteState[] | undefined) =>
  canonical((stocks ?? []).map(stock => [stock.officialId, stock.multiplierWad, stock.scheduledMultiplierWad, stock.scheduledEffectiveAt]));
type SimulatedCall = { step: UniswapLiquidityStep; gasUsed: bigint; returnData: string };

/** Append-only run history: identity, reviewed calls, hashes, terminal states and evidence never change. */
export function validateUniswapLiquidityLog(bytes: Uint8Array): void {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n') || bytes.length > 16_777_216) fail('UNISWAP_LIQUIDITY_STORE_CORRUPT');
  let prior: UniswapLiquidityRecord | null = null;
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  for (const line of text.trimEnd().split('\n')) {
    let run: UniswapLiquidityRecord;
    try { run = JSON.parse(line) as UniswapLiquidityRecord; } catch { fail('UNISWAP_LIQUIDITY_STORE_CORRUPT'); }
    if (!isObject(run) || run.format !== 'flofi.uniswap-liquidity-run.v1' || !UNISWAP_LIQUIDITY_RUN_ID.test(String(run.id)) ||
        !['PUBLIC_TESTNET', 'PUBLIC_MAINNET', 'MOCKED'].includes(run.provenance) || !ADDRESS.test(String(run.owner)) || !isObject(run.workflow) || !isObject(run.review) ||
        run.provenance === (catalogRun(run.id) ? 'PUBLIC_TESTNET' : 'PUBLIC_MAINNET') || !runChainMatches(run.id, run.review.chainId) ||
        run.review.owner !== run.owner || run.review.recipient !== run.owner || !profileOfReview(run.review) ||
        run.review.commitment !== reviewCommitment(run.review) || (run.authorization !== null && run.authorization !== run.review.commitment) ||
        !Array.isArray(run.attempts) || run.attempts.length > 16 || !['PENDING', 'RECONCILED', 'DIVERGENT'].includes(run.verdict) ||
        new Set(run.attempts.map(a => a.attemptId)).size !== run.attempts.length ||
        run.attempts.some(a => !isObject(a as unknown) || !a.attemptId.startsWith(run.id + '.') || a.tx.from !== run.owner || a.tx.chainId !== profileOfReview(run.review).chainHex ||
          (a.transactionHash !== null && !HASH.test(a.transactionHash)) || (a.replacementHash !== null && !HASH.test(a.replacementHash)) ||
          (a.reconciled && (a.state !== 'CONFIRMED' || a.transactionHash === null))) ||
        run.attempts.filter(a => ACTIVE.includes(a.state)).length > 1 ||
        run.attempts.filter(a => a.step === 'MINT' && a.state === 'CONFIRMED').length > 1 ||
        (run.verdict === 'RECONCILED') !== (run.evidence !== null) || (run.evidence !== null && run.position === null))
      fail('UNISWAP_LIQUIDITY_STORE_CORRUPT');
    if (prior) {
      if (run.id !== prior.id || run.owner !== prior.owner || run.provenance !== prior.provenance || run.review.chainId !== prior.review.chainId || !same(run.workflow, prior.workflow) ||
          run.attempts.length < prior.attempts.length || (prior.evidence && !same(run.evidence, prior.evidence)) ||
          (prior.position && !same(run.position, prior.position)) || (prior.verdict !== 'PENDING' && run.verdict !== prior.verdict))
        fail('UNISWAP_LIQUIDITY_STORE_CORRUPT');
      for (const [index, before] of prior.attempts.entries()) {
        const after = run.attempts[index]!;
        if (after.attemptId !== before.attemptId || after.step !== before.step || after.nonce !== before.nonce || !same(after.tx, before.tx) ||
            after.reviewCommitment !== before.reviewCommitment || after.preparedAtBlock !== before.preparedAtBlock ||
            after.positionsBefore !== before.positionsBefore || (before.transactionHash !== null && after.transactionHash !== before.transactionHash) ||
            (before.replacementHash !== null && after.replacementHash !== before.replacementHash) ||
            (TERMINAL.includes(before.state) && (after.state !== before.state || !same(after.receipt, before.receipt))))
          fail('UNISWAP_LIQUIDITY_STORE_CORRUPT');
      }
    }
    prior = run;
  }
}
export function reviewCommitment(review: UniswapLiquidityReview): string {
  const rest: Record<string, unknown> = { ...review };
  delete rest.commitment;
  return digest(rest);
}
/** The step and attempt state a projection or worker sees for a run. */
export function uniswapNeedsObservation(value: unknown): boolean {
  const record = value as UniswapLiquidityRecord, last = record.attempts.at(-1);
  return record.verdict === 'PENDING' && !!last && UNISWAP_OBSERVABLE.includes(last.state);
}

/**
 * `rpc` is the Base Sepolia read client; `rpcs` adds one chain-bound read client per further liquidity profile (CAIP-2 keyed).
 * BUILD-RH-002: with `catalog`, the service is one catalog network's liquidity runtime — Robinhood Chain by default (only chain 4663,
 * `rhlp-` runs), or BUILD-BASE-001 Base (`catalog.chain` 8453, `balp-` runs): pools come from the node's pair and fee tier, and both tokens
 * must resolve in that network's freshly validated catalog. Without it, only the testnet profiles.
 */
export function createUniswapLiquidityService(input: { readonly storage: ExecutionStorage; readonly rpc: Rpc; readonly rpcs?: Readonly<Partial<Record<string, Rpc>>>;
  readonly provenance: UniswapProvenance; readonly executionEnabled?: boolean; readonly now?: () => Date;
  /** MOCKED harness only: the synthetic chain's code pins. A public run always uses the profile's verified pins. */
  readonly mockedCodePins?: Readonly<Record<'factory' | 'positionManager' | 'pool', string>>;
  readonly catalog?: { readonly catalogFor: (chain: string) => Promise<AssetCatalog>;
    /** The catalog network this instance serves (default Robinhood Chain). */ readonly chain?: string;
    /** MOCKED harness only: synthetic code pins of the catalog's base assets and Stock Token proxy. */
    readonly codePins?: Partial<Record<string, string>> } }) {
  const { provenance } = input, { log, leases } = input.storage;
  if ((input.mockedCodePins || input.catalog?.codePins) && provenance !== 'MOCKED') fail('UNISWAP_CODE_PINS_MOCKED_ONLY');
  // A Robinhood Chain service is never labelled as a testnet, and a testnet service never as mainnet.
  if (provenance === (input.catalog ? 'PUBLIC_TESTNET' : 'PUBLIC_MAINNET')) fail('UNISWAP_PROVENANCE_INVALID');
  const servedChain = input.catalog?.chain ?? ROBINHOOD.chain, served = input.catalog ? swapProfile(servedChain) : null;
  if (input.catalog && (served?.kind !== 'CATALOG' || !uniswapCatalogDeployment(servedChain))) fail('UNISWAP_LIQUIDITY_NETWORK_UNSUPPORTED');
  const idPrefix = input.catalog ? CATALOG_RUN_PREFIX[served!.chainId]! : 'unilp';
  // The on-chain token policy of the served catalog network (pinned base assets; Stock Tokens on Robinhood Chain; listed tokens on Base).
  const tokenPolicy = input.catalog ? catalogTokenPolicy(served as CatalogSwapProfile, input.catalog.codePins) : null;
  const now = input.now ?? (() => new Date());
  const executionEnabled = input.executionEnabled !== false;
  const runName = (id: string) => { if (!UNISWAP_LIQUIDITY_RUN_ID.test(id) || !id.startsWith(idPrefix + '-')) fail('UNISWAP_LIQUIDITY_RUN_ID_INVALID'); return id + '.jsonl'; };
  async function load(id: string): Promise<UniswapLiquidityRecord> {
    const bytes = await log.read(runName(id));
    if (!bytes) fail('UNISWAP_LIQUIDITY_RUN_NOT_FOUND');
    try { validateUniswapLiquidityLog(bytes); } catch { fail('UNISWAP_LIQUIDITY_STORE_CORRUPT'); }
    const record = JSON.parse(utf8(bytes).trimEnd().split('\n').at(-1)!) as UniswapLiquidityRecord;
    if (record.id !== id || record.provenance !== provenance) fail('UNISWAP_LIQUIDITY_STORE_CORRUPT');
    return record;
  }
  async function save(record: UniswapLiquidityRecord): Promise<UniswapLiquidityRecord> {
    const name = runName(record.id), prior = await log.read(name);
    await log.extend(name, new TextEncoder().encode(utf8(prior) + JSON.stringify(record) + '\n'), validateUniswapLiquidityLog);
    return record;
  }
  const locked = <T,>(id: string, action: () => Promise<T>): Promise<T> => leases.hold(runName(id).slice(0, -6), action);

  const sameWorkflow = (a: SemanticWorkflow, b: SemanticWorkflow) => canonical(a) === canonical(b);
  const active = (record: UniswapLiquidityRecord) => record.attempts.find(a => ACTIVE.includes(a.state)) ?? null;
  function replaceAttempt(record: UniswapLiquidityRecord, attempt: UniswapAttempt): UniswapLiquidityRecord {
    return { ...record, attempts: record.attempts.map(a => a.attemptId === attempt.attemptId ? attempt : a) };
  }
  /** Every chain-specific helper of one profile, bound to that profile's own read client. */
  function bind(profile: UniswapPoolProfile, rpc: Rpc) {
  const pins = input.mockedCodePins ?? profile.codeSha256;
  const t0 = profile.token0, t1 = profile.token1, catalogPool = uniswapCatalogDeployment(profile.chainId) !== null;
  const nitro = profile.chain === ARBITRUM_ONE.chain;
  const view = (token: UniswapPoolProfile['token0'], asset: CanonicalAsset | undefined): UniswapTokenView =>
    ({ symbol: token.symbol, address: token.address, decimals: token.decimals, ...catalogPool ? { officialId: asset?.stock?.officialId ?? null } : {} });
  async function ethCall(to: string, data: string, at: string): Promise<string> { return hex(await rpc('eth_call', [{ to, data }, at])); }
  async function head() {
    if (quantity(await rpc('eth_chainId', [])) !== BigInt(profile.chainId)) fail('UNISWAP_WRONG_CHAIN');
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    if (!isObject(block)) fail('UNISWAP_RPC_INVALID');
    const number = Number(quantity(block.number)), hash = hex(block.hash), timestamp = Number(quantity(block.timestamp));
    const baseFee = block.baseFeePerGas === undefined ? 0n : quantity(block.baseFeePerGas);
    if (!Number.isSafeInteger(number) || !HASH.test(hash)) fail('UNISWAP_RPC_INVALID');
    return { number, hash, timestamp, baseFee };
  }
  /** Every read at one block; identities and code are verified before any economic value is used. */
  async function readState(owner: string, assets: PoolAssets | null): Promise<ChainState> {
    if (catalogPool !== Boolean(assets)) fail('ASSET_CATALOG_UNAVAILABLE');
    const block = await head(), at = tag(block.number);
    const age = now().getTime() - block.timestamp * 1000;
    if (age > 120_000 || age < -30_000) fail('UNISWAP_STALE_CHAIN_HEAD');
    const codeSha256: Record<string, string> = {};
    for (const [name, target] of [['factory', profile.factory], ['positionManager', profile.positionManager], ['pool', profile.pool],
      ['token0', t0.address], ['token1', t1.address]] as const) {
      const code = hex(await rpc('eth_getCode', [target, at]));
      if (code.length <= 2) fail('UNISWAP_CONTRACT_CODE_MISSING');
      codeSha256[name] = sha256Hex(Buffer.from(code.slice(2), 'hex'));
    }
    // A pool without its own pin (Robinhood Chain) is proven by its CREATE2 address from the pinned factory, confirmed by getPool below.
    if (codeSha256.factory !== pins.factory || codeSha256.positionManager !== pins.positionManager || (pins.pool !== null && codeSha256.pool !== pins.pool))
      fail('UNISWAP_UNEXPECTED_CONTRACT');
    if (addressAt(await ethCall(profile.positionManager, SEL.factory, at)) !== profile.factory ||
        addressAt(await ethCall(profile.positionManager, SEL.weth9, at)) !== (profile.weth ?? t1.address)) fail('UNISWAP_DEPLOYMENT_MISMATCH');
    if (int24At(await ethCall(profile.factory, SEL.feeAmountTickSpacing + word(BigInt(profile.feeTier)), at), 0) !== profile.tickSpacing)
      fail('UNISWAP_FEE_TIER_UNSUPPORTED');
    if (addressAt(await ethCall(profile.factory, SEL.getPool + addrWord(t0.address) + addrWord(t1.address) + word(BigInt(profile.feeTier)), at)) !== profile.pool)
      fail('UNISWAP_POOL_MISMATCH');
    if (addressAt(await ethCall(profile.pool, SEL.factory, at)) !== profile.factory ||
        addressAt(await ethCall(profile.pool, SEL.token0, at)) !== t0.address || addressAt(await ethCall(profile.pool, SEL.token1, at)) !== t1.address ||
        wordAt(await ethCall(profile.pool, SEL.fee, at), 0) !== BigInt(profile.feeTier) || int24At(await ethCall(profile.pool, SEL.tickSpacing, at), 0) !== profile.tickSpacing)
      fail('UNISWAP_POOL_MISMATCH');
    if (wordAt(await ethCall(t0.address, SEL.decimals, at), 0) !== BigInt(t0.decimals) || wordAt(await ethCall(t1.address, SEL.decimals, at), 0) !== BigInt(t1.decimals))
      fail('UNISWAP_TOKEN_MISMATCH');
    // BUILD-RH-002: both tokens are catalog assets, verified on chain (pinned base assets; Stock Tokens by beacon, uid and multiplier;
    // BUILD-BASE-001 listed Base tokens by code and decimals()).
    const stocks: StockQuoteState[] = [];
    if (assets) for (const [side, asset] of [['token0', assets.token0], ['token1', assets.token1]] as const) {
      const stock = await verifyCatalogToken(rpc, tokenPolicy ?? fail('ASSET_CATALOG_UNAVAILABLE'), asset, side, at, block.timestamp, profile.reviewTtlSeconds, now);
      if (stock) stocks.push(stock);
    }
    const slot0 = await ethCall(profile.pool, SEL.slot0, at);
    const sqrtPriceX96 = wordAt(slot0, 0), tick = int24At(slot0, 1);
    if (wordAt(slot0, 6) !== 1n) fail('UNISWAP_POOL_LOCKED');
    if (sqrtPriceX96 <= 4_295_128_739n || sqrtPriceX96 >= 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n ||
        tick < -887_272 || tick > 887_272) fail('UNISWAP_POOL_UNINITIALIZED');
    const liquidity = wordAt(await ethCall(profile.pool, SEL.liquidity, at), 0);
    const balance = async (token: string) => wordAt(await ethCall(token, SEL.balanceOf + addrWord(owner), at), 0);
    const allowance = async (token: string) => wordAt(await ethCall(token, SEL.allowance + addrWord(owner) + addrWord(profile.positionManager), at), 0);
    const [balance0, balance1, allowance0, allowance1, native, nonce, pendingNonce, positionCount] = await Promise.all([
      balance(t0.address), balance(t1.address), allowance(t0.address), allowance(t1.address), rpc('eth_getBalance', [owner, at]).then(quantity),
      rpc('eth_getTransactionCount', [owner, at]).then(quantity), rpc('eth_getTransactionCount', [owner, 'pending']).then(quantity),
      ethCall(profile.positionManager, SEL.balanceOf + addrWord(owner), at).then(data => wordAt(data, 0)),
    ]);
    const again = await rpc('eth_getBlockByNumber', [at, false]);
    if (!isObject(again) || hex(again.hash) !== block.hash) fail('UNISWAP_BLOCK_REORG');
    return { block, codeSha256, sqrtPriceX96, tick, liquidity, balance0, balance1, native, allowance0, allowance1, nonce, pendingNonce, positionCount, stocks };
  }
  /** Real public-network simulation of the exact call sequence, sequentially, from the owner, at the observed block. */
  async function simulateCalls(owner: string, calls: readonly { step: UniswapLiquidityStep; to: string; data: string }[], at: number): Promise<SimulatedCall[]> {
    let result: unknown;
    try {
      result = await rpc('eth_simulateV1', [{ blockStateCalls: [{ calls: calls.map(c => ({ from: owner, to: c.to, data: c.data, value: '0x0' })) }],
        validation: false, traceTransfers: false }, tag(at)]);
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'PUBLIC_RPC_METHOD_DENIED') throw cause;
      fail('UNISWAP_SIMULATION_UNAVAILABLE');
    }
    const blocks = Array.isArray(result) ? result : null, outputs = blocks && isObject(blocks[0]) && Array.isArray(blocks[0].calls) ? blocks[0].calls : null;
    if (!outputs || blocks!.length !== 1 || outputs.length !== calls.length) fail('UNISWAP_SIMULATION_INVALID');
    return calls.map((call, index) => {
      const output = outputs[index];
      if (!isObject(output)) fail('UNISWAP_SIMULATION_INVALID');
      if (quantity(output.status) !== 1n) fail(call.step === 'MINT' ? 'UNISWAP_SIMULATION_MINT_REVERTED' : 'UNISWAP_SIMULATION_APPROVAL_REVERTED');
      return { step: call.step, gasUsed: quantity(output.gasUsed), returnData: hex(output.returnData) };
    });
  }
  async function l1FeeUpperBound(dataBytes: number, at: string): Promise<bigint | null> {
    // Ethereum L1 has no separate data fee; an OP Stack chain reads its GasPriceOracle upper bound.
    if (profile.gasPriceOracle === null) return 0n;
    try { return wordAt(await ethCall(profile.gasPriceOracle, SEL.l1FeeUpperBound + word(BigInt(dataBytes + 120)), at), 0); } catch { return null; }
  }
  /** Exact executable step: current estimates must fit the frozen Review envelope, including OP fees where applicable. */
  async function assertRequestFees(review: UniswapLiquidityReview, tx: UniswapTx, at: string): Promise<void> {
    if (quantity(await rpc('eth_chainId', [])) !== BigInt(profile.chainId)) fail('UNISWAP_WRONG_CHAIN');
    const call = review.calls.find(c => c.to === tx.to && c.data === tx.data);
    if (!call || tx.chainId !== profile.chainHex || tx.from !== review.owner || tx.value !== '0x0' ||
        quantity(tx.gas) !== BigInt(call.gasLimit) || quantity(tx.maxFeePerGas) !== BigInt(review.fees.maxFeePerGas) ||
        quantity(tx.maxPriorityFeePerGas) !== BigInt(review.fees.maxPriorityFeePerGas)) fail('UNISWAP_REVIEW_CHANGED');
    const block = await rpc('eth_getBlockByNumber', [at, false]);
    if (!isObject(block)) fail('UNISWAP_RPC_INVALID');
    const price = nitro ? quantity(await rpc('eth_gasPrice', [])) : quantity(block.baseFeePerGas) + quantity(tx.maxPriorityFeePerGas);
    if (price <= 0n || price > quantity(tx.maxFeePerGas)) fail('UNISWAP_FEES_CHANGED_REVIEW_REQUIRED');
    const estimate = quantity(await rpc('eth_estimateGas', [{ from: tx.from, to: tx.to, data: tx.data, value: tx.value }, at]));
    if (estimate <= 0n || estimate > quantity(tx.gas)) fail('UNISWAP_GAS_CHANGED_REVIEW_REQUIRED');
    const l1 = await l1FeeUpperBound((tx.data.length - 2) / 2, at), bound = call.l1FeeUpperBoundWei === undefined ? review.fees.l1FeeUpperBoundWei : call.l1FeeUpperBoundWei;
    if (l1 === null || bound === null || l1 > BigInt(bound)) fail('UNISWAP_L1_FEES_CHANGED_REVIEW_REQUIRED');
    if (quantity(await rpc('eth_getBalance', [tx.from, at])) < quantity(tx.gas) * quantity(tx.maxFeePerGas) + l1) fail('UNISWAP_INSUFFICIENT_GAS_ETH');
  }
  function assertMintBounds(review: UniswapLiquidityReview, state: ChainState, fresh: readonly SimulatedCall[]): void {
    const minted = decodeUniswapMintResult(fresh.at(-1)!.returnData);
    const drift = (a: bigint, b: bigint) => (a > b ? a - b : b - a) * 20_000n > b * BigInt(review.intent.slippageBps);
    if (canonical(state.codeSha256) !== canonical(review.contracts.codeSha256) ||
        stockEconomics(state.stocks) !== stockEconomics(review.stocks) ||
        uniswapRangeState(state.tick, review.range.tickLower, review.range.tickUpper) !== review.range.state ||
        drift(minted.amount0, BigInt(review.expected.amount0)) || drift(minted.amount1, BigInt(review.expected.amount1)) ||
        drift(minted.liquidity, BigInt(review.expected.liquidity))) fail('UNISWAP_STATE_CHANGED_REVIEW_REQUIRED');
  }
  function intentOf(workflow: SemanticWorkflow) {
    const checked = validateAuthoringWorkflow(workflow, createBaseSepoliaReviewContext()) as SemanticWorkflow;
    const fields = validateUniswapLiquidityWorkflow(checked);
    const capability = resolveWorkflowCapability(checked, { environment: profile.environment ?? 'PUBLIC_TESTNET' });
    if (!capability.executionSupported || capability.nodes.find(n => n.nodeId === fields.nodeId)?.adapterId !== 'uniswap.v3') fail('UNISWAP_CAPABILITY_UNAVAILABLE');
    return fields;
  }
  /** Fresh state, exact approvals, two-pass simulation (expected amounts → minimums → exact reviewed mint), fees, commitment. */
  async function buildReview(workflow: SemanticWorkflow, owner: string, assets: PoolAssets | null): Promise<UniswapLiquidityReview> {
    const f = intentOf(workflow);
    if (f.token0.address !== t0.address || f.token1.address !== t1.address || f.feeTier !== profile.feeTier) fail('UNISWAP_POOL_MISMATCH');
    // Depositing a Stock Token into a pool disposes of it: the registry must allow that for this token.
    for (const [asset, amount] of [[assets?.token0, f.amount0Max], [assets?.token1, f.amount1Max]] as const)
      if (asset?.stock && BigInt(amount) > 0n && !asset.stock.trading.disposable) fail('STOCK_TOKEN_NOT_DISPOSABLE');
    const state = await readState(owner, assets), at = tag(state.block.number);
    const TOKEN0 = view(t0, assets?.token0), TOKEN1 = view(t1, assets?.token1);
    const amount0Max = BigInt(f.amount0Max), amount1Max = BigInt(f.amount1Max);
    let local: ReturnType<typeof uniswapComposition>;
    try { local = uniswapComposition(state.sqrtPriceX96, state.tick, f.tickLower, f.tickUpper, amount0Max, amount1Max); }
    catch { return fail('UNISWAP_LIQUIDITY_ZERO'); }
    const insufficient = (symbol: string) => symbol === 'USDC' || symbol === 'WETH' ? `UNISWAP_INSUFFICIENT_${symbol}` : 'UNISWAP_INSUFFICIENT_TOKEN';
    if (state.balance0 < local.amount0) fail(insufficient(t0.symbol));
    if (state.balance1 < local.amount1) fail(insufficient(t1.symbol));
    const approvals = ([['APPROVE_TOKEN0', TOKEN0, amount0Max, state.allowance0], ['APPROVE_TOKEN1', TOKEN1, amount1Max, state.allowance1]] as const)
      .filter(([, , amount]) => amount > 0n)
      .map(([step, token, amount, current]) => ({ step, token: token.address, symbol: token.symbol, spender: profile.positionManager,
        amount: amount.toString(), currentAllowance: current.toString(), required: current < amount }));
    const approvalCalls = approvals.filter(a => a.required).map(a => ({ step: a.step as UniswapLiquidityStep, to: a.token,
      data: encodeUniswapApprove(profile.positionManager, BigInt(a.amount)) }));
    const deadline = BigInt(state.block.timestamp + profile.mintDeadlineSeconds);
    const mintData = (min0: bigint, min1: bigint) => encodeUniswapMint({ token0: t0.address, token1: t1.address, fee: profile.feeTier,
      tickLower: f.tickLower, tickUpper: f.tickUpper, amount0Desired: amount0Max, amount1Desired: amount1Max, amount0Min: min0, amount1Min: min1,
      recipient: owner, deadline });
    const probe = await simulateCalls(owner, [...approvalCalls, { step: 'MINT', to: profile.positionManager, data: mintData(0n, 0n) }], state.block.number);
    const first = decodeUniswapMintResult(probe.at(-1)!.returnData);
    const min0 = uniswapMinimum(first.amount0, f.slippageBps!), min1 = uniswapMinimum(first.amount1, f.slippageBps!);
    const calls = [...approvalCalls, { step: 'MINT' as const, to: profile.positionManager, data: mintData(min0, min1) }];
    const simulated = await simulateCalls(owner, calls, state.block.number);
    const minted = decodeUniswapMintResult(simulated.at(-1)!.returnData);
    // Independent cross-check of the public simulation (tolerance covers the independent sqrt-ratio rounding only).
    const close = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= b / 1_000_000n + 2n;
    if (!close(minted.liquidity, local.liquidity) || !close(minted.amount0, local.amount0) || !close(minted.amount1, local.amount1) ||
        minted.amount0 > amount0Max || minted.amount1 > amount1Max || minted.amount0 < min0 || minted.amount1 < min1) fail('UNISWAP_SIMULATION_DIVERGENT');
    const state0 = uniswapRangeState(state.tick, f.tickLower, f.tickUpper);
    if (state0 === 'BELOW_RANGE' && minted.amount1 !== 0n || state0 === 'ABOVE_RANGE' && minted.amount0 !== 0n) fail('UNISWAP_SIMULATION_DIVERGENT');
    const priority = nitro ? 0n : quantity(await rpc('eth_maxPriorityFeePerGas', []));
    const price = nitro ? quantity(await rpc('eth_gasPrice', [])) : state.block.baseFee;
    if (nitro && (price <= 0n || price >= 1n << 128n)) fail('UNISWAP_FEE_INVALID');
    const maxFeePerGas = nitro ? nitroMaxFeePerGas(price) : price * 2n + priority;
    const reviewCalls: UniswapReviewCall[] = await Promise.all(calls.map(async (call, index) => {
      const gas = simulated[index]!.gasUsed;
      if (gas <= 0n || gas > 30_000_000n) fail('UNISWAP_FEE_INVALID');
      const gasLimit = nitro ? nitroGasLimit(gas + await nitroPostingGas(rpc, owner, call, at, 'UNISWAP_NITRO_FEE_UNAVAILABLE')) : gas * 13n / 10n + 25_000n;
      return { ...call, gasUsed: gas.toString(), gasLimit: gasLimit.toString(),
        l1FeeUpperBoundWei: (await l1FeeUpperBound((call.data.length - 2) / 2, at))?.toString() ?? null };
    }));
    const gasLimitTotal = reviewCalls.reduce((sum, c) => sum + BigInt(c.gasLimit), 0n);
    const l1Fees = reviewCalls.map(c => c.l1FeeUpperBoundWei === null ? null : BigInt(c.l1FeeUpperBoundWei!));
    const l1Total = l1Fees.every(v => v !== null) ? l1Fees.reduce((sum, v) => sum + v!, 0n) : null;
    const execution = gasLimitTotal * maxFeePerGas;
    if (state.native < execution + (l1Total ?? 0n)) fail('UNISWAP_INSUFFICIENT_GAS_ETH');
    const observed = now();
    const review: Omit<UniswapLiquidityReview, 'commitment'> = {
      format: 'flofi.uniswap-liquidity-review.v1', network: profile.network, chainId: profile.chainId, owner, recipient: owner,
      workflowHash: hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow))), revision: workflow.revision, nodeId: f.nodeId,
      observedAt: observed.toISOString(), expiresAt: new Date(observed.getTime() + profile.reviewTtlSeconds * 1000).toISOString(),
      block: { number: state.block.number, hash: state.block.hash, timestamp: state.block.timestamp },
      contracts: { factory: profile.factory, positionManager: profile.positionManager, pool: profile.pool, codeSha256: state.codeSha256 },
      token0: TOKEN0, token1: TOKEN1,
      pool: { fee: profile.feeTier, tickSpacing: profile.tickSpacing, sqrtPriceX96: state.sqrtPriceX96.toString(), tick: state.tick, liquidity: state.liquidity.toString(),
        price: uniswapQuotePriceAtSqrt(state.sqrtPriceX96, t0.decimals, t1.decimals) },
      range: { tickLower: f.tickLower, tickUpper: f.tickUpper, lowerPrice: uniswapQuotePriceAtTick(f.tickUpper, t0.decimals, t1.decimals),
        upperPrice: uniswapQuotePriceAtTick(f.tickLower, t0.decimals, t1.decimals), state: state0, description: rangeDescription(state0, t0.symbol, t1.symbol) },
      intent: { amount0Max: f.amount0Max, amount1Max: f.amount1Max, slippageBps: f.slippageBps! },
      expected: { liquidity: minted.liquidity.toString(), amount0: minted.amount0.toString(), amount1: minted.amount1.toString() },
      minimums: { amount0Min: min0.toString(), amount1Min: min1.toString() }, deadline: deadline.toString(),
      balances: { token0: state.balance0.toString(), token1: state.balance1.toString(), native: state.native.toString() },
      allowances: { token0: state.allowance0.toString(), token1: state.allowance1.toString() },
      approvals, calls: reviewCalls,
      fees: { maxFeePerGas: maxFeePerGas.toString(), maxPriorityFeePerGas: priority.toString(), gasLimitTotal: gasLimitTotal.toString(),
        executionFeeUpperBoundWei: execution.toString(), l1FeeUpperBoundWei: l1Total?.toString() ?? null,
        totalUpperBoundWei: l1Total === null ? null : (execution + l1Total).toString() },
      simulation: { method: 'eth_simulateV1', block: state.block.number, calls: simulated.map(s => ({ step: s.step, gasUsed: s.gasUsed.toString() })),
        mint: { liquidity: minted.liquidity.toString(), amount0: minted.amount0.toString(), amount1: minted.amount1.toString() },
        localEstimate: { liquidity: local.liquidity.toString(), amount0: local.amount0.toString(), amount1: local.amount1.toString() } },
      nonce: state.nonce.toString(),
      ...assets ? { stocks: state.stocks } : {},
    };
    return { ...review, commitment: reviewCommitment(review as UniswapLiquidityReview) };
  }

  /** Owner + nonce is a global economic identity: while an attempt holding it is active, no other attempt may prepare it. */
  async function reserveNonce(record: UniswapLiquidityRecord, attemptId: string, nonce: bigint): Promise<void> {
    // Owner nonces are per chain: Base Sepolia keeps its original names; any other chain is qualified by its CAIP-2 id.
    const key = profile.chain === BASE_PROFILE.chain ? `${record.owner}-${nonce}` : `${profile.chain.replace(':', '-')}-${record.owner}-${nonce}`, name = key + '.unilp-intent';
    await leases.hold(key, async () => {
      const entry = JSON.stringify({ runId: record.id, attemptId }) + '\n';
      const existing = await log.read(name);
      if (existing === null) { if (!await log.create(name, new TextEncoder().encode(entry))) fail('UNISWAP_OWNER_NONCE_IN_USE'); return; }
      const prior = JSON.parse(utf8(existing).trimEnd().split('\n').at(-1)!) as { runId: string; attemptId: string };
      const holder = prior.runId === record.id ? record : await load(prior.runId);
      const attempt = holder.attempts.find(a => a.attemptId === prior.attemptId);
      // Only an attempt that may still be signed, broadcast or land holds the nonce. A terminal holder cannot execute
      // again: CANCELLED was never broadcast, NOT_FOUND can no longer execute, and CONFIRMED / REVERTED /
      // RECONCILIATION_REQUIRED are already included. A MetaMask delegated redemption is sent by a relayer, so the
      // owner's nonce is unchanged after it and the run's next step legitimately prepares on the same nonce.
      if (!attempt || ACTIVE.includes(attempt.state)) fail('UNISWAP_OWNER_NONCE_IN_USE');
      await log.extend(name, new TextEncoder().encode(utf8(existing) + entry), () => undefined);
    });
  }
  /** Binary search on the owner's monotonic nonce finds the including block; the transaction there is compared to the attempt. */
  async function discoverByNonce(attempt: UniswapAttempt): Promise<{ consumed: false } | { consumed: true; tx: Record<string, unknown> }> {
    const owner = attempt.tx.from, nonce = BigInt(attempt.nonce);
    const count = async (block: number | 'latest') => quantity(await rpc('eth_getTransactionCount', [owner, block === 'latest' ? 'latest' : tag(block)]));
    const latest = Number(quantity(await rpc('eth_blockNumber', [])));
    if (!Number.isSafeInteger(latest) || latest < attempt.preparedAtBlock) fail('UNISWAP_RPC_INVALID');
    if (await count(latest) <= nonce) return { consumed: false };
    if (await count(attempt.preparedAtBlock) > nonce) fail('UNISWAP_NONCE_CONSUMED_BEFORE_PREPARATION');
    let low = attempt.preparedAtBlock, high = latest;
    while (high - low > 1) { const middle = low + Math.floor((high - low) / 2); if (await count(middle) > nonce) high = middle; else low = middle; }
    const block = await rpc('eth_getBlockByNumber', [tag(high), true]);
    if (!isObject(block) || !Array.isArray(block.transactions)) fail('UNISWAP_RPC_INVALID');
    const found = block.transactions.find(tx => isObject(tx) && typeof tx.from === 'string' && tx.from.toLowerCase() === owner && quantity(tx.nonce) === nonce);
    if (!isObject(found)) fail('UNISWAP_DISCOVERY_INCONSISTENT');
    return { consumed: true, tx: found };
  }
  const sameIntent = (attempt: UniswapAttempt, tx: Record<string, unknown>) => typeof tx.to === 'string' && tx.to.toLowerCase() === attempt.tx.to &&
    typeof tx.input === 'string' && tx.input.toLowerCase() === attempt.tx.data && quantity(tx.value) === 0n && quantity(tx.chainId) === BigInt(profile.chainId);

  async function reconcileApproval(record: UniswapLiquidityRecord, attempt: UniswapAttempt, raw: Record<string, unknown>, blockNumber: number): Promise<void> {
    const { spender, amount } = decodeUniswapApprove(attempt.tx.data);
    if (spender !== profile.positionManager) fail('UNISWAP_APPROVAL_MISMATCH');
    const logs = Array.isArray(raw.logs) ? raw.logs.filter(isObject) : fail('UNISWAP_RECEIPT_INVALID');
    const approvals = logs.filter(l => address(l.address) === attempt.tx.to && Array.isArray(l.topics) && l.topics[0] === TOPIC.approval);
    if (approvals.length !== 1) fail('UNISWAP_APPROVAL_MISMATCH');
    const topics = approvals[0]!.topics as unknown[];
    if (topicAddress(topics[1]) !== record.owner || topicAddress(topics[2]) !== profile.positionManager || quantity(approvals[0]!.data) !== amount)
      fail('UNISWAP_APPROVAL_MISMATCH');
    const observed = wordAt(await ethCall(attempt.tx.to, SEL.allowance + addrWord(record.owner) + addrWord(profile.positionManager), tag(blockNumber)), 0);
    if (observed !== amount) fail('UNISWAP_APPROVAL_NOT_EFFECTIVE');
  }
  async function reconcileMint(record: UniswapLiquidityRecord, attempt: UniswapAttempt, raw: Record<string, unknown>, blockNumber: number, hash: string): Promise<UniswapPosition> {
    const params = decodeUniswapMint(attempt.tx.data);
    if (params.recipient !== record.owner || params.token0 !== t0.address || params.token1 !== t1.address || params.fee !== profile.feeTier) fail('UNISWAP_MINT_MISMATCH');
    const logs = Array.isArray(raw.logs) ? raw.logs.filter(isObject) : fail('UNISWAP_RECEIPT_INVALID');
    const of = (target: string, topic: string) => logs.filter(l => address(l.address) === target && Array.isArray(l.topics) && l.topics[0] === topic);
    const nft = of(profile.positionManager, TOPIC.transfer), increase = of(profile.positionManager, TOPIC.increaseLiquidity), poolMint = of(profile.pool, TOPIC.poolMint);
    if (nft.length !== 1 || increase.length !== 1 || poolMint.length !== 1) fail('UNISWAP_MINT_MISMATCH');
    const nftTopics = nft[0]!.topics as unknown[], incTopics = increase[0]!.topics as unknown[], poolTopics = poolMint[0]!.topics as unknown[];
    if (nftTopics.length !== 4 || quantity(nftTopics[1]) !== 0n || topicAddress(nftTopics[2]) !== record.owner) fail('UNISWAP_POSITION_RECIPIENT_MISMATCH');
    const tokenId = quantity(nftTopics[3]);
    const incData = hex(increase[0]!.data);
    if (quantity(incTopics[1]) !== tokenId) fail('UNISWAP_MINT_MISMATCH');
    const liquidity = wordAt(incData, 0), amount0 = wordAt(incData, 1), amount1 = wordAt(incData, 2);
    const poolData = hex(poolMint[0]!.data);
    if (topicAddress(poolTopics[1]) !== profile.positionManager || int24At(hex(poolTopics[2]), 0) !== params.tickLower || int24At(hex(poolTopics[3]), 0) !== params.tickUpper ||
        addressAt(poolData, 0) !== profile.positionManager || wordAt(poolData, 1) !== liquidity || wordAt(poolData, 2) !== amount0 || wordAt(poolData, 3) !== amount1)
      fail('UNISWAP_MINT_MISMATCH');
    if (liquidity === 0n || amount0 < params.amount0Min || amount1 < params.amount1Min || amount0 > params.amount0Desired || amount1 > params.amount1Desired)
      fail('UNISWAP_MINT_BOUNDS_VIOLATED');
    for (const [token, amount] of [[t0.address, amount0], [t1.address, amount1]] as const) {
      const transfers = of(token, TOPIC.transfer).filter(l => topicAddress((l.topics as unknown[])[1]) === record.owner);
      if (amount === 0n ? transfers.length !== 0 : transfers.length !== 1 || topicAddress((transfers[0]!.topics as unknown[])[2]) !== profile.pool ||
          quantity(transfers[0]!.data) !== amount) fail('UNISWAP_TOKEN_TRANSFER_MISMATCH');
    }
    const at = tag(blockNumber), before = tag(blockNumber - 1);
    if (addressAt(await ethCall(profile.positionManager, SEL.ownerOf + word(tokenId), at)) !== record.owner) fail('UNISWAP_POSITION_OWNER_MISMATCH');
    const position = decodeUniswapPosition(await ethCall(profile.positionManager, SEL.positions + word(tokenId), at));
    if (position.token0 !== t0.address || position.token1 !== t1.address || position.fee !== profile.feeTier || position.tickLower !== params.tickLower ||
        position.tickUpper !== params.tickUpper || position.liquidity !== liquidity) fail('UNISWAP_POSITION_MISMATCH');
    const balance = async (token: string, block: string) => wordAt(await ethCall(token, SEL.balanceOf + addrWord(record.owner), block), 0);
    const [b0, a0, b1, a1] = await Promise.all([balance(t0.address, before), balance(t0.address, at), balance(t1.address, before), balance(t1.address, at)]);
    if (b0 - a0 !== amount0 || b1 - a1 !== amount1) fail('UNISWAP_BALANCE_DELTA_MISMATCH');
    return { tokenId: tokenId.toString(), owner: record.owner, liquidity: liquidity.toString(), amount0: amount0.toString(), amount1: amount1.toString(),
      tickLower: params.tickLower, tickUpper: params.tickUpper, pool: profile.pool, blockNumber, transactionHash: hash };
  }
  /** Evidence is never stronger than the run's provenance: a MOCKED chain is MOCKED; only a public mainnet run is MAINNET_EXECUTED. */
  const evidenceClass = provenance === 'PUBLIC_TESTNET' ? 'TESTNET_EXECUTED' as const : provenance === 'PUBLIC_MAINNET' ? 'MAINNET_EXECUTED' as const : 'MOCKED' as const;
  async function buildEvidence(record: UniswapLiquidityRecord, position: UniswapPosition): Promise<UniswapEvidence> {
    const confirmed = record.attempts.filter(a => a.state === 'CONFIRMED' && a.receipt);
    const mintAttempt = confirmed.find(a => a.step === 'MINT')!;
    const at = tag(position.blockNumber);
    const [allowance0, allowance1, balance0, balance1] = await Promise.all([
      ethCall(t0.address, SEL.allowance + addrWord(record.owner) + addrWord(profile.positionManager), at).then(d => wordAt(d, 0)),
      ethCall(t1.address, SEL.allowance + addrWord(record.owner) + addrWord(profile.positionManager), at).then(d => wordAt(d, 0)),
      ethCall(t0.address, SEL.balanceOf + addrWord(record.owner), at).then(d => wordAt(d, 0)),
      ethCall(t1.address, SEL.balanceOf + addrWord(record.owner), at).then(d => wordAt(d, 0)),
    ]);
    const asset0 = { chainId: profile.chain, address: t0.address, decimals: t0.decimals }, asset1 = { chainId: profile.chain, address: t1.address, decimals: t1.decimals };
    const fees = confirmed.reduce((sum, a) => sum + BigInt(a.receipt!.gasCostWei), 0n);
    const reconciliation = { balances: [{ asset: asset0, amount: balance0.toString() }, { asset: asset1, amount: balance1.toString() }],
      allowances: [{ asset: asset0, amount: allowance0.toString() }, { asset: asset1, amount: allowance1.toString() }], debt: [],
      positions: [{ asset: { chainId: profile.chain, address: profile.positionManager, decimals: 0 }, amount: '1' }],
      fees: [{ asset: { chainId: profile.chain, nativeId: 'ETH', decimals: 18 }, amount: fees.toString() }],
      residualAssets: [{ asset: asset0, amount: balance0.toString() }, { asset: asset1, amount: balance1.toString() }],
      ownership: [{ chainId: profile.chain, address: record.owner }],
      limitations: [provenance === 'PUBLIC_TESTNET' ? 'PUBLIC_TESTNET_ONLY' : provenance === 'PUBLIC_MAINNET' ? 'OWNER_WALLET_MAINNET' : 'MOCKED_CHAIN_ONLY'] };
    const transactions = confirmed.map(a => ({ step: a.step, transactionHash: a.receipt!.transactionHash, blockNumber: a.receipt!.blockNumber, blockHash: a.receipt!.blockHash,
      status: a.receipt!.status, gasCostWei: a.receipt!.gasCostWei, submissionKind: a.receipt!.submissionKind, reviewCommitment: a.reviewCommitment,
      explorer: explorerTx(a.receipt!.transactionHash, profile) }));
    const bundle = validateArtifact('evidence-bundle', { schemaVersion: '1.0.0', evidenceBundleId: record.id + '.evidence', version: 1, supersedes: null,
      semanticWorkflowHash: record.review.workflowHash, artifactSetHash: digest(record.review), simulationHash: digest(record.review.simulation),
      policyHash: digest({ intent: record.review.intent, minimums: record.review.minimums, deadline: record.review.deadline, approvals: record.review.approvals }),
      manifestHash: mintAttempt.reviewCommitment, executionPlanHash: digest(confirmed.map(a => a.tx)), journalHeadHash: digest(record),
      observedAt: now().toISOString(), environment: evidenceClass, outcome: 'RECONCILED',
      receipts: confirmed.map(a => ({ receiptId: a.receipt!.transactionHash, contentHash: a.receipt!.contentHash })), differences: [], reconciliation,
      evidence: [{ evidenceId: 'position-readback', kind: 'EXTERNAL_REFERENCE', contentHash: digest(position) },
        { evidenceId: 'public-explorer', kind: 'EXTERNAL_REFERENCE', contentHash: digest(transactions.map(t => t.explorer).join('\n')) },
        { evidenceId: 'balance-reconciliation', kind: 'EXTERNAL_REFERENCE', contentHash: digest(reconciliation) }],
    }) as EvidenceBundle;
    const bundleHash = hashArtifactBytes('evidence-bundle', new TextEncoder().encode(JSON.stringify(bundle)));
    return { bundle, bundleHash, evidenceClass, network: profile.network, chainId: profile.chainId,
      owner: record.owner, positionManager: profile.positionManager, pool: profile.pool, token0: record.review.token0, token1: record.review.token1, feeTier: profile.feeTier,
      tickLower: position.tickLower, tickUpper: position.tickUpper, lowerPrice: record.review.range.lowerPrice, upperPrice: record.review.range.upperPrice,
      position, minimums: record.review.minimums, transactions, residualAllowances: { token0: allowance0.toString(), token1: allowance1.toString() },
      balancesAfter: { token0: balance0.toString(), token1: balance1.toString() }, reconciliation: 'RECONCILED', observedAt: now().toISOString() };
  }
  /** Receipt → reconciled effects. Wrong transaction or effects freeze the run for the owner's attention (never resend). */
  async function settle(record: UniswapLiquidityRecord, attempt: UniswapAttempt, hash: string, raw: Record<string, unknown>): Promise<UniswapLiquidityRecord> {
    const tx = await rpc('eth_getTransactionByHash', [hash]);
    let verified: Awaited<ReturnType<typeof verifyOwnerSubmission>>;
    try { verified = await verifyOwnerSubmission(rpc, { txHash: hash, account: record.owner, target: attempt.tx.to, data: attempt.tx.data, preBlock: attempt.preparedAtBlock }, tx, raw,
      profile.chainId, profile.gasPriceOracle !== null); }
    catch (cause) {
      // Receipt not yet canonical (a preconfirmed receipt with a zero block hash, or a block not sealed or reorganized):
      // stay PENDING and observation-only; nothing becomes evidence and nothing is resent.
      if (cause instanceof Error && cause.message === 'RECEIPT_NOT_CANONICAL') return save({ ...record, error: 'UNISWAP_RECEIPT_NOT_CANONICAL' });
      if (cause instanceof Error && /^(TRANSACTION_MISMATCH|RECEIPT_INVALID)$/.test(cause.message)) {
        return save(replaceAttempt({ ...record, verdict: 'DIVERGENT', authorization: null, error: 'UNISWAP_TRANSACTION_MISMATCH' },
          { ...attempt, state: 'RECONCILIATION_REQUIRED', note: 'UNISWAP_TRANSACTION_MISMATCH' }));
      }
      throw cause;
    }
    const execution = verified.gasUsed * verified.effectiveGasPrice;
    const receipt: UniswapReceipt = { transactionHash: hash, status: verified.status, blockNumber: verified.blockNumber, blockHash: hex(raw.blockHash),
      from: verified.txFrom, gasUsed: verified.gasUsed.toString(), effectiveGasPrice: verified.effectiveGasPrice.toString(), l1FeeWei: verified.l1Fee.toString(),
      gasCostWei: (execution + verified.l1Fee).toString(), submissionKind: verified.delegated ? 'DELEGATED_SINGLE' : 'DIRECT', contentHash: digest(raw) };
    const reviewedCall = record.review.calls.find(c => c.to === attempt.tx.to && c.data === attempt.tx.data);
    const l1Bound = reviewedCall?.l1FeeUpperBoundWei === undefined ? record.review.fees.l1FeeUpperBoundWei : reviewedCall.l1FeeUpperBoundWei;
    if (verified.direct && (!isObject(tx) || quantity(tx.nonce) !== BigInt(attempt.nonce) || quantity(tx.gas) > quantity(attempt.tx.gas) ||
        quantity(tx.maxFeePerGas ?? tx.gasPrice) > quantity(attempt.tx.maxFeePerGas) ||
        quantity(tx.maxPriorityFeePerGas ?? '0x0') > quantity(attempt.tx.maxPriorityFeePerGas) ||
        verified.gasUsed > quantity(attempt.tx.gas) || verified.effectiveGasPrice > quantity(attempt.tx.maxFeePerGas) ||
        l1Bound === null || verified.l1Fee > BigInt(l1Bound))) {
      return save(replaceAttempt({ ...record, verdict: 'DIVERGENT', authorization: null, error: 'UNISWAP_RECEIPT_BOUNDS_VIOLATED' },
        { ...attempt, state: 'RECONCILIATION_REQUIRED', receipt, note: 'UNISWAP_RECEIPT_BOUNDS_VIOLATED' }));
    }
    if (verified.status === 0) {
      return save(replaceAttempt({ ...record, authorization: null, error: 'UNISWAP_TRANSACTION_REVERTED' }, { ...attempt, state: 'REVERTED', receipt, note: 'UNISWAP_TRANSACTION_REVERTED' }));
    }
    try {
      if (attempt.step !== 'MINT') {
        await reconcileApproval(record, attempt, raw, verified.blockNumber);
        return save(replaceAttempt({ ...record, error: null }, { ...attempt, state: 'CONFIRMED', receipt, reconciled: true }));
      }
      const position = await reconcileMint(record, attempt, raw, verified.blockNumber, hash);
      const confirmed = replaceAttempt({ ...record, authorization: null, error: null }, { ...attempt, state: 'CONFIRMED', receipt, reconciled: true });
      const evidence = await buildEvidence(confirmed, position);
      return save({ ...confirmed, position, evidence, verdict: 'RECONCILED' });
    } catch (cause) {
      const code = cause instanceof Error && /^UNISWAP_(?:APPROVAL_MISMATCH|APPROVAL_NOT_EFFECTIVE|MINT_MISMATCH|POSITION_RECIPIENT_MISMATCH|MINT_BOUNDS_VIOLATED|TOKEN_TRANSFER_MISMATCH|POSITION_OWNER_MISMATCH|POSITION_MISMATCH|BALANCE_DELTA_MISMATCH|POSITION_INVALID|MINT_INVALID|APPROVAL_INVALID|RECEIPT_INVALID)$/.test(cause.message) ? cause.message : null;
      // A confirmed transaction whose effects disagree with the Review is frozen for attention; RPC trouble is retried.
      if (!code) throw cause;
      return save(replaceAttempt({ ...record, verdict: 'DIVERGENT', authorization: null, error: code }, { ...attempt, state: 'RECONCILIATION_REQUIRED', receipt, note: code }));
    }
  }

  async function price(assets: PoolAssets | null): Promise<UniswapLiquidityPrice> {
    const state = await readState('0x' + '0'.repeat(40), assets);
    return { sqrtPriceX96: state.sqrtPriceX96.toString(), tick: state.tick,
      price: uniswapQuotePriceAtSqrt(state.sqrtPriceX96, t0.decimals, t1.decimals), blockNumber: state.block.number };
  }
  return { profile, rpc, head, readState, simulateCalls, buildReview, assertRequestFees, assertMintBounds, reserveNonce, discoverByNonce, sameIntent, settle, price };
  }
  /** The runtime of a pool: its chain's own read client, never another chain's. A chain without a configured client is not enabled. */
  const runtimes = new Map<string, ReturnType<typeof bind>>();
  function runtimeOf(profile: UniswapPoolProfile): ReturnType<typeof bind> {
    const key = `${profile.chainId}:${profile.pool}`, cached = runtimes.get(key);
    if (cached) return cached;
    const client = input.rpcs?.[profile.chain] ?? (profile.chain === BASE_PROFILE.chain ? input.rpc : undefined);
    if (!client) fail('UNISWAP_NETWORK_UNAVAILABLE');
    const created = bind(profile, client);
    runtimes.set(key, created);
    return created;
  }
  /** BUILD-RH-002: both pool tokens as catalog ERC-20s of the served network with their authored decimals (and, for a stored Review, the same identity). */
  async function catalogAssets(token0: { address: string; decimals: number; officialId?: string | null }, token1: typeof token0): Promise<PoolAssets> {
    const catalog = await input.catalog!.catalogFor(servedChain);
    if (catalog.chain !== servedChain) fail('CATALOG_NETWORK_MISMATCH');
    const side = (ref: typeof token0) => {
      const asset = catalogAsset(catalog, { address: ref.address });
      if (!asset || asset.kind !== 'ERC20' || asset.decimals !== ref.decimals || (ref.officialId !== undefined && (asset.stock?.officialId ?? null) !== ref.officialId))
        fail('CATALOG_ASSET_IDENTITY_CHANGED');
      return asset;
    };
    return { token0: side(token0), token1: side(token1) };
  }
  const assetsOfRecord = (record: UniswapLiquidityRecord) => input.catalog ? catalogAssets(record.review.token0, record.review.token1) : Promise.resolve(null);
  const runtimeOfRecord = (record: UniswapLiquidityRecord) => runtimeOf(profileOfReview(record.review));
  async function runtimeOfWorkflow(workflow: SemanticWorkflow): Promise<{ runtime: ReturnType<typeof bind>; assets: PoolAssets | null }> {
    const node = isObject(workflow) && Array.isArray(workflow.nodes) ? workflow.nodes.find(n => n.actionType === 'asset.liquidity.concentrated') : undefined;
    if (!input.catalog) return { runtime: runtimeOf(uniswapLiquidityProfile(node?.chainId) ?? fail('UNISWAP_LIQUIDITY_NETWORK_UNSUPPORTED')), assets: null };
    if (node?.chainId !== servedChain) fail('UNISWAP_LIQUIDITY_NETWORK_UNSUPPORTED');
    let fields: ReturnType<typeof readConcentratedLiquidity>;
    try { fields = readConcentratedLiquidity(node); } catch { return fail('UNISWAP_LIQUIDITY_DECLARATION_INVALID'); }
    const assets = await catalogAssets(fields.token0, fields.token1);
    let profile: UniswapPoolProfile;
    try { profile = catalogPoolOn(servedChain, assets.token0 as { symbol: string; address: string; decimals: number }, assets.token1 as { symbol: string; address: string; decimals: number }, fields.feeTier); }
    catch (cause) { return fail(cause instanceof Error && /^UNISWAP_[A-Z_]+$/.test(cause.message) ? cause.message : 'UNISWAP_LIQUIDITY_DECLARATION_INVALID'); }
    if (profile.token0.address !== fields.token0.address) fail('UNISWAP_TOKEN_ORDER_INVALID');
    return { runtime: runtimeOf(profile), assets };
  }

  return {
    executionEnabled,
    /** The current pool price of a liquidity network (Base Sepolia unless a chain is named; a catalog-network pool by its pair and fee tier). */
    async price(chain: string = BASE_PROFILE.chain, pair?: { readonly tokenA: string; readonly tokenB: string; readonly fee: number }): Promise<UniswapLiquidityPrice> {
      if (chain !== servedChain || !input.catalog) return runtimeOf(uniswapLiquidityProfile(chain) ?? fail('UNISWAP_LIQUIDITY_NETWORK_UNSUPPORTED')).price(null);
      if (!pair) fail('UNISWAP_POOL_REQUIRED');
      const catalog = await input.catalog.catalogFor(servedChain);
      const a = catalogAsset(catalog, { address: String(pair.tokenA).toLowerCase() }), b = catalogAsset(catalog, { address: String(pair.tokenB).toLowerCase() });
      if (!a || !b || a.kind !== 'ERC20' || b.kind !== 'ERC20') fail('CATALOG_ASSET_IDENTITY_CHANGED');
      let profile: UniswapPoolProfile;
      try { profile = catalogPoolOn(servedChain, a as { symbol: string; address: string; decimals: number }, b as { symbol: string; address: string; decimals: number }, pair.fee); }
      catch { return fail('UNISWAP_FEE_TIER_UNSUPPORTED'); }
      const assets = await catalogAssets(profile.token0, profile.token1);
      return runtimeOf(profile).price(assets);
    },
    /** Read-only: a new run with a fresh public simulation for this owner. */
    async simulate(workflowInput: unknown, ownerInput: string): Promise<UniswapLiquidityRecord> {
      const workflow = workflowInput as SemanticWorkflow, owner = address(ownerInput);
      const { runtime, assets } = await runtimeOfWorkflow(workflow);
      const review = await runtime.buildReview(workflow, owner, assets);
      const id = `${idPrefix}-` + randomBytes(16).toString('hex');
      return save({ format: 'flofi.uniswap-liquidity-run.v1', id, provenance, workflow, owner, review, authorization: null, attempts: [], position: null,
        evidence: null, verdict: 'PENDING', error: null });
    },
    /** A new simulation and Review for the same run (after an approval, expiry, revert or a proven-not-sent attempt). */
    async refresh(id: string): Promise<UniswapLiquidityRecord> { return locked(id, async () => {
      const record = await load(id);
      if (record.verdict !== 'PENDING' || active(record)) fail('UNISWAP_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
      return save({ ...record, review: await runtimeOfRecord(record).buildReview(record.workflow, record.owner, await assetsOfRecord(record)), authorization: null, error: null });
    }); },
    async review(id: string, commitment: string, workflow: SemanticWorkflow): Promise<UniswapLiquidityRecord> { return locked(id, async () => {
      const record = await load(id);
      if (!sameWorkflow(workflow, record.workflow)) fail('UNISWAP_SEMANTIC_REVISION_CHANGED');
      if (record.verdict !== 'PENDING' || active(record)) fail('UNISWAP_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
      if (commitment !== record.review.commitment) fail('UNISWAP_REVIEW_CHANGED');
      if (now().getTime() >= Date.parse(record.review.expiresAt)) fail('UNISWAP_REVIEW_EXPIRED');
      return save({ ...record, authorization: commitment, error: null });
    }); },
    async invalidate(id: string): Promise<UniswapLiquidityRecord> { return locked(id, async () => {
      const record = await load(id);
      return record.authorization ? save({ ...record, authorization: null, error: 'UNISWAP_SEMANTIC_EDIT_REQUIRES_REVIEW' }) : record;
    }); },
    /**
     * Re-verifies the Review against fresh public state and re-simulates the remaining reviewed calls, then persists
     * PREPARED with the exact next wallet request. Material change clears the authorization: re-simulate and review again.
     */
    async begin(id: string, ownerInput: string, workflow: SemanticWorkflow): Promise<UniswapBegin> { return locked(id, async () => {
      let record = await load(id);
      const owner = address(ownerInput);
      if (!executionEnabled) fail('UNISWAP_EXECUTION_NOT_ENABLED');
      if (owner !== record.owner) fail('UNISWAP_WRONG_OWNER');
      if (!sameWorkflow(workflow, record.workflow)) fail('UNISWAP_SEMANTIC_REVISION_CHANGED');
      if (record.verdict !== 'PENDING') fail(record.verdict === 'RECONCILED' ? 'UNISWAP_POSITION_ALREADY_MINTED' : 'UNISWAP_RECONCILIATION_REQUIRED');
      if (active(record)) fail('UNISWAP_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
      if (record.authorization !== record.review.commitment) fail('UNISWAP_REVIEW_REQUIRED');
      if (now().getTime() >= Date.parse(record.review.expiresAt)) fail('UNISWAP_REVIEW_EXPIRED');
      const R = runtimeOfRecord(record), profile = R.profile;
      const review = record.review;
      const changed = async (code = 'UNISWAP_STATE_CHANGED_REVIEW_REQUIRED'): Promise<never> => { await save({ ...record, authorization: null, error: code }); return fail(code); };
      // BUILD-RH-002: a Stock Token whose identity or multiplier changed (or is about to) since Review clears the authorization.
      let state: ChainState;
      try { state = await R.readState(owner, await assetsOfRecord(record)); }
      catch (cause) { if (cause instanceof Error && staleReviewError(cause.message)) return changed(cause.message); throw cause; }
      if (canonical(state.codeSha256) !== canonical(review.contracts.codeSha256)) return changed();
      if (stockEconomics(state.stocks) !== stockEconomics(review.stocks)) return changed('STOCK_MULTIPLIER_CHANGED_REVIEW_REQUIRED');
      const need0 = BigInt(review.intent.amount0Max) > 0n && state.allowance0 < BigInt(review.intent.amount0Max);
      const need1 = BigInt(review.intent.amount1Max) > 0n && state.allowance1 < BigInt(review.intent.amount1Max);
      const step: UniswapLiquidityStep = need0 ? 'APPROVE_TOKEN0' : need1 ? 'APPROVE_TOKEN1' : 'MINT';
      const index = review.calls.findIndex(c => c.step === step);
      if (index < 0) return changed();
      const remaining = review.calls.slice(index).filter(c => c.step === 'MINT' || (c.step === 'APPROVE_TOKEN0' ? need0 : need1));
      // Materiality: the exact reviewed calls must still succeed; range state and expected amounts within half the slippage.
      let fresh: SimulatedCall[];
      try { fresh = await R.simulateCalls(owner, remaining, state.block.number); }
      catch (cause) { if (cause instanceof Error && /^UNISWAP_SIMULATION_(MINT|APPROVAL)_REVERTED$/.test(cause.message)) return changed(); throw cause; }
      try { R.assertMintBounds(review, state, fresh); } catch { return changed(); }
      if (state.nonce !== state.pendingNonce) fail('UNISWAP_PENDING_TRANSACTION');
      if (step === 'MINT') {
        if (record.attempts.some(a => a.step === 'MINT' && a.state === 'CONFIRMED')) fail('UNISWAP_POSITION_ALREADY_MINTED');
        // Duplicate-position guard: an earlier mint attempt that never proved a landing must not have grown the owner's positions.
        const earlier = record.attempts.filter(a => a.step === 'MINT' && a.state !== 'REVERTED').at(-1);
        if (earlier && BigInt(earlier.positionsBefore ?? '0') !== state.positionCount) fail('UNISWAP_POSITION_MAY_EXIST_OBSERVE');
      }
      const call = review.calls[index]!;
      const priority = BigInt(review.fees.maxPriorityFeePerGas), maxFeePerGas = BigInt(review.fees.maxFeePerGas);
      const attemptId = `${id}.${step.toLowerCase()}.${record.attempts.length + 1}`;
      const tx: UniswapTx = { chainId: profile.chainHex, from: owner, to: call.to, data: call.data, value: '0x0', gas: tag(BigInt(call.gasLimit)),
        maxFeePerGas: tag(maxFeePerGas), maxPriorityFeePerGas: tag(priority) };
      try { await R.assertRequestFees(review, tx, tag(state.block.number)); }
      catch (cause) { if (cause instanceof Error && /^UNISWAP_.*_REVIEW_REQUIRED$/.test(cause.message)) return changed(cause.message); throw cause; }
      await R.reserveNonce(record, attemptId, state.nonce);
      const attempt: UniswapAttempt = { attemptId, step, state: 'PREPARED', reviewCommitment: review.commitment, nonce: state.nonce.toString(),
        preparedAtBlock: state.block.number, createdAt: now().toISOString(), tx, transactionHash: null, replacementHash: null,
        positionsBefore: step === 'MINT' ? state.positionCount.toString() : null, receipt: null, reconciled: false, note: null };
      record = await save({ ...record, attempts: [...record.attempts, attempt], error: null });
      return { record, attempt, transaction: tx };
    }); },
    /** The handoff boundary: SUBMITTING is durable before the browser calls the wallet. */
    async handoff(id: string): Promise<UniswapLiquidityRecord> { return locked(id, async () => {
      const record = await load(id), attempt = record.attempts.at(-1);
      if (!executionEnabled || attempt?.state !== 'PREPARED' || record.authorization !== attempt.reviewCommitment ||
          now().getTime() >= Date.parse(record.review.expiresAt)) fail('UNISWAP_WALLET_HANDOFF_NOT_AUTHORIZED');
      const R = runtimeOfRecord(record), { rpc } = R;
      try {
        const state = await R.readState(record.owner, await assetsOfRecord(record));
        const need0 = BigInt(record.review.intent.amount0Max) > 0n && state.allowance0 < BigInt(record.review.intent.amount0Max);
        const need1 = BigInt(record.review.intent.amount1Max) > 0n && state.allowance1 < BigInt(record.review.intent.amount1Max);
        if (attempt.step !== (need0 ? 'APPROVE_TOKEN0' : need1 ? 'APPROVE_TOKEN1' : 'MINT')) fail('UNISWAP_STATE_CHANGED_REVIEW_REQUIRED');
        const remaining = record.review.calls.slice(record.review.calls.findIndex(c => c.step === attempt.step))
          .filter(c => c.step === 'MINT' || (c.step === 'APPROVE_TOKEN0' ? need0 : need1));
        R.assertMintBounds(record.review, state, await R.simulateCalls(record.owner, remaining, state.block.number));
        await R.assertRequestFees(record.review, attempt.tx, tag(state.block.number));
      } catch (cause) {
        if (cause instanceof Error && staleReviewError(cause.message)) {
          await save({ ...record, authorization: null, error: cause.message });
        }
        throw cause;
      }
      const [latest, pending] = await Promise.all([rpc('eth_getTransactionCount', [record.owner, 'latest']).then(quantity),
        rpc('eth_getTransactionCount', [record.owner, 'pending']).then(quantity)]);
      if (latest !== BigInt(attempt.nonce) || pending !== BigInt(attempt.nonce)) fail('UNISWAP_NONCE_CHANGED');
      return save(replaceAttempt(record, { ...attempt, state: 'SUBMITTING' }));
    }); },
    /** Wallet result. A hash is recorded once (a repeated identical report is a no-op); ambiguity is observed, never resent. */
    async report(id: string, result: { kind: 'HASH'; hash: string } | { kind: 'UNKNOWN' | 'REJECTED'; code?: string }): Promise<UniswapLiquidityRecord> { return locked(id, async () => {
      const record = await load(id), attempt = record.attempts.at(-1);
      if (!attempt) fail('UNISWAP_ATTEMPT_MISSING');
      if (result.kind === 'HASH') {
        const hash = result.hash.toLowerCase();
        if (!HASH.test(hash)) fail('UNISWAP_HASH_INVALID');
        if (attempt.transactionHash) { if (attempt.transactionHash !== hash) fail('UNISWAP_HASH_DIVERGENT'); return record; }
        if (!['SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN'].includes(attempt.state)) fail('UNISWAP_ATTEMPT_STATE_INVALID');
        return save(replaceAttempt({ ...record, error: null }, { ...attempt, state: 'PENDING', transactionHash: hash }));
      }
      if (attempt.state !== 'SUBMITTING') return record;
      return save(replaceAttempt({ ...record, error: 'UNISWAP_SUBMISSION_UNKNOWN' }, { ...attempt, state: 'SUBMISSION_RESULT_UNKNOWN',
        note: result.kind === 'REJECTED' ? 'UNISWAP_REPORTED_REJECTED_UNPROVEN' : 'UNISWAP_SUBMISSION_UNKNOWN' }));
    }); },
    /** Records a proven pre-broadcast failure or refusal. Anything that may have reached the network stays observation-only. */
    async walletFailure(id: string, diagnostic: UniswapWalletDiagnostic): Promise<UniswapLiquidityRecord> { return locked(id, async () => {
      const record = await load(id), attempt = record.attempts.at(-1);
      if (JSON.stringify(diagnostic).length > 65_536 || typeof diagnostic.invoked !== 'boolean' || !Array.isArray(diagnostic.calls) ||
          !/^UNISWAP_[A-Z0-9_]{2,70}$/.test(diagnostic.code)) fail('UNISWAP_DIAGNOSTIC_INVALID');
      const send = diagnostic.calls.find(c => c.submission === true), error = send?.error as { code?: unknown } | undefined;
      const refused = diagnostic.invoked && send !== undefined && send.result === undefined && typeof error?.code === 'number' &&
        error.code === diagnostic.rejectionCode && REFUSALS.includes(error.code);
      if ((diagnostic.invoked || send) && !refused || !attempt || attempt.transactionHash ||
          !['PREPARED', 'SUBMITTING', 'SUBMISSION_RESULT_UNKNOWN'].includes(attempt.state)) fail('UNISWAP_DIAGNOSTIC_NOT_PRE_SUBMISSION');
      return save(replaceAttempt({ ...record, authorization: null, error: diagnostic.code }, { ...attempt, state: 'CANCELLED', note: diagnostic.code }));
    }); },
    /** Read-only observation and reconciliation (API and worker). There is no send path here. */
    async observe(id: string): Promise<UniswapLiquidityRecord> { return locked(id, async () => {
      const record = await load(id), attempt = record.attempts.at(-1);
      if (!attempt || record.verdict !== 'PENDING' || !ACTIVE.includes(attempt.state)) return record;
      if (attempt.state === 'PREPARED') {
        // The browser stopped before the durable handoff: no wallet request can exist for this attempt.
        return save(replaceAttempt({ ...record, authorization: null, error: 'UNISWAP_WALLET_NOT_SUBMITTED' }, { ...attempt, state: 'CANCELLED', note: 'UNISWAP_WALLET_NOT_SUBMITTED' }));
      }
      const { rpc, head, discoverByNonce, sameIntent, settle } = runtimeOfRecord(record);
      let hash = attempt.replacementHash ?? attempt.transactionHash;
      let raw = hash ? await rpc('eth_getTransactionReceipt', [hash]) : null;
      if (raw === null) {
        const found = await discoverByNonce(attempt);
        if (!found.consumed) {
          const latest = await head();
          const pending = quantity(await rpc('eth_getTransactionCount', [record.owner, 'pending']));
          const expired = attempt.step === 'MINT' ? latest.timestamp > Number(decodeUniswapMint(attempt.tx.data).deadline)
            : now().getTime() - Date.parse(attempt.createdAt) > APPROVAL_ABANDON_MS && pending === BigInt(attempt.nonce);
          if (expired) return save(replaceAttempt({ ...record, authorization: null, error: 'UNISWAP_SUBMISSION_EXPIRED_NOT_EXECUTED' },
            { ...attempt, state: 'NOT_FOUND', note: 'UNISWAP_SUBMISSION_EXPIRED_NOT_EXECUTED' }));
          return save({ ...record, error: hash ? 'UNISWAP_TRANSACTION_PENDING' : 'UNISWAP_TRANSACTION_NOT_OBSERVED' });
        }
        const foundHash = hex(found.tx.hash);
        if (!sameIntent(attempt, found.tx)) {
          // The reviewed nonce was consumed by a different transaction (e.g. a wallet cancellation): this attempt can never execute.
          return save(replaceAttempt({ ...record, authorization: null, error: 'UNISWAP_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION' },
            { ...attempt, state: 'NOT_FOUND', transactionHash: attempt.transactionHash ?? foundHash, note: 'UNISWAP_NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION' }));
        }
        // Same exact call on the reviewed nonce: the reported transaction, or a wallet speed-up replacement of it.
        const replaced = attempt.transactionHash !== null && attempt.transactionHash !== foundHash;
        const current: UniswapAttempt = { ...attempt, state: 'PENDING', transactionHash: attempt.transactionHash ?? foundHash, replacementHash: replaced ? foundHash : attempt.replacementHash };
        hash = foundHash;
        raw = await rpc('eth_getTransactionReceipt', [hash]);
        const saved = await save(replaceAttempt(record, current));
        if (raw === null) return save({ ...saved, error: 'UNISWAP_TRANSACTION_PENDING' });
        if (!isObject(raw)) fail('UNISWAP_RECEIPT_INVALID');
        return settle(saved, current, hash, raw);
      }
      if (!isObject(raw)) fail('UNISWAP_RECEIPT_INVALID');
      return settle(record, attempt, hash!, raw);
    }); },
    load,
  };
}
export type UniswapLiquidityService = ReturnType<typeof createUniswapLiquidityService>;
