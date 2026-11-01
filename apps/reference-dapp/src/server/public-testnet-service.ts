// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One opt-in, exact-profile Uniswap v3 swap on a public testnet: Base Sepolia USDC/WETH 0.05%, or (BUILD-ETHEREUM-001)
 * Ethereum Sepolia USDC/WETH 0.3%. BUILD-RH-002 adds the catalog profile kind: Robinhood Chain mainnet (real funds), any
 * pair of the official asset catalog (Stock Tokens, USDG, WETH) on a locally derived canonical pool, with the Stock Token
 * identity and ERC-8056 multiplier state bound into the Review. BUILD-BASE-001 adds Base mainnet as a second catalog network
 * (pinned USDC/WETH plus the validated token list; `bas-` runs), with the OP Stack L1 fee in its balance check. The authored chain
 * selects the profile and its own read client; no chain falls back to another. This service never signs or sends.
 */
import { nitroGasLimit, nitroMaxFeePerGas } from './arbitrum-fees.ts';
import { readNotAnswered } from './public-testnet-rpc.ts';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { baseAssetRegistry, catalogAsset, referenceRegistry, resolveWorkflowCapability, uniswapV3PoolAddress, type AssetCatalog, type CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { createBaseSepoliaReviewContext, createReviewContext, reviewContextForChain, validateAuthoringWorkflow } from '@defi-workflow-engine/reference-linter';
import { encodeNativeSwap, encodeSwap, encodeWethDeposit, encodeWethWithdraw, erc7710, ownerAccountCode, toHex } from '@defi-workflow-engine/reference-compiler';
import { catalogSwapKind, hashArtifactBytes, isCatalogSwapNode, isReferencePairSwap, readCatalogSwapNode, type CatalogAssetRef, type CatalogSwapFields, type EvidenceBundle, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { validateArtifact } from '@defi-workflow-engine/workflow-contracts/schemas';
import { createFileExecutionStorage, discoverTransferByNonce, utf8, type ExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { BASE_SEPOLIA, NATIVE_ETH, ownerBoundSwapReview, publicSwapProfile, quoteDecimals, swapProfile, type CatalogSwapProfile, type PairSwapProfile, type SwapProfile } from '../domain/public-testnet-swap.ts';
export { BASE_MAINNET_SWAP, BASE_SEPOLIA, ETHEREUM_SEPOLIA_SWAP, NATIVE_ETH, ROBINHOOD_MAINNET_SWAP, quoteDecimals } from '../domain/public-testnet-swap.ts';

export type Rpc = (method: string, params: readonly unknown[]) => Promise<unknown>;
type Step = 'approval' | 'swap';
/** BUILD-FLOFI-BRIDGE-LIVE-FIX-003: `value` is the exact native ETH the reviewed call carries — the amount in of a native-ETH swap or wrap, else 0. */
type Tx = { readonly chainId: SwapProfile['chainHex']; readonly from: string; readonly to: string;
  readonly data: string; readonly value: string; readonly gas: string;
  readonly nonce?: string; readonly maxFeePerGas?: string; readonly maxPriorityFeePerGas?: string };
/** Optional strict owner preflight on the shared engine. Quote-only previews cannot be authorized. */
export type SwapOwnerReview = { readonly account: string; readonly router: string; readonly nonce: string; readonly step: Step;
  readonly allowance: string; readonly transaction: Tx; readonly gasEstimate: string; readonly maxFeePerGas: string;
  readonly feeBudgetWei: string; readonly deadline: number; readonly simulationDigest: string;
  /**
   * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: the reviewed EIP-7702 delegate when the owner is a delegated EOA (a MetaMask Smart Account),
   * absent for a plain EOA. Bound into the Review: a delegation added, removed or changed before Execute needs a new Review.
   */
  readonly delegation?: string };
/** BUILD-RH-002: the identity and ERC-8056 multiplier state of a Stock Token side, read at the quote block and bound into the Review. */
export type StockQuoteState = { readonly side: 'input' | 'output' | 'token0' | 'token1'; readonly symbol: string; readonly token: string; readonly officialId: string;
  /** Onchain `uiMultiplier()`, `newUIMultiplier()` and `effectiveAt()` (1e18 = 1.0; `effectiveAt` 0 when nothing is scheduled). */
  readonly multiplierWad: string; readonly scheduledMultiplierWad: string; readonly scheduledEffectiveAt: number;
  /** The official registry's view at the same Review (must agree with the chain). */
  readonly registryMultiplierWad: string; readonly registryPendingMultiplierWad: string | null; readonly registryPendingEffectiveTime: string | null;
  readonly fractionalRestricted: boolean };
export type PublicQuote = { readonly executionId: string; readonly revision: number; readonly nodeId: string;
  readonly workflowHash: string; readonly manifestHash: string; readonly chainId: SwapProfile['chainId']; readonly inputToken: string;
  readonly outputToken: string; readonly inputSymbol: string; readonly outputSymbol: string;
  readonly amountIn: string; readonly expectedOut: string; readonly minimumOut: string; readonly slippageBps: number;
  readonly pool: string; readonly fee: number; readonly blockNumber: number; readonly blockHash: string;
  readonly observedAt: string; readonly expiresAt: string; readonly estimatedGas: string | null;
  /** BUILD-RH-002 catalog quotes only (absent on testnet pair quotes, whose decimals follow the USDC/WETH symbol). */
  readonly inputDecimals?: number; readonly outputDecimals?: number; readonly environment?: 'MAINNET';
  readonly provenance?: 'PUBLIC_MAINNET' | 'MOCKED'; readonly stocks?: readonly StockQuoteState[];
  readonly feeTiers?: readonly { readonly fee: number; readonly pool: string; readonly expectedOut: string | null }[];
  readonly catalog?: { readonly contentSha256: readonly (string | null)[]; readonly fetchedAt: string };
  /**
   * BUILD-FLOFI-BRIDGE-LIVE-FIX-003: `native` names the side that is the network's native ETH (its token field is `NATIVE_ETH`, never WETH9);
   * `conversion` marks a WETH9 wrap/unwrap (exactly 1:1, no pool: `pool` is the WETH9 contract, `fee` 0). Absent on every ERC-20 quote.
   */
  readonly native?: 'INPUT' | 'OUTPUT'; readonly conversion?: 'WRAP' | 'UNWRAP';
  readonly ownerReview?: SwapOwnerReview };
export type PublicAttempt = { readonly attemptId: string; readonly executionId: string; readonly step: Step;
  readonly state: 'PREPARED' | 'HASH' | 'REJECTED' | 'UNKNOWN' | 'PENDING' | 'REVERTED' | 'CONFIRMED';
  readonly createdAt: string; readonly submittedAt: string | null; readonly account: string; readonly chainId: SwapProfile['chainId']; readonly environment: 'PUBLIC_TESTNET' | 'MAINNET';
  readonly adapter: 'uniswap.v3' | 'weth9.wrap'; readonly semanticRevision: number; readonly manifestHash: string;
  readonly tx: Tx; readonly calldataDigest: string; readonly authorizedInput: string; readonly authorizedMinimumOutput: string;
  readonly preBlock: number; readonly nativeBefore: string; readonly inputBefore: string; readonly outputBefore: string;
  readonly allowanceBefore: string; readonly nativeAfter: string | null; readonly txHash: string | null; readonly receipt: PublicReceipt | null };
export type PublicReceipt = { readonly transactionHash: string; readonly status: 0 | 1; readonly blockNumber: number;
  readonly blockHash: string; readonly from: string; readonly to: string; readonly gasUsed: string;
  readonly effectiveGasPrice: string; readonly executionGasCostWei: string; readonly l1FeeWei: string;
  readonly gasCostWei: string; readonly gasPayer: string; readonly nonce: string; readonly value: string;
  readonly submissionKind: 'DIRECT' | 'DELEGATED_SINGLE'; readonly executionTarget: string;
  readonly delegationDepth: number; readonly outerCalldataDigest: string; readonly executionCalldataDigest: string };
export type PublicOutcome = { readonly inputSpent: string; readonly outputReceived: string;
  readonly inputAfter: string; readonly outputAfter: string; readonly allowanceAfter: string; readonly nativeAfter: string;
  readonly gasCostWei: string; readonly explorer: string; readonly evidence: EvidenceBundle;
  readonly evidenceBundleHash: string };
export type PublicRun = { readonly quote: PublicQuote; readonly workflow: SemanticWorkflow; readonly reviewedManifestHash: string | null;
  readonly attempts: readonly PublicAttempt[]; readonly outcome: PublicOutcome | null; readonly divergence?: string };
export type PublicBegin = { readonly attempt: PublicAttempt; readonly tx: Tx };
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
/** WETH9 `Deposit(address indexed dst, uint256 wad)` and `Withdrawal(address indexed src, uint256 wad)` (Base and Ethereum WETH9). */
const DEPOSIT_TOPIC = '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c';
const WITHDRAWAL_TOPIC = '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65';
/**
 * Run-id namespaces: `pub-` for the public-testnet pairs, `rhs-` (BUILD-RH-002) for Robinhood Chain mainnet catalog swaps, `bas-`
 * (BUILD-BASE-001) for Base mainnet swaps, so a run id alone routes to its deployment and a testnet journal can never hold a mainnet
 * run (or the reverse), nor one network's run another's.
 */
export type SwapRunPrefix = 'pub' | 'rhs' | 'bas' | 'ars' | 'ets';
export const SWAP_RUN_ID = /^(pub|rhs|bas|ars|ets)-[0-9a-f]{24}$/;
const runIdPattern = (prefix: SwapRunPrefix) => new RegExp(`^${prefix}-[0-9a-f]{24}$`);
/** A run's namespace must match its network: each catalog (mainnet) network has its own, testnet pair runs are `pub-`. */
const prefixFor = (profile: SwapProfile): SwapRunPrefix => profile.kind === 'CATALOG' ? profile.runPrefix : 'pub';
// MetaMask Delegation Framework v1.3.0 on Base Sepolia. This is a readback format only;
// Gryloo still prepares one direct exact-call artifact and never constructs a delegation.
const DELEGATION_MANAGER = erc7710.DELEGATION_FRAMEWORK_V1_3.delegationManager;
const DELEGATOR_IMPL = erc7710.DELEGATION_FRAMEWORK_V1_3.eip7702StatelessDeleGator;
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: contracts of the reviewed Delegation Framework v1.3.0 that may log in a relayed (Delegation Manager)
 * redemption besides the swap's own tokens and pool: the manager's `RedeemedDelegation` and its caveat enforcers' bookkeeping (the real
 * MetaMask redemption recorded in testdata logs the LimitedCalls enforcer's `IncreasedCount`). None of them moves funds; any fund movement
 * still has to be one of the swap's own, exactly accounted logs.
 */
const RELAY_FRAMEWORK_LOGGERS: ReadonlySet<string> = new Set([DELEGATION_MANAGER, ...Object.values(erc7710.DELEGATION_FRAMEWORK_V1_3.enforcers)]);
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: a relayed redemption is accepted only when its delegation is single use, as in the real MetaMask
 * relay (testdata/metamask-delegated-depth1-approval.base-sepolia.json): the owner's root delegation carries the framework's LimitedCalls caveat
 * with a limit of one, and LimitedCalls logged `IncreasedCount(sender, redeemer, delegationHash, limit, callCount)` reaching that one call for
 * exactly this delegation. The enforcer then refuses every later redemption: the relay cannot execute the reviewed call a second time.
 */
const LIMITED_CALLS = erc7710.DELEGATION_FRAMEWORK_V1_3.enforcers.limitedCalls;
const INCREASED_COUNT_TOPIC = erc7710.keccakHex('IncreasedCount(address,address,bytes32,uint256,uint256)');
const DELEGATION_ABI: erc7710.AbiType = { tuple: ['address', 'address', 'bytes32', { array: { tuple: ['address', 'bytes', 'bytes'] } }, 'uint256', 'bytes'] };
export function singleUseRelayedDelegation(logs: readonly unknown[], owner: string, relayer: string): boolean {
  try {
    const records = logs.filter(isObject);
    const [redeemed, ...more] = records.filter(log => address(log.address) === DELEGATION_MANAGER && Array.isArray(log.topics) && log.topics[0] === REDEEMED_TOPIC);
    if (!redeemed || more.length) return false;
    const [value] = erc7710.abiDecode([DELEGATION_ABI], erc7710.bytesOf(hex(redeemed.data)));
    const [delegate, delegator, authority, caveats, salt] = value as [string, string, string, [string, string, string][], bigint, string];
    if (address(delegator) !== owner || authority !== erc7710.ROOT_AUTHORITY ||
        !caveats.some(([enforcer, terms]) => address(enforcer) === LIMITED_CALLS && terms === '0x' + word(1n))) return false;
    const hash = erc7710.delegationHash({ delegate, delegator, authority, salt,
      caveats: caveats.map(([enforcer, terms, args]) => ({ enforcer, terms, args })) });
    const counted = records.filter(log => address(log.address) === LIMITED_CALLS);
    return counted.length === 1 && Array.isArray(counted[0]!.topics) && counted[0]!.topics.length === 4 && counted[0]!.topics[0] === INCREASED_COUNT_TOPIC &&
      topicAddress(counted[0]!.topics[1]) === DELEGATION_MANAGER && topicAddress(counted[0]!.topics[2]) === relayer && counted[0]!.topics[3] === hash &&
      hex(counted[0]!.data) === '0x' + word(1n) + word(1n);
  } catch { return false; }
}
const REDEEM_SELECTOR = '0xcef6d209';
const REDEEMED_TOPIC = '0x40dadaa36c6c2e3d7317e24757451ffb2d603d875f0ad5e92c5dd156573b1873';
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
/** ERC-8056 `TransferWithScaledUI(address,address,uint256,uint256)`, emitted by Robinhood Stock Tokens next to `Transfer`. */
const SCALED_TRANSFER_TOPIC = '0x37e7f0db430edc9dd31bc66f25f8449353aa0818f503b906747dd8f286cd3802';
/**
 * HOTFIX-WORKFLOW-CONCURRENCY-001: the swap proven from its own receipt alone, for a direct submission whose balance window also holds other
 * transactions of the owner. Exactly one input Transfer owner → pool of the authorized amount, one output Transfer pool → owner, one pool Swap
 * from the router to the owner whose amounts match both transfers; a Stock Token's ERC-8056 companion log only mirrors a verified Transfer.
 * Returns the output amount received.
 */
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: OpenZeppelin-style tokens (Arbitrum's aeWETH, ARB, …) also log `Approval(owner, router, remaining)`
 * when the router's `transferFrom` spends the owner's allowance. That bookkeeping moves nothing; only that pair, on the input token, is accepted.
 */
function spendApprovals(tokenLogs: readonly Record<string, unknown>[], inputToken: string, owner: string, router: string): Record<string, unknown>[] {
  return tokenLogs.filter(log => address(log.address) === inputToken && Array.isArray(log.topics) && log.topics.length === 3 && log.topics[0] === APPROVAL_TOPIC &&
    topicAddress(log.topics[1]) === owner && topicAddress(log.topics[2]) === router);
}
function receiptSwap(logs: unknown[], quote: PublicQuote, owner: string, router: string, amountIn: bigint): bigint {
  const records = logs.filter(isObject), tokens = [quote.inputToken, quote.outputToken];
  const ofToken = records.filter(log => tokens.includes(address(log.address))), poolLogs = records.filter(log => address(log.address) === quote.pool);
  const transfers = ofToken.filter(log => Array.isArray(log.topics) && log.topics[0] === TRANSFER_TOPIC);
  const companion = (log: Record<string, unknown>) => { const topics = log.topics;
    return Array.isArray(topics) && topics[0] === SCALED_TRANSFER_TOPIC && transfers.some(t => address(t.address) === address(log.address) &&
      (t.topics as unknown[])[1] === topics[1] && (t.topics as unknown[])[2] === topics[2] && hex(log.data).slice(0, 66) === hex(t.data).slice(0, 66)); };
  const input = transfers.find(log => address(log.address) === quote.inputToken), output = transfers.find(log => address(log.address) === quote.outputToken);
  const spent = spendApprovals(ofToken, quote.inputToken, owner, router);
  if (transfers.length !== 2 || spent.length > 1 || !ofToken.every(log => transfers.includes(log) || companion(log) || spent.includes(log)) || poolLogs.length !== 1 || !input || !output) fail('TRANSACTION_MISMATCH');
  const [pool] = poolLogs as [Record<string, unknown>];
  if (topicAddress((input.topics as unknown[])[1]) !== owner || topicAddress((input.topics as unknown[])[2]) !== quote.pool || quantity(input.data) !== amountIn ||
      topicAddress((output.topics as unknown[])[1]) !== quote.pool || topicAddress((output.topics as unknown[])[2]) !== owner ||
      !Array.isArray(pool.topics) || pool.topics[0] !== SWAP_TOPIC || topicAddress(pool.topics[1]) !== router || topicAddress(pool.topics[2]) !== owner) fail('TRANSACTION_MISMATCH');
  const data = hex(pool.data), amount0 = data.length < 130 ? null : signed(BigInt('0x' + data.slice(2, 66))), amount1 = data.length < 130 ? null : signed(BigInt('0x' + data.slice(66, 130)));
  const received = quantity(output.data);
  // Uniswap V3 Swap amounts are the pool's deltas: + for the token it received (the input), − for the token it paid out (the output).
  const [inDelta, outDelta] = quote.inputToken < quote.outputToken ? [amount0, amount1] : [amount1, amount0];
  if (inDelta !== amountIn || outDelta !== -received) fail('TRANSACTION_MISMATCH');
  return received;
}
/**
 * BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a native-ETH swap or WETH9 conversion proven from its own receipt — never from an ERC-20 Transfer alone.
 * A wrap is WETH's mint to the owner of exactly the amount; an unwrap its burn from the owner; a native-in swap is the router's wrap of exactly
 * the amount, its WETH → pool transfer and the pool's output Transfer to the owner; a native-out swap is the owner's input Transfer to the pool,
 * the pool's WETH → router transfer and the router's unwrap (the native ETH the router then pays the owner — its recipient is bound in the
 * reviewed calldata). WETH's own dialect decides how a wrap and an unwrap are logged (WETH9 `Deposit`/`Withdrawal`, or an aeWETH Transfer
 * mint/burn). Returns what was spent and received, in base units.
 */
function receiptNative(logs: unknown[], quote: PublicQuote, owner: string, P: CatalogSwapProfile, amountIn: bigint): { spent: bigint; received: bigint } {
  const records = logs.filter(isObject), weth = P.weth, zero = '0x' + '0'.repeat(40);
  const topics = (log: Record<string, unknown>) => Array.isArray(log.topics) ? log.topics as unknown[] : fail('TRANSACTION_MISMATCH');
  const transfer = (log: Record<string, unknown>, from: string, to: string) => topics(log)[0] === TRANSFER_TOPIC && topicAddress(topics(log)[1]) === from && topicAddress(topics(log)[2]) === to;
  /** WETH's wrap of `amount` for `holder` (minted to it), or its unwrap of `amount` from `holder` (burned from it). */
  const wrapped = (log: Record<string, unknown>, holder: string) => P.wethEvents === 'WETH9' ? topics(log)[0] === DEPOSIT_TOPIC && topicAddress(topics(log)[1]) === holder : transfer(log, zero, holder);
  const unwrapped = (log: Record<string, unknown>, holder: string) => P.wethEvents === 'WETH9' ? topics(log)[0] === WITHDRAWAL_TOPIC && topicAddress(topics(log)[1]) === holder : transfer(log, holder, zero);
  const wethLogs = records.filter(log => address(log.address) === weth);
  if (quote.conversion) {
    const [only] = wethLogs;
    if (records.length !== 1 || wethLogs.length !== 1 || quantity(only!.data) !== amountIn || !(quote.conversion === 'WRAP' ? wrapped(only!, owner) : unwrapped(only!, owner))) fail('TRANSACTION_MISMATCH');
    return { spent: amountIn, received: amountIn };
  }
  const token = quote.native === 'INPUT' ? quote.outputToken : quote.inputToken, router = P.router;
  const tokenLogs = records.filter(log => address(log.address) === token), poolLogs = records.filter(log => address(log.address) === quote.pool);
  const tokenTransfers = tokenLogs.filter(log => topics(log)[0] === TRANSFER_TOPIC);
  // A Stock Token's ERC-8056 companion log only mirrors a verified Transfer of the same token.
  const companion = (log: Record<string, unknown>) => topics(log)[0] === SCALED_TRANSFER_TOPIC && tokenTransfers.some(t => topics(t)[1] === topics(log)[1] && topics(t)[2] === topics(log)[2]);
  // A native-out swap spends the owner's ERC-20 through the router's allowance (its Approval bookkeeping is accepted, see spendApprovals).
  const spent = quote.native === 'OUTPUT' ? spendApprovals(tokenLogs, token, owner, router) : [];
  if (tokenTransfers.length !== 1 || spent.length > 1 || !tokenLogs.every(log => tokenTransfers.includes(log) || companion(log) || spent.includes(log)) || poolLogs.length !== 1 ||
      records.some(log => ![weth, token, quote.pool].includes(address(log.address)))) fail('TRANSACTION_MISMATCH');
  const [pool] = poolLogs as [Record<string, unknown>], [moved] = tokenTransfers as [Record<string, unknown>];
  const data = hex(pool.data), amount0 = data.length < 130 ? null : signed(BigInt('0x' + data.slice(2, 66))), amount1 = data.length < 130 ? null : signed(BigInt('0x' + data.slice(66, 130)));
  const [wethDelta, tokenDelta] = weth < token ? [amount0, amount1] : [amount1, amount0];
  if (topics(pool)[0] !== SWAP_TOPIC || topicAddress(topics(pool)[1]) !== router) fail('TRANSACTION_MISMATCH');
  if (quote.native === 'INPUT') {
    // The router wraps exactly the sent value, pays the pool, and the pool pays the owner.
    const wrap = wethLogs.find(log => wrapped(log, router)), paid = wethLogs.find(log => transfer(log, router, quote.pool));
    const received = quantity(moved.data);
    if (wethLogs.length !== 2 || !wrap || !paid || quantity(wrap.data) !== amountIn || quantity(paid.data) !== amountIn || !transfer(moved, quote.pool, owner) ||
        topicAddress(topics(pool)[2]) !== owner || wethDelta !== amountIn || tokenDelta !== -received) fail('TRANSACTION_MISMATCH');
    return { spent: amountIn, received };
  }
  // Native out: the owner pays the pool, the pool pays the router in WETH, the router unwraps all of it for the owner.
  const paid = wethLogs.find(log => transfer(log, quote.pool, router)), unwrap = wethLogs.find(log => unwrapped(log, router));
  if (wethLogs.length !== 2 || !paid || !unwrap || !transfer(moved, owner, quote.pool) || quantity(moved.data) !== amountIn || topicAddress(topics(pool)[2]) !== router ||
      tokenDelta !== amountIn || wethDelta !== -quantity(paid.data) || quantity(unwrap.data) < quantity(paid.data)) fail('TRANSACTION_MISMATCH');
  return { spent: amountIn, received: quantity(unwrap.data) };
}
function fail(code: string): never { throw new Error(code); }
function address(value: unknown): string { if (typeof value !== 'string' || !ADDRESS.test(value.toLowerCase())) fail('ADDRESS_INVALID'); return value.toLowerCase(); }
function hex(value: unknown): string { if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) fail('RPC_RESPONSE_INVALID'); return value.toLowerCase(); }
function quantity(value: unknown): bigint { return BigInt(hex(value)); }
function word(value: bigint): string { if (value < 0n || value >= 1n << 256n) fail('ABI_VALUE_INVALID'); return value.toString(16).padStart(64, '0'); }
function addrWord(value: string): string { return address(value).slice(2).padStart(64, '0'); }
function digest(value: unknown): string { return '0x' + createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
const blockHex = (n: number) => '0x' + n.toString(16);
const callData = (selector: string, ...words: string[]) => selector + words.join('');
const balanceData = (owner: string) => callData('0x70a08231', addrWord(owner));
const allowanceData = (owner: string, p: SwapProfile) => callData('0xdd62ed3e', addrWord(owner), addrWord(p.router));
const approveData = (amount: bigint, p: SwapProfile) => callData('0x095ea7b3', addrWord(p.router), word(amount));
const swapData = (q: PublicQuote, owner: string) => callData('0x04e45aaf', addrWord(q.inputToken), addrWord(q.outputToken),
  word(BigInt(q.fee)), addrWord(owner), word(BigInt(q.amountIn)), word(BigInt(q.minimumOut)), word(0n));
/** SwapRouter02 multicall(uint256,bytes[]) enforces the reviewed deadline on chain. */
const deadlineSwapData = (q: PublicQuote, owner: string, deadline: number) => {
  if (![100, 500, 3000, 10000].includes(q.fee)) fail('QUOTE_INVALID');
  return toHex(encodeSwap({ tokenIn: q.inputToken, tokenOut: q.outputToken, fee: q.fee as 100 | 500 | 3000 | 10000,
    recipient: owner, amountIn: BigInt(q.amountIn), amountOutMinimum: BigInt(q.minimumOut), sqrtPriceLimitX96: 0n, deadline: BigInt(deadline) }));
};
/**
 * BUILD-FLOFI-BRIDGE-LIVE-FIX-003: the reviewed main call of a quote — its target, exact calldata and exact native value. An ERC-20 swap keeps
 * its existing encoding (`strict`: multicall with deadline; else exactInputSingle); a native-ETH swap is always the deadline multicall of
 * `encodeNativeSwap` (native in: value = amount in; native out: the router unwraps for the owner); a wrap is WETH9 `deposit()` carrying
 * exactly the amount; an unwrap WETH9 `withdraw(amount)`. A token approval, when needed, is a separate earlier call (ERC-20 input only).
 */
function mainCall(q: PublicQuote, owner: string, deadline: number, P: SwapProfile, strict: boolean): { to: string; data: string; value: string } {
  const amount = BigInt(q.amountIn), value = (units: bigint) => '0x' + units.toString(16);
  if (q.conversion) {
    if (P.kind !== 'CATALOG') fail('PUBLIC_WORKFLOW_UNSUPPORTED');
    return q.conversion === 'WRAP' ? { to: P.weth, data: toHex(encodeWethDeposit()), value: value(amount) } : { to: P.weth, data: toHex(encodeWethWithdraw(amount)), value: '0x0' };
  }
  if (q.native) {
    if (P.kind !== 'CATALOG' || ![100, 500, 3000, 10000].includes(q.fee)) fail('QUOTE_INVALID');
    const data = toHex(encodeNativeSwap({ native: q.native, weth: P.weth, tokenIn: q.native === 'INPUT' ? P.weth : q.inputToken, tokenOut: q.native === 'OUTPUT' ? P.weth : q.outputToken,
      fee: q.fee as 100 | 500 | 3000 | 10000, recipient: owner, amountIn: amount, amountOutMinimum: BigInt(q.minimumOut), sqrtPriceLimitX96: 0n, deadline: BigInt(deadline) }));
    return { to: P.router, data, value: q.native === 'INPUT' ? value(amount) : '0x0' };
  }
  return { to: P.router, data: strict ? deadlineSwapData(q, owner, deadline) : swapData(q, owner), value: '0x0' };
}
/** Whether the main call spends an ERC-20 the router must be allowed to pull (never for native ETH in, a wrap or an unwrap). */
const needsAllowance = (q: PublicQuote) => !q.conversion && q.native !== 'INPUT';
const poolData = (a: string, b: string, p: PairSwapProfile) => callData('0x1698ee82', addrWord(a), addrWord(b), word(BigInt(p.fee)));
const quoteData = (a: string, b: string, amount: bigint, fee: number) => callData('0xc6a5026a', addrWord(a), addrWord(b),
  word(amount), word(BigInt(fee)), word(0n));
/** The swap profile of a run's quote; a persisted chain without a profile is corrupt. */
const profileOf = (chainId: number): SwapProfile => swapProfile(chainId) ?? fail('PUBLIC_STORE_CORRUPT');
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
}
function swapOf(workflow: SemanticWorkflow) {
  const financial = workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
  // The authored chain selects the profile; its own trusted asset context validates the swap (Base USDC is never Ethereum Sepolia USDC).
  const profile = financial.length === 1 && financial[0]?.actionType === 'asset.swap.exact-input' ? publicSwapProfile(financial[0].chainId) : null;
  if (!profile) fail('PUBLIC_WORKFLOW_UNSUPPORTED');
  validateAuthoringWorkflow(workflow, reviewContextForChain(profile.chainRef, createBaseSepoliaReviewContext()));
  const cap = resolveWorkflowCapability(workflow, { environment: 'PUBLIC_TESTNET' });
  if (!cap.executionSupported || cap.nodes.find(node => node.nodeId === financial[0]!.nodeId)?.profile?.adapterId !== 'uniswap.v3')
    fail('PUBLIC_WORKFLOW_UNSUPPORTED');
  const node = financial[0]!;
  const amount = node.inputs.find(p => p.name === 'amount-in');
  const out = node.inputs.find(p => p.name === 'asset-out');
  const slip = node.userConstraints.find(c => c.kind === 'MAXIMUM_SLIPPAGE_BPS');
  if (amount?.kind !== 'QUANTITY' || out?.kind !== 'ASSET' || slip?.kind !== 'MAXIMUM_SLIPPAGE_BPS' ||
      slip.maximumBps < 1 || slip.maximumBps > 300) fail('PUBLIC_SWAP_INVALID');
  const inputToken = address('address' in amount.value.asset ? amount.value.asset.address : '');
  const outputToken = address('address' in out.value ? out.value.address : '');
  if (!(inputToken === profile.usdc || inputToken === profile.weth) ||
      !(outputToken === profile.usdc || outputToken === profile.weth) || inputToken === outputToken)
    fail('PUBLIC_SWAP_INVALID');
  return { node, profile, inputToken, outputToken, inputSymbol: inputToken === profile.usdc ? 'USDC' as const : 'WETH' as const,
    outputSymbol: outputToken === profile.usdc ? 'USDC' as const : 'WETH' as const,
    amountIn: BigInt(amount.value.amount), slippageBps: slip.maximumBps };
}
function isObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function topicAddress(value: unknown): string {
  const raw = hex(value);
  if (!/^0x[0-9a-f]{64}$/.test(raw) || !/^0{24}$/.test(raw.slice(2, 26))) fail('RECEIPT_INVALID');
  return address('0x' + raw.slice(-40));
}
/** Strictly decode one default-mode ExecutionLib.encodeSingle inside redeemDelegations. */
function delegatedExecution(input: string): { target: string; data: string } | null {
  if (!input.startsWith(REDEEM_SELECTOR)) return null;
  const raw = input.slice(10);
  if (raw.length % 64 !== 0) return null;
  const bytes = raw.length / 2;
  const read = (offset: number) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 32 > bytes) throw new Error('DELEGATION_ABI_INVALID');
    return BigInt('0x' + raw.slice(offset * 2, (offset + 32) * 2));
  };
  const number = (offset: number) => {
    const value = read(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('DELEGATION_ABI_INVALID');
    return Number(value);
  };
  const oneBytes = (offset: number) => {
    if (number(offset) !== 1 || number(offset + 32) !== 32) throw new Error('DELEGATION_ABI_INVALID');
    const start = offset + 64, length = number(start), first = start + 32;
    const end = first + Math.ceil(length / 32) * 32;
    if (length < 1 || end > bytes || !/^0*$/.test(raw.slice((first + length) * 2, end * 2)))
      throw new Error('DELEGATION_ABI_INVALID');
    return { value: '0x' + raw.slice(first * 2, (first + length) * 2), end };
  };
  try {
    if (number(0) !== 96) return null;
    const contexts = oneBytes(96), modeOffset = number(32);
    if (modeOffset !== contexts.end || number(modeOffset) !== 1 || read(modeOffset + 32) !== 0n) return null;
    const callsOffset = number(64);
    if (callsOffset !== modeOffset + 64) return null;
    const call = oneBytes(callsOffset);
    if (call.end !== bytes || call.value.length < 2 + (20 + 32 + 4) * 2) return null;
    const packed = call.value.slice(2);
    if (BigInt('0x' + packed.slice(40, 104)) !== 0n) return null;
    return { target: address('0x' + packed.slice(0, 40)), data: '0x' + packed.slice(104) };
  } catch { return null; }
}
/** Accept at most two canonical single-call redemptions, ending in the exact prepared action. */
function delegatedExecutionDepth(input: string, target: string, data: string): number | null {
  let current = input;
  for (let depth = 1; depth <= 2; depth++) {
    const inner = delegatedExecution(current);
    if (!inner) return null;
    if (inner.target === target && inner.data === data) return depth;
    if (depth === 2 || inner.target !== DELEGATION_MANAGER || !inner.data.startsWith(REDEEM_SELECTOR)) return null;
    current = inner.data;
  }
  return null;
}
/**
 * Verifies that a receipt belongs to the owner's exact reviewed call on its chain (Base Sepolia by default): sent directly by the owner, or as one
 * canonical MetaMask Delegation Framework redemption of exactly that call (EIP-7702 delegator, Redeemed events naming the
 * owner). Read-only; shared by the public swap and the public Uniswap liquidity flow. Effects are checked by the caller.
 */
export async function verifyOwnerSubmission(rpc: Rpc, attempt: { readonly txHash: string; readonly account: string; readonly target: string;
  readonly data: string; readonly preBlock: number; /** BUILD-FLOFI-BRIDGE-LIVE-FIX-003: the reviewed native value (hex); absent: 0. */ readonly value?: string },
  tx: unknown, raw: Record<string, unknown>,
  /** EVM chain id of the reviewed call (Base Sepolia unless a flow names its chain, e.g. the Base mainnet router). */ chainId = 84532,
  /** OP Stack receipts must carry `l1Fee`; an Ethereum L1 receipt must not (BUILD-ETHEREUM-001). */ l1DataFee = true) {
  if (!isObject(tx)) fail('TRANSACTION_MISMATCH');
  const txFrom = address(tx.from), txTo = address(tx.to), txInput = hex(tx.input);
  const value = BigInt(attempt.value ?? '0x0');
  if (Number(quantity(tx.chainId)) !== chainId || hex(tx.hash) !== attempt.txHash || quantity(tx.value) !== value)
    fail('TRANSACTION_MISMATCH');
  const direct = txFrom === attempt.account && txTo === attempt.target && txInput === attempt.data;
  // A call that carries native ETH is only ever the owner's own direct transaction (no delegated re-entry may move that value).
  if (value > 0n && !direct) fail('TRANSACTION_MISMATCH');
  const delegationDepth = delegatedExecutionDepth(txInput, attempt.target, attempt.data);
  const authorizations = tx.authorizationList;
  const txType = direct ? null : hex(tx.type);
  const newlyAuthorized = txType === '0x4' && delegationDepth === 1 &&
    Array.isArray(authorizations) && authorizations.length === 1 && isObject(authorizations[0]) &&
    quantity(authorizations[0].chainId) === BigInt(chainId) && address(authorizations[0].address) === DELEGATOR_IMPL;
  // Owner already EIP-7702-delegated before this transaction (re-checked below at the prepared block): a type-2
  // redemption with no authorization list, redeemed directly (depth 1, as MetaMask sends on Base Sepolia, e.g.
  // 0x8248b684…5ccc) or through one redelegation (depth 2). The decoded inner call is still exactly the reviewed one.
  const alreadyDelegated = txType === '0x2' && (delegationDepth === 1 || delegationDepth === 2) &&
    !('authorizationList' in tx);
  const delegated = !direct && txFrom !== attempt.account && txTo === DELEGATION_MANAGER &&
    (newlyAuthorized || alreadyDelegated);
  if (!direct && !delegated) fail('TRANSACTION_MISMATCH');
  const status = Number(quantity(raw.status));
  const blockNumber = Number(quantity(raw.blockNumber));
  const gasUsed = quantity(raw.gasUsed), effectiveGasPrice = quantity(raw.effectiveGasPrice);
  const l1Fee = l1DataFee ? quantity(raw.l1Fee) : raw.l1Fee === undefined ? 0n : fail('RECEIPT_INVALID');
  if (![0, 1].includes(status) || !Number.isSafeInteger(blockNumber) || blockNumber < attempt.preBlock ||
      hex(raw.transactionHash) !== attempt.txHash || address(raw.from) !== txFrom ||
      address(raw.to) !== txTo || !HASH.test(hex(raw.blockHash))) fail('RECEIPT_INVALID');
  // Canonical inclusion before a receipt can become evidence. A preconfirmed receipt (Base Flashblocks) carries an
  // all-zero block hash for a block that is not sealed yet; it, or any hash that is not the canonical block at that
  // height containing this transaction, is not final: callers keep observing (RECEIPT_NOT_CANONICAL is never a mismatch).
  const receiptBlockHash = hex(raw.blockHash);
  if (/^0x0{64}$/.test(receiptBlockHash)) fail('RECEIPT_NOT_CANONICAL');
  const canonical = await rpc('eth_getBlockByNumber', [blockHex(blockNumber), false]);
  if (!isObject(canonical) || typeof canonical.hash !== 'string' || canonical.hash.toLowerCase() !== receiptBlockHash ||
      typeof canonical.number !== 'string' || Number(quantity(canonical.number)) !== blockNumber || !Array.isArray(canonical.transactions) ||
      !canonical.transactions.some(entry => (isObject(entry) ? entry.hash : entry) === attempt.txHash) ||
      typeof tx.blockHash === 'string' && tx.blockHash.toLowerCase() !== receiptBlockHash) fail('RECEIPT_NOT_CANONICAL');
  if (delegated) {
    const block = blockHex(blockNumber);
    // Account code may legitimately be empty (`0x`); an empty or different code is a mismatch, not an RPC failure.
    const code = (value: unknown) => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value) ? value.toLowerCase() : fail('RPC_RESPONSE_INVALID');
    const [managerCode, ownerCode, previousOwnerCode] = await Promise.all([
      rpc('eth_getCode', [DELEGATION_MANAGER, block]).then(code),
      rpc('eth_getCode', [attempt.account, block]).then(code),
      alreadyDelegated ? rpc('eth_getCode', [attempt.account, blockHex(attempt.preBlock)]).then(code) : Promise.resolve(null),
    ]);
    if (managerCode === '0x' || managerCode === '0x0' || ownerCode !== '0xef0100' + DELEGATOR_IMPL.slice(2))
      fail('TRANSACTION_MISMATCH');
    if (alreadyDelegated && previousOwnerCode !== ownerCode) fail('TRANSACTION_MISMATCH');
    if (status === 1) {
      if (!Array.isArray(raw.logs)) fail('RECEIPT_INVALID');
      const redeemed = raw.logs.filter(log => isObject(log) && address(log.address) === DELEGATION_MANAGER &&
        Array.isArray(log.topics) && log.topics[0] === REDEEMED_TOPIC);
      if (redeemed.length !== delegationDepth || redeemed.some(log => !isObject(log) ||
          !Array.isArray(log.topics) || topicAddress(log.topics[1]) !== attempt.account))
        fail('TRANSACTION_MISMATCH');
      const redeemers = redeemed.map(log => topicAddress((log as { topics: unknown[] }).topics[2]));
      if (delegationDepth === 1 ? redeemers[0] !== txFrom :
          redeemers.filter(value => value === attempt.account).length !== 1 ||
          redeemers.filter(value => value === txFrom).length !== 1) fail('TRANSACTION_MISMATCH');
    }
  }
  return { direct, delegated, delegationDepth: delegated ? delegationDepth! : 0, txFrom, txTo, txInput, status: status as 0 | 1, blockNumber,
    gasUsed, effectiveGasPrice, l1Fee, nonce: quantity(tx.nonce),
    /** BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: how the reviewed call reached the chain (relayed shapes carry no owner nonce or fee). */
    submission: direct ? 'DIRECT' as const : newlyAuthorized ? 'DELEGATED_NEW_AUTHORIZATION' as const : 'DELEGATED_EXISTING' as const };
}
/**
 * Bounds of the relayed-submission scan: blocks per `eth_getLogs` request; requests per lost-hash discovery poll (it repeats while unresolved);
 * requests for the one-off duplicate checks before a receipt becomes evidence or a refused attempt is retried (~5.8 days on Arbitrum One,
 * ~9 months on Ethereum). A duplicate check that cannot cover the whole window never passes: the attempt stays pending.
 */
const RELAY_SCAN_BLOCKS = 5_000, RELAY_SCAN_REQUESTS = 40, RELAY_DUPLICATE_SCAN_REQUESTS = 400;
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: every relayed execution of an attempt's exact reviewed call by this owner since `fromBlock`. A relayed
 * redemption does not use the owner's nonce, so nonce discovery cannot see it; the Delegation Manager's `RedeemedDelegation` logs naming the
 * owner as root delegator are the candidates, and only those `verifyOwnerSubmission` proves to execute exactly the reviewed call count. A
 * transaction already credited to another attempt (another run's identical call) is that attempt's, not this one's. `waiting`: a candidate is
 * not canonical yet (or its receipt is not served yet), so the answer is not final. The scan is bounded (RELAY_SCAN_REQUESTS × RELAY_SCAN_BLOCKS
 * blocks): `complete` is false when it stopped before the head, and nothing is then assumed about the rest.
 */
async function relayedExecutions(rpc: Rpc, P: SwapProfile, attempt: Pick<PublicAttempt, 'account' | 'tx'>, fromBlock: number,
  claimedElsewhere: (txHash: string) => Promise<boolean>, maxRequests = RELAY_SCAN_REQUESTS):
  Promise<{ readonly verified: readonly string[]; readonly unclassified: readonly string[]; readonly waiting: boolean; readonly complete: boolean }> {
  const head = Number(quantity(await rpc('eth_blockNumber', [])));
  if (!Number.isSafeInteger(head) || head < fromBlock) fail('RPC_RESPONSE_INVALID');
  const ownerTopic = '0x' + addrWord(attempt.account), candidates = new Set<string>();
  let from = fromBlock;
  for (let request = 0; from <= head && request < maxRequests; from += RELAY_SCAN_BLOCKS, request++) {
    const logs = await rpc('eth_getLogs', [{ address: DELEGATION_MANAGER, topics: [REDEEMED_TOPIC, ownerTopic],
      fromBlock: blockHex(from), toBlock: blockHex(Math.min(head, from + RELAY_SCAN_BLOCKS - 1)) }]);
    if (!Array.isArray(logs)) fail('RPC_RESPONSE_INVALID');
    for (const log of logs) {
      if (!isObject(log) || address(log.address) !== DELEGATION_MANAGER || !Array.isArray(log.topics) || log.topics[0] !== REDEEMED_TOPIC ||
          topicAddress(log.topics[1]) !== attempt.account) fail('RPC_RESPONSE_INVALID');
      if (log.removed !== true) candidates.add(hex(log.transactionHash));
    }
  }
  const verified: string[] = [], unclassified: string[] = [];
  let waiting = false;
  for (const txHash of candidates) {
    const [tx, raw] = await Promise.all([rpc('eth_getTransactionByHash', [txHash]), rpc('eth_getTransactionReceipt', [txHash])]);
    if (!isObject(raw)) { waiting = true; continue; }
    if (await claimedElsewhere(txHash)) continue;
    try {
      await verifyOwnerSubmission(rpc, { txHash, account: attempt.account, target: attempt.tx.to, data: attempt.tx.data, preBlock: fromBlock,
        value: attempt.tx.value }, tx, raw, P.chainId, P.l1DataFee);
    } catch (cause) {
      if (cause instanceof Error && cause.message === 'RECEIPT_NOT_CANONICAL') { waiting = true; continue; }
      if (!(cause instanceof Error && cause.message === 'TRANSACTION_MISMATCH')) throw cause;
      // Not the reconcilable shape, but a successful owner-rooted redemption whose input still carries the reviewed call's exact bytes (for
      // example the call batched with a fee payment) may have executed it: never ignored, never reconciled.
      if (Number(quantity(raw.status)) === 1 && isObject(tx) && hex(tx.input).includes(attempt.tx.data.toLowerCase().slice(2))) unclassified.push(txHash);
      continue;
    }
    verified.push(txHash);
  }
  return { verified, unclassified, waiting, complete: from > head };
}
function signed(value: bigint): bigint { return value >= 1n << 255n ? value - (1n << 256n) : value; }
export function publicRecordingEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.GRYLOO_PUBLIC_TESTNET === 'record' && env.NODE_ENV === 'development' &&
    typeof env.GRYLOO_PUBLIC_TESTNET_JOURNAL === 'string' && isAbsolute(env.GRYLOO_PUBLIC_TESTNET_JOURNAL);
}
export function explorerUrl(txHash: string, profile: SwapProfile = BASE_SEPOLIA): string { if (!HASH.test(txHash)) fail('TX_HASH_INVALID'); return profile.explorer + txHash; }
/** Persistence used by the shared core: synchronous files locally, async shared storage in the cloud. */
type Persistence = { readonly save: (run: PublicRun) => PublicRun | Promise<PublicRun>; readonly load: (id: string) => PublicRun | Promise<PublicRun>;
  readonly locked: <T>(id: string, action: () => Promise<T>) => Promise<T>;
  readonly reserveNonce: (run: PublicRun, owner: SwapOwnerReview, released: NonceRelease) => Promise<void>;
  /**
   * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: one on-chain transaction is credited to at most one attempt. A direct submission is bound to its
   * attempt by the reviewed owner nonce; a relayed redemption carries no owner nonce, so its hash is claimed once (create-once, never released).
   * `claim` resolves true when the transaction is (now or already) this attempt's, false when another attempt holds it.
   */
  readonly claims: { readonly claim: (chainId: number, txHash: string, holder: TransactionClaim) => Promise<boolean>;
    readonly holder: (chainId: number, txHash: string) => Promise<TransactionClaim | null> } };
type TransactionClaim = { readonly id: string; readonly attemptId: string };
function transactionClaims(storage: ExecutionStorage): Persistence['claims'] {
  const name = (chainId: number, txHash: string) => { if (!HASH.test(txHash)) fail('TX_HASH_INVALID'); return `claim-${chainId}-${txHash}.tx`; };
  const parse = (bytes: Uint8Array): TransactionClaim => {
    const value = JSON.parse(utf8(bytes)) as unknown;
    if (!isObject(value) || typeof value.id !== 'string' || typeof value.attemptId !== 'string') fail('PUBLIC_STORE_CORRUPT');
    return { id: value.id, attemptId: value.attemptId };
  };
  const holder = async (chainId: number, txHash: string) => { const bytes = await storage.log.read(name(chainId, txHash)); return bytes ? parse(bytes) : null; };
  return { holder, claim: async (chainId, txHash, claim) => {
    if (await storage.log.create(name(chainId, txHash), new TextEncoder().encode(JSON.stringify({ id: claim.id, attemptId: claim.attemptId }) + '\n'))) return true;
    const existing = await holder(chainId, txHash) ?? fail('PUBLIC_STORE_CORRUPT');
    return existing.id === claim.id && existing.attemptId === claim.attemptId;
  } };
}
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: whether the run holding a nonce intent provably never used that owner nonce, so a newer reviewed
 * transaction may take the reservation over (`relayedNonceRelease`). Returns the attempt that proves it, or null.
 */
type NonceRelease = (holderId: string, nonce: string, transaction: Tx) => Promise<{ readonly attemptId: string; readonly txHash: string } | null>;
type NonceIntent = { readonly id: string; readonly transaction: Tx; readonly supersedes?: string; readonly release?: { readonly attemptId: string; readonly txHash: string } };
/** The intent log: one reservation, then only evidence-carrying hand-overs, each superseding the line before it. */
function nonceIntents(bytes: Uint8Array): NonceIntent[] {
  const text = utf8(bytes);
  if (!text.endsWith('\n')) fail('PUBLIC_STORE_CORRUPT');
  const lines = text.trimEnd().split('\n').map(line => JSON.parse(line) as NonceIntent);
  lines.forEach((line, index) => {
    if (!isObject(line) || typeof line.id !== 'string' || !isObject(line.transaction) || (index === 0) !== (line.supersedes === undefined) ||
        index > 0 && (line.supersedes !== lines[index - 1]!.id || !isObject(line.release) || typeof line.release.attemptId !== 'string' || !HASH.test(String(line.release.txHash))))
      fail('PUBLIC_STORE_CORRUPT');
  });
  return lines;
}
/**
 * A permanent nonce intent survives restarts/unknown wallet results. No worker can release it or submit anything.
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: a reservation is never released because a relay transaction was merely observed. A newer reviewed
 * transaction takes it over only when the holder's own verified receipts prove that the owner nonce was never used (`released`), and the
 * hand-over is appended with that evidence (the earlier lines stay).
 */
function nonceReservation(storage: ExecutionStorage): Persistence['reserveNonce'] {
  return async (run, owner, released) => {
    const key = `swap-${run.quote.chainId}-${owner.account}-${owner.nonce}`;
    await storage.leases.hold(key, async () => {
      const existing = await storage.log.read(key + '.intent');
      const line = (extra: Partial<NonceIntent> = {}) => JSON.stringify({ id: run.quote.executionId, transaction: owner.transaction, ...extra }) + '\n';
      if (existing) {
        const intents = nonceIntents(existing), intent = intents.at(-1)!;
        const last = run.attempts.at(-1);
        // Only this run's identical call, after an explicit pre-broadcast wallet refusal, can reuse its intent.
        if (intent.id === run.quote.executionId && canonical(intent.transaction) === canonical(owner.transaction) &&
            last?.state === 'REJECTED' && !last.txHash && last.tx.nonce === owner.transaction.nonce) return;
        const release = await released(intent.id, owner.nonce, intent.transaction);
        if (!release) fail('SWAP_NONCE_ALREADY_RESERVED');
        await storage.log.extend(key + '.intent', new TextEncoder().encode(utf8(existing) + line({ supersedes: intent.id, release: release! })), bytes => { nonceIntents(bytes); });
        return;
      }
      if (!await storage.log.create(key + '.intent', new TextEncoder().encode(line())))
        fail('SWAP_NONCE_ALREADY_RESERVED');
    });
  };
}
/**
 * BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: whether the run holding the reservation of owner nonce `nonce` for `transaction` provably never used
 * that nonce. True only when the reserved transaction itself reached the chain as a verified relayed redemption (the relayer, not the owner,
 * sent it; no owner nonce is consumed) with a canonical receipt, single use and fully reconciled, every other attempt the
 * holder made at that nonce is either such a relayed submission or an explicit pre-broadcast wallet refusal, and the holder recorded no
 * divergence. A pending, unknown, unreconciled or direct attempt keeps the reservation, so does an observed relay that is not yet verified.
 */
export function relayedNonceRelease(holder: Pick<PublicRun, 'attempts' | 'divergence'>, nonce: string, transaction: Tx): { attemptId: string; txHash: string } | null {
  if (holder.divergence) return null;
  const atNonce = holder.attempts.filter(a => a.tx.nonce !== undefined && BigInt(a.tx.nonce) === BigInt(nonce));
  const relayed = (a: PublicAttempt) => a.txHash !== null && a.receipt !== null && a.receipt.transactionHash === a.txHash &&
    a.receipt.submissionKind === 'DELEGATED_SINGLE' && a.receipt.delegationDepth === 1 && a.receipt.gasPayer !== a.account && a.receipt.from !== a.account &&
    a.state === 'CONFIRMED' && a.receipt.status === 1 && a.nativeAfter !== null;
  if (!atNonce.every(a => relayed(a) || a.state === 'REJECTED' && a.txHash === null)) return null;
  const proof = atNonce.find(a => relayed(a) && canonical(a.tx) === canonical(transaction));
  return proof ? { attemptId: proof.attemptId, txHash: proof.txHash! } : null;
}
/** Pure Review transition, shared by the local and the durable service. */
/** Legacy quotes remain readable for recovery/evidence, but cannot create fresh financial authority. */
function assertCanonicalQuote(run: PublicRun): void {
  if (run.quote.revision !== run.workflow.revision || run.quote.workflowHash !==
      hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(run.workflow))))
    fail('WORKFLOW_BINDING_REQUIRES_SIMULATION');
  if (ownerBoundSwapReview(profileOf(run.quote.chainId))) {
    const { manifestHash, ...fields } = run.quote;
    if (manifestHash !== digest(canonical(fields))) fail('QUOTE_BINDING_INVALID');
  }
}
export function reviewPublicRun(run: PublicRun, manifestHash: string, now: Date): PublicRun {
  assertCanonicalQuote(run);
  if (ownerBoundSwapReview(profileOf(run.quote.chainId)) && !run.quote.ownerReview) fail('OWNER_SIMULATION_REQUIRED');
  if (run.divergence) fail('RECONCILIATION_MISMATCH');
  if (run.quote.manifestHash !== manifestHash || now.getTime() >= Date.parse(run.quote.expiresAt) ||
      run.attempts.some(a => a.step === 'swap' || ['PREPARED', 'HASH', 'PENDING', 'UNKNOWN'].includes(a.state)))
    fail('REVIEW_EXPIRED');
  return { ...run, reviewedManifestHash: manifestHash };
}
/** Pure wallet-result transition, shared by the local and the durable service. */
export function reportPublicRun(run: PublicRun, attemptId: string, result: { kind: 'HASH'; txHash: string } | { kind: 'REJECTED' | 'UNKNOWN' }, now: Date): PublicRun {
  const target = run.attempts.find(a => a.attemptId === attemptId);
  if (!target || !['PREPARED', 'UNKNOWN'].includes(target.state) || target.state === 'UNKNOWN' && result.kind !== 'HASH') fail('ATTEMPT_STATE_INVALID');
  if (result.kind === 'HASH' && !HASH.test(result.txHash)) fail('TX_HASH_INVALID');
  const changed: PublicAttempt = { ...target, state: result.kind === 'HASH' ? 'HASH' : result.kind,
    submittedAt: result.kind === 'HASH' ? now.toISOString() : null,
    txHash: result.kind === 'HASH' ? result.txHash : null };
  return { ...run, attempts: run.attempts.map(a => a.attemptId === attemptId ? changed : a) };
}
/** `rpc` is the Base Sepolia read client; `rpcs` adds one chain-bound read client per further swap profile (CAIP-2 keyed). */
export function createPublicTestnetService(config: { readonly rpc: Rpc; readonly rpcs?: Readonly<Partial<Record<string, Rpc>>>; readonly journalDir: string; readonly now?: () => Date;
  /** BUILD-RH-002: the catalog runtime (Robinhood Chain); without it a catalog swap fails closed. */ readonly catalog?: CatalogSwapRuntime;
  readonly idPrefix?: SwapRunPrefix }) {
  const { journalDir } = config;
  const idPattern = runIdPattern(config.idPrefix ?? 'pub');
  const now = config.now ?? (() => new Date());
  if (!isAbsolute(journalDir)) fail('PUBLIC_JOURNAL_INVALID');
  mkdirSync(journalDir, { recursive: true, mode: 0o700 });
  const locks = new Set<string>();
  function save(run: PublicRun): PublicRun {
    const file = join(journalDir, run.quote.executionId + '.json');
    const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(run)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
    const dir = openSync(journalDir, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
    return run;
  }
  function load(id: string): PublicRun {
    if (!idPattern.test(id)) fail('EXECUTION_ID_INVALID');
    const file = join(journalDir, id + '.json');
    if (!existsSync(file)) fail('EXECUTION_NOT_FOUND');
    return JSON.parse(readFileSync(file, 'utf8')) as PublicRun;
  }
  async function locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (locks.has(id)) fail('EXECUTION_BUSY');
    const lockFile = join(journalDir, id + '.lock');
    let fd: number;
    try { fd = openSync(lockFile, 'wx', 0o600); } catch { fail('EXECUTION_BUSY'); }
    closeSync(fd);
    locks.add(id);
    try { return await action(); } finally { locks.delete(id); unlinkSync(lockFile); }
  }
  const storage = createFileExecutionStorage(journalDir, 'EXECUTION_BUSY');
  const core = createPublicTestnetCore(rpcRouter(config), now, { save, load, locked,
    reserveNonce: nonceReservation(storage), claims: transactionClaims(storage) }, config.catalog, config.idPrefix ?? 'pub');
  const review = (id: string, manifestHash: string): PublicRun => save(reviewPublicRun(load(id), manifestHash, now()));
  const report = (id: string, attemptId: string, result: { kind: 'HASH'; txHash: string } | { kind: 'REJECTED' | 'UNKNOWN' }): PublicRun =>
    save(reportPublicRun(load(id), attemptId, result, now()));
  return { ...core, review, report, load,
    list: () => readdirSync(journalDir).filter(file => file.endsWith('.json') && idPattern.test(file.slice(0, -5))).map(file => file.slice(0, -5)) };
}
export type PublicTestnetService = ReturnType<typeof createPublicTestnetService>;

