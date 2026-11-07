// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the life of one user-funded execution group — prepare → owner authorization → submission →
 * reconciliation — for each strategy. Every fee is paid by the owner's own account (invariant S1, asserted before anything is relayed);
 * every artifact the owner signs is exact (calls, amounts, minimum outputs, gas words) and verified here before it is used.
 *
 *   EVM_WALLET_BATCH      prepare: exact calls + `wallet_sendCalls` request + fee estimate; the owner's wallet signs AND sends (FloFi relays
 *                         nothing); authorize: the batch id; report: the transaction hashes; reconcile: receipts re-read from the chain
 *   EVM_USER_OPERATION    prepare: the owner's own user operation (no factory, no paymaster) and its EIP-712 typed data; authorize: the owner's
 *                         signature, recovered to the owner; submit (when due): simulated by the bundler first, then relayed; the EntryPoint
 *                         charges the owner's account; reconcile: the bundle receipt's UserOperationEvent (sender = owner, paymaster = 0)
 *   SOLANA_SIGN_ALL       prepare: one exact, simulated v0 transaction per step (owner = fee payer and only signer; recent blockhash);
 *                         authorize: all signed transactions, each verified against its reviewed message; submit: in order, each after the
 *                         previous confirmed; reconcile: each finalized transaction's owner balance deltas and fee
 *
 * Nothing here chooses a wallet, holds a key or signs. A failed check is a closed code; a submitted artifact is never replaced by another.
 */
import { erc4337, eip5792, fromBase64, parseMessageV0, parseTransaction, simulateJupiterSwap, simulateSolanaTransfer, verifySignedJupiterTransaction,
  verifySignedSolanaTransfer, type JupiterHttp, type JupiterReview, type LookupTables, type SolanaRpc, type SolanaTransferReview } from '@defi-workflow-engine/reference-compiler';
import type { ChainTransport } from '../delegation/chains.ts';
import { assetKey, type WorkflowRequirement } from '../delegation/steps.ts';
import type { WorkflowComposition } from '../engine/strategy-engine';
import type { GroupStrategy } from '../workflow-runs/execution-groups.ts';
import type { BundlerClient } from './bundler.ts';
import { buildEvmGroupCalls, DEPENDENT_CALL_GAS, evmCallsOf, type AssetAmountFact, type EvmGroupCalls } from './evm-calls.ts';
import { reconcileUserOperation, reconcileWalletBatch, type StepFacts } from './evm-reconcile.ts';
import { assertUserFundedSubmission, type GasPaidFact } from './gas-payer.ts';

const WSOL = 'So11111111111111111111111111111111111111112';
/** How long a prepared EVM group's quotes are honoured before it must be prepared again. */
export const EVM_PREPARED_TTL_MS = 10 * 60_000;
/** Conservative user-operation limits when the account cannot be simulated yet (not upgraded, or waiting for a delivery). */
const USER_OP_FALLBACK: { readonly verificationGasLimit: bigint; readonly preVerificationGas: bigint; readonly perCallGas: bigint } =
  Object.freeze({ verificationGasLimit: 150_000n, preVerificationGas: 80_000n, perCallGas: 250_000n });
/** A delayed operation's signed fee ceiling: this multiple of the current base fee plus the priority fee (the most it can ever cost). */
const DELAYED_FEE_MULTIPLE = 3n;

export type UserFundedDeps = {
  readonly chains: readonly string[];
  /** Read-only EVM transport of a user-funded chain (`eth_call`, receipts, balances), or null. */
  readonly evm: (chain: string) => ChainTransport | null;
  /** The ERC-4337 v0.7 bundler of a chain, or null when the deployment has none there. */
  readonly bundler: (chain: string) => BundlerClient | null;
  /** Solana mainnet RPC (reads, simulation and `sendTransaction` of owner-signed bytes only), or null. */
  readonly solana: SolanaRpc | null;
  readonly jupiter: JupiterHttp | null;
  readonly now: () => Date;
};
export type GroupInput = { readonly runId: string; readonly groupIndex: number; readonly strategy: GroupStrategy; readonly chain: string; readonly feePayer: string;
  readonly stepFrom: number; readonly stepTo: number };
