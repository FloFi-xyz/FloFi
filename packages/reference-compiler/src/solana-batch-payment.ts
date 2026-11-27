// SPDX-License-Identifier: AGPL-3.0-only
/**
 * KAN-20 (BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 WS02): read-only simulation and Review of one atomic Solana Batch Payment on mainnet-beta.
 *
 * ONE v0 message (no address lookup tables), the owner as fee payer and only signer:
 *   [SetComputeUnitLimit, SetComputeUnitPrice, leg_1 .. leg_N]
 *   SOL leg   System `Transfer` owner -> recipient
 *   SPL leg   ATA `CreateIdempotent` (atomic owner check; creates and charges rent only when the ATA is missing) + `TransferChecked`
 * Every leg is byte-identical to the reviewed single transfer (`solanaTransferInstructions`). Every leg settles or none does.
 *
 * Every fact is read from the chain at one confirmed slot (owner, recipients, mint, source, every destination ATA). The exact message is compiled,
 * bounded (bytes with a wallet-guard reserve, account locks, instruction trace) and simulated twice: a compute probe without a priority fee, then the
 * exact bytes. Compute is simulation-measured and never capped silently: a batch that needs more than its ceiling is refused, never split or trimmed.
 * Every recipient's exact delta is verified. Nothing here signs or sends; the owner's wallet signs the exact reviewed bytes (or them plus verified
 * Lighthouse assertions) and anything else is refused before broadcast. Every refusal is `SOLANA_BATCH_PAYMENT_<REASON>` with a structured cause.
 */
import { SOLANA_BATCH_PAYMENT, solanaBatchPaymentAsset, solanaBatchPaymentComputeCap, solanaTransferProfile, type SolanaTransferProfile } from '@defi-workflow-engine/action-registry';
import { BATCH_PAYMENT_ACTION, BATCH_PAYMENT_SOLANA_ADAPTER, SOLANA_BATCH_PAYMENT_RESERVED_RECIPIENTS, isSolanaBatchPaymentNode, readSolanaBatchPaymentNode,
  type ArtifactSet, type AuthorizationPolicy, type ExecutionPlan, type SemanticWorkflow, type SimulationBundle, type SolanaBatchPaymentFields, type SolanaTransferToken,
  type StrategyManifest } from '@defi-workflow-engine/workflow-contracts';
import { associatedTokenAddress, compileMessageV0, decompileMessageV0, fromBase64, parseMessageV0, readU64, serializeMessageV0, serializeTransaction, sha256Hex,
  solanaAddress, solanaKeyOnCurve, toBase64, type SolanaInstruction } from './solana.js';
import { assertMessageRoundTrip, estimateFee, readSolanaAccounts, rpcContextValue, setComputeUnitLimit, setComputeUnitPrice, simulateSolanaMessage, solanaRecord, solanaSwapArtifactHash,
  solanaSwapHash, verifySignedSolanaSwap, verifySolanaCluster, type RawSolanaAccount, type SignedSolanaTransaction, type SolanaRpc } from './solana-swap.js';
import { assertSolanaTransferRecipientAccount, readSolanaTransferDestinationAccount, readSolanaTransferMintAccount, readSolanaTransferSourceAccount, selectSolanaTransferSource,
  solanaTransferInstructions, tokenAmountAfter, type SolanaTransferIntent } from './solana-transfer.js';
import { LIGHTHOUSE_PROGRAM } from './solana-wallet-change.js';

export { SOLANA_BATCH_PAYMENT, solanaBatchPaymentAsset, solanaBatchPaymentComputeCap } from '@defi-workflow-engine/action-registry';
export const SOLANA_BATCH_PAYMENT_CODE = 'SOLANA_BATCH_PAYMENT';
export const SOLANA_BATCH_PAYMENT_REVIEW_FORMAT = 'flofi.solana-batch-payment-review.v1';
const X = SOLANA_BATCH_PAYMENT_CODE;
const U64_MAX = (1n << 64n) - 1n;
function fail(code: string, cause?: unknown): never { throw new Error(`${X}_${code}`, cause === undefined ? undefined : { cause }); }
/** A shared single-transfer check re-raised as the batch's own code: `SOLANA_TRANSFER_<R>` becomes `SOLANA_BATCH_PAYMENT_<R>` (with the recipient index). */
function batchError(error: unknown, recipient?: number): unknown {
  if (!(error instanceof Error) || !error.message.startsWith('SOLANA_TRANSFER_')) return error;
  const inner = error.cause, cause = recipient === undefined ? inner : { recipient, ...inner === undefined ? {} : { cause: inner } };
  return new Error(`${X}_${error.message.slice('SOLANA_TRANSFER_'.length)}`, cause === undefined ? undefined : { cause });
}
function asBatch<T>(run: () => T, recipient?: number): T { try { return run(); } catch (error) { throw batchError(error, recipient); } }
async function asBatchAsync<T>(run: () => Promise<T>, recipient?: number): Promise<T> { try { return await run(); } catch (error) { throw batchError(error, recipient); } }
const lamports = (account: RawSolanaAccount | undefined) => account?.lamports ?? 0n;
const programOf = (profile: SolanaTransferProfile, program: 'spl-token' | 'token-2022') => program === 'token-2022' ? profile.programs.token2022 : profile.programs.token;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);

export type SolanaBatchPaymentLeg = { readonly index: number; readonly recipient: string; readonly amount: string; readonly intent: SolanaTransferIntent };
export type SolanaBatchPaymentIntent = { readonly nodeId: string; readonly profile: SolanaTransferProfile; readonly owner: string; readonly fields: SolanaBatchPaymentFields;
  readonly token: SolanaTransferToken | null; readonly total: string; readonly legs: readonly SolanaBatchPaymentLeg[] };
export type SolanaBatchRecipientFacts = { readonly index: number; readonly recipient: string; readonly amount: string; readonly recipientExists: boolean;
  readonly recipientLamports: string; readonly destinationAccount: string | null; readonly destinationAmount: string | null; readonly createDestination: boolean };
export type SolanaBatchPaymentTokenFacts = { readonly program: 'spl-token' | 'token-2022'; readonly programId: string; readonly mint: string; readonly decimals: number;
  readonly symbol: string; readonly extensions: number[]; readonly sourceAccount: string; readonly sourceAmount: string };
export type SolanaBatchPaymentFacts = { readonly slot: number; readonly ownerLamports: string; readonly rentExemptMinimum: string; readonly token: SolanaBatchPaymentTokenFacts | null;
  readonly recipients: readonly SolanaBatchRecipientFacts[] };