/**
 * BUILD-CLOUD-001: the same swap service on shared durable storage. Every snapshot is appended to an
 * append-only log (`<id>.jsonl`) under fenced leases, so N API/worker instances can serve one run and its full
 * history survives. Every mutation, including Review and wallet results, runs under the run lease.
 */
export function createDurablePublicTestnetService(config: { readonly rpc: Rpc; readonly rpcs?: Readonly<Partial<Record<string, Rpc>>>; readonly storage: ExecutionStorage; readonly now?: () => Date;
  readonly catalog?: CatalogSwapRuntime; readonly idPrefix?: SwapRunPrefix }) {
  const now = config.now ?? (() => new Date()), { log, leases } = config.storage;
  const idPattern = runIdPattern(config.idPrefix ?? 'pub');
  const name = (id: string) => { if (!idPattern.test(id)) fail('EXECUTION_ID_INVALID'); return id + '.jsonl'; };
  const validate = (bytes: Uint8Array) => validatePublicRunLog(bytes);
  async function load(id: string): Promise<PublicRun> {
    const bytes = await log.read(name(id));
    if (!bytes) fail('EXECUTION_NOT_FOUND');
    validate(bytes);
    const run = JSON.parse(utf8(bytes).trimEnd().split('\n').at(-1)!) as PublicRun;
    if (run.quote.executionId !== id) fail('PUBLIC_STORE_CORRUPT');
    return run;
  }
  async function save(run: PublicRun): Promise<PublicRun> {
    const file = name(run.quote.executionId);
    await log.extend(file, new TextEncoder().encode(utf8(await log.read(file)) + JSON.stringify(run) + '\n'), validate);
    return run;
  }
  const locked = <T,>(id: string, action: () => Promise<T>): Promise<T> => leases.hold(name(id).slice(0, -6), action);
  const core = createPublicTestnetCore(rpcRouter(config), now, { save, load, locked, reserveNonce: nonceReservation(config.storage),
    claims: transactionClaims(config.storage) }, config.catalog, config.idPrefix ?? 'pub');
  return { ...core, load,
    review: (id: string, manifestHash: string) => locked(id, async () => save(reviewPublicRun(await load(id), manifestHash, now()))),
    report: (id: string, attemptId: string, result: { kind: 'HASH'; txHash: string } | { kind: 'REJECTED' | 'UNKNOWN' }) =>
      locked(id, async () => save(reportPublicRun(await load(id), attemptId, result, now()))) };
}
export type DurablePublicTestnetService = ReturnType<typeof createDurablePublicTestnetService>;