export type Prepared = Readonly<Record<string, unknown>> & { readonly kind: GroupStrategy };
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly stepIndex?: number | null };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const no = (code: string, stepIndex: number | null = null): Result<never> => ({ ok: false, code, stepIndex });
const codeOf = (cause: unknown, fallback: string) => cause instanceof Error && /^[A-Z][A-Z0-9_:]{2,100}$/.test(cause.message) ? cause.message : fallback;
const hex = (v: bigint) => '0x' + v.toString(16);
const big = (v: unknown) => BigInt(String(v));

// ── Prepare ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** EVM fee facts: the price the wallet/bundler will see now and the owner's native balance (which must cover the maximum cost). */
async function feeFacts(t: ChainTransport, owner: string) {
  const [priority, gasPrice, balance] = await Promise.all([t.rpc('eth_maxPriorityFeePerGas', []), t.rpc('eth_gasPrice', []), t.rpc('eth_getBalance', [owner, 'latest'])]);
  return { priority: big(priority), gasPrice: big(gasPrice), balance: big(balance) };
}
const nativeSpend = (group: EvmGroupCalls) => group.calls.reduce((sum, c) => c.kind === 'NATIVE_TRANSFER' ? sum + BigInt(c.amount) : sum, 0n);

async function prepareWalletBatch(deps: UserFundedDeps, requirement: WorkflowRequirement, g: GroupInput, guaranteed: ReadonlyMap<number, AssetAmountFact>): Promise<Result<Prepared>> {
  const t = deps.evm(g.chain);
  if (!t) return no('USER_FUNDED_RPC_UNAVAILABLE');
  const built = await buildEvmGroupCalls(requirement, g.stepFrom, g.stepTo, { chains: deps.chains, owner: g.feePayer, transport: deps.evm, guaranteed });
  if (!built.ok) return no(built.code, built.stepIndex);
  const group = built.value, calls = evmCallsOf(group);
  // The first call depends on nothing earlier in the batch: if it cannot be estimated from the owner's account it would revert, so nothing is offered.
  let firstGas: bigint;
  try { firstGas = big(await t.rpc('eth_estimateGas', [{ from: group.owner, to: calls[0]!.target, value: hex(calls[0]!.value), data: calls[0]!.data }])); }
  catch (cause) { return no(codeOf(cause, '') === 'DELEGATION_RPC_UNAVAILABLE' ? 'USER_FUNDED_RPC_UNAVAILABLE' : 'SIMULATION_REVERTED', group.steps[0]?.stepIndex ?? null); }
  const gas = firstGas + group.calls.slice(1).reduce((sum, c) => sum + DEPENDENT_CALL_GAS[c.kind], 0n) + 30_000n;
  const fees = await feeFacts(t, group.owner);
  const maxFeePerGas = fees.gasPrice * 2n + fees.priority, maxCost = gas * maxFeePerGas;
  // Financial isolation: the owner's own native balance must cover the fee ceiling plus any native value sent; nobody else's ever does.
  if (fees.balance < maxCost + nativeSpend(group)) return no('USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE');
  const request = eip5792.sendCallsRequest(group.chainId, group.owner, calls);
  return ok({ kind: 'EVM_WALLET_BATCH', chainId: group.chainId, owner: group.owner, group, request,
    fee: { payer: group.owner, unit: 'wei', estimatedGas: gas.toString(), maxFeePerGas: maxFeePerGas.toString(), maxCost: maxCost.toString(), estimated: true } });
}