/** One reviewed payment: its chain facts, the deposit it creates now, the worst-case deposit, and the recipient's lamports (SOL) or ATA token amount (SPL) simulated. */
export type SolanaBatchPaymentPayment = SolanaBatchRecipientFacts & { readonly accountCreationLamports: string; readonly maximumAccountCreationLamports: string;
  readonly before: string; readonly after: string };
export type SolanaBatchPaymentAssetView = { readonly symbol: string; readonly mint: string | null; readonly decimals: number; readonly program: 'native' | 'spl-token' | 'token-2022';
  readonly verified: true };
export type SolanaBatchPaymentBounds = { readonly transactionBytes: number; readonly accountCount: number; readonly instructionCount: number; readonly instructionTraceBound: number };
/** The owner's SOL shortfall in lamports: what to add so the batch, its fee, every worst-case deposit and the owner's own reserve are covered. */
export type SolanaBatchPaymentShortfall = { readonly unit: 'lamports'; readonly balance: string; readonly fee: string; readonly deposits: string; readonly maxFee: string;
  readonly nativeSpend: string; readonly reserve: string; readonly required: string; readonly shortfall: string;
  /**
   * True once the exact message is priced. False for the refusal before simulation (the owner is below even the base fee, every worst-case deposit,
   * the SOL sent and its reserve): `fee` is then the ceiling at the compute cap, so adding `shortfall` always suffices.
   */
  readonly exact: boolean };
export type SolanaBatchPaymentReview = {
  readonly format: typeof SOLANA_BATCH_PAYMENT_REVIEW_FORMAT; readonly workflow: SemanticWorkflow; readonly chain: string;
  readonly cluster: 'mainnet-beta'; readonly network: 'Solana'; readonly owner: string; readonly atomic: true;
  readonly asset: SolanaBatchPaymentAssetView; readonly token: SolanaBatchPaymentFacts['token']; readonly payments: readonly SolanaBatchPaymentPayment[]; readonly total: string;
  readonly state: { readonly slot: number; readonly ownerLamports: string; readonly rentExemptMinimum: string };
  readonly blockhash: string; readonly lastValidBlockHeight: number;
  readonly computeUnitLimit: number; readonly computeUnitPrice: string; readonly computeUnitCap: number; readonly unitsConsumed: number;
  readonly estimatedFeeLamports: string; readonly accountCreationLamports: string; readonly maximumAccountCreationLamports: string;
  readonly maximumNetworkCostLamports: string; readonly requiredLamports: string;
  readonly transactionBytes: number; readonly accountCount: number; readonly instructionCount: number; readonly instructionTraceBound: number;
  readonly manifestHash: string; readonly message: string; readonly messageHash: string; readonly unsignedTransaction: string;
  readonly expiresAt: string; readonly artifactSet: ArtifactSet; readonly simulation: SimulationBundle; readonly policy: AuthorizationPolicy;
  readonly manifest: StrategyManifest; readonly plan: ExecutionPlan; readonly commitment: string };

/**
 * The isolated canonical Solana batch, resolved against the mainnet transfer profile. Every key is decoded to 32 canonical bytes; recipients must be
 * wallet keys (on curve), never the owner, a program, a sysvar, a native mint, the batch mint or the Lighthouse program, and never repeated.
 */
export function solanaBatchPaymentIntent(workflow: SemanticWorkflow, ownerInput: string): SolanaBatchPaymentIntent {
  const nodes = workflow.nodes.filter(n => n.actionType === BATCH_PAYMENT_ACTION);
  if (nodes.length !== 1 || !isSolanaBatchPaymentNode(nodes[0]!) || workflow.nodes.some(n => n !== nodes[0] && !n.actionType.startsWith('mock-')) ||
      workflow.resourceEdges.length || workflow.nodes.some(n => n.dependencies.length)) fail('ISOLATED_ONLY');
  const node = nodes[0]!;
  let fields: SolanaBatchPaymentFields;
  try { fields = readSolanaBatchPaymentNode(node); } catch (cause) { return fail('DECLARATION_INVALID', cause); }
  const profile = solanaTransferProfile(fields.chain);
  // Mainnet-beta only: Solana Devnet has no batch.
  if (!profile || !profile.realFunds || profile.chain !== SOLANA_BATCH_PAYMENT.chain || profile.cluster !== 'mainnet-beta') return fail('NETWORK_UNSUPPORTED');
  let owner: string;
  try { owner = solanaAddress(ownerInput); } catch { return fail('OWNER_REQUIRED'); }
  const token: SolanaTransferToken | null = fields.asset.kind === 'SPL_TOKEN' ? { mint: fields.asset.mint, decimals: fields.asset.decimals, program: fields.asset.program } : null;
  if (token) {
    try { solanaAddress(token.mint); } catch { return fail('MINT_INVALID'); }
    // Only the registry's verified assets (USDC, USDT: classic SPL Token) with exactly their decimals and program; Token-2022 is not advertised.
    const known = solanaBatchPaymentAsset(token.mint);
    if (!known || known.decimals !== token.decimals || known.program !== token.program) fail('ASSET_UNSUPPORTED', { mint: token.mint });
  }
  const reserved = new Set([...SOLANA_BATCH_PAYMENT_RESERVED_RECIPIENTS, ...Object.values(profile.programs), LIGHTHOUSE_PROGRAM, ...token ? [token.mint] : []]);
  const seen = new Set<string>(), maximum = token ? U64_MAX : BigInt(profile.maximumLamports);
  let total = 0n;
  const legs = fields.payments.map((p, index): SolanaBatchPaymentLeg => {
    let recipient: string;
    try { recipient = solanaAddress(p.recipient); } catch { return fail('RECIPIENT_INVALID', { recipient: index }); }
    // FloFi never turns a payment into a self-send.
    if (recipient === owner) fail('RECIPIENT_IS_SENDER', { recipient: index });
    // A program-derived address (a multisig vault, any PDA) has no private key: same policy as the single transfer.
    if (!solanaKeyOnCurve(recipient)) fail('RECIPIENT_OFF_CURVE', { recipient: index });
    if (reserved.has(recipient)) fail('RECIPIENT_RESERVED', { recipient: index });
    if (seen.has(recipient)) fail('DUPLICATE_RECIPIENT', { recipient: index });
    seen.add(recipient);
    const amount = BigInt(p.amount);
    if (amount < 1n || amount > maximum) fail('AMOUNT_OUT_OF_RANGE', { recipient: index });
    total += amount;
    return { index, recipient, amount: p.amount, intent: { nodeId: `${node.nodeId}#${index}`, profile, owner, recipient, amount: p.amount,
      fields: { chain: fields.chain, amount: p.amount, recipient, token } } };
  });
  // The source token account and the owner's lamports are u64: the total itself must fit.
  if (total > U64_MAX) fail('TOTAL_OUT_OF_RANGE', { total: total.toString() });
  return { nodeId: node.nodeId, profile, owner, fields, token, total: total.toString(), legs };
}

