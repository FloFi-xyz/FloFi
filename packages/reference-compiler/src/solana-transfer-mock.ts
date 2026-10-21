// SPDX-License-Identifier: AGPL-3.0-only
import { sha256 } from '@noble/hashes/sha2.js';
import { SOLANA_MAINNET_TRANSFER, type SolanaTransferProfile } from '@defi-workflow-engine/action-registry';
import { associatedTokenAddress, base58Encode, decompileMessageV0, fromBase64, parseMessageV0, parseTransaction, publicKeyBytes, readU64, toBase64,
  verifyEd25519, type SolanaInstruction } from './solana.js';

/**
 * BUILD-SOLANA-TRANSFER-UX-001: a MOCKED deterministic Solana cluster for transfer tests and the offline browser harness. It interprets the
 * exact compiled message under the runtime's rules that matter to a transfer — fee payment from the compute budget, rent-exempt minimums
 * for System and token accounts, Associated Token Account derivation, and `TransferChecked`'s mint, decimals, owner, balance and frozen
 * checks for SPL Token and Token-2022 (with extension TLVs) — and keeps finalized transaction metadata. Nothing here is public evidence.
 */
export const MOCKED_RENT = Object.freeze({ system: 890_880n, token: 2_039_280n, token2022: 2_074_080n });
const label = (text: string) => base58Encode(sha256(new TextEncoder().encode('flofi-transfer-mock:' + text)));
export type MockedTransferMint = { program: 'spl-token' | 'token-2022'; decimals: number; supply: bigint; extensions: { type: number; value: Uint8Array }[] };
export type MockedTransferTokenAccount = { program: 'spl-token' | 'token-2022'; mint: string; owner: string; amount: bigint; state: 1 | 2; extensions: { type: number; value: Uint8Array }[] };
type Snapshot = { lamports: Map<string, bigint>; systemData: Map<string, number>; mints: Map<string, MockedTransferMint>; tokens: Map<string, MockedTransferTokenAccount>; executables: Set<string> };
type Landed = { signature: string; slot: number; bytes: string; err: unknown; fee: bigint; keys: string[]; pre: bigint[]; post: bigint[]; preTokens: unknown[]; postTokens: unknown[];
  finalizedAt: number };
export type MockedTransferOptions = { profile?: SolanaTransferProfile; send?: 'OK' | 'RPC_ERROR_AFTER_LANDING' | 'RPC_ERROR_DROPPED' | 'DROPPED'; confirmationDelay?: number;
  /** A wrong RPC cluster (genesis hash) for wrong-network tests. */ genesisHash?: string; simulateWithoutFee?: boolean };
const cloneToken = (t: MockedTransferTokenAccount): MockedTransferTokenAccount => ({ ...t, extensions: t.extensions.map(e => ({ ...e })) });