async function prepareUserOperation(deps: UserFundedDeps, requirement: WorkflowRequirement, g: GroupInput, guaranteed: ReadonlyMap<number, AssetAmountFact>,
  delayed: boolean): Promise<Result<Prepared>> {
  const t = deps.evm(g.chain), bundler = deps.bundler(g.chain);
  if (!t) return no('USER_FUNDED_RPC_UNAVAILABLE');
  if (!bundler) return no('USER_OPERATION_BUNDLER_UNAVAILABLE');
  const built = await buildEvmGroupCalls(requirement, g.stepFrom, g.stepTo, { chains: deps.chains, owner: g.feePayer, transport: deps.evm, guaranteed });
  if (!built.ok) return no(built.code, built.stepIndex);
  const group = built.value, callData = erc4337.batchCallData(evmCallsOf(group));
  // The account must be (or become, inside an earlier batch of this run) the owner's MetaMask EIP-7702 smart account.
  const code = String(await t.rpc('eth_getCode', [group.owner, 'latest'])).toLowerCase();
  const upgraded = code === '0xef0100' + erc4337.DELEGATOR_IMPLEMENTATION.slice(2).toLowerCase();
  if (!upgraded && code !== '0x') return no('EVM_ACCOUNT_DELEGATED_ELSEWHERE');
  const key = erc4337.nonceKeyOf(`${g.runId}:g${g.groupIndex}`);
  const sequence = erc4337.decodeGetNonce(await t.rpc('eth_call', [{ to: erc4337.ENTRY_POINT_V0_7, data: erc4337.getNonceCall(group.owner, key) }, 'latest']));
  const nonce = erc4337.userOpNonce(key, sequence);
  const fees = await feeFacts(t, group.owner);
  const maxFeePerGas = fees.gasPrice * (delayed ? DELAYED_FEE_MULTIPLE : 2n) + fees.priority;
  let limits = { verificationGasLimit: USER_OP_FALLBACK.verificationGasLimit, callGasLimit: USER_OP_FALLBACK.perCallGas * BigInt(group.calls.length),
    preVerificationGas: USER_OP_FALLBACK.preVerificationGas };
  // A delayed group cannot be simulated before its delivery: it is signed with conservative limits and simulated by the bundler when due.
  if (upgraded && !delayed) {
    const draft = erc4337.packedUserOperation({ sender: group.owner, nonce, callData, gas: { ...limits, maxFeePerGas, maxPriorityFeePerGas: fees.priority } });
    try { const e = await bundler.estimate(draft); limits = { verificationGasLimit: e.verificationGasLimit * 12n / 10n, callGasLimit: e.callGasLimit * 12n / 10n,
      preVerificationGas: e.preVerificationGas * 11n / 10n }; }
    catch (cause) { return no(codeOf(cause, 'USER_OPERATION_SIMULATION_FAILED')); }
  }
  const gas = { ...limits, maxFeePerGas, maxPriorityFeePerGas: fees.priority };
  const op = erc4337.packedUserOperation({ sender: group.owner, nonce, callData, gas });
  erc4337.assertUserFundedOperation(op);
  const maxCost = erc4337.maxPrefund(gas);
  if (!delayed && fees.balance < maxCost + nativeSpend(group)) return no('USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE');
  return ok({ kind: 'EVM_USER_OPERATION', chainId: group.chainId, owner: group.owner, group, upgraded,
    op: serialOp(op), userOpHash: erc4337.userOpHash(op, group.chainId), typedData: erc4337.delegatorUserOpTypedData(group.chainId, op),
    fee: { payer: group.owner, unit: 'wei', maxFeePerGas: maxFeePerGas.toString(), maxCost: maxCost.toString(), estimated: !delayed && upgraded } });
}
export type SerialOp = { readonly sender: string; readonly nonce: string; readonly callData: string; readonly accountGasLimits: string; readonly preVerificationGas: string;
  readonly gasFees: string };
