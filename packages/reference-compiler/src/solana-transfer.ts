// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-SOLANA-TRANSFER-UX-001: read-only simulation and Review of one direct transfer to another wallet on a Solana cluster.
 *
 *   native SOL    ComputeBudget limit + price, System Program `Transfer`
 *   SPL token     ComputeBudget limit + price, Associated Token Account `CreateIdempotent` (also checks an existing ATA's owner atomically),
 *                 the token program's own `TransferChecked` (mint and decimals enforced on chain) — classic SPL Token or Token-2022
 *
 * Every fact is read from the chain, never from the request: the mint's owning program and decimals, Token-2022 extensions (only a
 * reviewed allowlist is accepted), both token accounts' mint/owner/state, balances, the rent-exemption reserve and the account-creation
 * deposit. The exact v0 message is compiled, round-tripped and simulated with `simulateTransaction`; the owner's and the recipient's
 * resulting balances must equal the intent. The Review commitment binds the exact message, blockhash validity, fees and limits.
 * Nothing here signs or sends; the owner's wallet signs the exact reviewed bytes and any change is refused before broadcast.
 */
import { SAFE_ACCOUNT_EXTENSIONS, SAFE_MINT_EXTENSIONS, TOKEN_2022_EXTENSIONS, solanaTransferAsset, solanaTransferProfile, type SolanaTransferProfile } from '@defi-workflow-engine/action-registry';
import { isSolanaTransferNode, readSolanaTransferNode, TRANSFER_ACTION, SOLANA_SYSTEM_TRANSFER_ADAPTER, SOLANA_TOKEN_TRANSFER_ADAPTER, type SemanticWorkflow,
  type SolanaTransferFields, type ArtifactSet, type SimulationBundle, type AuthorizationPolicy, type StrategyManifest, type ExecutionPlan } from '@defi-workflow-engine/workflow-contracts';
import { associatedTokenAddress, base58Encode, compileMessageV0, fromBase64, readU64, serializeMessageV0, serializeTransaction, sha256Hex, solanaAddress,
  solanaKeyOnCurve, toBase64, u64Bytes, type SolanaInstruction } from './solana.js';
import { assertMessageRoundTrip, readSolanaAccounts, rpcContextValue, setComputeUnitLimit, setComputeUnitPrice, simulateSolanaMessage, solanaSwapArtifactHash,
  solanaSwapHash, solanaRecord, decodeRpcAccount, verifySignedSolanaSwap, verifySolanaCluster, type RawSolanaAccount, type SolanaRpc } from './solana-swap.js';

export { SOLANA_TRANSFER_PROFILES, SOLANA_MAINNET_TRANSFER, SOLANA_DEVNET_TRANSFER, solanaTransferProfile, solanaTransferAsset } from '@defi-workflow-engine/action-registry';
export type { SolanaTransferProfile, SolanaTransferAsset } from '@defi-workflow-engine/action-registry';
export const SOLANA_TRANSFER_CODE = 'SOLANA_TRANSFER';
const X = SOLANA_TRANSFER_CODE;
const fail = (code: string, cause?: unknown): never => { throw new Error(`${X}_${code}`, cause === undefined ? undefined : { cause }); };
const WRAPPED_SOL = 'So11111111111111111111111111111111111111112';

export type SolanaTransferIntent = { nodeId: string; profile: SolanaTransferProfile; owner: string; recipient: string; amount: string; fields: SolanaTransferFields };
/** The isolated canonical transfer, resolved against its cluster's profile. Addresses are decoded to 32-byte keys; nothing is guessed. */
export function solanaTransferIntent(workflow: SemanticWorkflow, ownerInput: string): SolanaTransferIntent {
  const nodes = workflow.nodes.filter(n => n.actionType === TRANSFER_ACTION);
  if (nodes.length !== 1 || !isSolanaTransferNode(nodes[0]!) || workflow.nodes.some(n => n !== nodes[0] && !n.actionType.startsWith('mock-')) ||
      workflow.resourceEdges.length || workflow.nodes.some(n => n.dependencies.length)) fail('ISOLATED_ONLY');
  let fields: SolanaTransferFields;
  try { fields = readSolanaTransferNode(nodes[0]!); } catch (cause) { return fail('DECLARATION_INVALID', cause); }
  const profile = solanaTransferProfile(fields.chain) ?? fail('NETWORK_UNSUPPORTED');
  let owner: string, recipient: string;
  try { owner = solanaAddress(ownerInput); } catch { return fail('OWNER_REQUIRED'); }
  try { recipient = solanaAddress(fields.recipient); } catch { return fail('RECIPIENT_INVALID'); }
  // An explicit recipient that is the signing wallet itself is refused: FloFi never turns a transfer into a self-send.
  if (recipient === owner) fail('RECIPIENT_IS_SENDER');
  // A program-derived address has no private key: tokens or SOL sent there are controlled only by its program.
  if (!solanaKeyOnCurve(recipient)) fail('RECIPIENT_OFF_CURVE');
  if (fields.token) {
    try { solanaAddress(fields.token.mint); } catch { return fail('MINT_INVALID'); }
    if (fields.token.mint === WRAPPED_SOL) fail('WRAPPED_SOL_UNSUPPORTED');
    const known = solanaTransferAsset(profile, fields.token.mint);
    if (known && (known.decimals !== fields.token.decimals || known.program !== fields.token.program)) fail('MINT_DECIMALS_MISMATCH');
    if (BigInt(fields.amount) > 10n ** BigInt(fields.token.decimals + 9)) fail('AMOUNT_OUT_OF_RANGE');
  } else if (BigInt(fields.amount) > BigInt(profile.maximumLamports)) fail('AMOUNT_OUT_OF_RANGE');
  return { nodeId: nodes[0]!.nodeId, profile, owner, recipient, amount: fields.amount, fields };
}