/**
 * Chain facts at one confirmed slot: the owner (an ordinary System wallet that pays the fee), every recipient (absent or an ordinary wallet), and
 * for SPL the mint, ONE source account that covers the whole total (never several combined) and every destination ATA (existing: the recipient's,
 * not frozen; missing: created by its CreateIdempotent).
 */
export async function readSolanaBatchPaymentFacts(rpc: SolanaRpc, intent: SolanaBatchPaymentIntent): Promise<SolanaBatchPaymentFacts> {
  const { profile, owner, token, legs } = intent, P = profile.programs;
  const rent = await rpc('getMinimumBalanceForRentExemption', [0, { commitment: 'confirmed' }]);
  if (!Number.isSafeInteger(rent) || (rent as number) <= 0) fail('RPC_INVALID');
  const programId = token ? programOf(profile, token.program) : null, total = BigInt(intent.total);
  const source = token ? await asBatchAsync(() => selectSolanaTransferSource(rpc, profile, owner, token, programId!, total)) : null;
  const destinations = token ? legs.map(leg => associatedTokenAddress(leg.recipient, token.mint, programId!, P.associatedToken)) : [];
  const keys = [owner, ...legs.map(leg => leg.recipient), ...token ? [token.mint, source!, ...destinations] : []];
  const { slot, accounts } = await readSolanaAccounts(rpc, keys);
  const ownerAccount = accounts[0] ?? null;
  // The owner pays the fee and every deposit in SOL: an ordinary System wallet (no Kora fee payer for a batch).
  if (!ownerAccount || ownerAccount.owner !== P.system || ownerAccount.data.length > 0) fail('OWNER_NOT_WALLET');
  const recipientAccounts = legs.map((_, i) => accounts[1 + i] ?? null);
  recipientAccounts.forEach((account, i) => asBatch(() => assertSolanaTransferRecipientAccount(profile, account), i));
  const facts = (i: number, destinationAccount: string | null, destinationAmount: string | null, createDestination: boolean): SolanaBatchRecipientFacts => ({
    index: i, recipient: legs[i]!.recipient, amount: legs[i]!.amount, recipientExists: recipientAccounts[i] !== null, recipientLamports: lamports(recipientAccounts[i]).toString(),
    destinationAccount, destinationAmount, createDestination });
  const base = { slot, ownerLamports: ownerAccount!.lamports.toString(), rentExemptMinimum: String(rent) };
  if (!token) return { ...base, token: null, recipients: legs.map((_, i) => facts(i, null, null, false)) };
  const at = 1 + legs.length;
  const mint = asBatch(() => readSolanaTransferMintAccount(programId!, token, accounts[at] ?? null));
  const from = asBatch(() => readSolanaTransferSourceAccount(programId!, token, owner, accounts[at + 1] ?? null, total));
  const recipients = legs.map((leg, i) => {
    const account = accounts[at + 2 + i] ?? null;
    const destinationAmount = asBatch(() => readSolanaTransferDestinationAccount(programId!, token, leg.recipient, account), i);
    return facts(i, destinations[i]!, destinationAmount, account === null);
  });
  const known = solanaBatchPaymentAsset(token.mint) ?? fail('ASSET_UNSUPPORTED', { mint: token.mint });
  return { ...base, token: { program: token.program, programId: programId!, mint: token.mint, decimals: token.decimals, symbol: known.symbol,
    extensions: mint.extensions.map(e => e.type), sourceAccount: source!, sourceAmount: from.amount.toString() }, recipients };
}

type LegToken = { readonly programId: string; readonly mint: string; readonly decimals: number; readonly sourceAccount: string };
/** One leg, exactly the reviewed single transfer's instructions (the transfer intent carries only what `solanaTransferInstructions` reads). */
function legInstructions(profile: SolanaTransferProfile, owner: string, recipient: string, amount: string, token: LegToken | null, destination: string | null,
  createDestination = false, intent?: SolanaTransferIntent): SolanaInstruction[] {
  if (token && !destination) fail('MANIFEST_MISMATCH');
  const leg: SolanaTransferIntent = intent ?? { nodeId: 'leg', profile, owner, recipient, amount,
    fields: { chain: profile.chain, amount, recipient, token: token ? { mint: token.mint, decimals: token.decimals, program: token.programId === profile.programs.token2022 ? 'token-2022' : 'spl-token' } : null } };
  return solanaTransferInstructions(leg, token ? { ...token, destinationAccount: destination!, createDestination } : null);
}
/** `[SetComputeUnitLimit, SetComputeUnitPrice, leg_1 .. leg_N]`, each leg byte-identical to the reviewed single transfer of that payment. */
export function solanaBatchPaymentInstructions(intent: Pick<SolanaBatchPaymentIntent, 'profile' | 'owner' | 'legs'>, facts: Pick<SolanaBatchPaymentFacts, 'token' | 'recipients'>,
  units: number, price = intent.profile.computeUnitPriceMicroLamports): SolanaInstruction[] {
  if (facts.recipients.length !== intent.legs.length) fail('MANIFEST_MISMATCH');
  const token = facts.token ? { programId: facts.token.programId, mint: facts.token.mint, decimals: facts.token.decimals, sourceAccount: facts.token.sourceAccount } : null;
  return [setComputeUnitLimit(units), ...setComputeUnitPrice(price), ...intent.legs.flatMap((leg, i) =>
    legInstructions(intent.profile, intent.owner, leg.recipient, leg.amount, token, facts.recipients[i]!.destinationAccount, facts.recipients[i]!.createDestination, leg.intent))];
}

/**
 * The batch's static bounds (pure) and their refusals, all before any simulation: unsigned transaction bytes within 1,232 minus the wallet-guard
 * reserve, at most 64 account locks, and an instruction-trace bound within 64 with the wallet-guard reserve. The trace bound counts every SPL leg as
 * creating its ATA (1 top-level + 4 CPIs, plus TransferChecked): an ATA that exists at Review may be closed and recreated before execution.
 */