const serialOp = (op: erc4337.PackedUserOperation): SerialOp => ({ sender: op.sender, nonce: op.nonce.toString(), callData: op.callData, accountGasLimits: op.accountGasLimits,
  preVerificationGas: op.preVerificationGas.toString(), gasFees: op.gasFees });
export const opOf = (s: SerialOp, signature = '0x'): erc4337.PackedUserOperation => ({ sender: s.sender, nonce: BigInt(s.nonce), initCode: '0x', callData: s.callData,
  accountGasLimits: s.accountGasLimits, preVerificationGas: BigInt(s.preVerificationGas), gasFees: s.gasFees, paymasterAndData: '0x', signature });

/** One reviewed Solana transaction of a group (what the owner signs and what FloFi verifies; never the whole Review artifact chain). */
export type SolanaGroupTx = { readonly stepIndex: number; readonly kind: 'JUPITER' | 'TRANSFER'; readonly owner: string; readonly message: string; readonly messageHash: string;
  readonly unsignedTransaction: string; readonly lookupTables: LookupTables; readonly lastValidBlockHeight: number; readonly estimatedFeeLamports: string;
  readonly spend: AssetAmountFact; readonly minimumOut: AssetAmountFact | null };
async function prepareSolanaSignAll(deps: UserFundedDeps, composition: WorkflowComposition, requirement: WorkflowRequirement, g: GroupInput): Promise<Result<Prepared>> {
  if (!deps.solana) return no('USER_FUNDED_SOLANA_RPC_UNAVAILABLE');
  const txs: SolanaGroupTx[] = [];
  for (let index = g.stepFrom; index <= g.stepTo; index++) {
    const step = requirement.steps[index]!;
    // The compiler's builders take the canonical workflow as a plain (mutable-typed) value; it is never modified.
    const workflow = composition.steps[index]!.workflow as unknown as Parameters<typeof simulateSolanaTransfer>[0];
    // Independent steps only: a step bound to an earlier step of this group could not be simulated before that step lands (it is cut off by the planner).
    if (requirement.bindings.some(b => b.step === index && b.amountFrom >= g.stepFrom)) return no('SOLANA_GROUP_STEP_DEPENDENT', index);
    try {
      if (step.action === 'transfer') {
        const review: SolanaTransferReview = await simulateSolanaTransfer(workflow, g.feePayer, deps.solana, deps.now().getTime());
        txs.push({ stepIndex: index, kind: 'TRANSFER', owner: review.owner, message: review.message, messageHash: review.messageHash, unsignedTransaction: review.unsignedTransaction,
          lookupTables: {}, lastValidBlockHeight: review.lastValidBlockHeight, estimatedFeeLamports: review.estimatedFeeLamports,
          spend: { asset: assetKey({ chain: step.chain, address: review.asset.mint ?? WSOL }), amount: review.amount }, minimumOut: null });
      } else if (step.action === 'swap') {
        if (!deps.jupiter) return no('JUPITER_UNAVAILABLE', index);
        const review: JupiterReview = await simulateJupiterSwap(workflow, g.feePayer, deps.jupiter, deps.solana, deps.now().getTime());
        const r = review as unknown as { lookupTables?: LookupTables; quote: { inputMint: string; outputMint: string; inAmount: string; otherAmountThreshold: string } };
        txs.push({ stepIndex: index, kind: 'JUPITER', owner: review.owner, message: review.message, messageHash: review.messageHash, unsignedTransaction: review.unsignedTransaction,
          lookupTables: r.lookupTables ?? {}, lastValidBlockHeight: review.lastValidBlockHeight, estimatedFeeLamports: review.estimatedFeeLamports,
          spend: { asset: assetKey({ chain: step.chain, address: r.quote.inputMint }), amount: r.quote.inAmount },
          minimumOut: { asset: assetKey({ chain: step.chain, address: r.quote.outputMint }), amount: r.quote.otherAmountThreshold } });
      } else return no(`USER_FUNDED_ACTION_NOT_BUILDABLE:${step.action.toUpperCase()}`, index);
    } catch (cause) { return no(codeOf(cause, 'SIMULATION_FAILED'), index); }
    const last = txs.at(-1)!;
    // S1: the fee payer of every transaction (static key 0 of its message) is the owner.
    assertUserFundedSubmission({ kind: 'SOLANA_TRANSACTION', feePayer: parseMessageV0(fromBase64(last.message)).staticKeys[0] ?? '', ownerWallet: g.feePayer });
  }
  const fee = txs.reduce((sum, x) => sum + BigInt(x.estimatedFeeLamports), 0n);
  return ok({ kind: 'SOLANA_SIGN_ALL', owner: g.feePayer, transactions: txs, fee: { payer: g.feePayer, unit: 'lamports', maxCost: fee.toString(), estimated: true },
    lastValidBlockHeight: Math.min(...txs.map(x => x.lastValidBlockHeight)) });
}