/** One Token-2022 TLV extension entry (type and raw value), in account order. */
export type TokenExtension = { type: number; value: Uint8Array };
function extensionsOf(data: Uint8Array, base: number, accountType: 1 | 2): TokenExtension[] {
  if (data.length === base) return [];
  // Token-2022 pads a mint to the account length (165), then writes the account type and the TLV area.
  if (data.length < 166 || data[165] !== accountType || data.slice(base, 165).some(byte => byte !== 0)) fail(accountType === 1 ? 'MINT_INVALID' : 'TOKEN_ACCOUNT_MISMATCH');
  const out: TokenExtension[] = [];
  let at = 166;
  while (at + 4 <= data.length) {
    const type = data[at]! | data[at + 1]! << 8, length = data[at + 2]! | data[at + 3]! << 8;
    if (type === 0) { if (data.slice(at).some(byte => byte !== 0)) fail('TOKEN_EXTENSION_UNSUPPORTED'); return out; }
    if (out.some(extension => extension.type === type)) fail('TOKEN_EXTENSION_UNSUPPORTED');
    if (at + 4 + length > data.length) fail(accountType === 1 ? 'MINT_INVALID' : 'TOKEN_ACCOUNT_MISMATCH');
    out.push({ type, value: data.slice(at + 4, at + 4 + length) });
    at += 4 + length;
  }
  if (data.slice(at).some(byte => byte !== 0)) fail('TOKEN_EXTENSION_UNSUPPORTED');
  return out;
}
export type DecodedMint = { decimals: number; supply: bigint; initialized: boolean; freezeAuthority: string | null; extensions: TokenExtension[] };
/** SPL mint (82 bytes, Token-2022 optionally followed by extensions): supply, decimals, initialization and freeze authority. */
export function decodeSplMint(data: Uint8Array, token2022: boolean): DecodedMint {
  if (data.length < 82 || !token2022 && data.length !== 82) fail('MINT_INVALID');
  const freeze = data[46] === 1 ? base58Encode(data.slice(50, 82)) : null;
  return { supply: readU64(data, 36), decimals: data[44]!, initialized: data[45] === 1, freezeAuthority: freeze, extensions: token2022 ? extensionsOf(data, 82, 1) : [] };
}
export type DecodedTokenAccount = { mint: string; owner: string; amount: bigint; state: number; extensions: TokenExtension[] };
/** SPL token account (165 bytes, Token-2022 optionally followed by extensions): mint, owner, amount and state (1 initialized, 2 frozen). */
export function decodeSplTokenAccount(data: Uint8Array, token2022: boolean): DecodedTokenAccount {
  if (data.length < 165 || !token2022 && data.length !== 165) fail('TOKEN_ACCOUNT_MISMATCH');
  return { mint: base58Encode(data.slice(0, 32)), owner: base58Encode(data.slice(32, 64)), amount: readU64(data, 64), state: data[108]!,
    extensions: token2022 ? extensionsOf(data, 165, 2) : [] };
}
const zero = (bytes: Uint8Array) => bytes.every(byte => byte === 0);
/**
 * The reviewed Token-2022 allowlist. A transfer fee must be zero in both configured epochs (so the recipient receives exactly the amount), a
 * default account state must be Initialized (a new account would otherwise be frozen) and a transfer hook must name no program or update authority. Every other
 * extension — confidential transfers, permanent delegate, non-transferable, interest-bearing, scaled UI amount, pausable — is refused.
 */