/** The read client of a profile's chain; a chain without a configured client is not enabled and fails closed. */
function rpcRouter(config: { readonly rpc: Rpc; readonly rpcs?: Readonly<Partial<Record<string, Rpc>>> }): (profile: SwapProfile) => Rpc {
  return profile => config.rpcs?.[profile.chainRef] ?? (profile.chainRef === BASE_SEPOLIA.chainRef ? config.rpc : fail('PUBLIC_NETWORK_UNAVAILABLE'));
}
/** Append-only snapshot history: identity, authorized calls, hashes and terminal results never change. */
export function validatePublicRunLog(bytes: Uint8Array): void {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n') || bytes.length > 16_777_216) fail('PUBLIC_STORE_CORRUPT');
  let prior: PublicRun | null = null;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  for (const line of text.trimEnd().split('\n')) {
    const run = JSON.parse(line) as PublicRun;
    const profile = isObject(run) && isObject(run.quote) ? swapProfile(run.quote.chainId as number) : null;
    if (!isObject(run) || !isObject(run.quote) || !profile || !runIdPattern(prefixFor(profile)).test(String(run.quote.executionId)) ||
        !isObject(run.workflow) || !Array.isArray(run.attempts) || run.attempts.length > 8 || (run.outcome !== null && !isObject(run.outcome)) ||
        run.attempts.some(a => !isObject(a) || a.executionId !== run.quote.executionId || a.chainId !== run.quote.chainId || !ADDRESS.test(String(a.account)) ||
          (a.txHash !== null && !HASH.test(String(a.txHash)))) || new Set(run.attempts.map(a => a.attemptId)).size !== run.attempts.length)
      fail('PUBLIC_STORE_CORRUPT');
    if (ownerBoundSwapReview(profile)) {
      assertCanonicalQuote(run);
      if (run.reviewedManifestHash !== null && run.reviewedManifestHash !== run.quote.manifestHash ||
          run.attempts.some(a => !run.quote.ownerReview || a.account !== run.quote.ownerReview.account || a.tx.chainId !== profile.chainHex ||
            a.tx.from !== a.account || a.calldataDigest !== digest(a.tx.data))) fail('PUBLIC_STORE_CORRUPT');
    }
    if (prior) {
      if (run.quote.executionId !== prior.quote.executionId || run.quote.chainId !== prior.quote.chainId || !same(run.workflow, prior.workflow) || run.attempts.length < prior.attempts.length ||
          prior.outcome && !same(run.outcome, prior.outcome) || prior.divergence && run.divergence !== prior.divergence) fail('PUBLIC_STORE_CORRUPT');
      for (const [index, before] of prior.attempts.entries()) {
        const after = run.attempts[index]!;
        if (after.attemptId !== before.attemptId || after.step !== before.step || after.account !== before.account || !same(after.tx, before.tx) ||
            after.authorizedInput !== before.authorizedInput || after.authorizedMinimumOutput !== before.authorizedMinimumOutput ||
            after.preBlock !== before.preBlock || before.txHash !== null && after.txHash !== before.txHash ||
            ['CONFIRMED', 'REVERTED', 'REJECTED'].includes(before.state) && after.state !== before.state) fail('PUBLIC_STORE_CORRUPT');
      }
    }
    prior = run;
  }
}

