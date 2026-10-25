// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: Solana reads and proofs for the universal router — mint facts, the pinned Relay program deployment,
 * the exact v0 deposit message FloFi compiles (compute budget + FloFi-built Relay deposit, no lookup tables), its simulation with the
 * owner's and the vault's post-states, the confirmed deposit, and a delivery or refund credit to a Solana account.
 * Read-only: nothing here signs; `sendTransaction` exists only on the service's owner-signed submit path.
 */
import type { UniversalSolanaDeployment } from '@defi-workflow-engine/action-registry';
import { assertSafeMintExtensions, base58Decode, base58Encode, compileMessageV0, decodeSplMint, decodeSplTokenAccount, decompileMessageV0, estimateFee, fromBase64,
  parseMessageV0, parseTransaction, readSolanaAccounts, serializeMessageV0, serializeTransaction, setComputeUnitLimit, setComputeUnitPrice, simulateSolanaMessage,
  solanaKeyOnCurve, solanaMessageHash, solanaRecord, toBase64, associatedTokenAddress, type RawSolanaAccount, type SolanaInstruction, type SolanaRpc,
  SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID, SOLANA_SYSTEM_PROGRAM_ID, SOLANA_TOKEN_2022_PROGRAM_ID, SOLANA_TOKEN_PROGRAM_ID, RELAY_SOLANA_VAULT } from '@defi-workflow-engine/reference-compiler';
import type { UniversalRoute } from '@defi-workflow-engine/workflow-contracts';
import { sha256Hex } from './evm-chain.ts';

const fail = (code: string, cause?: unknown): never => { throw new Error(code, cause === undefined ? undefined : { cause }); };
const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
export type SolanaMintFacts = { mint: string; programId: string; program: 'spl-token' | 'token-2022'; decimals: number };