export function assertSafeMintExtensions(extensions: readonly TokenExtension[]): void {
  for (const { type, value } of extensions) {
    if (!SAFE_MINT_EXTENSIONS.includes(type)) fail('TOKEN_EXTENSION_UNSUPPORTED', { extension: type });
    if (type === TOKEN_2022_EXTENSIONS.TransferFeeConfig && (value.length !== 108 || !zero(value.slice(0, 32)) || readU64(value, 80) !== 0n || value[88] !== 0 || value[89] !== 0 ||
      readU64(value, 98) !== 0n || value[106] !== 0 || value[107] !== 0)) fail('TOKEN_EXTENSION_UNSUPPORTED', { extension: type, reason: 'TRANSFER_FEE' });
    if (type === TOKEN_2022_EXTENSIONS.DefaultAccountState && (value.length !== 1 || value[0] !== 1)) fail('TOKEN_EXTENSION_UNSUPPORTED', { extension: type, reason: 'FROZEN_DEFAULT' });
    if (type === TOKEN_2022_EXTENSIONS.TransferHook && (value.length !== 64 || !zero(value))) fail('TOKEN_EXTENSION_UNSUPPORTED', { extension: type, reason: 'MUTABLE_OR_ACTIVE_HOOK' });
  }
}
/** Token-account extensions that leave a direct TransferChecked unchanged; a recipient that requires incoming memos is refused. */
export function assertSafeAccountExtensions(extensions: readonly TokenExtension[], destination: boolean): void {
  for (const { type, value } of extensions) {
    if (!SAFE_ACCOUNT_EXTENSIONS.includes(type)) fail('TOKEN_EXTENSION_UNSUPPORTED', { extension: type, account: destination ? 'DESTINATION' : 'SOURCE' });
    const expectedLength = type === TOKEN_2022_EXTENSIONS.TransferFeeAmount ? 8 : type === TOKEN_2022_EXTENSIONS.ImmutableOwner ? 0 : 1;
    if (value.length !== expectedLength || expectedLength === 1 && value[0]! > 1 || type === TOKEN_2022_EXTENSIONS.TransferHookAccount && value[0] !== 0)
      fail('TOKEN_EXTENSION_UNSUPPORTED', { extension: type });
    if (type === TOKEN_2022_EXTENSIONS.MemoTransfer && destination && value[0] === 1) fail('RECIPIENT_MEMO_EXTENSION_UNSUPPORTED');
  }
}

export type SolanaTransferTokenFacts = { program: 'spl-token' | 'token-2022'; programId: string; mint: string; decimals: number; symbol: string | null; verified: boolean;
  extensions: number[]; sourceAccount: string; destinationAccount: string; sourceAmount: string; destinationAmount: string | null; createDestination: boolean };
export type SolanaTransferState = { slot: number; ownerLamports: string; recipientExists: boolean; recipientLamports: string; rentExemptMinimum: string };
export type SolanaTransferSimulation = { slot: number; unitsConsumed: number; logs: string[]; ownerLamportsBefore: string; ownerLamportsAfter: string;
  recipientLamportsBefore: string; recipientLamportsAfter: string; sourceAmountBefore: string | null; sourceAmountAfter: string | null;
  destinationAmountBefore: string | null; destinationAmountAfter: string | null; accountCreationLamports: string; feeLamports: string };
export type SolanaTransferReview = { format: 'gryloo.solana-transfer-review.v1'; workflow: SemanticWorkflow; chain: string; cluster: 'mainnet-beta' | 'devnet';
  network: 'Solana' | 'Solana Devnet'; owner: string; recipient: string; amount: string;
  asset: { symbol: string; mint: string | null; decimals: number; program: 'native' | 'spl-token' | 'token-2022'; verified: boolean };
  token: SolanaTransferTokenFacts | null; state: SolanaTransferState;
  blockhash: string; lastValidBlockHeight: number; computeUnitLimit: number; computeUnitPrice: string; estimatedFeeLamports: string;
  accountCreationLamports: string; maximumAccountCreationLamports: string; maximumNetworkCostLamports: string; message: string; messageHash: string; unsignedTransaction: string;
  simulationResult: SolanaTransferSimulation; expiresAt: string; artifactSet: ArtifactSet; simulation: SimulationBundle; policy: AuthorizationPolicy;
  manifest: StrategyManifest; plan: ExecutionPlan; commitment: string };

