// SPDX-License-Identifier: AGPL-3.0-only
import { SOLANA_MAINNET_TRANSFER } from '@defi-workflow-engine/action-registry';
import { associatedTokenAddress, compileMessageV0, decompileMessageV0, fromBase64, parseMessageV0, parseTransaction, serializeMessageV0, serializeSignedTransaction,
  serializeTransaction, toBase64, u64Bytes, type LookupTables, type SolanaInstruction } from './solana.js';
import { LIGHTHOUSE_PROGRAM } from './solana-wallet-change.js';
import { decodeLighthouseAssertion } from './solana-wallet-guard.js';

/**
 * MOCKED Phantom transaction protection, byte for byte as captured from Phantom-signed mainnet-beta transactions (for example the
 * Jupiter swap 5DSfVKL9eA3TRQGiokeA4y3tnNiktUSfYFRP7YT31LwM9zkBYsb7GHzGnpbtV67MvatNDW2ZMq2RCkjwesoesuJ5): after the dApp's
 * instructions the wallet appends
 *   AssertAccountInfoMulti  (owner)          lamports >= N, owner == System, dataLength == 0
 *   AssertTokenAccountMulti (token account)  amount >= M, delegate == none, delegatedAmount <= 0, ownerIsDerivedAssociatedTokenAccount
 * both at log level FailedPlaintextMessage, keeping the fee payer, signers, blockhash and every reviewed instruction. Returns the
 * unsigned transaction the wallet would then sign; nothing here signs or sends.
 */
export type MockedPhantomGuard = { lamportsAtLeast: bigint; tokenAccount?: string; tokenAmountAtLeast?: bigint };
export function mockedPhantomGuardInstructions(owner: string, guard: MockedPhantomGuard): SolanaInstruction[] {
  const meta = (pubkey: string) => [{ pubkey, isSigner: false, isWritable: false }];
  const info = Uint8Array.from([6, 4, 3, 0, ...u64Bytes(guard.lamportsAtLeast), 4, 3, 0, 0, 1, ...u64Bytes(0n), 0]);
  const out: SolanaInstruction[] = [{ programId: LIGHTHOUSE_PROGRAM, accounts: meta(owner), data: info }];
  if (guard.tokenAccount) out.push({ programId: LIGHTHOUSE_PROGRAM, accounts: meta(guard.tokenAccount),
    data: Uint8Array.from([10, 4, 4, 2, ...u64Bytes(guard.tokenAmountAtLeast ?? 0n), 4, 3, 0, 0, 6, ...u64Bytes(0n), 5, 8]) });
  return out;
}
export function applyMockedPhantomLighthouseGuards(unsignedBase64: string, guard: MockedPhantomGuard, tables: LookupTables = {}): string {
  const { signatures, message } = parseTransaction(fromBase64(unsignedBase64, 2048));
  const parsed = parseMessageV0(message), owner = parsed.staticKeys[0]!;
  // The reviewed account flags are message-level; a read-only reference to an account the transaction already writes keeps it writable.
  const changed = serializeMessageV0(compileMessageV0(owner, [...decompileMessageV0(parsed, tables), ...mockedPhantomGuardInstructions(owner, guard)], parsed.blockhash, tables));
  return toBase64(signatures.length === 1 ? serializeTransaction(null, changed) : serializeSignedTransaction(signatures.map(() => null), changed));
}

const { system: SYSTEM, token: TOKEN, token2022: TOKEN_2022, associatedToken: ASSOCIATED } = SOLANA_MAINNET_TRANSFER.programs;
export type MockedLighthouseAccount = { address: string; lamports: bigint; owner: string; dataLength: number;
  token: { mint: string; owner: string; amount: bigint; delegate: string | null; delegatedAmount: bigint } | null } | null;
const compare = (actual: bigint, op: string, expected: bigint) => op === '==' ? actual === expected : op === '!=' ? actual !== expected : op === '>' ? actual > expected
  : op === '<' ? actual < expected : op === '>=' ? actual >= expected : op === '<=' ? actual <= expected : false;
/**
 * MOCKED Lighthouse program: evaluates the assertions FloFi accepts against the loopback's current account state, as the program does
 * (a missing account has 0 lamports and no data). Throws on the first failed assertion, which fails the whole transaction.
 */
export function evaluateMockedLighthouse(data: Uint8Array, account: MockedLighthouseAccount): void {
  const { kind, assertions } = decodeLighthouseAssertion(data);
  const knownOwner: Record<string, string> = { System: SYSTEM, Token: TOKEN, Token2022: TOKEN_2022 };
  for (const assertion of assertions) {
    const [field, op = '', value = ''] = assertion.split(' ');
    let ok: boolean;
    if (kind.startsWith('AssertAccountInfo')) {
      if (field === 'lamports') ok = compare(account?.lamports ?? 0n, op, BigInt(value));
      else if (field === 'dataLength') ok = compare(BigInt(account?.dataLength ?? 0), op, BigInt(value));
      else if (field === 'owner' && knownOwner[value]) ok = (account?.owner ?? SYSTEM) === knownOwner[value] === (op === '==');
      else throw new Error('LIGHTHOUSE_MOCK_UNSUPPORTED');
    } else {
      const token = account?.token ?? null;
      if (!token || ![TOKEN, TOKEN_2022].includes(account!.owner)) throw new Error('LIGHTHOUSE_ACCOUNT_OWNER_MISMATCH');
      if (field === 'amount') ok = compare(token.amount, op, BigInt(value));
      else if (field === 'delegatedAmount') ok = compare(token.delegatedAmount, op, BigInt(value));
      else if (field === 'delegate' && value === 'none') ok = (token.delegate === null) === (op === '==');
      else if (field === 'ownerIsDerivedAssociatedTokenAccount') ok = associatedTokenAddress(token.owner, token.mint, account!.owner, ASSOCIATED) === account!.address;
      else throw new Error('LIGHTHOUSE_MOCK_UNSUPPORTED');
    }
    if (!ok) throw new Error('LIGHTHOUSE_ASSERTION_FAILED');
  }
}