export function solanaBatchPaymentStaticBounds(intent: Pick<SolanaBatchPaymentIntent, 'legs' | 'token'>, facts: Pick<SolanaBatchPaymentFacts, 'recipients'>,
  messageBytes: Uint8Array): SolanaBatchPaymentBounds {
  if (facts.recipients.length !== intent.legs.length) fail('MANIFEST_MISMATCH');
  const message = parseMessageV0(messageBytes), B = SOLANA_BATCH_PAYMENT;
  // One compact-u16 signature count byte and one 64-byte slot per required signer (the owner only).
  const transactionBytes = 1 + 64 * message.header[0] + messageBytes.length;
  const accountCount = message.staticKeys.length + message.lookups.reduce((n, l) => n + l.writable.length + l.readonly.length, 0);
  const instructionCount = message.instructions.length;
  const instructionTraceBound = 2 + intent.legs.length * (intent.token ? 6 : 1) + B.walletGuardInstructionReserve;
  const limit = B.maximumTransactionBytes - B.walletGuardReserveBytes;
  if (transactionBytes > limit) fail('TRANSACTION_TOO_LARGE', { bytes: transactionBytes, limit });
  if (accountCount > B.maximumAccounts) fail('TOO_MANY_ACCOUNTS', { accounts: accountCount, limit: B.maximumAccounts });
  if (instructionTraceBound > B.maximumInstructionTrace) fail('INSTRUCTION_TRACE_TOO_LONG', { bound: instructionTraceBound, limit: B.maximumInstructionTrace });
  return { transactionBytes, accountCount, instructionCount, instructionTraceBound };
}

export type SolanaBatchPaymentDecodeExpectation = { readonly owner: string; readonly profile: SolanaTransferProfile;
  readonly token: { readonly programId: string; readonly mint: string; readonly decimals: number; readonly sourceAccount: string } | null; readonly computeUnitPrice: string };
export type DecodedSolanaBatchPayment = { readonly computeUnitLimit: number;
  readonly payments: readonly { readonly recipient: string; readonly amount: string; readonly destinationAccount: string | null }[] };
/**
 * Closed decoder of a reviewed batch message: v0, no lookups, one signer (the owner, fee payer), SetComputeUnitLimit, SetComputeUnitPrice of
 * exactly `computeUnitPrice`, then 2..8 legs read from the raw instruction data (System `Transfer`, or `CreateIdempotent` + `TransferChecked` with the
 * ATA re-derived from the recipient). The instructions are then rebuilt from what was read and the message must be EXACTLY their canonical
 * compilation. Anything extra, missing, reordered, another program, account, amount, flag or key is `SOLANA_BATCH_PAYMENT_MANIFEST_MISMATCH`.
 */
export function decodeSolanaBatchPaymentMessage(message: Uint8Array, expected: SolanaBatchPaymentDecodeExpectation): DecodedSolanaBatchPayment {
  try { return decodeBatch(message, expected); } catch (cause) {
    if (cause instanceof Error && cause.message === `${X}_MANIFEST_MISMATCH`) throw cause;
    return fail('MANIFEST_MISMATCH', cause);
  }
}
function decodeBatch(message: Uint8Array, expected: SolanaBatchPaymentDecodeExpectation): DecodedSolanaBatchPayment {
  const P = expected.profile.programs, token = expected.token, mismatch = (): never => fail('MANIFEST_MISMATCH');
  const parsed = parseMessageV0(message);
  if (parsed.lookups.length || parsed.header[0] !== 1 || parsed.header[1] !== 0 || parsed.staticKeys[0] !== expected.owner) mismatch();
  const ixs = decompileMessageV0(parsed, {}), price = setComputeUnitPrice(expected.computeUnitPrice);
  const limit = ixs[0];
  if (!limit || limit.programId !== P.computeBudget || limit.accounts.length || limit.data.length !== 5 || limit.data[0] !== 2) mismatch();
  const units = new DataView(limit!.data.buffer, limit!.data.byteOffset, limit!.data.byteLength).getUint32(1, true);
  price.forEach((p, i) => { const ix = ixs[1 + i]; if (!ix || ix.programId !== p.programId || ix.accounts.length || !sameBytes(ix.data, p.data)) mismatch(); });
  const body = ixs.slice(1 + price.length), width = token ? 2 : 1, count = body.length / width;
  if (!Number.isInteger(count) || count < SOLANA_BATCH_PAYMENT.minimumRecipients || count > SOLANA_BATCH_PAYMENT.maximumRecipients) mismatch();
  const payments: { recipient: string; amount: string; destinationAccount: string | null }[] = [];
  for (let at = 0; at < body.length; at += width) {
    if (!token) {
      const ix = body[at]!;
      if (ix.programId !== P.system || ix.data.length !== 12 || ix.accounts.length !== 2 ||
          new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getUint32(0, true) !== 2) mismatch();
      payments.push({ recipient: ix.accounts[1]!.pubkey, amount: readU64(ix.data, 4).toString(), destinationAccount: null });
      continue;
    }
    const create = body[at]!, transfer = body[at + 1]!;
    if (create.programId !== P.associatedToken || create.data.length !== 1 || create.data[0] !== 1 || create.accounts.length !== 6) mismatch();
    if (transfer.programId !== token.programId || transfer.data.length !== 10 || transfer.data[0] !== 12 || transfer.accounts.length !== 4) mismatch();
    const recipient = create.accounts[2]!.pubkey, ata = create.accounts[1]!.pubkey;
    if (associatedTokenAddress(recipient, token.mint, token.programId, P.associatedToken) !== ata) mismatch();
    payments.push({ recipient, amount: readU64(transfer.data, 1).toString(), destinationAccount: ata });
  }
  if (payments.some(p => p.amount === '0' || p.recipient === expected.owner) || new Set(payments.map(p => p.recipient)).size !== payments.length) mismatch();
  const rebuilt = [setComputeUnitLimit(units), ...price,
    ...payments.flatMap(p => legInstructions(expected.profile, expected.owner, p.recipient, p.amount, token, p.destinationAccount))];
  assertMessageRoundTrip(message, rebuilt, expected.owner, {}, X);
  if (!sameBytes(serializeMessageV0(compileMessageV0(expected.owner, rebuilt, parsed.blockhash, {})), message)) mismatch();
  return { computeUnitLimit: units, payments };
}