/** On-chain facts of a mint: owning token program, decimals, initialized, and only Token-2022 extensions that keep amounts exact. */
export async function solanaMintFacts(rpc: SolanaRpc, mint: string): Promise<SolanaMintFacts> {
  const { accounts } = await readSolanaAccounts(rpc, [mint]), account = accounts[0];
  if (!account) fail('UNIVERSAL_TOKEN_NOT_FOUND');
  const token2022 = account!.owner === SOLANA_TOKEN_2022_PROGRAM_ID;
  if (!token2022 && account!.owner !== SOLANA_TOKEN_PROGRAM_ID) fail('UNIVERSAL_TOKEN_PROGRAM_UNSUPPORTED');
  let decoded: ReturnType<typeof decodeSplMint>;
  try { decoded = decodeSplMint(account!.data, token2022); assertSafeMintExtensions(decoded.extensions); }
  catch (cause) { return fail('UNIVERSAL_TOKEN_EXTENSION_UNSUPPORTED', cause); }
  if (!decoded.initialized) fail('UNIVERSAL_TOKEN_INVALID');
  return { mint, programId: account!.owner, program: token2022 ? 'token-2022' : 'spl-token', decimals: decoded.decimals };
}
/** The Relay program is still the verified deployment: executable, upgradeable-loader program, same ProgramData, authority and deployment slot. */
export async function assertSolanaRelayProgram(rpc: SolanaRpc, d: UniversalSolanaDeployment): Promise<{ deploymentSlot: number; authority: string | null }> {
  const { accounts } = await readSolanaAccounts(rpc, [d.relayProgram]), program = accounts[0];
  if (!program || program.owner !== BPF_UPGRADEABLE_LOADER || program.data.length !== 36 || new DataView(program.data.buffer, program.data.byteOffset).getUint32(0, true) !== 2 ||
      base58Encode(program.data.slice(4, 36)) !== d.relayProgramData) fail('UNIVERSAL_UNEXPECTED_CONTRACT');
  const header = solanaRecord(await rpc('getMultipleAccounts', [[d.relayProgramData], { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: 45 } }]),
    'SOLANA_RPC_INVALID');
  const value = Array.isArray(header.value) ? header.value[0] : null, raw = value ? solanaRecord(value, 'SOLANA_RPC_INVALID') : fail('UNIVERSAL_UNEXPECTED_CONTRACT');
  const data = Array.isArray(raw.data) ? fromBase64(raw.data[0], 100) : fail('SOLANA_RPC_INVALID');
  if (raw.owner !== BPF_UPGRADEABLE_LOADER || data.length !== 45 || new DataView(data.buffer, data.byteOffset).getUint32(0, true) !== 3) fail('UNIVERSAL_UNEXPECTED_CONTRACT');
  const slot = Number(new DataView(data.buffer, data.byteOffset).getBigUint64(4, true)), authority = data[12] === 1 ? base58Encode(data.slice(13, 45)) : null;
  if (slot !== d.relayDeploymentSlot || authority !== d.relayUpgradeAuthority) fail('UNIVERSAL_UNEXPECTED_CONTRACT');
  return { deploymentSlot: slot, authority };
}
/** A Solana recipient must be a wallet key (on the Ed25519 curve) that is not a token account. */
export async function assertSolanaRecipient(rpc: SolanaRpc, recipient: string): Promise<void> {
  if (!solanaKeyOnCurve(recipient)) fail('UNIVERSAL_RECIPIENT_OFF_CURVE');
  const { accounts } = await readSolanaAccounts(rpc, [recipient]), account = accounts[0];
  if (account && (account.owner === SOLANA_TOKEN_PROGRAM_ID || account.owner === SOLANA_TOKEN_2022_PROGRAM_ID)) fail('UNIVERSAL_RECIPIENT_IS_TOKEN_ACCOUNT');
  if (account && (account.owner !== SOLANA_SYSTEM_PROGRAM_ID || account.data.length)) fail('UNIVERSAL_RECIPIENT_NOT_WALLET');
}
export const solanaInstructionOf = (route: UniversalRoute): SolanaInstruction => {
  if (route.source.ecosystem !== 'SOLANA') return fail('UNIVERSAL_ROUTE_TRANSACTION_INVALID');
  return { programId: route.source.instruction.programId, accounts: route.source.instruction.accounts.map(a => ({ ...a })),
    data: Uint8Array.from(Buffer.from(route.source.instruction.data.slice(2), 'hex')) };
};
export type SolanaDepositAccounts = { owner: string; ownerToken: string | null; vault: string; vaultToken: string | null };
export function solanaDepositAccounts(route: UniversalRoute, programId: string | null): SolanaDepositAccounts {
  const owner = route.depositor;
  if (route.inputToken.kind === 'NATIVE') return { owner, ownerToken: null, vault: RELAY_SOLANA_VAULT, vaultToken: null };
  const mint = route.inputToken.address!;
  return { owner, ownerToken: associatedTokenAddress(owner, mint, programId!, SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID), vault: RELAY_SOLANA_VAULT,
    vaultToken: associatedTokenAddress(RELAY_SOLANA_VAULT, mint, programId!, SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID) };
}
const tokenAmount = (account: RawSolanaAccount, programId: string, mint: string, owner: string): bigint | null => {
  if (!account || account.lamports === 0n && account.data.length === 0) return null;
  if (account.owner !== programId) fail('UNIVERSAL_TOKEN_ACCOUNT_MISMATCH');
  const decoded = decodeSplTokenAccount(account.data, programId === SOLANA_TOKEN_2022_PROGRAM_ID);
  if (decoded.mint !== mint || decoded.owner !== owner) fail('UNIVERSAL_TOKEN_ACCOUNT_MISMATCH');
  if (decoded.state !== 1) fail('UNIVERSAL_TOKEN_ACCOUNT_FROZEN');
  return decoded.amount;
};
export type SolanaDepositReview = { message: string; messageHash: string; unsignedTransaction: string; blockhash: string; lastValidBlockHeight: number; slot: number;
  computeUnitLimit: number; computeUnitPrice: string; estimatedFeeLamports: string; vaultTokenCreationLamports: string; unitsConsumed: number;
  ownerBalanceBefore: string; ownerLamportsBefore: string; ownerDebit: string; logs: string[] };
/**
 * Compiles the exact deposit message (ComputeBudget limit + price, then the FloFi-built Relay instruction; no lookup tables) and
 * simulates it twice: once at the ceiling to measure, then the final bytes with a tight limit. The vault must receive exactly the amount
 * and the owner's token account (or lamports, net of the fee) must lose exactly the amount.
 */