/**
 * BUILD-RH-002: the catalog runtime of a network whose swaps are authored from its official asset catalog. `catalogFor`
 * returns the freshly validated official catalog (it fails closed when the registry is unavailable or malformed);
 * `provenance` labels quotes and evidence (`MOCKED` for the loopback harness). Code pins may be replaced only by a MOCKED harness.
 */
export type CatalogSwapRuntime = { readonly catalogFor: (chain: string) => Promise<AssetCatalog>; readonly provenance: 'PUBLIC_MAINNET' | 'MOCKED';
  readonly codePins?: Partial<Record<string, string>>; readonly executionEnabled: boolean;
  /** BUILD-FLOFI-EXECUTION-PERFORMANCE-001: verified immutable deployment facts; undefined = the process cache on public mainnets, null = off. */
  readonly deploymentFacts?: DeploymentFactCache | null };
/**
 * BUILD-FLOFI-EXECUTION-PERFORMANCE-001: positive verifications of IMMUTABLE deployment facts, remembered per process for a bounded time so a
 * quote does not re-read them through the paced transport on every keystroke and every Review. Only facts the EVM cannot change once true are
 * kept: a pinned contract's runtime code (a contract created by CREATE/CREATE2 keeps its code: no SELFDESTRUCT removal since EIP-6780, no
 * CREATE2 redeploy; an EIP-7702 delegation designator on an account CAN change, so it is never remembered), the immutables compiled into that code
 * (a router's/quoter's factory and WETH9, a pool's factory/token0/token1/fee), a listed token having code, and a CREATE2 pool having code.
 * Failures are never remembered. Liquidity, slot0, the quoter's output, token decimals, Stock Token state, the head, balances, nonces, gas and
 * the reorg check are always read fresh at the quote's pinned block. Keys carry the chain and the expected pin.
 */
export type DeploymentFactCache = { readonly has: (key: string, nowMs: number) => boolean; readonly add: (key: string, nowMs: number) => void };
export function createDeploymentFactCache(ttlMs = 600_000, limit = 1_024): DeploymentFactCache {
  const verified = new Map<string, number>();
  return {
    has: (key, nowMs) => { const at = verified.get(key); if (at === undefined) return false; if (nowMs - at < ttlMs && nowMs >= at) return true; verified.delete(key); return false; },
    add: (key, nowMs) => { verified.delete(key); verified.set(key, nowMs); while (verified.size > limit) verified.delete(verified.keys().next().value!); },
  };
}
const PUBLIC_DEPLOYMENT_FACTS = createDeploymentFactCache();
const deploymentFactsOf = (runtime: CatalogSwapRuntime): DeploymentFactCache | null =>
  runtime.deploymentFacts !== undefined ? runtime.deploymentFacts : runtime.provenance === 'PUBLIC_MAINNET' ? PUBLIC_DEPLOYMENT_FACTS : null;
const sha256Hex = (code: string) => createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
/** One side of a catalog swap: the current official catalog must still map the authored identity exactly. */
function catalogSide(catalog: AssetCatalog, ref: CatalogAssetRef, side: 'input' | 'output'): CanonicalAsset {
  // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: the network's native ETH, by the catalog's own NATIVE entry (never its WETH).
  if (ref.address === null) {
    const native = catalogAsset(catalog, { symbol: 'ETH' });
    if (!native || native.kind !== 'NATIVE' || native.decimals !== 18 || native.chain !== catalog.chain) fail('CATALOG_ASSET_IDENTITY_CHANGED');
    return native;
  }
  const asset = catalogAsset(catalog, { address: ref.address });
  if (!asset || asset.chain !== catalog.chain || asset.chainId !== catalog.chainId || asset.kind !== 'ERC20' || asset.decimals !== ref.decimals || (asset.stock?.officialId ?? null) !== ref.officialId)
    fail('CATALOG_ASSET_IDENTITY_CHANGED');
  if (asset.stock && side === 'output' && !asset.stock.trading.acquirable) fail('STOCK_TOKEN_NOT_ACQUIRABLE');
  if (asset.stock && side === 'input' && !asset.stock.trading.disposable) fail('STOCK_TOKEN_NOT_DISPOSABLE');
  return asset;
}
/**
 * BUILD-BASE-001: how a catalog network's tokens are verified on chain. `pinnedTokens` maps each code-pinned base asset (by address) to its
 * runtime SHA-256; `listedTokens` says what any other non-issuer asset needs — `REFUSE` (Robinhood Chain: only its pinned assets and Stock
 * Tokens exist) or `CODE_AND_DECIMALS` (Base: a listed token must have code and report exactly the catalog's decimals); `stockToken` is the
 * Robinhood Stock Token beacon policy (null elsewhere).
 */
export type CatalogTokenPolicy = { readonly pinnedTokens: Readonly<Record<string, string>>; readonly listedTokens: 'REFUSE' | 'CODE_AND_DECIMALS';
  readonly stockToken: { readonly beacon: string; readonly beaconSlot: string; readonly proxySha256: string } | null };
/** The token policy of a catalog swap profile; a MOCKED harness may replace code pins (never a public run). */
export function catalogTokenPolicy(P: CatalogSwapProfile, codePins: Partial<Record<string, string>> = {}): CatalogTokenPolicy {
  const pins: Record<string, string> = { ...P.codeSha256 };
  for (const [key, value] of Object.entries(codePins)) if (value) pins[key] = value;
  return { pinnedTokens: Object.fromEntries(Object.entries(P.pinnedTokens).map(([token, key]) => [token, pins[key]!])), listedTokens: P.listedTokens,
    stockToken: 'stockTokenBeacon' in P ? { beacon: P.stockTokenBeacon, beaconSlot: P.beaconSlot, proxySha256: pins.stockTokenProxy! } : null };
}
/**
 * BUILD-RH-002: one official catalog ERC-20 verified at a pinned block, shared by catalog swaps and catalog liquidity. A pinned base asset
 * (USDG and WETH on Robinhood Chain, USDC and WETH on Base) must carry its pinned code; every Stock Token must be the official beacon proxy on
 * the official beacon and report the registry's uid, and its onchain multiplier must equal the registry's. A change scheduled to take effect
 * before the Review expires fails closed (STOCK_MULTIPLIER_CHANGE_PENDING). BUILD-BASE-001: a listed Base token must have code and report the
 * catalog's decimals (listing is never authority). Returns the Stock Token state the Review binds, or null for any other asset. Read-only.
 */