const lamports = (account: RawSolanaAccount) => account?.lamports ?? 0n;
const programOf = (profile: SolanaTransferProfile, program: 'spl-token' | 'token-2022') => program === 'token-2022' ? profile.programs.token2022 : profile.programs.token;
/** The exact instructions after the two reviewed ComputeBudget instructions, for the intent and the token facts read at Simulate. */
export function solanaTransferInstructions(intent: SolanaTransferIntent, token: Pick<SolanaTransferTokenFacts, 'programId' | 'mint' | 'decimals' | 'sourceAccount' | 'destinationAccount' | 'createDestination'> | null): SolanaInstruction[] {
  const P = intent.profile.programs;
  if (!token) return [{ programId: P.system, accounts: [{ pubkey: intent.owner, isSigner: true, isWritable: true }, { pubkey: intent.recipient, isSigner: false, isWritable: true }],
    data: Uint8Array.from([2, 0, 0, 0, ...u64Bytes(BigInt(intent.amount))]) }];
  // TransferChecked alone checks the destination mint, not its owner. CreateIdempotent checks both atomically even when the ATA already
  // exists; an ATA reassigned while the wallet prompt is open must never receive this transfer. Its possible recreation deposit is reviewed.
  const create: SolanaInstruction[] = [{ programId: P.associatedToken, data: Uint8Array.of(1), accounts: [
    { pubkey: intent.owner, isSigner: true, isWritable: true }, { pubkey: token.destinationAccount, isSigner: false, isWritable: true },
    { pubkey: intent.recipient, isSigner: false, isWritable: false }, { pubkey: token.mint, isSigner: false, isWritable: false },
    { pubkey: P.system, isSigner: false, isWritable: false }, { pubkey: token.programId, isSigner: false, isWritable: false }] }];
  return [...create, { programId: token.programId, data: Uint8Array.from([12, ...u64Bytes(BigInt(intent.amount)), token.decimals]), accounts: [
    { pubkey: token.sourceAccount, isSigner: false, isWritable: true }, { pubkey: token.mint, isSigner: false, isWritable: false },
    { pubkey: token.destinationAccount, isSigner: false, isWritable: true }, { pubkey: intent.owner, isSigner: true, isWritable: false }] }];
}
const allInstructions = (intent: SolanaTransferIntent, token: SolanaTransferTokenFacts | null, units: number, price = intent.profile.computeUnitPriceMicroLamports) =>
  [setComputeUnitLimit(units), ...setComputeUnitPrice(price), ...solanaTransferInstructions(intent, token)];