export function createMockedSolanaTransferChain(options: MockedTransferOptions = {}) {
  const profile = options.profile ?? SOLANA_MAINNET_TRANSFER, P = profile.programs;
  const state = { slot: 400_000_000, blockHeight: 380_000_000, current: { lamports: new Map(), systemData: new Map(), mints: new Map(), tokens: new Map(), executables: new Set([P.token, P.token2022, P.system, P.associatedToken]) } as Snapshot,
    transactions: new Map<string, Landed>(), sent: [] as string[] };
  const programIdOf = (program: 'spl-token' | 'token-2022') => program === 'token-2022' ? P.token2022 : P.token;
  const ata = (owner: string, mint: string, program: 'spl-token' | 'token-2022' = 'spl-token') => associatedTokenAddress(owner, mint, programIdOf(program), P.associatedToken);
  const blockhash = (height: number) => base58Encode(sha256(new TextEncoder().encode('transfer-blockhash:' + height)));
  const issued = new Map<string, number>();
  const snapshot = (s: Snapshot = state.current): Snapshot => ({ lamports: new Map(s.lamports), systemData: new Map(s.systemData), executables: new Set(s.executables),
    mints: new Map([...s.mints].map(([k, v]) => [k, { ...v, extensions: v.extensions.map(e => ({ ...e })) }])), tokens: new Map([...s.tokens].map(([k, v]) => [k, cloneToken(v)])) });
  const rentOf = (t: MockedTransferTokenAccount) => t.program === 'token-2022' ? MOCKED_RENT.token2022 : MOCKED_RENT.token;
  /** Test setup: a System wallet, optionally with tokens in its canonical ATA. */
  function fundWallet(owner: string, lamports: bigint) { state.current.lamports.set(owner, lamports); }
  function createMint(mint: string, input: Partial<MockedTransferMint> & { decimals: number }) {
    state.current.mints.set(mint, { program: input.program ?? 'spl-token', decimals: input.decimals, supply: input.supply ?? 1_000_000_000_000n, extensions: input.extensions ?? [] });
    state.current.lamports.set(mint, 1_461_600n);
  }
  function fundToken(owner: string, mint: string, amount: bigint, input: { state?: 1 | 2; extensions?: { type: number; value: Uint8Array }[]; at?: string; tokenOwner?: string } = {}) {
    const m = state.current.mints.get(mint); if (!m) throw new Error('MOCK_MINT_MISSING');
    const address = input.at ?? ata(owner, mint, m.program);
    const account: MockedTransferTokenAccount = { program: m.program, mint, owner: input.tokenOwner ?? owner, amount, state: input.state ?? 1,
      extensions: input.extensions ?? (m.program === 'token-2022' ? [{ type: 7, value: new Uint8Array() }] : []) };
    state.current.tokens.set(address, account); state.current.lamports.set(address, rentOf(account));
    return address;
  }
  function mintData(m: MockedTransferMint): Uint8Array {
    const base = new Uint8Array(82); new DataView(base.buffer).setBigUint64(36, m.supply, true); base[44] = m.decimals; base[45] = 1;
    if (m.program === 'spl-token' || !m.extensions.length) return base;
    const tlv = m.extensions.flatMap(e => [e.type & 255, e.type >> 8, e.value.length & 255, e.value.length >> 8, ...e.value]);
    const out = new Uint8Array(166 + tlv.length); out.set(base, 0); out[165] = 1; out.set(tlv, 166); return out;
  }
  function tokenData(t: MockedTransferTokenAccount): Uint8Array {
    const base = new Uint8Array(165); base.set(publicKeyBytes(t.mint), 0); base.set(publicKeyBytes(t.owner), 32); new DataView(base.buffer).setBigUint64(64, t.amount, true); base[108] = t.state;
    if (t.program === 'spl-token') return base;
    const tlv = t.extensions.flatMap(e => [e.type & 255, e.type >> 8, e.value.length & 255, e.value.length >> 8, ...e.value]);
    const out = new Uint8Array(166 + tlv.length); out.set(base, 0); out[165] = 2; out.set(tlv, 166); return out;
  }
  function accountValue(s: Snapshot, k: string) {
    const lamports = s.lamports.get(k);
    if (lamports === undefined || lamports === 0n && !s.tokens.has(k)) return null;
    const mint = s.mints.get(k), token = s.tokens.get(k);
    if (mint) { const data = mintData(mint); return { lamports: Number(lamports), owner: programIdOf(mint.program), data: [toBase64(data), 'base64'], executable: false, rentEpoch: 0, space: data.length }; }
    if (token) { const data = tokenData(token); return { lamports: Number(lamports), owner: programIdOf(token.program), data: [toBase64(data), 'base64'], executable: false, rentEpoch: 0, space: data.length }; }
    const size = s.systemData.get(k) ?? 0;
    return { lamports: Number(lamports), owner: s.executables.has(k) ? 'BPFLoaderUpgradeab1e11111111111111111111111' : P.system, data: [toBase64(new Uint8Array(size)), 'base64'],
      executable: s.executables.has(k), rentEpoch: 0, space: size };
  }
  const custom = (index: number, error: unknown) => Object.assign(new Error('instruction'), { custom: { InstructionError: [index, error] } });
  /** Execute instructions against a snapshot; returns an error object instead of throwing on program failure. */
  function execute(s: Snapshot, instructions: SolanaInstruction[], payer: string, chargeFee = true): { err: unknown; fee: bigint; units: number } {
    let limit = 200_000, price = 0n;
    for (const i of instructions) if (i.programId === P.computeBudget) { if (i.data[0] === 2) limit = new DataView(i.data.buffer, i.data.byteOffset).getUint32(1, true); if (i.data[0] === 3) price = readU64(i.data, 1); }
    const fee = 5000n + (BigInt(limit) * price + 999_999n) / 1_000_000n;
    if ((s.lamports.get(payer) ?? 0n) < fee) return { err: 'InsufficientFundsForFee', fee, units: 0 };
    if (chargeFee) s.lamports.set(payer, s.lamports.get(payer)! - fee);
    const debit = (k: string, n: bigint, index: number) => { const v = s.lamports.get(k) ?? 0n; if (v < n) throw custom(index, { Custom: 1 }); s.lamports.set(k, v - n); };
    let units = 300;
    try {
      instructions.forEach((i, index) => {
        const a = (n: number) => i.accounts[n]!.pubkey;
        if (i.programId === P.computeBudget) { units += 150; return; }
        if (i.programId === P.system) {
          if (i.data.length !== 12 || new DataView(i.data.buffer, i.data.byteOffset).getUint32(0, true) !== 2 || !i.accounts[0]!.isSigner) throw custom(index, 'InvalidInstructionData');
          const n = readU64(i.data, 4); debit(a(0), n, index); s.lamports.set(a(1), (s.lamports.get(a(1)) ?? 0n) + n); units += 150; return;
        }
        if (i.programId === P.associatedToken) {
          if (i.data.length !== 1 || i.data[0] !== 1) throw custom(index, 'InvalidInstructionData');
          const [payerKey, account, wallet, mint, , program] = [0, 1, 2, 3, 4, 5].map(a);
          const m = s.mints.get(mint!); if (!m || programIdOf(m.program) !== program) throw custom(index, 'IncorrectProgramId');
          if (associatedTokenAddress(wallet!, mint!, program!, P.associatedToken) !== account) throw custom(index, 'InvalidSeeds');
          units += m.program === 'token-2022' ? 30_000 : 22_000;
          const existing = s.tokens.get(account!);
          if (existing) {
            if (existing.owner !== wallet || existing.mint !== mint || programIdOf(existing.program) !== program) throw custom(index, 'InvalidOwner');
            return;
          }
          const created: MockedTransferTokenAccount = { program: m.program, mint: mint!, owner: wallet!, amount: 0n, state: 1, extensions: m.program === 'token-2022' ? [{ type: 7, value: new Uint8Array() }] : [] };
          debit(payerKey!, rentOf(created), index); s.tokens.set(account!, created); s.lamports.set(account!, rentOf(created)); return;
        }
        if (i.programId === P.token || i.programId === P.token2022) {
          if (i.data[0] !== 12 || i.data.length !== 10) throw custom(index, 'InvalidInstructionData');
          const source = s.tokens.get(a(0)), mint = s.mints.get(a(1)), target = s.tokens.get(a(2)), amount = readU64(i.data, 1), decimals = i.data[9];
          if (!source || !target || !mint || programIdOf(mint.program) !== i.programId) throw custom(index, 'IncorrectProgramId');
          if (source.mint !== a(1) || target.mint !== a(1)) throw custom(index, { Custom: 3 }); // MintMismatch
          if (decimals !== mint.decimals) throw custom(index, { Custom: 18 }); // MintDecimalsMismatch
          if (source.owner !== a(3) || !i.accounts[3]!.isSigner) throw custom(index, { Custom: 4 }); // OwnerMismatch
          if (source.state === 2 || target.state === 2) throw custom(index, { Custom: 17 }); // AccountFrozen
          if (source.amount < amount) throw custom(index, { Custom: 1 }); // InsufficientFunds
          source.amount -= amount; target.amount += amount; units += mint.program === 'token-2022' ? 9_000 : 6_200; return;
        }
        throw custom(index, 'UnsupportedProgramId');
      });
      // Rent rule: a System account with no data ends either empty or rent-exempt; token accounts keep their deposit.
      for (const [k, v] of s.lamports) if (!s.tokens.has(k) && !s.mints.has(k) && !s.executables.has(k) && (s.systemData.get(k) ?? 0) === 0 && v > 0n && v < MOCKED_RENT.system)
        throw Object.assign(new Error('rent'), { custom: { InsufficientFundsForRent: { account_index: 0 } } });
    } catch (cause) { return { err: (cause as { custom?: unknown }).custom ?? 'ProgramFailed', fee, units }; }
    return { err: null, fee, units };
  }
  function decode(txBase64: unknown) {
    const bytes = fromBase64(txBase64, 2048), { signatures, message } = parseTransaction(bytes), parsed = parseMessageV0(message);
    return { bytes, signatures, message, parsed, instructions: decompileMessageV0(parsed, {}) };
  }
  function tokenBalances(s: Snapshot, keys: string[]) {
    return keys.flatMap((k, accountIndex) => { const t = s.tokens.get(k), m = t ? s.mints.get(t.mint) : null;
      return t && m ? [{ accountIndex, mint: t.mint, owner: t.owner, programId: programIdOf(t.program), uiTokenAmount: { amount: t.amount.toString(), decimals: m.decimals } }] : []; });
  }
  function land(txBase64: string): string {
    const d = decode(txBase64), signature = base58Encode(d.signatures[0]!);
    if (state.transactions.has(signature)) return signature;
    if (!verifyEd25519(d.signatures[0]!, d.message, d.parsed.staticKeys[0]!)) throw Object.assign(new Error('Transaction signature verification failure'), { rpc: -32003 });
    const valid = issued.get(d.parsed.blockhash);
    if (valid === undefined || state.blockHeight > valid) throw Object.assign(new Error('Blockhash not found'), { rpc: -32002 });
    const keys = d.parsed.staticKeys, before = snapshot(), working = snapshot(), result = execute(working, d.instructions, keys[0]!);
    const final = result.err ? (() => { const s = snapshot(); s.lamports.set(keys[0]!, (s.lamports.get(keys[0]!) ?? 0n) - result.fee); return s; })() : working;
    const lamportsAt = (s: Snapshot, k: string) => s.lamports.get(k) ?? 0n;
    state.current = final; state.slot += 1;
    state.transactions.set(signature, { signature, slot: state.slot, bytes: txBase64, err: result.err, fee: result.fee, keys, pre: keys.map(k => lamportsAt(before, k)),
      post: keys.map(k => lamportsAt(final, k)), preTokens: tokenBalances(before, keys), postTokens: tokenBalances(final, keys),
      finalizedAt: state.blockHeight + (options.confirmationDelay ?? 0) });
    return signature;
  }
  const value = (v: unknown) => ({ context: { slot: state.slot, apiVersion: 'mocked' }, value: v });
  async function rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    switch (method) {
      case 'getGenesisHash': return options.genesisHash ?? profile.genesisHash;
      case 'getMinimumBalanceForRentExemption': return Number(params[0]) === 0 ? Number(MOCKED_RENT.system) : Number((128n + BigInt(Number(params[0]))) * 6_960n);
      case 'getMultipleAccounts': return value((params[0] as string[]).map(k => accountValue(state.current, k)));
      case 'getTokenAccountsByOwner': return value([...state.current.tokens].filter(([, token]) => token.owner === params[0] && token.mint === (params[1] as { mint: string }).mint)
        .map(([pubkey]) => ({ pubkey, account: accountValue(state.current, pubkey) })));
      case 'getLatestBlockhash': { const hash = blockhash(state.blockHeight); issued.set(hash, state.blockHeight + 150); return value({ blockhash: hash, lastValidBlockHeight: state.blockHeight + 150 }); }
      case 'getBlockHeight': return state.blockHeight;
      case 'getSlot': return state.slot;
      case 'getFeeForMessage': {
        const message = parseMessageV0(fromBase64(params[0]));
        const instructions = decompileMessageV0(message, {});
        return value(Number(execute(snapshot(), instructions, message.staticKeys[0]!, false).fee));
      }
      case 'simulateTransaction': {
        const d = decode(params[0]), s = snapshot(), result = execute(s, d.instructions, d.parsed.staticKeys[0]!, !options.simulateWithoutFee);
        const addresses = ((params[1] as { accounts?: { addresses?: string[] } })?.accounts?.addresses) ?? [];
        return value({ err: result.err, logs: ['Program log: MOCKED transfer simulation'], unitsConsumed: Math.max(1, result.units), accounts: addresses.map(k => accountValue(s, k)) });
      }
      case 'sendTransaction': {
        state.sent.push(params[0] as string);
        if (options.send === 'DROPPED') return base58Encode(parseTransaction(fromBase64(params[0], 2048)).signatures[0]!);
        if (options.send === 'RPC_ERROR_DROPPED') throw Object.assign(new Error('Node is behind'), { rpc: -32005 });
        const signature = land(params[0] as string);
        if (options.send === 'RPC_ERROR_AFTER_LANDING') throw Object.assign(new Error('Request timed out'), { rpc: -32603 });
        return signature;
      }
      case 'getSignatureStatuses': return value((params[0] as string[]).map(sig => { const t = state.transactions.get(sig);
        return t ? { slot: t.slot, confirmations: null, err: t.err, confirmationStatus: state.blockHeight >= t.finalizedAt ? 'finalized' : 'confirmed' } : null; }));
      case 'getTransaction': { const t = state.transactions.get(params[0] as string);
        if (!t || state.blockHeight < t.finalizedAt) return null;
        return { slot: t.slot, blockTime: 1_790_900_000 + t.slot % 1000, version: 0, transaction: [t.bytes, 'base64'],
          meta: { err: t.err, fee: Number(t.fee), preBalances: t.pre.map(Number), postBalances: t.post.map(Number), preTokenBalances: t.preTokens, postTokenBalances: t.postTokens,
            loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [], logMessages: ['Program log: MOCKED'], computeUnitsConsumed: 30_000 } }; }
      default: throw new Error('SOLANA_RPC_METHOD_DENIED');
    }
  }
  return { state, rpc, profile, fundWallet, createMint, fundToken, ata, label, advance: (blocks: number) => { state.blockHeight += blocks; state.slot += blocks; },
    tokenAccount: (address: string) => state.current.tokens.get(address) ?? null, lamports: (address: string) => state.current.lamports.get(address) ?? 0n,
    markProgram: (address: string) => { state.current.executables.add(address); state.current.lamports.set(address, 1_141_440n); },
    systemAccountWithData: (address: string, size: number, lamports: bigint) => { state.current.systemData.set(address, size); state.current.lamports.set(address, lamports); } };
}