export async function simulateSolanaDeposit(rpc: SolanaRpc, d: UniversalSolanaDeployment, route: UniversalRoute, programId: string | null): Promise<SolanaDepositReview> {
  const ix = solanaInstructionOf(route), accounts = solanaDepositAccounts(route, programId), amount = BigInt(route.inputAmount), owner = route.depositor;
  const keys = [owner, ...accounts.ownerToken ? [accounts.ownerToken] : [], accounts.vault, ...accounts.vaultToken ? [accounts.vaultToken] : []];
  const before = await readSolanaAccounts(rpc, keys);
  const ownerAccount = before.accounts[0] ?? fail('UNIVERSAL_OWNER_NOT_WALLET');
  if (ownerAccount.owner !== SOLANA_SYSTEM_PROGRAM_ID || ownerAccount.data.length) fail('UNIVERSAL_OWNER_NOT_WALLET');
  const mint = route.inputToken.address;
  const ownerTokenBefore = accounts.ownerToken ? tokenAmount(before.accounts[1]!, programId!, mint!, owner) : null;
  if (accounts.ownerToken && (ownerTokenBefore ?? 0n) < amount) fail('UNIVERSAL_INSUFFICIENT_TOKEN');
  const vaultTokenBefore = accounts.vaultToken ? tokenAmount(before.accounts[3]!, programId!, mint!, accounts.vault) : null;
  const vaultBefore = before.accounts[accounts.ownerToken ? 2 : 1]?.lamports ?? 0n;
  const latest = solanaRecord(solanaRecord(await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]), 'SOLANA_RPC_INVALID').value, 'SOLANA_RPC_INVALID');
  const blockhash = typeof latest.blockhash === 'string' ? latest.blockhash : fail('SOLANA_RPC_INVALID');
  const lastValidBlockHeight = Number.isSafeInteger(latest.lastValidBlockHeight) ? latest.lastValidBlockHeight as number : fail('SOLANA_RPC_INVALID');
  const price = d.computeUnitPriceMicroLamports;
  const compile = (units: number) => serializeMessageV0(compileMessageV0(owner, [setComputeUnitLimit(units), ...setComputeUnitPrice(price), ix], blockhash, {}));
  let measured: Awaited<ReturnType<typeof simulateSolanaMessage>>;
  try { measured = await simulateSolanaMessage(rpc, compile(d.maximumComputeUnits), keys, 'UNIVERSAL'); }
  catch (cause) { return fail(cause instanceof Error && cause.message === 'UNIVERSAL_SIMULATION_FAILED' ? 'UNIVERSAL_SIMULATION_DEPOSIT_REVERTED' : 'UNIVERSAL_SIMULATION_UNAVAILABLE', cause); }
  const units = Math.min(d.maximumComputeUnits, Math.ceil(measured.unitsConsumed * 1.2) + 5_000);
  const message = compile(units);
  let simulated: Awaited<ReturnType<typeof simulateSolanaMessage>>;
  try { simulated = await simulateSolanaMessage(rpc, message, keys, 'UNIVERSAL'); }
  catch (cause) { return fail(cause instanceof Error && cause.message === 'UNIVERSAL_SIMULATION_FAILED' ? 'UNIVERSAL_SIMULATION_DEPOSIT_REVERTED' : 'UNIVERSAL_SIMULATION_UNAVAILABLE', cause); }
  const fee = BigInt(estimateFee(units, price));
  const ownerAfter = simulated.accounts[0]?.lamports ?? 0n;
  let ownerDebit: bigint, creation = 0n;
  if (accounts.ownerToken) {
    const ownerTokenAfter = tokenAmount(simulated.accounts[1]!, programId!, mint!, owner) ?? 0n, vaultTokenAfter = tokenAmount(simulated.accounts[3]!, programId!, mint!, accounts.vault) ?? 0n;
    ownerDebit = (ownerTokenBefore ?? 0n) - ownerTokenAfter;
    if (vaultTokenAfter - (vaultTokenBefore ?? 0n) !== amount || ownerDebit !== amount) fail('UNIVERSAL_SIMULATED_DEBIT_MISMATCH');
    if (vaultTokenBefore === null) creation = simulated.accounts[3]?.lamports ?? 0n;
    // The owner pays only the network fee and, when the vault's token account does not exist yet, its rent-exempt deposit.
    if (ownerAccount.lamports - ownerAfter > fee + creation) fail('UNIVERSAL_SIMULATED_DEBIT_MISMATCH');
  } else {
    const vaultAfter = simulated.accounts[1]?.lamports ?? 0n;
    ownerDebit = ownerAccount.lamports - ownerAfter - fee;
    if (vaultAfter - vaultBefore !== amount || ownerDebit !== amount) fail('UNIVERSAL_SIMULATED_DEBIT_MISMATCH');
  }
  if (ownerAccount.lamports < fee + creation + (accounts.ownerToken ? 0n : amount)) fail('UNIVERSAL_INSUFFICIENT_SOL_FOR_FEES');
  return { message: toBase64(message), messageHash: solanaMessageHash(message), unsignedTransaction: toBase64(serializeTransaction(null, message)), blockhash,
    lastValidBlockHeight, slot: before.slot, computeUnitLimit: units, computeUnitPrice: price, estimatedFeeLamports: fee.toString(), vaultTokenCreationLamports: creation.toString(),
    unitsConsumed: simulated.unitsConsumed, ownerBalanceBefore: (ownerTokenBefore ?? ownerAccount.lamports).toString(), ownerLamportsBefore: ownerAccount.lamports.toString(),
    ownerDebit: ownerDebit.toString(), logs: simulated.logs.slice(-20) };
}