/** Chain facts of the owner, the recipient and (SPL) the mint and both token accounts, at one confirmed slot. Refuses anything unsafe. */
export async function readSolanaTransferFacts(rpc: SolanaRpc, intent: SolanaTransferIntent, reviewedSource?: string): Promise<{ state: SolanaTransferState; token: SolanaTransferTokenFacts | null }> {
  const { profile, owner, recipient, fields } = intent, P = profile.programs;
  const rent = await rpc('getMinimumBalanceForRentExemption', [0, { commitment: 'confirmed' }]);
  if (!Number.isSafeInteger(rent) || (rent as number) <= 0) fail('RPC_INVALID');
  const token = fields.token, programId = token ? programOf(profile, token.program) : null;
  let source = token ? reviewedSource ?? associatedTokenAddress(owner, token.mint, programId!, P.associatedToken) : null;
  const destination = token ? associatedTokenAddress(recipient, token.mint, programId!, P.associatedToken) : null;
  // Prefer the sender ATA. If it cannot cover the transfer, resolve a single sufficient account belonging to this sender and mint.
  // Multiple accounts are never silently combined into a different transaction.
  if (token && !reviewedSource) {
    const initial = (await readSolanaAccounts(rpc, [source!, token.mint])).accounts;
    const canonical = initial[0], mint = initial[1];
    if (!mint) fail('MINT_NOT_FOUND');
    if (mint!.owner !== programId) fail('TOKEN_PROGRAM_MISMATCH');
    if (!canonical || canonical.owner === programId && decodeSplTokenAccount(canonical.data, token.program === 'token-2022').amount < BigInt(intent.amount)) {
      const listed = solanaRecord(await rpc('getTokenAccountsByOwner', [owner, { mint: token.mint }, { encoding: 'base64', commitment: 'confirmed' }]), `${X}_RPC_INVALID`);
      if (!Array.isArray(listed.value)) fail('RPC_INVALID');
      const candidates = (listed.value as unknown[]).map(value => {
        const item = solanaRecord(value, `${X}_RPC_INVALID`), account = decodeRpcAccount(item.account);
        if (!account || account.owner !== programId) fail('TOKEN_ACCOUNT_MISMATCH');
        const decoded = decodeSplTokenAccount(account!.data, token.program === 'token-2022');
        if (decoded.owner !== owner || decoded.mint !== token.mint) fail('TOKEN_ACCOUNT_MISMATCH');
        return { address: solanaAddress(item.pubkey), decoded };
      }).filter(candidate => candidate.decoded.state === 1 && candidate.decoded.amount >= BigInt(intent.amount)).sort((a, b) => a.address.localeCompare(b.address));
      if (!candidates.length) fail('INSUFFICIENT_TOKEN_BALANCE');
      source = candidates[0]!.address;
    }
  }
  const keys = [owner, recipient, ...token ? [token.mint, source!, destination!] : []];
  const { slot, accounts } = await readSolanaAccounts(rpc, keys);
  const [ownerAccount, recipientAccount] = accounts;
  // The signer pays the fee: it must be an ordinary System account (no data, not a program).
  if (!ownerAccount || ownerAccount.owner !== P.system || ownerAccount.data.length) fail('OWNER_NOT_WALLET');
  if (recipientAccount) {
    if (recipientAccount.owner === P.token || recipientAccount.owner === P.token2022) fail('RECIPIENT_IS_TOKEN_ACCOUNT');
    if (recipientAccount.owner !== P.system || recipientAccount.data.length) fail('RECIPIENT_NOT_WALLET');
  }
  const state: SolanaTransferState = { slot, ownerLamports: lamports(ownerAccount ?? null).toString(), recipientExists: Boolean(recipientAccount),
    recipientLamports: lamports(recipientAccount ?? null).toString(), rentExemptMinimum: String(rent) };
  if (!token) return { state, token: null };
  const [, , mintAccount, sourceAccount, destinationAccount] = accounts;
  const token2022 = token.program === 'token-2022';
  if (!mintAccount) fail('MINT_NOT_FOUND');
  if (mintAccount!.owner !== programId) fail('TOKEN_PROGRAM_MISMATCH');
  const mint = decodeSplMint(mintAccount!.data, token2022);
  if (!mint.initialized) fail('MINT_INVALID');
  if (mint.decimals !== token.decimals) fail('MINT_DECIMALS_MISMATCH');
  assertSafeMintExtensions(mint.extensions);
  // The chosen source is re-read with the other facts and bound into the exact reviewed message.
  if (!sourceAccount) fail('INSUFFICIENT_TOKEN_BALANCE');
  if (sourceAccount!.owner !== programId) fail('TOKEN_ACCOUNT_MISMATCH');
  const from = decodeSplTokenAccount(sourceAccount!.data, token2022);
  if (from.mint !== token.mint || from.owner !== owner) fail('TOKEN_ACCOUNT_MISMATCH');
  if (from.state === 2) fail('TOKEN_ACCOUNT_FROZEN');
  if (from.state !== 1) fail('TOKEN_ACCOUNT_MISMATCH');
  assertSafeAccountExtensions(from.extensions, false);
  if (from.amount < BigInt(intent.amount)) fail('INSUFFICIENT_TOKEN_BALANCE');
  let destinationAmount: string | null = null;
  if (destinationAccount) {
    if (destinationAccount.owner !== programId) fail('TOKEN_ACCOUNT_MISMATCH');
    const to = decodeSplTokenAccount(destinationAccount.data, token2022);
    // A classic SPL ATA's owner can be reassigned: tokens would reach someone other than the named recipient.
    if (to.mint !== token.mint || to.owner !== recipient) fail('DESTINATION_OWNER_MISMATCH');
    if (to.state === 2) fail('TOKEN_ACCOUNT_FROZEN');
    if (to.state !== 1) fail('TOKEN_ACCOUNT_MISMATCH');
    assertSafeAccountExtensions(to.extensions, true);
    destinationAmount = to.amount.toString();
  }
  const known = solanaTransferAsset(profile, token.mint);
  return { state, token: { program: token.program, programId: programId!, mint: token.mint, decimals: token.decimals, symbol: known?.symbol ?? null, verified: Boolean(known),
    extensions: mint.extensions.map(e => e.type), sourceAccount: source!, destinationAccount: destination!, sourceAmount: from.amount.toString(), destinationAmount,
    createDestination: destinationAccount === null } };
}

function tokenAmountAfter(account: RawSolanaAccount, token: SolanaTransferTokenFacts, owner: string): bigint | null {
  if (!account || account.lamports === 0n && account.data.length === 0) return null;
  if (account.owner !== token.programId) fail('SIMULATED_TRANSFER_MISMATCH');
  const decoded = decodeSplTokenAccount(account.data, token.program === 'token-2022');
  if (decoded.mint !== token.mint || decoded.owner !== owner) fail('SIMULATED_TRANSFER_MISMATCH');
  return decoded.amount;
}