export async function verifyCatalogToken(rpc: Rpc, policy: CatalogTokenPolicy, asset: CanonicalAsset, side: StockQuoteState['side'],
  block: string, headTime: number, reviewTtlSeconds: number, now: () => Date,
  facts: { readonly cache: DeploymentFactCache; readonly chainId: number; readonly learn: (key: string) => void } | null = null): Promise<StockQuoteState | null> {
  const call = async (to: string, data: string) => hex(await rpc('eth_call', [{ to, data }, block]));
  const word0 = (value: string) => value.length >= 66 ? BigInt(value.slice(0, 66)) : fail('RPC_RESPONSE_INVALID');
  const addressOf = (value: string) => address('0x' + value.slice(-40));
  // A non-Stock token's code check is an immutable fact (its pinned hash, or for a listed token that code exists); decimals stay a fresh read.
  const pin = asset.stock ? undefined : policy.pinnedTokens[asset.address!];
  const factKey = facts && !asset.stock && (pin !== undefined || policy.listedTokens === 'CODE_AND_DECIMALS')
    ? `${facts.chainId}:token-code:${asset.address!.toLowerCase()}:${pin ?? 'listed'}` : null;
  const known = factKey !== null && facts!.cache.has(factKey, now().getTime());
  const code = known ? null : await rpc('eth_getCode', [asset.address, block]);
  if (!known && (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code))) fail('RPC_RESPONSE_INVALID');
  if (!known && code === '0x') fail('CONTRACT_CODE_MISSING');
  const tokenCode = known ? null : sha256Hex((code as string).toLowerCase());
  if (BigInt(await call(asset.address!, '0x313ce567')) !== BigInt(asset.decimals)) fail('TOKEN_METADATA_MISMATCH');
  if (!asset.stock) {
    if (!known && (pin !== undefined ? tokenCode !== pin : policy.listedTokens !== 'CODE_AND_DECIMALS')) fail('TOKEN_DEPLOYMENT_MISMATCH');
    // An EIP-7702 delegation designator (`0xef0100‖delegate`) is code an account can later change or clear: never remembered as a fact.
    if (factKey !== null && !known && !(code as string).toLowerCase().startsWith('0xef0100')) facts!.learn(factKey);
    return null;
  }
  // Every official Stock Token is the same beacon proxy on the official beacon, and reports the registry's uid.
  const stockPolicy = policy.stockToken ?? fail('STOCK_TOKEN_DEPLOYMENT_MISMATCH');
  if (tokenCode !== stockPolicy.proxySha256 || addressOf(hex(await rpc('eth_getStorageAt', [asset.address, stockPolicy.beaconSlot, block]))) !== stockPolicy.beacon)
    fail('STOCK_TOKEN_DEPLOYMENT_MISMATCH');
  if ('0x' + word0(await call(asset.address!, '0xf514ce36')).toString(16).padStart(64, '0') !== asset.stock.officialId) fail('STOCK_TOKEN_IDENTITY_MISMATCH');
  const multiplier = word0(await call(asset.address!, '0xa60bf13d')), scheduled = word0(await call(asset.address!, '0xdc767007'));
  const effectiveAt = Number(word0(await call(asset.address!, '0x97a4064f')));
  if (multiplier <= 0n || !Number.isSafeInteger(effectiveAt)) fail('STOCK_MULTIPLIER_INVALID');
  // The registry and the chain must agree on the multiplier the Review shows; a disagreement is not resolved by guessing.
  if (multiplier.toString() !== asset.stock.multiplierWad) fail('STOCK_MULTIPLIER_MISMATCH');
  // A scheduled change that takes effect before this Review can be executed would change the economic meaning under it.
  const reviewEnd = Math.floor(now().getTime() / 1000) + reviewTtlSeconds;
  const registryPending = asset.stock.pendingEffectiveTime ? Math.floor(Date.parse(asset.stock.pendingEffectiveTime) / 1000) : null;
  if ((scheduled !== multiplier && effectiveAt > headTime && effectiveAt <= reviewEnd) || (registryPending !== null && registryPending <= reviewEnd))
    fail('STOCK_MULTIPLIER_CHANGE_PENDING');
  return { side, symbol: asset.symbol, token: asset.address!, officialId: asset.stock.officialId, multiplierWad: multiplier.toString(),
    scheduledMultiplierWad: scheduled.toString(), scheduledEffectiveAt: effectiveAt, registryMultiplierWad: asset.stock.multiplierWad,
    registryPendingMultiplierWad: asset.stock.pendingMultiplierWad, registryPendingEffectiveTime: asset.stock.pendingEffectiveTime,
    fractionalRestricted: asset.stock.trading.fractionalRestricted };
}
/** The Base mainnet reference registry context (the DApp's initial context): Base USDC and WETH of the BUILD-002 reference swap. */
const baseReferenceContext = () => createReviewContext({ registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id,
  actionId: referenceRegistry.actions[0]!.id, assets: baseAssetRegistry });
/**
 * The swap node of a catalog-network workflow and its fields: a canonical catalog swap, or (BUILD-BASE-001) Base's USDC ⇄ WETH reference
 * swap, validated by the reference registry exactly as before and read into the same fields. One isolated swap; anything else fails closed.
 */
function catalogSwapRead(workflow: SemanticWorkflow, P: CatalogSwapProfile): { node: SemanticWorkflow['nodes'][number]; fields: CatalogSwapFields } {
  const catalogNode = workflow.nodes.find(isCatalogSwapNode);
  if (catalogNode) {
    if (catalogNode.chainId !== P.chainRef) fail('PUBLIC_WORKFLOW_UNSUPPORTED');
    validateAuthoringWorkflow(workflow, createBaseSepoliaReviewContext());
    return { node: catalogNode, fields: readCatalogSwapNode(catalogNode) };
  }
  const financial = workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
  const node = financial.length === 1 && P.referencePair && financial[0]!.chainId === P.chainRef && isReferencePairSwap(financial[0]!) ? financial[0]! : fail('PUBLIC_WORKFLOW_UNSUPPORTED');
  validateAuthoringWorkflow(workflow, baseReferenceContext());
  const amount = node.inputs.find(p => p.name === 'amount-in'), out = node.inputs.find(p => p.name === 'asset-out');
  const slip = node.userConstraints.find(c => c.kind === 'MAXIMUM_SLIPPAGE_BPS');
  // The CoW variant names a second protocol; only the plain Uniswap declaration is this service's intent.
  if (amount?.kind !== 'QUANTITY' || !('address' in amount.value.asset) || out?.kind !== 'ASSET' || !('address' in out.value) || slip?.kind !== 'MAXIMUM_SLIPPAGE_BPS' ||
      node.adapterConstraints.protocols.join() !== 'uniswap' || slip.maximumBps < 1 || slip.maximumBps > 300) fail('PUBLIC_SWAP_INVALID');
  const ref = (asset: { chainId: string; address: string; decimals: number }) => ({ chain: asset.chainId, address: asset.address, decimals: asset.decimals, officialId: null });
  return { node, fields: { chain: node.chainId, input: ref(amount.value.asset), output: ref(out.value), amount: amount.value.amount, slippageBps: slip.maximumBps } };
}
/**
 * The catalog quote: official identity, deployment code, Stock Token uid and multiplier state, and every locally derived
 * canonical pool are read at one pinned block; the best live fee tier is bound with its pool. Read-only.
 */
async function catalogQuote(workflow: SemanticWorkflow, executionId: string, P: CatalogSwapProfile, rpc: Rpc, runtime: CatalogSwapRuntime, now: () => Date): Promise<PublicQuote> {
  const { node, fields } = catalogSwapRead(workflow, P);
  // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a side may be the network's native ETH; ETH ⇄ WETH9 is a WETH9 conversion (its own adapter, no pool).
  const kind = catalogSwapKind(fields), native = fields.input.address === null ? 'INPUT' as const : fields.output.address === null ? 'OUTPUT' as const : null;
  const cap = resolveWorkflowCapability(workflow, { environment: P.environment });
  if (!cap.executionSupported || cap.nodes.find(item => item.nodeId === node.nodeId)?.profile?.adapterId !== (kind === 'SWAP' ? 'uniswap.v3' : 'weth9.wrap')) fail('PUBLIC_WORKFLOW_UNSUPPORTED');
  const catalog = await runtime.catalogFor(P.chainRef);
  if (catalog.chain !== P.chainRef || catalog.chainId !== P.chainId) fail('CATALOG_NETWORK_MISMATCH');
  const input = catalogSide(catalog, fields.input, 'input'), output = catalogSide(catalog, fields.output, 'output');
  const mockedPins = runtime.provenance === 'MOCKED' ? runtime.codePins ?? {} : {};
  const pins: Record<string, string> = { ...P.codeSha256 };
  for (const [key, value] of Object.entries(mockedPins)) if (value) pins[key] = value;
  const policy = catalogTokenPolicy(P, mockedPins);
  const call = async (to: string, data: string, block: string) => hex(await rpc('eth_call', [{ to, data }, block]));
  const word0 = (value: string) => value.length >= 66 ? BigInt(value.slice(0, 66)) : fail('RPC_RESPONSE_INVALID');
  const addressOf = (value: string) => address('0x' + value.slice(-40));
  if (quantity(await rpc('eth_chainId', [])) !== BigInt(P.chainId)) fail('WRONG_PROVIDER_CHAIN');
  const head = await rpc('eth_getBlockByNumber', ['latest', false]);
  if (!isObject(head) || typeof head.number !== 'string' || typeof head.hash !== 'string' || typeof head.timestamp !== 'string') fail('RPC_RESPONSE_INVALID');
  const blockNumber = Number(quantity(head.number)), blockHash = hex(head.hash), block = blockHex(blockNumber), headTime = Number(quantity(head.timestamp));
  if (!Number.isSafeInteger(blockNumber) || !HASH.test(blockHash)) fail('RPC_RESPONSE_INVALID');
  const age = now().getTime() - headTime * 1000;
  if (age > 120_000 || age < -30_000) fail('STALE_CHAIN_HEAD');
  // Runtime code may legitimately be empty (`0x`): no contract there. Anything that is not even-length hex is a malformed answer.
  const codeAt = async (target: string) => { const value = await rpc('eth_getCode', [target, block]);
    return typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value) ? value.toLowerCase() : fail('RPC_RESPONSE_INVALID'); };
  const code = async (target: string) => { const value = await codeAt(target); return value === '0x' ? fail('CONTRACT_CODE_MISSING') : value; };
  // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: immutable deployment facts verified earlier in this process are not re-read (see DeploymentFactCache).
  // Facts verified by this quote are remembered only once its final same-block check passed (a reorged-out deployment is never remembered).
  const facts = deploymentFactsOf(runtime), factKey = (key: string) => `${P.chainId}:${key}`, verified: string[] = [];
  const known = (key: string) => facts !== null && facts.has(factKey(key), now().getTime());
  const learn = (key: string) => { if (facts) verified.push(factKey(key)); };
  for (const [name, target] of [['factory', P.factory], ['router', P.router], ['quoter', P.quoter]] as const) {
    const key = `protocol-code:${name}:${target}:${pins[name]}`;
    if (known(key)) continue;
    if (sha256Hex(await code(target)) !== pins[name]) fail('PROTOCOL_DEPLOYMENT_MISMATCH');
    learn(key);
  }
  // A router's and quoter's factory/WETH9 are immutables compiled into their pinned code.
  const pointers = `protocol-pointers:${P.quoter}:${P.router}:${P.factory}:${P.weth}:${pins.quoter}:${pins.router}`;
  if (!known(pointers)) {
    for (const target of [P.quoter, P.router])
      if (addressOf(await call(target, '0xc45a0155', block)) !== P.factory || addressOf(await call(target, '0x4aa4a4fc', block)) !== P.weth) fail('PROTOCOL_DEPLOYMENT_MISMATCH');
    learn(pointers);
  }
  const stocks: StockQuoteState[] = [];
  for (const [side, asset] of [['input', input], ['output', output]] as const) {
    if (asset.kind === 'NATIVE') continue;
    const stock = await verifyCatalogToken(rpc, policy, asset, side, block, headTime, P.reviewTtlSeconds, now,
      facts ? { cache: facts, chainId: P.chainId, learn: key => verified.push(key) } : null);
    if (stock) stocks.push(stock);
  }
  // Native ETH travels through the router's WETH9 (the router's own `WETH9()`, checked above): it must carry its pinned code.
  const wethKey = `weth-code:${P.weth}:${pins.weth}`;
  if (native && !known(wethKey)) { if (sha256Hex(await code(P.weth)) !== pins.weth) fail('TOKEN_DEPLOYMENT_MISMATCH'); learn(wethKey); }
  const amountIn = BigInt(fields.amount);
  const routeToken = (asset: CanonicalAsset) => asset.kind === 'NATIVE' ? P.weth : asset.address!;
  const inRoute = routeToken(input), outRoute = routeToken(output);
  // Every standard fee tier's canonical pool is derived locally (CREATE2), checked for code and live liquidity, and quoted. A WETH9 conversion has none.
  // The tiers are independent reads at the same pinned block, asked together; a failure is reported in tier order, as when they were sequential.
  const quoteTier = async (tier: { fee: number }): Promise<{ fee: number; pool: string; expectedOut: string | null }> => {
    const pool = uniswapV3PoolAddress(P.factory, P.poolInitCodeHash, inRoute, outRoute, tier.fee);
    const [token0, token1] = [inRoute, outRoute].sort();
    // A pool with code keeps it, and its factory/token0/token1/fee are immutables; a missing pool is re-checked every time (it can be created).
    const poolKey = `pool:${pool}:${P.factory}:${token0}:${token1}:${tier.fee}`;
    if (!known(poolKey)) {
      if (await codeAt(pool) === '0x') return { fee: tier.fee, pool, expectedOut: null };
      if (addressOf(await call(pool, '0xc45a0155', block)) !== P.factory || addressOf(await call(pool, '0x0dfe1681', block)) !== token0 ||
          addressOf(await call(pool, '0xd21220a7', block)) !== token1 || BigInt(await call(pool, '0xddca3f43', block)) !== BigInt(tier.fee)) fail('POOL_METADATA_MISMATCH');
      learn(poolKey);
    }
    if (BigInt(await call(pool, '0x1a686502', block)) === 0n || word0(await call(pool, '0x3850c7bd', block)) === 0n) return { fee: tier.fee, pool, expectedOut: null };
    // A tier whose quote reverts (no usable liquidity for this size) is simply not a candidate. BUILD-FLOFI-EXECUTION-PERFORMANCE-001: a read the
    // node never answered (after the transport's own retries) is not a revert — the tier's price is unknown, so the quote fails closed instead of
    // silently binding another tier. An explicit revert (code 3, or revert text under any code, -32603 included) still only removes this tier;
    // a bare -32603 without revert text is an internal error, so it is treated as unanswered (public-testnet-rpc.ts).
    let out: bigint | null;
    try { out = word0(await call(P.quoter, quoteData(inRoute, outRoute, amountIn, tier.fee), block)); }
    catch (cause) { if (readNotAnswered(cause)) throw cause; out = null; }
    return { fee: tier.fee, pool, expectedOut: out && out > 0n ? out.toString() : null };
  };
  const settled = await Promise.allSettled((kind === 'SWAP' ? P.feeTiers : []).map(quoteTier));
  const tiers = settled.map(result => { if (result.status === 'rejected') throw result.reason; return result.value; });
  // A WETH9 conversion is exactly 1:1 on the WETH9 contract itself (its "pool"); its minimum is the amount.
  const best = kind !== 'SWAP' ? { fee: 0, pool: P.weth, expectedOut: amountIn.toString() }
    : tiers.filter(tier => tier.expectedOut !== null).sort((a, b) => BigInt(b.expectedOut!) > BigInt(a.expectedOut!) ? 1 : BigInt(b.expectedOut!) < BigInt(a.expectedOut!) ? -1 : a.fee - b.fee)[0];
  if (!best) fail('POOL_UNUSABLE');
  const expectedOut = BigInt(best.expectedOut!), minimumOut = expectedOut * BigInt(10_000 - fields.slippageBps) / 10_000n;
  if (minimumOut <= 0n) fail('QUOTE_INVALID');
  const sameBlock = await rpc('eth_getBlockByNumber', [block, false]);
  if (!isObject(sameBlock) || sameBlock.hash !== blockHash) fail('QUOTE_BLOCK_REORG');
  for (const key of verified) facts?.add(key, now().getTime());
  const observedAt = now().toISOString();
  const quoteFields = { executionId, revision: workflow.revision, nodeId: node.nodeId,
    workflowHash: hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow))), chainId: P.chainId,
    inputToken: input.kind === 'NATIVE' ? NATIVE_ETH : input.address!, outputToken: output.kind === 'NATIVE' ? NATIVE_ETH : output.address!,
    inputSymbol: input.symbol, outputSymbol: output.symbol, amountIn: fields.amount,
    expectedOut: expectedOut.toString(), minimumOut: minimumOut.toString(), slippageBps: fields.slippageBps, pool: best.pool, fee: best.fee,
    blockNumber, blockHash, observedAt, expiresAt: new Date(now().getTime() + P.reviewTtlSeconds * 1000).toISOString(), estimatedGas: null,
    inputDecimals: input.decimals, outputDecimals: output.decimals, environment: 'MAINNET' as const, provenance: runtime.provenance, stocks, feeTiers: tiers,
    catalog: { contentSha256: catalog.provenance.map(item => item.contentSha256), fetchedAt: catalog.provenance.map(item => item.fetchedAt).sort().at(-1)! },
    ...native ? { native } : {}, ...kind !== 'SWAP' ? { conversion: kind } : {} };
  return { ...quoteFields, manifestHash: digest(canonical(quoteFields)) };
}
/** The economically material state of a catalog quote: a change of any of it needs a new Review. */
function catalogEconomics(quote: PublicQuote) {
  return canonical({ expectedOut: quote.expectedOut, minimumOut: quote.minimumOut, pool: quote.pool, fee: quote.fee,
    stocks: (quote.stocks ?? []).map(stock => [stock.officialId, stock.multiplierWad, stock.scheduledMultiplierWad, stock.scheduledEffectiveAt]) });
}