type TokenBalance = { index: number; mint: string; owner: string; amount: bigint };
const tokenBalances = (v: unknown): TokenBalance[] => Array.isArray(v) ? (v as unknown[]).map(item => {
  const b = solanaRecord(item, 'SOLANA_RPC_INVALID'), ui = solanaRecord(b.uiTokenAmount, 'SOLANA_RPC_INVALID');
  if (!Number.isSafeInteger(b.accountIndex) || typeof b.mint !== 'string' || typeof b.owner !== 'string' || typeof ui.amount !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(ui.amount))
    fail('SOLANA_TOKEN_BALANCE_INVALID');
  return { index: b.accountIndex as number, mint: b.mint as string, owner: b.owner as string, amount: BigInt(ui.amount as string) };
}) : fail('SOLANA_RPC_INVALID');
const lamportList = (v: unknown, n: number): bigint[] => Array.isArray(v) && v.length === n && v.every(x => Number.isSafeInteger(x) && (x as number) >= 0)
  ? (v as number[]).map(x => BigInt(x)) : fail('SOLANA_RPC_INVALID');
export type SolanaTransactionFacts = { slot: number; blockTime: number | null; err: unknown; keys: string[]; pre: bigint[]; post: bigint[]; preTokens: TokenBalance[];
  postTokens: TokenBalance[]; instructions: SolanaInstruction[]; fee: bigint; bytes: Uint8Array; contentHash: string };