/** Read-only: chain facts, exact v0 message, RPC simulation and Review artifacts. Never signs or sends. */
export async function simulateSolanaTransfer(workflow: SemanticWorkflow, ownerInput: string, rpc: SolanaRpc, now = Date.now()): Promise<SolanaTransferReview> {
  const intent = solanaTransferIntent(workflow, ownerInput), { profile, owner, recipient } = intent;
  await verifySolanaCluster(rpc, profile.genesisHash).catch((cause: unknown) => fail('WRONG_CLUSTER', cause));
  const facts = await readSolanaTransferFacts(rpc, intent), token = facts.token, state = facts.state;
  const amount = BigInt(intent.amount), reserve = BigInt(state.rentExemptMinimum);
  // A new System account must start rent-exempt, or the runtime refuses the transfer.
  if (!token && !state.recipientExists && amount < reserve) fail('AMOUNT_BELOW_RENT_EXEMPT', { minimum: state.rentExemptMinimum });
  const latest = rpcContextValue(await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]));
  const blockhash = solanaAddress(latest.blockhash), lastValidBlockHeight = latest.lastValidBlockHeight;
  if (!Number.isSafeInteger(lastValidBlockHeight)) fail('RPC_INVALID');
  const compile = (units: number, price?: string) => serializeMessageV0(compileMessageV0(owner, allInstructions(intent, token, units, price), blockhash, {}));
  const watched = [owner, recipient, ...token ? [token.sourceAccount, token.destinationAccount] : []];
  const simulate = (message: Uint8Array) => simulateSolanaMessage(rpc, message, watched, X);
  // The compute probe carries no priority fee: priced at the maximum limit it could exhaust a near-maximum transfer's reserve on its own.
  const probe = await simulate(compile(profile.maximumComputeUnits, '0'));
  const units = Math.min(profile.maximumComputeUnits, Math.ceil(probe.unitsConsumed * 1.2) + 5_000);
  const messageBytes = compile(units);
  assertMessageRoundTrip(messageBytes, allInstructions(intent, token, units), owner, {}, X);
  const final = await simulate(messageBytes);
  // Ask the cluster to price these exact bytes, including the reviewed compute budget. A null price means the blockhash is unusable.
  const priced = solanaRecord(await rpc('getFeeForMessage', [toBase64(messageBytes), { commitment: 'confirmed' }]), `${X}_RPC_INVALID`);
  if (!Number.isSafeInteger(priced.value) || (priced.value as number) <= 0) fail('FEE_UNAVAILABLE');
  const fee = BigInt(priced.value as number);
  const [ownerAfter, recipientAfter, sourceAfter, destinationAfter] = final.accounts;
  const ownerBefore = BigInt(state.ownerLamports), ownerPost = lamports(ownerAfter ?? null), recipientBefore = BigInt(state.recipientLamports);
  // The simulator may or may not debit the fee from the payer; any other owner difference is a mismatch.
  const ownerDebit = (expected: bigint) => { const debit = ownerBefore - ownerPost; if (debit !== expected && debit !== expected + fee) fail('SIMULATED_TRANSFER_MISMATCH', { debit: debit.toString() }); };
  let created = 0n, maximumDeposit = 0n, sourceAmountAfter: bigint | null = null, destinationAmountAfter: bigint | null = null;
  if (!token) {
    if (lamports(recipientAfter ?? null) - recipientBefore !== amount) fail('SIMULATED_TRANSFER_MISMATCH');
    ownerDebit(amount);
  } else {
    sourceAmountAfter = tokenAmountAfter(sourceAfter ?? null, token, owner);
    destinationAmountAfter = tokenAmountAfter(destinationAfter ?? null, token, recipient);
    if (sourceAmountAfter === null || BigInt(token.sourceAmount) - sourceAmountAfter !== amount) fail('SIMULATED_TRANSFER_MISMATCH');
    if (destinationAmountAfter === null || destinationAmountAfter - BigInt(token.destinationAmount ?? '0') !== amount) fail('SIMULATED_TRANSFER_MISMATCH');
    // A new recipient token account keeps a rent-exempt deposit paid from the owner's SOL (recoverable only by the account's new owner).
    created = token.createDestination ? lamports(destinationAfter ?? null) : 0n;
    const minimum = await rpc('getMinimumBalanceForRentExemption', [destinationAfter?.data.length ?? 0, { commitment: 'confirmed' }]);
    if (!Number.isSafeInteger(minimum) || (minimum as number) <= 0) fail('ACCOUNT_RENT_MISMATCH');
    maximumDeposit = BigInt(minimum as number);
    if (token.createDestination && created !== maximumDeposit) fail('ACCOUNT_RENT_MISMATCH');
    if (lamports(recipientAfter ?? null) !== recipientBefore) fail('SIMULATED_TRANSFER_MISMATCH');
    ownerDebit(created);
  }
  // Spendable balance: the owner keeps its own rent-exempt reserve after the amount, the fee and any account deposit.
  if (ownerBefore - (token ? 0n : amount) - fee - maximumDeposit < reserve) fail('INSUFFICIENT_SOL', { required: ((token ? 0n : amount) + fee + maximumDeposit + reserve).toString() });
  const simulationResult: SolanaTransferSimulation = { slot: state.slot, unitsConsumed: final.unitsConsumed, logs: final.logs, ownerLamportsBefore: state.ownerLamports,
    ownerLamportsAfter: ownerPost.toString(), recipientLamportsBefore: state.recipientLamports, recipientLamportsAfter: lamports(recipientAfter ?? null).toString(),
    sourceAmountBefore: token?.sourceAmount ?? null, sourceAmountAfter: sourceAmountAfter?.toString() ?? null, destinationAmountBefore: token ? token.destinationAmount ?? '0' : null,
    destinationAmountAfter: destinationAmountAfter?.toString() ?? null, accountCreationLamports: created.toString(), feeLamports: fee.toString() };
  const expiresAt = new Date(now + profile.reviewTtlSeconds * 1000).toISOString();
  const message = toBase64(messageBytes), messageHash = sha256Hex(messageBytes), maximumNetworkCost = fee + maximumDeposit;
  const asset = token ? { symbol: token.symbol ?? 'SPL token', mint: token.mint, decimals: token.decimals, program: token.program, verified: token.verified }
    : { symbol: 'SOL', mint: null, decimals: 9, program: 'native' as const, verified: true };
  const artifacts = buildSolanaTransferArtifacts({ workflow, intent, token, state, messageHash, maximumNetworkCost, lastValidBlockHeight: lastValidBlockHeight as number, expiresAt,
    observedAt: new Date(now).toISOString() });
  const review: Omit<SolanaTransferReview, 'commitment'> = { format: 'gryloo.solana-transfer-review.v1', workflow, chain: profile.chain, cluster: profile.cluster,
    network: profile.network, owner, recipient, amount: intent.amount, asset, token, state, blockhash, lastValidBlockHeight: lastValidBlockHeight as number,
    computeUnitLimit: units, computeUnitPrice: profile.computeUnitPriceMicroLamports, estimatedFeeLamports: fee.toString(), accountCreationLamports: created.toString(),
    maximumAccountCreationLamports: maximumDeposit.toString(), maximumNetworkCostLamports: maximumNetworkCost.toString(), message, messageHash, unsignedTransaction: toBase64(serializeTransaction(null, messageBytes)),
    simulationResult, expiresAt, ...artifacts };
  return { ...review, commitment: solanaSwapHash(review) };
}