/** Read-only exact owner transaction preflight, hashed into Review before any wallet request is prepared. */
async function bindSwapOwner(q: PublicQuote, rpc: Rpc, ownerValue: string, expiresAt = q.expiresAt): Promise<PublicQuote> {
  const P = profileOf(q.chainId), account = address(ownerValue), at = blockHex(q.blockNumber);
  if (account === '0x' + '0'.repeat(40)) fail('ADDRESS_INVALID');
  if (quantity(await rpc('eth_chainId', [])) !== BigInt(P.chainId)) fail('WRONG_PROVIDER_CHAIN');
  // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: native ETH in is spent from the account's own balance (no allowance); an ERC-20 in keeps its allowance read.
  const nativeIn = q.native === 'INPUT' || q.conversion === 'WRAP', allowanceRead = needsAllowance(q);
  // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: the owner's native balance at the pinned block is read once (it was read twice for native ETH in).
  const nativeAt = rpc('eth_getBalance', [account, at]).then(quantity);
  const [nonce, pending, allowed, input, native, gasPrice, code] = await Promise.all([
    rpc('eth_getTransactionCount', [account, at]).then(quantity), rpc('eth_getTransactionCount', [account, 'pending']).then(quantity),
    allowanceRead ? rpc('eth_call', [{ to: q.inputToken, data: allowanceData(account, P) }, at]).then(quantity) : Promise.resolve(BigInt(q.amountIn)),
    nativeIn ? nativeAt : rpc('eth_call', [{ to: q.inputToken, data: balanceData(account) }, at]).then(quantity),
    nativeAt, rpc('eth_gasPrice', []).then(quantity), rpc('eth_getCode', [account, at]),
  ]);
  // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: an EIP-7702 delegated EOA (MetaMask Smart Account) still signs and originates this ordinary
  // transaction with its own key; the exact-call simulation and gas estimate below run with its delegate code at the pinned block. Only a
  // reviewed delegate is accepted (an unknown one could forward the swap's ETH elsewhere); contract wallets cannot originate it at all.
  const kind = ownerAccountCode(code);
  if (kind.kind === 'CONTRACT') fail('OWNER_NOT_EOA');
  if (kind.kind === 'EIP7702' && !kind.verified) fail('OWNER_DELEGATION_UNVERIFIED');
  const delegation = kind.kind === 'EIP7702' ? kind.delegate : null;
  // HOTFIX-WORKFLOW-CONCURRENCY-001: the owner's pending transactions never block a swap. The reviewed transaction carries the nonce the
  // account uses next, after all of them; each run reserves its nonce, so two runs never hold the same one.
  if (pending < nonce) fail('OWNER_NONCE_STATE_INVALID');
  if (input < BigInt(q.amountIn)) fail('INSUFFICIENT_INPUT');
  const step: Step = allowed < BigInt(q.amountIn) ? 'approval' : 'swap', deadline = Math.floor(Date.parse(expiresAt) / 1000);
  const main = mainCall(q, account, deadline, P, true);
  const data = step === 'approval' ? approveData(BigInt(q.amountIn), P) : main.data;
  const to = step === 'approval' ? q.inputToken : main.to;
  const call = { from: account, to, data, value: step === 'approval' ? '0x0' : main.value };
  const simulation = await rpc('eth_call', [call, at]);
  if (typeof simulation !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(simulation) ||
      step === 'approval' && simulation !== '0x' && simulation !== '0x' + word(1n)) fail('SWAP_SIMULATION_INVALID');
  const gas = quantity(await rpc('eth_estimateGas', [call, at]));
  if (gas < 21_000n || gas > 30_000_000n || gasPrice <= 0n || gasPrice >= 1n << 128n) fail('SWAP_FEE_INVALID');
  // Nitro: estimate includes posting gas. No separate OP Stack l1Fee, no quoter-only gas estimate.
  const gasLimit = nitroGasLimit(gas), maxFee = nitroMaxFeePerGas(gasPrice), budget = gasLimit * maxFee;
  // Native ETH in must cover the amount AND the network fee ceiling (the wallet pays both from the same balance).
  if (native < budget + BigInt(call.value)) fail(native < BigInt(call.value) ? 'INSUFFICIENT_INPUT' : 'INSUFFICIENT_GAS_FUNDS');
  const transaction: Tx = { ...call, chainId: P.chainHex, nonce: '0x' + pending.toString(16), gas: '0x' + gasLimit.toString(16),
    maxFeePerGas: '0x' + maxFee.toString(16), maxPriorityFeePerGas: '0x0' };
  const ownerReview: SwapOwnerReview = { account, router: P.router, nonce: pending.toString(), step, allowance: allowed.toString(), transaction,
    gasEstimate: gas.toString(), maxFeePerGas: maxFee.toString(), feeBudgetWei: budget.toString(), deadline, simulationDigest: digest(simulation),
    ...delegation ? { delegation } : {} };
  const { manifestHash, ...fields } = q;
  if (!HASH.test(manifestHash)) fail('QUOTE_BINDING_INVALID');
  const bound = { ...fields, expiresAt, estimatedGas: gas.toString(), ownerReview };
  if (quantity(await rpc('eth_chainId', [])) !== BigInt(P.chainId)) fail('WRONG_PROVIDER_CHAIN');
  const head = await rpc('eth_getBlockByNumber', [at, false]);
  if (!isObject(head) || head.hash !== q.blockHash) fail('QUOTE_BLOCK_REORG');
  return { ...bound, manifestHash: digest(canonical(bound)) };
}

function ownerReviewChanged(before: SwapOwnerReview, after: SwapOwnerReview): boolean {
  return before.account !== after.account || before.router !== after.router || before.nonce !== after.nonce || before.step !== after.step ||
    before.allowance !== after.allowance || before.transaction.data !== after.transaction.data || before.deadline !== after.deadline ||
    (before.delegation ?? null) !== (after.delegation ?? null) ||
    BigInt(after.gasEstimate) > BigInt(before.transaction.gas) || BigInt(after.maxFeePerGas) > BigInt(before.maxFeePerGas);
}

/** Shared verified read path. It has no persistence, Review or transaction submission port. */
export function createPublicSwapQuoteReader(rpcFor: (profile: SwapProfile) => Rpc, now: () => Date = () => new Date(), catalog?: CatalogSwapRuntime) {
  const read = async (rpc: Rpc, to: string, data: string, block: string) => hex(await rpc('eth_call', [{ to, data }, block]));
  async function quote(workflow: SemanticWorkflow, executionId: string, account?: string, expiresAt?: string): Promise<PublicQuote> {
    // A swap on a catalog network (Robinhood Chain, Base) takes the catalog path; BUILD-BASE-001: Base's reference pair included.
    const swapNode = workflow.nodes.find(node => node.actionType === 'asset.swap.exact-input'), catalogProfile = swapNode ? swapProfile(swapNode.chainId) : null;
    if (catalogProfile?.kind === 'CATALOG') {
      const q = await catalogQuote(workflow, executionId, catalogProfile, rpcFor(catalogProfile), catalog ?? fail('PUBLIC_NETWORK_UNAVAILABLE'), now);
      return ownerBoundSwapReview(catalogProfile) && account !== undefined ? bindSwapOwner(q, rpcFor(catalogProfile), account, expiresAt) : q;
    }
    const swap = swapOf(workflow), P = swap.profile, rpc = rpcFor(P);
    const call = (to: string, data: string, block: string) => read(rpc, to, data, block);
    if (quantity(await rpc('eth_chainId', [])) !== BigInt(P.chainId)) fail('WRONG_PROVIDER_CHAIN');
    const head = await rpc('eth_getBlockByNumber', ['latest', false]);
    if (!isObject(head) || typeof head.number !== 'string' || typeof head.hash !== 'string' || typeof head.timestamp !== 'string') fail('RPC_RESPONSE_INVALID');
    const blockNumber = Number(quantity(head.number)), blockHash = hex(head.hash), block = blockHex(blockNumber);
    if (!Number.isSafeInteger(blockNumber) || !HASH.test(blockHash)) fail('RPC_RESPONSE_INVALID');
    const age = now().getTime() - Number(quantity(head.timestamp)) * 1000;
    if (age > 120_000 || age < -30_000) fail('STALE_CHAIN_HEAD');
    for (const target of [P.factory, P.router, P.quoter, P.usdc, P.weth, P.pool]) {
      const code = hex(await rpc('eth_getCode', [target, block]));
      if (code === '0x0' || code === '0x') fail('CONTRACT_CODE_MISSING');
    }
    for (const target of [P.quoter, P.router]) {
      if (address('0x' + (await call(target, '0xc45a0155', block)).slice(-40)) !== P.factory ||
          address('0x' + (await call(target, '0x4aa4a4fc', block)).slice(-40)) !== P.weth)
        fail('PROTOCOL_DEPLOYMENT_MISMATCH');
    }
    if (Number(BigInt(await call(P.usdc, '0x313ce567', block))) !== 6 ||
        Number(BigInt(await call(P.weth, '0x313ce567', block))) !== 18) fail('TOKEN_METADATA_MISMATCH');
    if (address('0x' + (await call(P.factory, poolData(swap.inputToken, swap.outputToken, P), block)).slice(-40)) !== P.pool)
      fail('POOL_FACTORY_MISMATCH');
    if (address('0x' + (await call(P.pool, '0x0dfe1681', block)).slice(-40)) !== P.usdc ||
        address('0x' + (await call(P.pool, '0xd21220a7', block)).slice(-40)) !== P.weth ||
        BigInt(await call(P.pool, '0xddca3f43', block)) !== BigInt(P.fee)) fail('POOL_METADATA_MISMATCH');
    if (BigInt(await call(P.pool, '0x1a686502', block)) === 0n ||
        BigInt((await call(P.pool, '0x3850c7bd', block)).slice(0, 66)) === 0n) fail('POOL_UNUSABLE');
    const raw = await call(P.quoter, quoteData(swap.inputToken, swap.outputToken, swap.amountIn, P.fee), block);
    if (raw.length < 66) fail('QUOTE_INVALID');
    const expectedOut = BigInt(raw.slice(0, 66));
    const minimumOut = expectedOut * BigInt(10_000 - swap.slippageBps) / 10_000n;
    if (expectedOut <= 0n || minimumOut <= 0n) fail('QUOTE_INVALID');
    const sameBlock = await rpc('eth_getBlockByNumber', [block, false]);
    if (!isObject(sameBlock) || sameBlock.hash !== blockHash) fail('QUOTE_BLOCK_REORG');
    const observedAt = now().toISOString();
    const fields = { executionId, revision: workflow.revision, nodeId: swap.node.nodeId,
      workflowHash: hashArtifactBytes('semantic-workflow', new TextEncoder().encode(JSON.stringify(workflow))), chainId: P.chainId, inputToken: swap.inputToken, outputToken: swap.outputToken,
      inputSymbol: swap.inputSymbol, outputSymbol: swap.outputSymbol, amountIn: swap.amountIn.toString(),
      expectedOut: expectedOut.toString(), minimumOut: minimumOut.toString(), slippageBps: swap.slippageBps,
      pool: P.pool, fee: P.fee, blockNumber, blockHash, observedAt,
      expiresAt: new Date(now().getTime() + 60_000).toISOString(), estimatedGas: null };
    return { ...fields, manifestHash: digest(canonical(fields)) };
  }
  return quote;
}