/** Builds what the owner signs for one group, from fresh chain facts. `guaranteed`: outputs fixed before this group (a bridge's signed minimum). */
export async function prepareGroup(deps: UserFundedDeps, composition: WorkflowComposition, requirement: WorkflowRequirement, g: GroupInput,
  options: { readonly guaranteed?: ReadonlyMap<number, AssetAmountFact>; readonly delayed?: boolean } = {}): Promise<Result<{ readonly prepared: Prepared; readonly validUntil: Date }>> {
  const now = deps.now().getTime(), guaranteed = options.guaranteed ?? new Map();
  try {
    let r: Result<Prepared>;
    if (g.strategy === 'EVM_WALLET_BATCH') r = await prepareWalletBatch(deps, requirement, g, guaranteed);
    else if (g.strategy === 'EVM_USER_OPERATION') r = await prepareUserOperation(deps, requirement, g, guaranteed, options.delayed === true);
    else if (g.strategy === 'SOLANA_SIGN_ALL') r = await prepareSolanaSignAll(deps, composition, requirement, g);
    else return no('USER_FUNDED_GROUP_NOT_PREPARABLE');
    if (!r.ok) return r;
    // Wallet batches and Solana transactions are honoured for a short window (quotes, recent blockhash); a user operation is bound by its nonce and the run.
    const validUntil = new Date(g.strategy === 'EVM_USER_OPERATION' ? now + 24 * 3_600_000 : g.strategy === 'SOLANA_SIGN_ALL' ? now + 60_000 : now + EVM_PREPARED_TTL_MS);
    return ok({ prepared: { ...r.value, preparedAt: new Date(now).toISOString() }, validUntil });
  } catch (cause) { return no(codeOf(cause, 'USER_FUNDED_PREPARE_FAILED')); }
}

// ── Authorization (what the owner's wallet returned) ──────────────────────────────────────────────────────────────────────
export type OwnerAnswer = { readonly kind: 'EVM_WALLET_BATCH'; readonly batchId: string } | { readonly kind: 'EVM_USER_OPERATION'; readonly signature: string }
  | { readonly kind: 'SOLANA_SIGN_ALL'; readonly transactions: readonly string[] };