/** A finalized transaction with its full account list (static keys, then loaded writable and readonly), balances and decompiled instructions. */
export async function solanaFinalizedTransaction(rpc: SolanaRpc, signature: string): Promise<SolanaTransactionFacts | null> {
  const value = await rpc('getTransaction', [signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
  if (value === null) return null;
  const tx = solanaRecord(value, 'SOLANA_RPC_INVALID'), meta = solanaRecord(tx.meta, 'SOLANA_RPC_INVALID');
  if (!Array.isArray(tx.transaction) || tx.transaction[1] !== 'base64' || !Number.isSafeInteger(tx.slot)) fail('SOLANA_RPC_INVALID');
  const bytes = fromBase64((tx.transaction as unknown[])[0], 4096), parsed = parseTransaction(bytes);
  if (base58Encode(parsed.signatures[0]!) !== signature) fail('UNIVERSAL_SIGNATURE_MISMATCH');
  let keys: string[], instructions: SolanaInstruction[];
  if (parsed.message[0] === 0x80) {
    const message = parseMessageV0(parsed.message);
    const loaded = meta.loadedAddresses === undefined || meta.loadedAddresses === null ? { writable: [], readonly: [] } : solanaRecord(meta.loadedAddresses, 'SOLANA_RPC_INVALID');
    const writable = Array.isArray(loaded.writable) ? loaded.writable as string[] : [], readonly = Array.isArray(loaded.readonly) ? loaded.readonly as string[] : [];
    keys = [...message.staticKeys, ...writable, ...readonly];
    // Resolve lookups with the addresses the runtime reports as loaded, in table order.
    const tables: Record<string, string[]> = {};
    let w = 0, r = 0;
    for (const lookup of message.lookups) {
      const table: string[] = [];
      for (const i of lookup.writable) table[i] = writable[w++]!;
      for (const i of lookup.readonly) table[i] = readonly[r++]!;
      tables[lookup.table] = table;
    }
    instructions = decompileMessageV0(message, tables);
  } else {
    // A legacy message (Relay solvers may use them): header, keys, blockhash, instructions; no lookups.
    const m = parsed.message, count = m[3]!, staticKeys: string[] = [];
    if (count >= 0x80 || m.length < 4 + count * 32) fail('SOLANA_RPC_INVALID');
    let at = 4;
    for (let i = 0; i < count; i++) { staticKeys.push(base58Encode(m.slice(at, at + 32))); at += 32; }
    keys = staticKeys;
    instructions = [];
  }
  const fee = typeof meta.fee === 'number' && Number.isSafeInteger(meta.fee) ? BigInt(meta.fee) : fail('SOLANA_RPC_INVALID');
  return { slot: tx.slot as number, blockTime: Number.isSafeInteger(tx.blockTime) ? tx.blockTime as number : null, err: meta.err ?? null, keys,
    pre: lamportList(meta.preBalances, keys.length), post: lamportList(meta.postBalances, keys.length), preTokens: tokenBalances(meta.preTokenBalances),
    postTokens: tokenBalances(meta.postTokenBalances), instructions, fee, bytes, contentHash: '0x' + sha256Hex(JSON.stringify(value)) };
}
/** Net credit of `owner` in `mint` (null = lamports) within one transaction. */
export function solanaCredit(t: SolanaTransactionFacts, owner: string, mint: string | null): bigint {
  if (mint === null) { const i = t.keys.indexOf(owner); return i < 0 ? 0n : t.post[i]! - t.pre[i]!; }
  const sum = (list: TokenBalance[]) => list.filter(b => b.owner === owner && b.mint === mint).reduce((s, b) => s + b.amount, 0n);
  return sum(t.postTokens) - sum(t.preTokens);
}
export type SolanaCreditCheck = { ok: true; amount: bigint; slot: number; timestamp: number | null; orderBound: boolean; contentHash: string }
  | { ok: false; reason: 'NOT_FINALIZED' | 'REVERTED' | 'NO_CREDIT' | 'BELOW_MINIMUM' };
export async function verifySolanaCredit(rpc: SolanaRpc, input: { signature: string; recipient: string; mint: string | null; minimum: bigint; orderId: string }): Promise<SolanaCreditCheck> {
  const t = await solanaFinalizedTransaction(rpc, input.signature);
  if (!t) return { ok: false, reason: 'NOT_FINALIZED' };
  if (t.err !== null) return { ok: false, reason: 'REVERTED' };
  const amount = solanaCredit(t, input.recipient, input.mint);
  if (amount <= 0n) return { ok: false, reason: 'NO_CREDIT' };
  if (amount < input.minimum) return { ok: false, reason: 'BELOW_MINIMUM' };
  const id = input.orderId.slice(2);
  return { ok: true, amount, slot: t.slot, timestamp: t.blockTime, orderBound: t.instructions.some(i => Buffer.from(i.data).toString('hex').includes(id)), contentHash: t.contentHash };
}
/** The deposit as it landed: the exact owner-signed bytes, success, the vault credited exactly the amount and the order's instruction present. */
export async function verifySolanaDeposit(rpc: SolanaRpc, route: UniversalRoute, signature: string, signedTransaction: string, programId: string | null):
  Promise<{ status: 'FINALIZED'; slot: number; timestamp: number | null; ownerDebit: bigint; fee: bigint; contentHash: string } | { status: 'REVERTED'; slot: number; fee: bigint } | null> {
  const t = await solanaFinalizedTransaction(rpc, signature);
  if (!t) return null;
  if (Buffer.from(t.bytes).toString('base64') !== Buffer.from(fromBase64(signedTransaction, 4096)).toString('base64')) fail('UNIVERSAL_TRANSACTION_MISMATCH');
  if (t.err !== null) return { status: 'REVERTED', slot: t.slot, fee: t.fee };
  const accounts = solanaDepositAccounts(route, programId), amount = BigInt(route.inputAmount);
  const relay = t.instructions.filter(i => i.programId === solanaInstructionOf(route).programId);
  if (route.source.ecosystem !== 'SOLANA' || relay.length !== 1 || '0x' + Buffer.from(relay[0]!.data).toString('hex') !== route.source.instruction.data)
    fail('UNIVERSAL_DEPOSIT_EVENT_MISMATCH');
  const vaultCredit = solanaCredit(t, accounts.vault, route.inputToken.address);
  if (vaultCredit !== amount) fail('UNIVERSAL_DEPOSIT_EVENT_MISMATCH');
  const ownerDebit = route.inputToken.kind === 'NATIVE' ? -(solanaCredit(t, route.depositor, null) + t.fee) : -solanaCredit(t, route.depositor, route.inputToken.address);
  if (ownerDebit !== amount) fail('UNIVERSAL_OWNER_DEBIT_MISMATCH');
  return { status: 'FINALIZED', slot: t.slot, timestamp: t.blockTime, ownerDebit, fee: t.fee, contentHash: t.contentHash };
}
export { base58Decode };