function createPublicTestnetCore(rpcFor: (profile: SwapProfile) => Rpc, now: () => Date, persistence: Persistence, catalog: CatalogSwapRuntime | undefined, idPrefix: SwapRunPrefix) {
  const { locked } = persistence;
  const save = async (run: PublicRun) => persistence.save(run), load = async (id: string) => persistence.load(id);
  async function read(rpc: Rpc, to: string, data: string, block: string): Promise<string> {
    return hex(await rpc('eth_call', [{ to, data }, block]));
  }
  async function balance(rpc: Rpc, token: string, owner: string, block: string): Promise<bigint> {
    return BigInt(await read(rpc, token, balanceData(owner), block));
  }
  async function allowance(rpc: Rpc, profile: SwapProfile, token: string, owner: string, block: string): Promise<bigint> {
    return BigInt(await read(rpc, token, allowanceData(owner, profile), block));
  }
  const quote = createPublicSwapQuoteReader(rpcFor, now, catalog);
  async function prepare(workflow: SemanticWorkflow, account?: string): Promise<PublicRun> {
    const node = workflow.nodes.find(item => item.actionType === 'asset.swap.exact-input'), profile = node ? swapProfile(node.chainId) : null;
    // Each service serves one namespace; a workflow for the other kind of network is refused before any read.
    if (!profile || prefixFor(profile) !== idPrefix) fail('PUBLIC_WORKFLOW_UNSUPPORTED');
    const executionId = idPrefix + '-' + randomBytes(12).toString('hex');
    const q = await quote(workflow, executionId, account);
    return save({ quote: q, workflow, reviewedManifestHash: null, attempts: [], outcome: null });
  }
  async function refresh(id: string): Promise<PublicRun> {
    return locked(id, async () => {
      const run = await load(id);
      if (run.divergence) fail('RECONCILIATION_MISMATCH');
      const last = run.attempts.at(-1);
      if (run.outcome || last?.step !== 'approval' || last.state !== 'CONFIRMED' ||
          run.quote.ownerReview && last.nativeAfter === null ||
          run.attempts.some(attempt => attempt.step === 'swap')) fail('QUOTE_REFRESH_NOT_ALLOWED');
      const fresh = await quote(run.workflow, id, run.quote.ownerReview?.account);
      return save({ ...run, quote: fresh, reviewedManifestHash: null });
    });
  }
  async function begin(id: string, ownerValue: string): Promise<PublicBegin> {
    return locked(id, async () => {
      let run = await load(id);
      const owner = address(ownerValue);
      assertCanonicalQuote(run);
      if (run.divergence) fail('RECONCILIATION_MISMATCH');
      if (run.outcome || run.attempts.some(attempt => ['PREPARED', 'HASH', 'PENDING', 'UNKNOWN'].includes(attempt.state))) fail('ATTEMPT_ALREADY_ACTIVE');
      if (run.attempts.some(attempt => attempt.step === 'swap' && attempt.state !== 'REJECTED')) fail('SWAP_ALREADY_ATTEMPTED');
      if (run.reviewedManifestHash !== run.quote.manifestHash) fail('REVIEW_REQUIRED');
      const P = profileOf(run.quote.chainId), rpc = rpcFor(P);
      // BUILD-RH-002: real-funds execution needs the deployment's explicit owner-execution opt-in; Review stays available without it.
      if (P.kind === 'CATALOG' && !catalog?.executionEnabled) fail('OWNER_EXECUTION_NOT_ENABLED');
      const strict = ownerBoundSwapReview(P), reviewedOwner = run.quote.ownerReview;
      if (strict && (!reviewedOwner || reviewedOwner.account !== owner)) fail('OWNER_REVIEW_MISMATCH');
      if (now().getTime() >= Date.parse(run.quote.expiresAt)) {
        const renewed = await quote(run.workflow, id, reviewedOwner?.account);
        await save({ ...run, quote: renewed, reviewedManifestHash: null }); fail('QUOTE_EXPIRED_REVIEW_REQUIRED');
      }
      let fresh: PublicQuote;
      try { fresh = await quote(run.workflow, id, reviewedOwner?.account, strict ? run.quote.expiresAt : undefined); }
      catch (cause) {
        // A Stock Token multiplier change now inside the Review window invalidates the reviewed authority.
        if (strict || cause instanceof Error && cause.message === 'STOCK_MULTIPLIER_CHANGE_PENDING') { await save({ ...run, reviewedManifestHash: null }); }
        throw cause;
      }
      if (strict && reviewedOwner && fresh.ownerReview && ownerReviewChanged(reviewedOwner, fresh.ownerReview)) {
        await save({ ...run, quote: fresh, reviewedManifestHash: null }); fail('OWNER_STATE_CHANGED_REVIEW_REQUIRED');
      }
      if (fresh.manifestHash !== run.quote.manifestHash) {
        // Observation metadata changes each block; only economic changes require a new review. For a catalog quote the
        // Stock Token multiplier state is economic: a changed multiplier changes what the owner's tokens represent.
        const stockChanged = canonical((fresh.stocks ?? []).map(x => [x.officialId, x.multiplierWad, x.scheduledMultiplierWad, x.scheduledEffectiveAt])) !==
          canonical((run.quote.stocks ?? []).map(x => [x.officialId, x.multiplierWad, x.scheduledMultiplierWad, x.scheduledEffectiveAt]));
        if (P.kind === 'CATALOG' ? catalogEconomics(fresh) !== catalogEconomics(run.quote) : fresh.expectedOut !== run.quote.expectedOut ||
            fresh.minimumOut !== run.quote.minimumOut || fresh.pool !== run.quote.pool || fresh.fee !== run.quote.fee) {
          run = await save({ ...run, quote: fresh, reviewedManifestHash: null });
          fail(stockChanged ? 'STOCK_MULTIPLIER_CHANGED_REVIEW_REQUIRED' : 'QUOTE_CHANGED_REVIEW_REQUIRED');
        }
      }
      if (now().getTime() >= Date.parse(run.quote.expiresAt)) {
        run = await save({ ...run, quote: fresh, reviewedManifestHash: null });
        fail('QUOTE_EXPIRED_REVIEW_REQUIRED');
      }
      const gate = resolveWorkflowCapability(run.workflow, { environment: P.environment, runtime: {
        quoteProviderAvailable: true, walletConnected: true, walletChainId: P.chainRef,
        artifacts: 'CURRENT', simulationReady: true, authorizationReady: true,
      } });
      if (!gate.executionReady) fail('EXECUTION_NOT_READY');
      const head = Number(quantity(await rpc('eth_blockNumber', []))), at = blockHex(head);
      const amountIn = BigInt(run.quote.amountIn), q = run.quote;
      // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a native side is read as the account's native balance (never as WETH); native ETH in needs no allowance.
      // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: one native-balance read at the pinned block serves every native side and the fee check.
      const nativeRead = rpc('eth_getBalance', [owner, at]).then(quantity), nativeBalance = () => nativeRead;
      const [inputBefore, outputBefore, allowanceBefore, ethBefore] = await Promise.all([
        q.inputToken === NATIVE_ETH ? nativeBalance() : balance(rpc, q.inputToken, owner, at), q.outputToken === NATIVE_ETH ? nativeBalance() : balance(rpc, q.outputToken, owner, at),
        needsAllowance(q) ? allowance(rpc, P, q.inputToken, owner, at) : Promise.resolve(amountIn), nativeBalance(),
      ]);
      if (inputBefore < amountIn) fail('INSUFFICIENT_INPUT');
      const step: Step = allowanceBefore < amountIn ? 'approval' : 'swap';
      if (step === 'approval' && run.attempts.some(a => a.step === 'approval' && a.state === 'CONFIRMED')) fail('APPROVAL_INEFFECTIVE');
      const main = mainCall(q, owner, Math.floor(Date.parse(q.expiresAt) / 1000), P, false);
      const data = strict ? reviewedOwner!.transaction.data : step === 'approval' ? approveData(amountIn, P) : main.data;
      const to = step === 'approval' ? q.inputToken : main.to, value = step === 'approval' ? '0x0' : main.value;
      const baseTx = { chainId: P.chainHex, from: owner, to, data, value };
      // BUILD-FLOFI-EXECUTION-PERFORMANCE-001: gas, gas price and (OP Stack) the L1 data fee are independent reads of the same transaction: asked
      // together, judged in the original order.
      // BUILD-BASE-001: on an OP Stack catalog network the owner also pays the L1 data fee, bounded by the GasPriceOracle (fails closed).
      const [gasRead, priceRead, l1Read] = await Promise.allSettled([rpc('eth_estimateGas', [{ from: owner, to, data, value }]).then(quantity),
        rpc('eth_gasPrice', []).then(quantity),
        'gasPriceOracle' in P ? rpc('eth_call', [{ to: P.gasPriceOracle, data: '0xf1c7a58b' + word(BigInt((data.length - 2) / 2 + 120)) }, at]).then(quantity) : Promise.resolve(0n)]);
      const settled = <T,>(r: PromiseSettledResult<T>): T => { if (r.status === 'rejected') throw r.reason; return r.value; };
      const gas = settled(gasRead), gasPrice = settled(priceRead), l1Fee = settled(l1Read);
      // Native ETH in is paid from the same balance as the network fee: the account needs both.
      if (gas <= 0n || gasPrice <= 0n || ethBefore < gas * gasPrice * 2n + l1Fee + BigInt(value)) fail(P.environment === 'MAINNET' ? 'INSUFFICIENT_GAS_FUNDS' : 'INSUFFICIENT_TEST_ETH');
      const tx: Tx = strict ? reviewedOwner!.transaction : { ...baseTx, gas: '0x' + (gas * 12n / 10n).toString(16) };
      if (strict) {
        const [nonce, pending] = await Promise.all([rpc('eth_getTransactionCount', [owner, 'latest']).then(quantity),
          rpc('eth_getTransactionCount', [owner, 'pending']).then(quantity)]);
        if (step !== reviewedOwner!.step || BigInt(tx.value) !== BigInt(value) || ethBefore < BigInt(reviewedOwner!.feeBudgetWei) + BigInt(tx.value) || gas > BigInt(tx.gas) || gasPrice > BigInt(reviewedOwner!.maxFeePerGas)) {
          await save({ ...run, reviewedManifestHash: null }); fail('OWNER_STATE_CHANGED_REVIEW_REQUIRED');
        }
        // The reviewed nonce must still be the one the account uses next (its other pending transactions come before it).
        if (pending !== BigInt(reviewedOwner!.nonce) || nonce > pending) {
          await save({ ...run, reviewedManifestHash: null }); fail('OWNER_STATE_CHANGED_REVIEW_REQUIRED');
        }
        // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: a wallet refusal is trusted for a new attempt only after checking that no refused attempt of this
        // run reached the chain through a relay (a relayed redemption leaves the owner nonce unchanged, so the nonce check above cannot see it).
        // (Checked for every refused attempt, not only while the Review still shows the delegation: it may have been cleared since.)
        for (const refused of run.attempts.filter(a => a.state === 'REJECTED' && a.txHash === null)) {
          const scan = await relayedExecutions(rpc, P, refused, refused.preBlock, async txHash => await persistence.claims.holder(P.chainId, txHash) !== null,
            RELAY_DUPLICATE_SCAN_REQUESTS);
          if (scan.verified.length || scan.unclassified.length) { await save({ ...run, divergence: 'REJECTED_ATTEMPT_EXECUTED', reviewedManifestHash: null }); fail('RECONCILIATION_MISMATCH'); }
          if (scan.waiting || !scan.complete) fail('RELAYED_EXECUTION_PENDING');
        }
        // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: a reservation whose holder's reserved transaction was verified as relayed (owner nonce unused)
        // is taken over with that evidence; anything else keeps SWAP_NONCE_ALREADY_RESERVED.
        await persistence.reserveNonce(run, reviewedOwner!, async (holderId, nonce, transaction) => {
          const holder = holderId === run.quote.executionId ? run : await Promise.resolve(load(holderId)).catch(() => null);
          return holder && holder.quote.ownerReview?.account === owner && holder.quote.chainId === run.quote.chainId ? relayedNonceRelease(holder, nonce, transaction) : null;
        });
      }
      const attempt: PublicAttempt = { attemptId: id + '.' + step + '.' + String(run.attempts.length + 1), executionId: id,
        step, state: 'PREPARED', createdAt: now().toISOString(), submittedAt: null, account: owner, chainId: P.chainId, environment: P.environment,
        adapter: run.quote.conversion ? 'weth9.wrap' : 'uniswap.v3', semanticRevision: run.quote.revision, manifestHash: run.quote.manifestHash,
        tx, calldataDigest: digest(data), authorizedInput: run.quote.amountIn,
        authorizedMinimumOutput: run.quote.minimumOut, preBlock: head, nativeBefore: ethBefore.toString(), inputBefore: inputBefore.toString(),
        outputBefore: outputBefore.toString(), allowanceBefore: allowanceBefore.toString(), nativeAfter: null, txHash: null, receipt: null };
      await save({ ...run, attempts: [...run.attempts, attempt] });
      return { attempt, tx };
    });
  }
  /** BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: a transaction credited to any other attempt (another run's identical call) is never this one's. */
  const claimedElsewhere = (profile: SwapProfile, attempt: Pick<PublicAttempt, 'executionId' | 'attemptId'>) => async (txHash: string) => {
    const holder = await persistence.claims.holder(profile.chainId, txHash);
    return holder !== null && (holder.id !== attempt.executionId || holder.attemptId !== attempt.attemptId);
  };
  /** The first block from which this run could have had the attempt's exact call executed (its earliest attempt of that same transaction). */
  const sameCallFrom = (run: PublicRun, attempt: PublicAttempt) =>
    Math.min(...run.attempts.filter(a => canonical(a.tx) === canonical(attempt.tx)).map(a => a.preBlock), attempt.preBlock);
  async function observe(id: string): Promise<PublicRun> {
    return locked(id, async () => {
      let run = await load(id);
      try {
        let attempt = run.attempts.at(-1);
        if (run.divergence) return run;
        if (attempt && !attempt.txHash && run.quote.ownerReview && ['PREPARED', 'UNKNOWN'].includes(attempt.state)) {
          const pending = attempt, profile = profileOf(run.quote.chainId);
          const found = await discoverTransferByNonce({ nonce: run.quote.ownerReview.nonce, transaction: { ...attempt.tx, maxFeePerGas: attempt.tx.maxFeePerGas!, maxPriorityFeePerGas: attempt.tx.maxPriorityFeePerGas! }, preparedAtBlock: attempt.preBlock, transactionHash: null }, rpcFor(profile));
          // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: an owner with the reviewed MetaMask delegation may have had the call relayed (its nonce
          // unused, or later used by another of its transactions): a verified relayed execution is this attempt's submission. Both a relayed
          // and a direct execution of the call, or two relayed ones, are a duplicate and are recorded as divergent.
          const scan = run.quote.ownerReview.delegation === DELEGATOR_IMPL ?
            await relayedExecutions(rpcFor(profile), profile, attempt, sameCallFrom(run, attempt), claimedElsewhere(profile, pending)) : null;
          if (scan?.waiting) return run;
          // The reviewed call executed in a relayed shape FloFi does not reconcile: recorded, never adopted or ignored.
          if (scan?.unclassified.length) return save({ ...run, divergence: 'RELAYED_EXECUTION_UNSUPPORTED_SHAPE' });
          if (scan && (scan.verified.length > 1 || scan.verified.length === 1 && found.hash && !found.mismatch))
            return save({ ...run, divergence: 'RELAYED_DUPLICATE_EXECUTION' });
          const relayedHash = scan?.verified[0] ?? null, hash = relayedHash ?? found.hash;
          if (!hash) return run;
          if (!relayedHash && found.mismatch) return save({ ...run, divergence: 'NONCE_CONSUMED_BY_DIFFERENT_TRANSACTION' });
          const changed: PublicAttempt = { ...attempt, state: 'HASH', txHash: hash, submittedAt: now().toISOString() };
          run = await save({ ...run, attempts: run.attempts.map(a => a.attemptId === changed.attemptId ? changed : a) });
          attempt = changed;
        }
        if (!attempt?.txHash || !['HASH', 'PENDING', 'CONFIRMED'].includes(attempt.state) || run.outcome) fail('NO_SUBMITTED_ATTEMPT');
        const P = profileOf(run.quote.chainId), rpc = rpcFor(P);
        if (quantity(await rpc('eth_chainId', [])) !== BigInt(P.chainId)) fail('WRONG_PROVIDER_CHAIN');
        const raw = await rpc('eth_getTransactionReceipt', [attempt.txHash]);
        if (raw === null) return await save({ ...run, attempts: run.attempts.map(a => a.attemptId === attempt.attemptId ? { ...a, state: 'PENDING' } : a) });
        if (!isObject(raw)) fail('RECEIPT_INVALID');
        const tx = await rpc('eth_getTransactionByHash', [attempt.txHash]);
        let verified: Awaited<ReturnType<typeof verifyOwnerSubmission>>;
        try { verified = await verifyOwnerSubmission(rpc, { txHash: attempt.txHash, account: attempt.account, target: attempt.tx.to, data: attempt.tx.data,
          preBlock: attempt.preBlock, value: attempt.tx.value }, tx, raw, P.chainId, P.l1DataFee); }
        catch (cause) {
          // Not yet canonically included (e.g. a preconfirmed receipt): exactly like no receipt yet.
          if (cause instanceof Error && cause.message === 'RECEIPT_NOT_CANONICAL')
            return await save({ ...run, attempts: run.attempts.map(a => a.attemptId === attempt.attemptId ? { ...a, state: 'PENDING' } : a) });
          if (run.quote.ownerReview && cause instanceof Error && cause.message === 'TRANSACTION_MISMATCH')
            return save({ ...run, divergence: cause.message });
          throw cause;
        }
        const { direct, delegated, delegationDepth, txFrom, txTo, txInput, status, blockNumber, gasUsed, effectiveGasPrice, l1Fee, nonce } = verified;
        const review = run.quote.ownerReview;
        // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: a MetaMask Smart Account (an EIP-7702 delegated EOA) may hand the reviewed call to a relayer,
        // which redeems the owner's delegation through the Delegation Manager and pays the network fee. For an owner-bound swap this is accepted
        // only in the shape verified on chain (testdata/metamask-delegated-depth1-approval.base-sepolia.json): a type-2 redemption, sent by a
        // third party, of exactly the reviewed call (one call, depth 1, no native value) from the owner's reviewed DeleGator delegation, unchanged
        // from preparation to inclusion, with a single `RedeemedDelegation` naming the owner. Any other delegated shape is recorded as divergent.
        const relayed = review !== undefined && delegated && verified.submission === 'DELEGATED_EXISTING' && delegationDepth === 1 &&
          review.delegation === DELEGATOR_IMPL && txFrom !== attempt.account;
        // Whether the owner's balances can move without its nonce moving (relayed redemptions): the nonce count then cannot show that the
        // balance window is this swap's alone, so the receipt is the proof (as HOTFIX-WORKFLOW-CONCURRENCY-001 does for concurrent transactions).
        let relayCapable = false;
        if (review) {
          if (delegated && !relayed) return save({ ...run, divergence: 'OWNER_SUBMISSION_UNSUPPORTED' });
          if (direct) {
            // A direct submission is bounded by the reviewed transaction. A relayed one is the relayer's own transaction: its nonce, gas and fee
            // are the relayer's and are never charged to the owner (the owner sent nothing, so its nonce is untouched).
            const submitted = isObject(tx) ? tx : fail('TRANSACTION_MISMATCH');
            const offeredFee = submitted.maxFeePerGas === undefined ? quantity(submitted.gasPrice) : quantity(submitted.maxFeePerGas);
            if (nonce !== BigInt(attempt.tx.nonce!) || quantity(submitted.gas) > BigInt(attempt.tx.gas) || offeredFee > BigInt(attempt.tx.maxFeePerGas!) ||
                gasUsed > BigInt(attempt.tx.gas) || effectiveGasPrice > BigInt(attempt.tx.maxFeePerGas!))
              return save({ ...run, divergence: 'TRANSACTION_BOUNDS_MISMATCH' });
          }
          // The owner's account where the swap landed is still a standard account or a reviewed EIP-7702 delegation (MetaMask may upgrade an EOA
          // in the meantime). Contract code or an unreviewed delegate (one that could forward the swap's ETH on receipt) is never reconciled.
          const landed = ownerAccountCode(await rpc('eth_getCode', [attempt.account, blockHex(blockNumber)]));
          if (landed.kind === 'CONTRACT' || landed.kind === 'EIP7702' && !landed.verified) return save({ ...run, divergence: 'OWNER_ACCOUNT_CODE_MISMATCH' });
          relayCapable = relayed || review.delegation !== undefined || landed.kind === 'EIP7702';
          if (relayed) {
            // A relayed redemption carries no owner nonce: its hash is credited to this attempt once, never to another attempt or run.
            if (!await persistence.claims.claim(P.chainId, attempt.txHash, { id, attemptId: attempt.attemptId }))
              return save({ ...run, divergence: 'RELAYED_TRANSACTION_ALREADY_CLAIMED' });
            // A reverted redemption has no logs: nothing proves whose authorization it carried, and an authorization that was not consumed may
            // still be redeemed later. It is never treated as a final result for the owner (and never releases a nonce reservation).
            if (status === 0) return save({ ...run, divergence: 'RELAYED_SUBMISSION_REVERTED' });
            // Besides the swap's own tokens and pool (and WETH only where native ETH is wrapped or unwrapped), only the reviewed framework
            // (Delegation Manager, its caveat enforcers) may log.
            const native = Boolean(run.quote.native || run.quote.conversion);
            const allowed = new Set([...RELAY_FRAMEWORK_LOGGERS, run.quote.inputToken,
              ...attempt.step === 'swap' ? [run.quote.outputToken, run.quote.pool, ...native && P.kind === 'CATALOG' ? [P.weth] : []] : []]);
            if (status === 1 && (!Array.isArray(raw.logs) || raw.logs.some(log => !isObject(log) || !allowed.has(address(log.address)))))
              fail('TRANSACTION_MISMATCH');
            // Single use, proven on chain: the relay can never redeem this authorization again (no relayed replay of the reviewed call).
            if (status === 1 && !singleUseRelayedDelegation(raw.logs as unknown[], attempt.account, txFrom))
              return save({ ...run, divergence: 'RELAYED_DELEGATION_NOT_SINGLE_USE' });
          }
          // No second execution of the same reviewed call: for an owner that relays, the owner nonce cannot prove it. Every verified relayed
          // execution since the run first prepared this transaction, and (for a relayed receipt) a direct one at the reviewed nonce, are looked
          // for before this receipt becomes evidence; a candidate not yet final keeps the attempt pending.
          if (review.delegation === DELEGATOR_IMPL && status === 1) {
            const scan = await relayedExecutions(rpc, P, attempt, sameCallFrom(run, attempt), claimedElsewhere(P, attempt), RELAY_DUPLICATE_SCAN_REQUESTS);
            if (scan.waiting || !scan.complete) return await save({ ...run, attempts: run.attempts.map(a => a.attemptId === attempt.attemptId ? { ...a, state: 'PENDING' } : a) });
            const direct2 = relayed ? await discoverTransferByNonce({ nonce: review.nonce, transaction: { ...attempt.tx, maxFeePerGas: attempt.tx.maxFeePerGas!,
              maxPriorityFeePerGas: attempt.tx.maxPriorityFeePerGas! }, preparedAtBlock: attempt.preBlock, transactionHash: null }, rpc) : null;
            if (scan.verified.some(hash => hash !== attempt.txHash) || scan.unclassified.some(hash => hash !== attempt.txHash) || direct2?.hash && !direct2.mismatch)
              return save({ ...run, divergence: 'RELAYED_DUPLICATE_EXECUTION' });
          }
        }
        // HOTFIX-WORKFLOW-CONCURRENCY-001: other transactions of this owner between preparation and inclusion (independent workflows) also move
        // its balances, so that window is not this swap's alone. A direct submission is then proven from its own receipt instead; with no other
        // owner transaction in the window the balance proof below is unchanged. (Catalog networks; test-network pair runs are unchanged.)
        const concurrent = direct && P.kind === 'CATALOG' && quantity(await rpc('eth_getTransactionCount', [attempt.account, blockHex(blockNumber)])) -
          quantity(await rpc('eth_getTransactionCount', [attempt.account, blockHex(attempt.preBlock)])) > 1n;
        let receivedByReceipt: bigint | null = null;
        const nativeRun = Boolean(run.quote.native || run.quote.conversion);
        const proven = concurrent || relayCapable;
        // The swap's own logs: a relayed receipt's framework bookkeeping (checked above) is not part of the swap's effects.
        const ownLogs = Array.isArray(raw.logs) ? relayed ? raw.logs.filter(log => isObject(log) && !RELAY_FRAMEWORK_LOGGERS.has(address(log.address))) : raw.logs : null;
        if (proven && status === 1 && !(nativeRun && attempt.step === 'swap')) {
          if (!ownLogs) fail('RECEIPT_INVALID');
          const records = ownLogs.filter(isObject);
          if (attempt.step === 'approval') {
            const approvals = records.filter(log => address(log.address) === run.quote.inputToken);
            if (approvals.length !== 1 || !Array.isArray(approvals[0]!.topics) || approvals[0]!.topics[0] !== APPROVAL_TOPIC || topicAddress(approvals[0]!.topics[1]) !== attempt.account ||
                topicAddress(approvals[0]!.topics[2]) !== P.router || quantity(approvals[0]!.data) !== BigInt(attempt.authorizedInput)) fail('TRANSACTION_MISMATCH');
          } else receivedByReceipt = receiptSwap(ownLogs, run.quote, attempt.account, P.router, BigInt(attempt.authorizedInput));
        }
        // Base Sepolia (not owner-bound) delegated redemptions keep their original window proof.
        if (delegated && !relayed && status === 1) {
          if (!Array.isArray(raw.logs)) fail('RECEIPT_INVALID');
          if (attempt.step === 'approval') {
            const tokenLogs = raw.logs.filter(log => isObject(log) &&
              [run.quote.inputToken, run.quote.outputToken].includes(address(log.address)));
            if (tokenLogs.length !== 1 || !isObject(tokenLogs[0]) ||
                address(tokenLogs[0].address) !== run.quote.inputToken || !Array.isArray(tokenLogs[0].topics) ||
                tokenLogs[0].topics[0] !== APPROVAL_TOPIC ||
                topicAddress(tokenLogs[0].topics[1]) !== attempt.account ||
                topicAddress(tokenLogs[0].topics[2]) !== P.router ||
                quantity(tokenLogs[0].data) !== BigInt(attempt.authorizedInput)) fail('TRANSACTION_MISMATCH');
          } else {
            const tokenLogs = raw.logs.filter(log => isObject(log) &&
              [run.quote.inputToken, run.quote.outputToken].includes(address(log.address)));
            const poolLogs = raw.logs.filter(log => isObject(log) && address(log.address) === run.quote.pool);
            if (tokenLogs.length !== 2 || poolLogs.length !== 1) fail('TRANSACTION_MISMATCH');
            const inputLog = tokenLogs.find(log => isObject(log) && address(log.address) === run.quote.inputToken);
            const outputLog = tokenLogs.find(log => isObject(log) && address(log.address) === run.quote.outputToken);
            const poolLog = poolLogs[0];
            if (!isObject(inputLog) || !Array.isArray(inputLog.topics) || inputLog.topics[0] !== TRANSFER_TOPIC ||
                topicAddress(inputLog.topics[1]) !== attempt.account || topicAddress(inputLog.topics[2]) !== run.quote.pool ||
                quantity(inputLog.data) !== BigInt(attempt.authorizedInput) ||
                !isObject(outputLog) || !Array.isArray(outputLog.topics) || outputLog.topics[0] !== TRANSFER_TOPIC ||
                topicAddress(outputLog.topics[1]) !== run.quote.pool || topicAddress(outputLog.topics[2]) !== attempt.account ||
                !isObject(poolLog) || !Array.isArray(poolLog.topics) || poolLog.topics[0] !== SWAP_TOPIC ||
                topicAddress(poolLog.topics[1]) !== P.router || topicAddress(poolLog.topics[2]) !== attempt.account)
              fail('TRANSACTION_MISMATCH');
            const poolData = hex(poolLog.data);
            if (poolData.length < 130 || BigInt('0x' + poolData.slice(2, 66)) !== BigInt(attempt.authorizedInput) ||
                signed(BigInt('0x' + poolData.slice(66, 130))) !== -quantity(outputLog.data))
              fail('TRANSACTION_MISMATCH');
          }
        }
        // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a native-ETH swap or WETH9 conversion is always proven from its own receipt (direct only).
        let nativeProof: { spent: bigint; received: bigint } | null = null;
        if (nativeRun && attempt.step === 'swap' && status === 1) {
          if (!(direct || relayed) || P.kind !== 'CATALOG' || !ownLogs) fail('TRANSACTION_MISMATCH');
          nativeProof = receiptNative(ownLogs, run.quote, attempt.account, P, BigInt(attempt.authorizedInput));
        }
        const executionGasCost = gasUsed * effectiveGasPrice;
        const receipt: PublicReceipt = { transactionHash: attempt.txHash, status: status as 0 | 1,
          blockNumber, blockHash: hex(raw.blockHash), from: txFrom, to: txTo,
          gasUsed: gasUsed.toString(), effectiveGasPrice: effectiveGasPrice.toString(),
          executionGasCostWei: executionGasCost.toString(), l1FeeWei: l1Fee.toString(),
          gasCostWei: (executionGasCost + l1Fee).toString(), gasPayer: txFrom,
          nonce: nonce.toString(), value: BigInt(attempt.tx.value).toString(),
          submissionKind: delegated ? 'DELEGATED_SINGLE' : 'DIRECT', executionTarget: attempt.tx.to,
          delegationDepth,
          outerCalldataDigest: digest(txInput), executionCalldataDigest: attempt.calldataDigest };
        const changed: PublicAttempt = { ...attempt, state: status === 1 ? 'CONFIRMED' : 'REVERTED', receipt };
        run = await save({ ...run, attempts: run.attempts.map(a => a.attemptId === attempt.attemptId ? changed : a) });
        if (status === 0) return run;
        const at = blockHex(blockNumber);
        if (attempt.step === 'approval') {
          // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: a native-ETH output side is the native balance, which only this approval's gas moved (checked below).
          const nativeOut = run.quote.outputToken === NATIVE_ETH;
          const [observed, inputAfter, outputAfter, nativeAfter] = await Promise.all([
            allowance(rpc, P, run.quote.inputToken, attempt.account, at),
            balance(rpc, run.quote.inputToken, attempt.account, at), nativeOut ? Promise.resolve(BigInt(attempt.outputBefore)) : balance(rpc, run.quote.outputToken, attempt.account, at),
            rpc('eth_getBalance', [attempt.account, at]).then(quantity),
          ]);
          if (observed !== BigInt(attempt.authorizedInput) || !proven && (inputAfter !== BigInt(attempt.inputBefore) || outputAfter !== BigInt(attempt.outputBefore)) ||
              (direct && !relayCapable && BigInt(attempt.nativeBefore) - nativeAfter < BigInt(receipt.gasCostWei)) ||
              (delegated && !relayed && nativeAfter !== BigInt(attempt.nativeBefore)))
            fail('APPROVAL_NOT_EFFECTIVE');
          return await save({ ...run, attempts: run.attempts.map(a => a.attemptId === attempt.attemptId ?
            { ...a, nativeAfter: nativeAfter.toString() } : a) });
        }
        const nativeAt = () => rpc('eth_getBalance', [attempt.account, at]).then(quantity);
        const [inputAfter, outputAfter, allowanceAfter, nativeAfter] = await Promise.all([
          run.quote.inputToken === NATIVE_ETH ? nativeAt() : balance(rpc, run.quote.inputToken, attempt.account, at),
          run.quote.outputToken === NATIVE_ETH ? nativeAt() : balance(rpc, run.quote.outputToken, attempt.account, at),
          needsAllowance(run.quote) ? allowance(rpc, P, run.quote.inputToken, attempt.account, at) : Promise.resolve(0n), nativeAt(),
        ]);
        // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: an owner-bound run's fees are what the owner paid: a relayed submission's fee is the relayer's.
        // (The Base Sepolia pair runs keep reporting the receipt's own cost, sponsored or not, as before.)
        const ownerPaid = (paid: PublicReceipt, owner: string) => !review || paid.gasPayer === owner ? BigInt(paid.gasCostWei) : 0n;
        const approvalGasCost = run.attempts.filter(a => a.step === 'approval' && a.state === 'CONFIRMED').reduce((sum, a) => {
          if (a.nativeAfter === null || a.receipt === null) fail('APPROVAL_GAS_UNKNOWN');
          return sum + ownerPaid(a.receipt, a.account);
        }, 0n);
        const actualGasCost = ownerPaid(receipt, attempt.account) + approvalGasCost;
        let spent: bigint, received: bigint;
        if (nativeProof) {
          // The receipt proves the amounts; the balances only bound them. Native ETH and gas share one balance, so a gas deduction is never read
          // as a missing output: native in spent at most amount + gas; native out received at least the proven amount − gas. Third-party
          // deposits can only add to a balance; an owner transaction in the window (concurrent) leaves the receipt as the only proof.
          ({ spent, received } = nativeProof);
          const gasCost = ownerPaid(receipt, attempt.account), nativeDelta = nativeAfter - BigInt(attempt.nativeBefore);
          const nativeIn = run.quote.inputToken === NATIVE_ETH, nativeOut = run.quote.outputToken === NATIVE_ETH;
          if (!proven && (nativeIn && -nativeDelta > spent + gasCost || nativeOut && nativeDelta + gasCost < received ||
              !nativeIn && BigInt(attempt.inputBefore) - inputAfter !== spent || !nativeOut && outputAfter - BigInt(attempt.outputBefore) < received)) fail('RECONCILIATION_MISMATCH');
          if (spent !== BigInt(run.quote.amountIn) || received < BigInt(run.quote.minimumOut)) fail('RECONCILIATION_MISMATCH');
        } else {
          spent = proven ? BigInt(attempt.authorizedInput) : BigInt(attempt.inputBefore) - inputAfter;
          received = proven ? receivedByReceipt! : outputAfter - BigInt(attempt.outputBefore);
          if (spent !== BigInt(run.quote.amountIn) || received < BigInt(run.quote.minimumOut) ||
              (direct && !relayCapable && BigInt(attempt.nativeBefore) - nativeAfter < BigInt(receipt.gasCostWei)) ||
              (delegated && !relayed && nativeAfter !== BigInt(attempt.nativeBefore))) fail('RECONCILIATION_MISMATCH');
        }
        const explorer = explorerUrl(attempt.txHash, P);
        run = { ...run, attempts: run.attempts.map(a => a.attemptId === attempt.attemptId ?
          { ...a, nativeAfter: nativeAfter.toString() } : a) };
        const journalHeadHash = digest(canonical(run));
        const receiptHash = digest(canonical(raw));
        const nativeAsset = { chainId: P.chainRef, nativeId: 'ETH', decimals: 18 };
        // Native ETH is reconciled as the native asset, never as WETH9 or the EIP-7528 marker.
        const inputAsset = run.quote.inputToken === NATIVE_ETH ? nativeAsset : { chainId: P.chainRef, address: run.quote.inputToken, decimals: quoteDecimals(run.quote, 'input') };
        const outputAsset = run.quote.outputToken === NATIVE_ETH ? nativeAsset : { chainId: P.chainRef, address: run.quote.outputToken, decimals: quoteDecimals(run.quote, 'output') };
        const reconciliation = { balances: [{ asset: inputAsset, amount: inputAfter.toString() },
          { asset: outputAsset, amount: outputAfter.toString() }],
          allowances: needsAllowance(run.quote) ? [{ asset: inputAsset, amount: allowanceAfter.toString() }] : [], debt: [], positions: [],
          fees: [{ asset: nativeAsset, amount: actualGasCost.toString() }],
          residualAssets: [{ asset: inputAsset, amount: inputAfter.toString() }, { asset: outputAsset, amount: outputAfter.toString() }],
          ownership: [{ chainId: P.chainRef, address: attempt.account }],
          limitations: [...P.kind === 'CATALOG' ? ['OWNER_WALLET_MAINNET', ...run.quote.provenance === 'MOCKED' ? ['MOCKED_LOOPBACK_CHAIN'] : []] : ['PUBLIC_TESTNET_ONLY'],
            ...concurrent ? ['OWNER_TRANSACTIONS_IN_WINDOW_RECEIPT_RECONCILED'] : [], ...nativeProof ? ['NATIVE_ETH_RECEIPT_RECONCILED'] : [],
            ...relayCapable && !concurrent ? ['OWNER_DELEGATED_ACCOUNT_RECEIPT_RECONCILED'] : [],
            ...review && run.attempts.some(a => a.receipt?.submissionKind === 'DELEGATED_SINGLE' && a.receipt.gasPayer !== a.account) ? ['OWNER_SUBMISSION_RELAYED_FEE_PAID_BY_RELAYER'] : []] };
        const bundle = validateArtifact('evidence-bundle', { schemaVersion: '1.0.0',
          evidenceBundleId: id + '.evidence', version: 1, supersedes: null,
          semanticWorkflowHash: run.quote.workflowHash, artifactSetHash: digest(canonical(run.quote)),
          simulationHash: digest(canonical({ expected: run.quote.expectedOut, minimum: run.quote.minimumOut, pool: run.quote.pool })),
          policyHash: digest(canonical({ amount: run.quote.amountIn, slippageBps: run.quote.slippageBps })),
          manifestHash: run.quote.manifestHash, executionPlanHash: digest(canonical(attempt.tx)),
          journalHeadHash, observedAt: now().toISOString(),
          // A MOCKED loopback run is never labeled as public execution.
          environment: P.kind === 'CATALOG' ? run.quote.provenance === 'PUBLIC_MAINNET' ? 'MAINNET_EXECUTED' : 'MOCKED' : 'TESTNET_EXECUTED', outcome: 'RECONCILED',
          receipts: [{ receiptId: attempt.txHash, contentHash: receiptHash }], differences: [], reconciliation,
          evidence: [{ evidenceId: 'public-explorer', kind: 'EXTERNAL_REFERENCE', contentHash: digest(explorer) },
            { evidenceId: 'transaction-readback', kind: 'EXTERNAL_REFERENCE', contentHash: digest(canonical(tx)) },
            { evidenceId: 'balance-reconciliation', kind: 'EXTERNAL_REFERENCE', contentHash: digest(canonical(reconciliation)) }],
        }) as EvidenceBundle;
        const evidenceBundleHash = hashArtifactBytes('evidence-bundle', new TextEncoder().encode(JSON.stringify(bundle)));
        const outcome: PublicOutcome = { inputSpent: spent.toString(), outputReceived: received.toString(),
          inputAfter: inputAfter.toString(), outputAfter: outputAfter.toString(), allowanceAfter: allowanceAfter.toString(),
          nativeAfter: nativeAfter.toString(), gasCostWei: actualGasCost.toString(), explorer, evidence: bundle, evidenceBundleHash };
        return await save({ ...run, outcome });
      } catch (cause) {
        // Persist proven semantic mismatches so neither refresh nor a restarted worker can revive this authority.
        // Provider outages and incomplete reads remain retriable observations.
        if (run.quote.ownerReview && cause instanceof Error &&
            ['TRANSACTION_MISMATCH', 'APPROVAL_NOT_EFFECTIVE', 'RECONCILIATION_MISMATCH'].includes(cause.message))
          return save({ ...run, divergence: cause.message, reviewedManifestHash: null });
        throw cause;
      }
    });
  }
  return { prepare, refresh, begin, observe };
}