/** Verifies the owner's answer against the frozen prepared artifact (never against anything the browser sends back as "the artifact"). */
export function authorizeGroup(prepared: Prepared, answer: OwnerAnswer, owner: string, now: Date): Result<Readonly<Record<string, unknown>>> {
  if (answer.kind !== prepared.kind) return no('USER_FUNDED_AUTHORIZATION_KIND_MISMATCH');
  const at = now.toISOString();
  if (answer.kind === 'EVM_WALLET_BATCH') {
    try { return ok({ kind: answer.kind, batchId: eip5792.sendCallsId(answer.batchId), at }); } catch { return no('EIP5792_RESPONSE_INVALID'); }
  }
  if (answer.kind === 'EVM_USER_OPERATION') {
    const op = opOf(prepared.op as SerialOp), chainId = Number(prepared.chainId);
    if (typeof answer.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(answer.signature)) return no('USER_OPERATION_SIGNATURE_INVALID');
    // The delegator account accepts only its own EOA's signature over its EIP-712 digest: anything else would fail on chain (S6: exact op).
    if (!erc4337.verifyOwnerUserOpSignature(chainId, op, answer.signature) || op.sender.toLowerCase() !== owner.toLowerCase()) return no('USER_OPERATION_SIGNER_MISMATCH');
    return ok({ kind: answer.kind, signature: answer.signature.toLowerCase(), signer: owner.toLowerCase(), at });
  }
  const txs = prepared.transactions as readonly SolanaGroupTx[];
  if (!Array.isArray(answer.transactions) || answer.transactions.length !== txs.length) return no('SOLANA_SIGNED_COUNT_MISMATCH');
  const signed: { signature: string; transaction: string }[] = [];
  for (const [i, tx] of txs.entries()) {
    try {
      const review = { message: tx.message, owner, lookupTables: tx.lookupTables };
      const verified = tx.kind === 'TRANSFER' ? verifySignedSolanaTransfer(review, answer.transactions[i]) : verifySignedJupiterTransaction(review as unknown as JupiterReview, answer.transactions[i]);
      // A wallet guard (Lighthouse) may append assertions; the signed message must still be the reviewed one or the verifier refused above.
      signed.push({ signature: verified.signature, transaction: verified.transaction });
    } catch (cause) { return no(codeOf(cause, 'SOLANA_SIGNATURE_INVALID'), tx.stepIndex); }
  }
  return ok({ kind: answer.kind, transactions: signed, at });
}

// ── Submission ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Relays an AUTHORIZED user operation (simulated by the bundler first: a failing one is never sent, so it costs the owner nothing). */
export async function submitUserOperation(deps: UserFundedDeps, prepared: Prepared, authorization: Readonly<Record<string, unknown>>, owner: string): Promise<Result<Readonly<Record<string, unknown>>>> {
  const chain = `eip155:${String(prepared.chainId)}`, bundler = deps.bundler(chain);
  if (!bundler) return no('USER_OPERATION_BUNDLER_UNAVAILABLE');
  const op = opOf(prepared.op as SerialOp, String(authorization.signature));
  assertUserFundedSubmission({ kind: 'EVM_USER_OPERATION', feePayer: op.sender, ownerWallet: owner, sponsorship: op.paymasterAndData });
  try {
    // Due-time simulation: the bundler validates and simulates the exact signed operation; a revert or a too-low fee is a refusal, not a send.
    await bundler.estimate(op);
    const hash = await bundler.send(op);
    return ok({ kind: 'EVM_USER_OPERATION', userOpHash: hash, hashes: [], submittedAt: deps.now().toISOString() });
  } catch (cause) { return no(codeOf(cause, 'USER_OPERATION_REJECTED')); }
}
/** The Solana submission record: every signature is known before anything is sent (the first signature of each owner-signed transaction). */
export function solanaSubmission(authorization: Readonly<Record<string, unknown>>, now: Date): Readonly<Record<string, unknown>> {
  const txs = authorization.transactions as readonly { signature: string }[];
  return { kind: 'SOLANA_SIGN_ALL', hashes: txs.map(t => t.signature), submittedAt: now.toISOString() };
}
type SignatureStatus = { readonly confirmationStatus?: string; readonly err?: unknown } | null;
async function statuses(rpc: SolanaRpc, signatures: readonly string[]): Promise<readonly SignatureStatus[]> {
  const r = await rpc('getSignatureStatuses', [signatures, { searchTransactionHistory: true }]) as { value?: readonly SignatureStatus[] };
  return r?.value ?? signatures.map(() => null);
}
/**
 * Sends the next transaction of a Solana group whose predecessor confirmed (exactly the owner-signed bytes; a resend is the same signature).
 * Returns what happened; never sends a transaction past its blockhash validity.
 */