/** The frozen v1 artifact chain (ArtifactSet → SimulationBundle → AuthorizationPolicy → StrategyManifest → ExecutionPlan) for one transfer. */
function buildSolanaTransferArtifacts(input: { workflow: SemanticWorkflow; intent: SolanaTransferIntent; token: SolanaTransferTokenFacts | null; state: SolanaTransferState;
  messageHash: string; maximumNetworkCost: bigint; lastValidBlockHeight: number; expiresAt: string; observedAt: string }) {
  const { workflow, intent, token, state } = input, { profile, owner, recipient } = intent, chain = profile.chain, prefix = profile.idPrefix;
  const semanticHash = solanaSwapArtifactHash('semantic-workflow', workflow);
  const adapter = { id: token ? SOLANA_TOKEN_TRANSFER_ADAPTER : SOLANA_SYSTEM_TRANSFER_ADAPTER, version: '1.0.0' };
  const program = token ? token.programId : profile.programs.system;
  const contract = { chainId: chain, address: program, version: token ? token.program : 'system' };
  const moved = token ? { chainId: chain, address: token.mint, decimals: token.decimals } : { chainId: chain, nativeId: 'SOL', decimals: 9 };
  const artifactSet: ArtifactSet = { schemaVersion: '1.0.0', artifactSetId: `${prefix}-artifacts`, semanticWorkflowHash: semanticHash,
    artifacts: [{ artifactId: `${prefix}-transfer-state`, nodeId: intent.nodeId, artifactHash: solanaSwapHash({ state, token, messageHash: input.messageHash }) }] };
  const artifactHash = solanaSwapArtifactHash('artifact-set', artifactSet);
  const simulation: SimulationBundle = { schemaVersion: '1.0.0', simulationId: `${prefix}-simulation`, semanticWorkflowRevision: workflow.revision,
    semanticWorkflowHash: semanticHash, artifactSetHash: artifactHash, adapters: [adapter], contracts: [contract], outputs: [], propagatedOutputs: [], failurePaths: [],
    uncertainty: [{ code: 'SOLANA_FINALITY', description: `Inclusion is a confirmed ${profile.network} slot; reconciliation waits for the finalized transaction.` }],
    unsupportedAssumptions: [], freshness: { observedAt: input.observedAt, expiresAt: input.expiresAt, maximumAgeSeconds: profile.reviewTtlSeconds } };
  const simulationHash = solanaSwapArtifactHash('simulation-bundle', simulation), ownerRef = { chainId: chain, address: owner };
  const spendLimits = [{ asset: moved, maximumAmount: intent.amount, maximumPerStepAmount: intent.amount, maximumCumulativeAmount: intent.amount }];
  const gasBudgets = [{ asset: { chainId: chain, nativeId: 'SOL', decimals: 9 }, maximumAmount: input.maximumNetworkCost.toString() }];
  const recovery = { failurePolicy: 'ABORT' as const, residualAssetRecipient: ownerRef, maximumAttemptsPerStep: 1, requiresHumanReview: true as const };
  const providers = { kind: 'FIXED' as const, providerId: adapter.id };
  const policy: AuthorizationPolicy = { schemaVersion: '1.0.0', policyId: `${prefix}-policy`, semanticWorkflowHash: semanticHash, artifactSetHash: artifactHash, simulationHash,
    requiredAuthorizationClass: 'MODE_A', allowlists: { owners: [ownerRef], accounts: [ownerRef], recipients: [{ chainId: chain, address: recipient }], chains: [chain],
      adapters: [adapter], protocols: [token ? token.program : 'native'], contracts: [contract],
      functions: [{ chainId: chain, contract: program, functionId: token ? 'transfer-checked' : 'system-transfer' }] },
    budgetReservation: { rule: 'RESERVE_BEFORE_SUBMISSION', concurrentConsumption: 'CUMULATIVE_ACROSS_BRANCHES', implementation: 'NOT_IMPLEMENTED' },
    spendLimits, maximumSlippageBps: 0, gasBudgets, feeBudgets: [], oracleRules: [], accountRiskRules: [], checkpointRules: [], providers,
    nonce: String(input.lastValidBlockHeight), deadline: input.expiresAt, revocationEpoch: workflow.revision, recovery, enforcement: 'NOT_ENFORCED' };
  const policyHash = solanaSwapArtifactHash('authorization-policy', policy);
  const manifest: StrategyManifest = { schemaVersion: '1.0.0', manifestId: `${prefix}-manifest`, semanticWorkflowRevision: workflow.revision, semanticWorkflowHash: semanticHash,
    artifactSetHash: artifactHash, simulationHash, policyHash, authorizationMode: 'MODE_A', owner: ownerRef, executor: null, expiresAt: input.expiresAt,
    nonce: String(input.lastValidBlockHeight), revocationEpoch: workflow.revision, spendLimits, maximumSlippageBps: 0, gasBudgets, feeBudgets: [], providers, recovery,
    enforcement: 'NOT_ENFORCED' };
  const manifestHash = solanaSwapArtifactHash('strategy-manifest', manifest);
  const plan: ExecutionPlan = { schemaVersion: '1.0.0', executionPlanId: `${prefix}-plan`, semanticWorkflowHash: semanticHash, manifestHash,
    segments: [{ segmentId: `${prefix}-segment`, chainId: chain, dependencies: [], steps: [{ stepId: `${prefix}-transfer`, nodeId: intent.nodeId, chainId: chain,
      adapter, dependencies: [], requiredAuthorizationClass: 'MODE_A', executionKind: 'DIRECT_TRANSACTION', payloadHash: input.messageHash }] }],
    checkpointIds: [], enforcement: 'NOT_ENFORCED' };
  solanaSwapArtifactHash('execution-plan', plan);
  return { artifactSet, simulation, policy, manifest, plan };
}