/** The canonical, order-sensitive hash of a batch manifest: chain, owner, asset identity and every (recipient, amount) in order. */
export function solanaBatchPaymentManifestHash(m: { readonly chain: string; readonly owner: string;
  readonly asset: { readonly kind: 'NATIVE' | 'SPL_TOKEN'; readonly mint: string | null; readonly decimals: number; readonly program: 'native' | 'spl-token' | 'token-2022' };
  readonly payments: readonly { readonly recipient: string; readonly amount: string }[] }): string {
  return solanaSwapHash({ chain: m.chain, owner: m.owner, asset: { kind: m.asset.kind, mint: m.asset.mint, decimals: m.asset.decimals, program: m.asset.program },
    payments: m.payments.map(p => ({ recipient: p.recipient, amount: p.amount })) });
}
const manifestOf = (intent: SolanaBatchPaymentIntent) => ({ chain: intent.profile.chain, owner: intent.owner,
  asset: intent.token ? { kind: 'SPL_TOKEN' as const, mint: intent.token.mint, decimals: intent.token.decimals, program: intent.token.program }
    : { kind: 'NATIVE' as const, mint: null, decimals: 9, program: 'native' as const },
  payments: intent.legs.map(leg => ({ recipient: leg.recipient, amount: leg.amount })) });
const expectationOf = (owner: string, profile: SolanaTransferProfile, token: SolanaBatchPaymentFacts['token'], computeUnitPrice: string): SolanaBatchPaymentDecodeExpectation =>
  ({ owner, profile, token: token ? { programId: token.programId, mint: token.mint, decimals: token.decimals, sourceAccount: token.sourceAccount } : null, computeUnitPrice });
/** A compute exhaustion reported by the simulation (the runtime error, or its log line), as opposed to any other program failure. */
function computeExhausted(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause as { err?: unknown; logs?: unknown } | undefined : undefined;
  return JSON.stringify(cause?.err ?? null).includes('ComputationalBudgetExceeded') ||
    Array.isArray(cause?.logs) && (cause.logs as unknown[]).some(line => typeof line === 'string' && /exceeded CUs meter/i.test(line));
}
const shortfallOf = (balance: bigint, fee: bigint, deposits: bigint, nativeSpend: bigint, reserve: bigint, exact: boolean): SolanaBatchPaymentShortfall => {
  const required = nativeSpend + fee + deposits + reserve;
  return { unit: 'lamports', balance: balance.toString(), fee: fee.toString(), deposits: deposits.toString(), maxFee: (fee + deposits).toString(),
    nativeSpend: nativeSpend.toString(), reserve: reserve.toString(), required: required.toString(), shortfall: (required > balance ? required - balance : 0n).toString(), exact };
};