export async function advanceSolanaSubmission(deps: UserFundedDeps, prepared: Prepared, authorization: Readonly<Record<string, unknown>>, owner: string)
  : Promise<{ readonly state: 'SENT' | 'WAITING' | 'DONE' | 'EXPIRED' | 'FAILED'; readonly index: number | null; readonly code: string | null }> {
  const rpc = deps.solana;
  if (!rpc) return { state: 'WAITING', index: null, code: 'USER_FUNDED_SOLANA_RPC_UNAVAILABLE' };
  const txs = prepared.transactions as readonly SolanaGroupTx[], signed = authorization.transactions as readonly { signature: string; transaction: string }[];
  const known = await statuses(rpc, signed.map(s => s.signature));
  for (const [i, status] of known.entries()) {
    if (status?.err) return { state: 'FAILED', index: i, code: 'SOLANA_TRANSACTION_FAILED' };
    if (status && ['confirmed', 'finalized'].includes(String(status.confirmationStatus))) continue;
    if (status) return { state: 'WAITING', index: i, code: null };
    // Not seen yet: send it unless its blockhash expired (then it can never land, and nothing later is sent).
    const height = Number(await rpc('getBlockHeight', [{ commitment: 'confirmed' }]));
    if (height > txs[i]!.lastValidBlockHeight) return { state: 'EXPIRED', index: i, code: 'SOLANA_BLOCKHASH_EXPIRED' };
    const message = parseMessageV0(parseTransaction(fromBase64(signed[i]!.transaction)).message);
    assertUserFundedSubmission({ kind: 'SOLANA_TRANSACTION', feePayer: message.staticKeys[0] ?? '', ownerWallet: owner });
    await rpc('sendTransaction', [signed[i]!.transaction, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 10 }]);
    return { state: 'SENT', index: i, code: null };
  }
  return { state: 'DONE', index: null, code: null };
}

// ── Reconciliation ────────────────────────────────────────────────────────────────────────────────────────────────────────
export type Reconciled = { readonly status: 'PENDING' } | { readonly status: 'RECONCILED'; readonly steps: readonly StepFacts[]; readonly gasPaid: GasPaidFact; readonly transactions: readonly string[] }
  | { readonly status: 'FAILED'; readonly code: string; readonly gasPaid: GasPaidFact | null; readonly transactions: readonly string[]; readonly steps?: readonly StepFacts[] };
type TokenBalance = { readonly accountIndex: number; readonly mint: string; readonly owner?: string; readonly uiTokenAmount: { readonly amount: string } };
type SolanaTxMeta = { readonly err: unknown; readonly fee: number | string; readonly preBalances: readonly (number | string)[]; readonly postBalances: readonly (number | string)[];
  readonly preTokenBalances?: readonly TokenBalance[]; readonly postTokenBalances?: readonly TokenBalance[] };