/** Review/Execute guard: commitment, semantic revision, owner, freshness, blockhash validity and the exact message. */
export function assertSolanaTransferReview(review: SolanaTransferReview, workflow: SemanticWorkflow, owner: string, blockHeight: number, now = Date.now()): void {
  const { commitment, ...content } = review;
  if (review.format !== 'gryloo.solana-transfer-review.v1' || solanaSwapHash(content) !== commitment) fail('AUTHORIZATION_INVALID');
  if (solanaSwapArtifactHash('semantic-workflow', workflow) !== review.manifest.semanticWorkflowHash || JSON.stringify(workflow) !== JSON.stringify(review.workflow)) fail('SEMANTIC_REVISION_CHANGED');
  if (owner !== review.owner) fail('WRONG_OWNER');
  if (now >= Date.parse(review.expiresAt) || now < Date.parse(review.simulation.freshness.observedAt)) fail('REVIEW_EXPIRED');
  if (!Number.isSafeInteger(blockHeight) || blockHeight >= review.lastValidBlockHeight - 20) fail('REVIEW_EXPIRED');
  const intent = solanaTransferIntent(workflow, owner);
  if (intent.amount !== review.amount || intent.recipient !== review.recipient || intent.profile.chain !== review.chain ||
      (intent.fields.token?.mint ?? null) !== review.asset.mint || (intent.fields.token?.program ?? 'native') !== review.asset.program) fail('SEMANTIC_REVISION_CHANGED');
  const step = review.plan.segments[0]?.steps[0];
  if (sha256Hex(fromBase64(review.message)) !== review.messageHash || step?.executionKind !== 'DIRECT_TRANSACTION' || step.payloadHash !== review.messageHash ||
      toBase64(serializeTransaction(null, fromBase64(review.message))) !== review.unsignedTransaction) fail('TRANSACTION_CHANGED');
}
/** The wallet must return exactly the reviewed message with a valid owner signature. Any modification fails closed. */
export function verifySignedSolanaTransfer(review: Pick<SolanaTransferReview, 'message' | 'owner'>, signedBase64: unknown): { signature: string; transaction: string } {
  return verifySignedSolanaSwap(review, signedBase64, X);
}