/** Read-only: chain facts, the exact v0 message, static bounds, measured compute, RPC simulation and Review artifacts. Never signs or sends. */
export async function simulateSolanaBatchPayment(workflow: SemanticWorkflow, ownerInput: string, rpc: SolanaRpc, now = Date.now()): Promise<SolanaBatchPaymentReview> {
  const intent = solanaBatchPaymentIntent(workflow, ownerInput), { profile, owner, legs } = intent;
  await verifySolanaCluster(rpc, profile.genesisHash).catch((cause: unknown) => fail('WRONG_CLUSTER', cause));
  const facts = await readSolanaBatchPaymentFacts(rpc, intent), token = facts.token;
  const reserve = BigInt(facts.rentExemptMinimum), total = BigInt(intent.total), balance = BigInt(facts.ownerLamports), nativeSpend = token ? 0n : total;
  // A new System account must start rent-exempt, or the runtime refuses the whole transaction.
  if (!token) for (const r of facts.recipients) if (!r.recipientExists && BigInt(r.amount) < reserve) fail('AMOUNT_BELOW_RENT_EXEMPT', { recipient: r.index, minimum: facts.rentExemptMinimum });
  const latest = rpcContextValue(await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]));
  const blockhash = solanaAddress(latest.blockhash), lastValidBlockHeight = latest.lastValidBlockHeight;
  if (!Number.isSafeInteger(lastValidBlockHeight)) fail('RPC_INVALID');
  const instructions = (units: number, price?: string) => solanaBatchPaymentInstructions(intent, facts, units, price);
  const compile = (units: number, price?: string) => {
    try { return serializeMessageV0(compileMessageV0(owner, instructions(units, price), blockhash, {})); } catch (cause) {
      if (cause instanceof Error && cause.message === 'SOLANA_TRANSACTION_TOO_LARGE') fail('TRANSACTION_TOO_LARGE', { limit: SOLANA_BATCH_PAYMENT.maximumTransactionBytes - SOLANA_BATCH_PAYMENT.walletGuardReserveBytes });
      if (cause instanceof Error && cause.message === 'SOLANA_TOO_MANY_ACCOUNTS') fail('TOO_MANY_ACCOUNTS', { limit: SOLANA_BATCH_PAYMENT.maximumAccounts });
      throw cause;
    }
  };
  const cap = solanaBatchPaymentComputeCap(legs.length);
  // Deterministic refusals first: a batch that can never be signed is refused before any balance question or simulation.
  solanaBatchPaymentStaticBounds(intent, facts, compile(cap));
  // Every SPL payment reserves the deposit of a new ATA (the account size of its token program): an ATA that exists now may be closed and recreated
  // before execution. Then a lower bound before any simulation (the base fee, every such deposit, the SOL sent and the owner's own reserve): an owner
  // below it is refused with an actionable shortfall instead of a failed simulation. Its `fee` is the ceiling at the compute cap, so the top-up suffices.
  let deposits = 0n;
  if (token) {
    const minimum = await rpc('getMinimumBalanceForRentExemption', [token.program === 'token-2022' ? 170 : 165, { commitment: 'confirmed' }]);
    if (!Number.isSafeInteger(minimum) || (minimum as number) <= 0) fail('RPC_INVALID');
    deposits = BigInt(minimum as number) * BigInt(legs.length);
  }
  if (balance < nativeSpend + BigInt(profile.baseFeeLamports) + deposits + reserve)
    fail('INSUFFICIENT_SOL', shortfallOf(balance, BigInt(estimateFee(cap, profile.computeUnitPriceMicroLamports, profile.baseFeeLamports)), deposits, nativeSpend, reserve, false));
  const watched = [owner, ...legs.map(leg => leg.recipient), ...token ? [token.sourceAccount, ...facts.recipients.map(r => r.destinationAccount!)] : []];
  const simulate = async (message: Uint8Array, limit: number) => {
    try { return await simulateSolanaMessage(rpc, message, watched, X); } catch (cause) {
      if (computeExhausted(cause)) fail('COMPUTE_LIMIT_EXCEEDED', { limit, cap });
      throw cause;
    }
  };
  // The compute probe carries no priority fee (it costs nothing); the reviewed limit is ceil(1.2 x consumed) + 5,000, refused (never capped) above the ceiling.
  const probe = await simulate(compile(cap, '0'), cap);
  const units = Math.floor((probe.unitsConsumed * 6 + 4) / 5) + 5_000;
  if (units > cap) fail('COMPUTE_LIMIT_EXCEEDED', { needed: units, cap });
  const messageBytes = compile(units);
  assertMessageRoundTrip(messageBytes, instructions(units), owner, {}, X);
  const decoded = decodeSolanaBatchPaymentMessage(messageBytes, expectationOf(owner, profile, token, profile.computeUnitPriceMicroLamports));
  if (decoded.computeUnitLimit !== units || decoded.payments.length !== legs.length || decoded.payments.some((p, i) => p.recipient !== legs[i]!.recipient ||
      p.amount !== legs[i]!.amount || p.destinationAccount !== facts.recipients[i]!.destinationAccount)) fail('MANIFEST_MISMATCH');
  const bounds = solanaBatchPaymentStaticBounds(intent, facts, messageBytes);
  // The cluster prices these exact bytes, including the reviewed compute budget. A null price means the blockhash is unusable.
  const priced = solanaRecord(await rpc('getFeeForMessage', [toBase64(messageBytes), { commitment: 'confirmed' }]), `${X}_RPC_INVALID`);
  if (!Number.isSafeInteger(priced.value) || (priced.value as number) <= 0) fail('FEE_UNAVAILABLE');
  const fee = BigInt(priced.value as number);
  // Exact before the final simulation (which the runtime would fail once the owner dropped below its own reserve).
  if (balance < nativeSpend + fee + deposits + reserve) fail('INSUFFICIENT_SOL', shortfallOf(balance, fee, deposits, nativeSpend, reserve, true));
  const final = await simulate(messageBytes, units);
  if (final.unitsConsumed > units) fail('COMPUTE_LIMIT_EXCEEDED', { needed: final.unitsConsumed, limit: units, cap });
  const n = legs.length, ownerPost = lamports(final.accounts[0]);
  // The simulator may or may not debit the fee from the payer; any other owner difference is a mismatch.
  const ownerDebit = (expected: bigint) => {
    const debit = balance - ownerPost;
    if (debit !== expected && debit !== expected + fee) fail('SIMULATED_TRANSFER_MISMATCH', { account: 'OWNER', debit: debit.toString(), expected: expected.toString() });
  };
  const walletAfter = (i: number) => lamports(final.accounts[1 + i]);
  const payments: SolanaBatchPaymentPayment[] = [];
  let created = 0n, maximumDeposits = 0n;
  if (!token) {
    for (const r of facts.recipients) {
      const before = BigInt(r.recipientLamports), after = walletAfter(r.index);
      if (after - before !== BigInt(r.amount)) fail('SIMULATED_TRANSFER_MISMATCH', { recipient: r.index });
      payments.push({ ...r, accountCreationLamports: '0', maximumAccountCreationLamports: '0', before: before.toString(), after: after.toString() });
    }
    ownerDebit(total);
  } else {
    const tokenFacts = { programId: token.programId, program: token.program, mint: token.mint };
    const sourceAfter = asBatch(() => tokenAmountAfter(final.accounts[1 + n] ?? null, tokenFacts, owner));
    if (sourceAfter === null || BigInt(token.sourceAmount) - sourceAfter !== total) fail('SIMULATED_TRANSFER_MISMATCH', { account: 'SOURCE' });
    // Rent is asked once per distinct simulated account length.
    const rents = new Map<number, bigint>();
    const rentOf = async (length: number, recipient: number) => {
      const known = rents.get(length);
      if (known !== undefined) return known;
      const minimum = await rpc('getMinimumBalanceForRentExemption', [length, { commitment: 'confirmed' }]);
      if (!Number.isSafeInteger(minimum) || (minimum as number) <= 0) fail('ACCOUNT_RENT_MISMATCH', { recipient });
      rents.set(length, BigInt(minimum as number));
      return BigInt(minimum as number);
    };
    for (const r of facts.recipients) {
      const account = final.accounts[2 + n + r.index] ?? null;
      const after = asBatch(() => tokenAmountAfter(account, tokenFacts, r.recipient), r.index), before = BigInt(r.destinationAmount ?? '0');
      if (after === null || after - before !== BigInt(r.amount)) fail('SIMULATED_TRANSFER_MISMATCH', { recipient: r.index });
      // Worst case for EVERY SPL payment: an ATA that exists now may be closed and recreated before execution (the single-transfer rule).
      const maximum = await rentOf(account?.data.length ?? 0, r.index);
      const deposit = r.createDestination ? lamports(account) : 0n;
      if (r.createDestination && deposit !== maximum) fail('ACCOUNT_RENT_MISMATCH', { recipient: r.index });
      if (walletAfter(r.index) !== BigInt(r.recipientLamports)) fail('SIMULATED_TRANSFER_MISMATCH', { recipient: r.index, account: 'WALLET' });
      created += deposit; maximumDeposits += maximum;
      payments.push({ ...r, accountCreationLamports: deposit.toString(), maximumAccountCreationLamports: maximum.toString(), before: before.toString(), after: after.toString() });
    }
    ownerDebit(created);
  }
  // Spendable balance: the owner keeps its own rent-exempt reserve after the SOL sent, the fee and every worst-case deposit (simulated lengths).
  const required = nativeSpend + fee + maximumDeposits + reserve;
  if (balance < required) fail('INSUFFICIENT_SOL', shortfallOf(balance, fee, maximumDeposits, nativeSpend, reserve, true));
  const expiresAt = new Date(now + SOLANA_BATCH_PAYMENT.reviewTtlSeconds * 1000).toISOString();
  const message = toBase64(messageBytes), messageHash = sha256Hex(messageBytes), maximumNetworkCost = fee + maximumDeposits;
  const known = solanaBatchPaymentAsset(token?.mint ?? null) ?? fail('ASSET_UNSUPPORTED');
  const asset: SolanaBatchPaymentAssetView = token ? { symbol: known.symbol, mint: token.mint, decimals: token.decimals, program: token.program, verified: true }
    : { symbol: 'SOL', mint: null, decimals: 9, program: 'native', verified: true };
  const state = { slot: facts.slot, ownerLamports: facts.ownerLamports, rentExemptMinimum: facts.rentExemptMinimum };
  const artifacts = buildSolanaBatchPaymentArtifacts({ workflow, intent, facts, state, payments, messageHash, maximumNetworkCost, lastValidBlockHeight: lastValidBlockHeight as number,
    expiresAt, observedAt: new Date(now).toISOString() });
  const review: Omit<SolanaBatchPaymentReview, 'commitment'> = { format: SOLANA_BATCH_PAYMENT_REVIEW_FORMAT, workflow, chain: profile.chain, cluster: 'mainnet-beta',
    network: 'Solana', owner, atomic: true, asset, token, payments, total: intent.total, state, blockhash, lastValidBlockHeight: lastValidBlockHeight as number,
    computeUnitLimit: units, computeUnitPrice: profile.computeUnitPriceMicroLamports, computeUnitCap: cap, unitsConsumed: final.unitsConsumed,
    estimatedFeeLamports: fee.toString(), accountCreationLamports: created.toString(), maximumAccountCreationLamports: maximumDeposits.toString(),
    maximumNetworkCostLamports: maximumNetworkCost.toString(), requiredLamports: required.toString(), ...bounds, manifestHash: solanaBatchPaymentManifestHash(manifestOf(intent)),
    message, messageHash, unsignedTransaction: toBase64(serializeTransaction(null, messageBytes)), expiresAt, ...artifacts };
  return { ...review, commitment: solanaSwapHash(review) };
}