/** The owner's balance deltas of one finalized Solana transaction (native SOL keyed by the wrapped mint, fee separated). */
export function solanaOwnerDeltas(chain: string, owner: string, meta: SolanaTxMeta): { readonly spent: AssetAmountFact[]; readonly received: AssetAmountFact[]; readonly fee: bigint } {
  const fee = BigInt(meta.fee), spent: AssetAmountFact[] = [], received: AssetAmountFact[] = [];
  const sol = BigInt(meta.preBalances[0]!) - BigInt(meta.postBalances[0]!) - fee;
  if (sol > 0n) spent.push({ asset: assetKey({ chain, address: WSOL }), amount: sol.toString() });
  if (sol < 0n) received.push({ asset: assetKey({ chain, address: WSOL }), amount: (-sol).toString() });
  const mints = new Set([...meta.preTokenBalances ?? [], ...meta.postTokenBalances ?? []].filter(b => b.owner === owner).map(b => b.mint));
  for (const mint of mints) {
    const sum = (xs: readonly TokenBalance[] | undefined) => (xs ?? []).filter(b => b.owner === owner && b.mint === mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
    const delta = sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
    if (delta < 0n) spent.push({ asset: assetKey({ chain, address: mint }), amount: (-delta).toString() });
    if (delta > 0n) received.push({ asset: assetKey({ chain, address: mint }), amount: delta.toString() });
  }
  return { spent, received, fee };
}
export async function reconcileSolanaGroup(deps: UserFundedDeps, prepared: Prepared, submission: Readonly<Record<string, unknown>>, chain: string, owner: string): Promise<Reconciled> {
  const rpc = deps.solana;
  if (!rpc) return { status: 'PENDING' };
  const txs = prepared.transactions as readonly SolanaGroupTx[], signatures = submission.hashes as readonly string[];
  const steps: StepFacts[] = [];
  let fee = 0n;
  for (const [i, signature] of signatures.entries()) {
    const tx = await rpc('getTransaction', [signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]) as { meta?: SolanaTxMeta } | null;
    if (!tx?.meta) return { status: 'PENDING' };
    const deltas = solanaOwnerDeltas(chain, owner, tx.meta);
    fee += deltas.fee;
    const gasPaid: GasPaidFact = { payer: owner, amount: fee.toString(), unit: 'lamports', source: 'SOLANA_META' };
    if (tx.meta.err) return { status: 'FAILED', code: 'SOLANA_TRANSACTION_FAILED', gasPaid, transactions: signatures.slice(0, i + 1), steps };
    const expected = txs[i]!;
    const min = expected.minimumOut, got = min ? deltas.received.find(r => r.asset === min.asset) : null;
    if (min && (!got || BigInt(got.amount) < BigInt(min.amount))) return { status: 'FAILED', code: 'RECONCILIATION_BELOW_SIGNED_MINIMUM', gasPaid, transactions: signatures.slice(0, i + 1), steps };
    steps.push({ stepIndex: expected.stepIndex, spent: deltas.spent, received: deltas.received });
  }
  return { status: 'RECONCILED', steps, gasPaid: { payer: owner, amount: fee.toString(), unit: 'lamports', source: 'SOLANA_META' }, transactions: [...signatures] };
}
/** Reconciles an EVM group from the chain (wallet batch: the reported hashes; user operation: the bundler's bundle transaction, re-read). */
export async function reconcileEvmGroup(deps: UserFundedDeps, prepared: Prepared, submission: Readonly<Record<string, unknown>>): Promise<Reconciled> {
  const group = prepared.group as EvmGroupCalls, t = deps.evm(group.chain);
  if (!t) return { status: 'PENDING' };
  if (prepared.kind === 'EVM_WALLET_BATCH') {
    const r = await reconcileWalletBatch(t, group, (submission.hashes ?? []) as string[]);
    return r.status === 'PENDING' ? r : r.status === 'RECONCILED' ? { status: 'RECONCILED', steps: r.steps, gasPaid: r.gasPaid, transactions: r.transactions }
      : { status: 'FAILED', code: r.code, gasPaid: r.gasPaid, transactions: r.transactions };
  }
  const bundler = deps.bundler(group.chain), userOpHash = String(submission.userOpHash);
  const receipt = bundler ? await bundler.receipt(userOpHash).catch(() => null) : null;
  const r = await reconcileUserOperation(t, group, userOpHash, receipt?.transactionHash ?? null);
  return r.status === 'PENDING' ? r : r.status === 'RECONCILED' ? { status: 'RECONCILED', steps: r.steps, gasPaid: r.gasPaid, transactions: r.transactions }
    : { status: 'FAILED', code: r.code, gasPaid: r.gasPaid, transactions: r.transactions };
}