/**
 * The frozen v1 artifact chain (ArtifactSet -> SimulationBundle -> AuthorizationPolicy -> StrategyManifest -> ExecutionPlan) for one batch: ONE plan
 * step, one transaction, atomic. Every recipient is allowlisted; the spend limit is the exact total (the largest single payment per step).
 */
function buildSolanaBatchPaymentArtifacts(input: { workflow: SemanticWorkflow; intent: SolanaBatchPaymentIntent; facts: SolanaBatchPaymentFacts;
  state: SolanaBatchPaymentReview['state']; payments: readonly SolanaBatchPaymentPayment[]; messageHash: string; maximumNetworkCost: bigint; lastValidBlockHeight: number;
  expiresAt: string; observedAt: string }) {
  const { workflow, intent, facts } = input, { profile, owner } = intent, chain = profile.chain, P = profile.programs, prefix = 'solbp', token = facts.token;
  const semanticHash = solanaSwapArtifactHash('semantic-workflow', workflow);
  const adapter = { id: BATCH_PAYMENT_SOLANA_ADAPTER, version: '1.0.0' };
  const contracts = token ? [{ chainId: chain, address: token.programId, version: token.program }, { chainId: chain, address: P.associatedToken, version: 'associated-token' }]
    : [{ chainId: chain, address: P.system, version: 'system' }];
  const moved = token ? { chainId: chain, address: token.mint, decimals: token.decimals } : { chainId: chain, nativeId: 'SOL', decimals: 9 };
  const artifactSet: ArtifactSet = { schemaVersion: '1.0.0', artifactSetId: `${prefix}-artifacts`, semanticWorkflowHash: semanticHash,
    artifacts: [{ artifactId: `${prefix}-batch-state`, nodeId: intent.nodeId, artifactHash: solanaSwapHash({ state: input.state, token, payments: input.payments, messageHash: input.messageHash }) }] };
  const artifactHash = solanaSwapArtifactHash('artifact-set', artifactSet);
  const simulation: SimulationBundle = { schemaVersion: '1.0.0', simulationId: `${prefix}-simulation`, semanticWorkflowRevision: workflow.revision,
    semanticWorkflowHash: semanticHash, artifactSetHash: artifactHash, adapters: [adapter], contracts, outputs: [], propagatedOutputs: [], failurePaths: [],
    uncertainty: [{ code: 'SOLANA_FINALITY', description: `Inclusion is a confirmed ${profile.network} slot; reconciliation waits for the finalized transaction.` }],
    unsupportedAssumptions: [], freshness: { observedAt: input.observedAt, expiresAt: input.expiresAt, maximumAgeSeconds: SOLANA_BATCH_PAYMENT.reviewTtlSeconds } };
  const simulationHash = solanaSwapArtifactHash('simulation-bundle', simulation), ownerRef = { chainId: chain, address: owner };
  const largest = intent.legs.reduce((max, leg) => BigInt(leg.amount) > max ? BigInt(leg.amount) : max, 0n).toString();
  const spendLimits = [{ asset: moved, maximumAmount: intent.total, maximumPerStepAmount: largest, maximumCumulativeAmount: intent.total }];
  const gasBudgets = [{ asset: { chainId: chain, nativeId: 'SOL', decimals: 9 }, maximumAmount: input.maximumNetworkCost.toString() }];
  const feeBudgets: never[] = [];
  const recovery = { failurePolicy: 'ABORT' as const, residualAssetRecipient: ownerRef, maximumAttemptsPerStep: 1, requiresHumanReview: true as const };
  const providers = { kind: 'FIXED' as const, providerId: adapter.id };
  const functions = token ? [{ chainId: chain, contract: P.associatedToken, functionId: 'create-idempotent' }, { chainId: chain, contract: token.programId, functionId: 'transfer-checked' }]
    : [{ chainId: chain, contract: P.system, functionId: 'system-transfer' }];
  const policy: AuthorizationPolicy = { schemaVersion: '1.0.0', policyId: `${prefix}-policy`, semanticWorkflowHash: semanticHash, artifactSetHash: artifactHash, simulationHash,
    requiredAuthorizationClass: 'MODE_A', allowlists: { owners: [ownerRef], accounts: [ownerRef], recipients: intent.legs.map(leg => ({ chainId: chain, address: leg.recipient })),
      chains: [chain], adapters: [adapter], protocols: [token ? token.program : 'native'], contracts, functions },
    budgetReservation: { rule: 'RESERVE_BEFORE_SUBMISSION', concurrentConsumption: 'CUMULATIVE_ACROSS_BRANCHES', implementation: 'NOT_IMPLEMENTED' },
    spendLimits, maximumSlippageBps: 0, gasBudgets, feeBudgets, oracleRules: [], accountRiskRules: [], checkpointRules: [], providers,
    nonce: String(input.lastValidBlockHeight), deadline: input.expiresAt, revocationEpoch: workflow.revision, recovery, enforcement: 'NOT_ENFORCED' };
  const policyHash = solanaSwapArtifactHash('authorization-policy', policy);
  const manifest: StrategyManifest = { schemaVersion: '1.0.0', manifestId: `${prefix}-manifest`, semanticWorkflowRevision: workflow.revision, semanticWorkflowHash: semanticHash,
    artifactSetHash: artifactHash, simulationHash, policyHash, authorizationMode: 'MODE_A', owner: ownerRef, executor: null, expiresAt: input.expiresAt,
    nonce: String(input.lastValidBlockHeight), revocationEpoch: workflow.revision, spendLimits, maximumSlippageBps: 0, gasBudgets, feeBudgets, providers, recovery,
    enforcement: 'NOT_ENFORCED' };
  const manifestHash = solanaSwapArtifactHash('strategy-manifest', manifest);
  const plan: ExecutionPlan = { schemaVersion: '1.0.0', executionPlanId: `${prefix}-plan`, semanticWorkflowHash: semanticHash, manifestHash,
    segments: [{ segmentId: `${prefix}-segment`, chainId: chain, dependencies: [], steps: [{ stepId: `${prefix}-batch`, nodeId: intent.nodeId, chainId: chain,
      adapter, dependencies: [], requiredAuthorizationClass: 'MODE_A', executionKind: 'DIRECT_TRANSACTION', payloadHash: input.messageHash }] }],
    checkpointIds: [], enforcement: 'NOT_ENFORCED' };
  solanaSwapArtifactHash('execution-plan', plan);
  return { artifactSet, simulation, policy, manifest, plan };
}

/**
 * Review/Execute guard: commitment, semantic revision, owner, freshness, blockhash validity, the exact manifest (recipients, amounts, order, asset),
 * the plan's single payload and the exact message, re-decoded with the closed decoder.
 */
export function assertSolanaBatchPaymentReview(review: SolanaBatchPaymentReview, workflow: SemanticWorkflow, owner: string, blockHeight: number, now = Date.now()): void {
  const { commitment, ...content } = review;
  if (review.format !== SOLANA_BATCH_PAYMENT_REVIEW_FORMAT || solanaSwapHash(content) !== commitment) fail('AUTHORIZATION_INVALID');
  if (solanaSwapArtifactHash('semantic-workflow', workflow) !== review.manifest.semanticWorkflowHash || JSON.stringify(workflow) !== JSON.stringify(review.workflow))
    fail('SEMANTIC_REVISION_CHANGED');
  if (owner !== review.owner) fail('WRONG_OWNER');
  if (now >= Date.parse(review.expiresAt) || now < Date.parse(review.simulation.freshness.observedAt)) fail('REVIEW_EXPIRED');
  if (!Number.isSafeInteger(blockHeight) || blockHeight >= review.lastValidBlockHeight - 20) fail('REVIEW_EXPIRED');
  const intent = solanaBatchPaymentIntent(workflow, owner);
  if (intent.profile.chain !== review.chain || intent.total !== review.total || intent.legs.length !== review.payments.length ||
      intent.legs.some((leg, i) => review.payments[i]!.index !== i || review.payments[i]!.recipient !== leg.recipient || review.payments[i]!.amount !== leg.amount) ||
      (intent.token?.mint ?? null) !== review.asset.mint || (intent.token?.program ?? 'native') !== review.asset.program || (intent.token?.decimals ?? 9) !== review.asset.decimals ||
      solanaBatchPaymentManifestHash(manifestOf(intent)) !== review.manifestHash) fail('SEMANTIC_REVISION_CHANGED');
  const steps = review.plan.segments.flatMap(segment => segment.steps), step = steps[0];
  let messageBytes: Uint8Array;
  try { messageBytes = fromBase64(review.message); } catch { return fail('TRANSACTION_CHANGED'); }
  if (sha256Hex(messageBytes) !== review.messageHash || steps.length !== 1 || step?.executionKind !== 'DIRECT_TRANSACTION' || step.payloadHash !== review.messageHash ||
      toBase64(serializeTransaction(null, messageBytes)) !== review.unsignedTransaction) fail('TRANSACTION_CHANGED');
  let decoded: DecodedSolanaBatchPayment;
  try { decoded = decodeSolanaBatchPaymentMessage(messageBytes, expectationOf(owner, intent.profile, review.token, review.computeUnitPrice)); }
  catch { return fail('TRANSACTION_CHANGED'); }
  if (review.computeUnitPrice !== intent.profile.computeUnitPriceMicroLamports || decoded.computeUnitLimit !== review.computeUnitLimit ||
      decoded.payments.length !== review.payments.length || decoded.payments.some((p, i) => p.recipient !== review.payments[i]!.recipient ||
      p.amount !== review.payments[i]!.amount || p.destinationAccount !== review.payments[i]!.destinationAccount)) fail('TRANSACTION_CHANGED');
}

/**
 * The reviewed message, or it plus only verified Lighthouse assertions (`verifySolanaWalletGuard`: same fee payer, signers and blockhash, every
 * reviewed instruction an exact prefix, no compute-budget change, no new account but the Lighthouse program), with a valid owner signature and at
 * most 1,232 bytes. Anything else fails closed (`TRANSACTION_CHANGED`, `SIGNATURE_INVALID`, `SIGNED_TRANSACTION_TOO_LARGE`).
 */
export function verifySignedSolanaBatchPayment(review: { readonly message: string; readonly owner: string }, signedBase64: unknown): SignedSolanaTransaction {
  let bytes: Uint8Array;
  try { bytes = fromBase64(signedBase64, 2048); } catch { return fail('TRANSACTION_CHANGED'); }
  if (bytes.length > SOLANA_BATCH_PAYMENT.maximumTransactionBytes) fail('SIGNED_TRANSACTION_TOO_LARGE', { bytes: bytes.length, limit: SOLANA_BATCH_PAYMENT.maximumTransactionBytes });
  try { return verifySignedSolanaSwap({ message: review.message, owner: review.owner, lookupTables: {} }, signedBase64, X); } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith(`${X}_`)) throw cause;
    return fail('TRANSACTION_CHANGED', cause);
  }
}
