// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001 test harness: deterministic MOCKED chains and a MOCKED Relay API, in memory.
 *
 *  - EVM chains (Base, Arbitrum One, Ethereum, Robinhood Chain): blocks, ERC-20 balances/allowances, native balances, nonces with
 *    historical reads, `eth_simulateV1`, receipts, and a Relay Depository double that behaves like the real contract (pulls the
 *    tokens or takes the value, emits `RelayErc20Deposit` / `RelayNativeDeposit`).
 *  - Solana mainnet-beta: the Relay program (upgradeable loader, ProgramData header), mints, token accounts, `simulateTransaction`
 *    of FloFi's exact v0 message, `sendTransaction`, signature statuses and finalized transactions with balance metadata.
 *  - Relay API: quotes whose `orderId` is the real EIP-712 hash of the order and whose steps are the real Depository encodings, so the
 *    production adapter verifies them unchanged; status per request id, settable by the test (the solver).
 * Nothing here reaches a network. The owner's EVM wallet is played by `wallet.send`; the Solana owner signs with an in-memory test key.
 */
import { createHash, generateKeyPairSync, randomBytes, sign as signBytes } from 'node:crypto';
import type { UniversalEvmDeployment, UniversalSolanaDeployment } from '@defi-workflow-engine/action-registry';
import { associatedTokenAddress, base58Decode, base58Encode, compileMessageV0, decompileMessageV0, encodeErc20ApproveExact, encodeRelayDepositErc20,
  encodeRelayDepositNative, encodeRelayDepositLog, parseMessageV0, parseTransaction, relayOrderId, relaySolanaDepositInstruction, serializeMessageV0, serializeSignedTransaction,
  toBase64, fromBase64, RELAY_EVM_DEPOSITORY, RELAY_SOLANA_DEPOSITORY_PROGRAM, RELAY_SOLANA_VAULT, RELAY_SOLANA_DISCRIMINATORS, SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID,
  SOLANA_SYSTEM_PROGRAM_ID, SOLANA_TOKEN_PROGRAM_ID, type RelayOrderData } from '@defi-workflow-engine/reference-compiler';
import { UNIVERSAL_NETWORKS, type UniversalNetwork, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';
import type { UniversalHttp } from './http.ts';
import type { Rpc } from '../public-testnet-service.ts';
import { MOCK_DEPOSITORY_CODE, MOCK_TOKEN_CODE } from './mock-deployment.ts';

export { mockedUniversalDeployment } from './mock-deployment.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const word = (value: bigint) => BigInt.asUintN(256, value).toString(16).padStart(64, '0');
const addrWord = (a: string) => a.toLowerCase().slice(2).padStart(64, '0');
const tagN = (n: number) => '0x' + n.toString(16);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
// --- EVM -------------------------------------------------------------------------------------------------------------
type Receipt = Record<string, unknown>;
export type EvmMock = ReturnType<typeof createEvmMockChain>;
export function createEvmMockChain(d: UniversalEvmDeployment, options: { now: () => number; tokens: Record<string, number> }) {
  const state = { head: 5_000, safeLag: 2, hashes: new Map<number, string>(), times: new Map<number, number>(), balances: new Map<string, bigint>(), allowances: new Map<string, bigint>(),
    native: new Map<string, bigint>(), nonces: new Map<string, number>(), pending: new Map<string, number>(), code: new Map<string, string>([[d.relayDepository, MOCK_DEPOSITORY_CODE]]),
    receipts: new Map<string, Receipt>(), txs: new Map<string, Record<string, unknown>>(), blockTxs: new Map<number, string[]>(),
    snapshots: new Map<number, { nonces: Map<string, number>; balances: Map<string, bigint>; native: Map<string, bigint> }>(), gasUsed: 90_000n, baseFee: 1_000_000n,
    simulateFails: false, depositRevert: false };
  for (const token of Object.keys(options.tokens)) state.code.set(token, MOCK_TOKEN_CODE);
  const hash = (n: number) => { if (!state.hashes.has(n)) state.hashes.set(n, '0x' + sha(`${d.chain}-block-${n}`)); return state.hashes.get(n)!; };
  const time = (n: number) => { if (!state.times.has(n)) state.times.set(n, Math.floor(options.now() / 1000) - (state.head - n) * 2); return state.times.get(n)!; };
  const key = (token: string, owner: string) => `${token}:${owner.toLowerCase()}`;
  const block = (n: number, full = false) => ({ number: tagN(n), hash: hash(n), timestamp: tagN(time(n)), baseFeePerGas: tagN(Number(state.baseFee)),
    transactions: (state.blockTxs.get(n) ?? []).map(h => full ? state.txs.get(h) : h) });
  const snapshot = () => state.snapshots.set(state.head, { nonces: new Map(state.nonces), balances: new Map(state.balances), native: new Map(state.native) });
  const view = (tag: unknown) => { const n = tag === undefined || tag === 'latest' || tag === 'pending' ? state.head : Number(BigInt(String(tag)));
    return n >= state.head ? state : state.snapshots.get(n) ?? state; };
  /** Executes a call against a state copy: approve, depositErc20, depositNative. Returns logs and the mutation. */
  function execute(s: { balances: Map<string, bigint>; allowances: Map<string, bigint>; native: Map<string, bigint> }, from: string, to: string, data: string, value: bigint) {
    const logs: { address: string; topics: string[]; data: string }[] = [];
    const sel = data.slice(0, 10), arg = (i: number) => data.slice(10 + i * 64, 74 + i * 64);
    if (value > 0n && sel !== '0x49290c1c') return { ok: false, logs };
    if (sel === '0x095ea7b3' && options.tokens[to] !== undefined) {
      const spender = '0x' + arg(0).slice(24), amount = BigInt('0x' + arg(1));
      s.allowances.set(`${to}:${from}:${spender}`, amount);
      logs.push({ address: to, topics: [APPROVAL, '0x' + addrWord(from), '0x' + addrWord(spender)], data: '0x' + word(amount) });
      return { ok: true, logs };
    }
    if (to === d.relayDepository && sel === '0xe8017952') {
      if (state.depositRevert) return { ok: false, logs };
      const depositor = '0x' + arg(0).slice(24), token = '0x' + arg(1).slice(24), amount = BigInt('0x' + arg(2)), id = '0x' + arg(3);
      const allowance = s.allowances.get(`${token}:${from}:${d.relayDepository}`) ?? 0n, balance = s.balances.get(key(token, from)) ?? 0n;
      if (allowance < amount || balance < amount || depositor !== from) return { ok: false, logs };
      s.allowances.set(`${token}:${from}:${d.relayDepository}`, allowance - amount);
      s.balances.set(key(token, from), balance - amount);
      s.balances.set(key(token, d.relayDepository), (s.balances.get(key(token, d.relayDepository)) ?? 0n) + amount);
      logs.push({ address: token, topics: [TRANSFER, '0x' + addrWord(from), '0x' + addrWord(d.relayDepository)], data: '0x' + word(amount) });
      logs.push(encodeRelayDepositLog({ kind: 'ERC20', from, token, amount, id }, d.relayDepository) as { address: string; topics: string[]; data: string });
      return { ok: true, logs };
    }
    if (to === d.relayDepository && sel === '0x49290c1c') {
      if (state.depositRevert) return { ok: false, logs };
      const id = '0x' + arg(1), balance = s.native.get(from) ?? 0n;
      if (balance < value) return { ok: false, logs };
      s.native.set(from, balance - value);
      logs.push(encodeRelayDepositLog({ kind: 'NATIVE', from, token: null, amount: value, id }, d.relayDepository) as { address: string; topics: string[]; data: string });
      return { ok: true, logs };
    }
    return { ok: false, logs };
  }
  let txCounter = 0;
  function mine() { snapshot(); state.head += 1; }
  function record(tx: Record<string, unknown>, receipt: Receipt | null) {
    const h = tx.hash as string;
    state.txs.set(h, tx);
    if (receipt) { state.receipts.set(h, receipt); state.blockTxs.set(Number(BigInt(receipt.blockNumber as string)), [...state.blockTxs.get(Number(BigInt(receipt.blockNumber as string))) ?? [], h]); }
  }
  const wallet = {
    /** The owner's wallet signs and sends; `mineNow` false leaves it pending (nonce reserved, no receipt). */
    send(tx: { from: string; to: string; data: string; value: string }, opts: { mineNow?: boolean; hash?: string } = {}) {
      const from = tx.from.toLowerCase(), nonce = state.pending.get(from) ?? state.nonces.get(from) ?? 0;
      const h = opts.hash ?? '0x' + sha(`${d.chain}-tx-${++txCounter}-${from}-${nonce}`);
      state.pending.set(from, nonce + 1);
      const full = { hash: h, from, to: tx.to.toLowerCase(), input: tx.data.toLowerCase(), value: tagN(Number(BigInt(tx.value))), nonce: tagN(nonce), chainId: tagN(d.chainId),
        gas: tagN(500_000), maxFeePerGas: tagN(Number(state.baseFee) * 2), maxPriorityFeePerGas: '0x0', type: '0x2' };
      const land = () => {
        const result = execute(state, from, full.to, full.input, BigInt(tx.value));
        mine();
        state.nonces.set(from, nonce + 1);
        state.native.set(from, (state.native.get(from) ?? 0n) - state.gasUsed * state.baseFee);
        const receipt: Receipt = { transactionHash: h, status: result.ok ? '0x1' : '0x0', blockNumber: tagN(state.head), blockHash: hash(state.head), from, to: full.to,
          gasUsed: tagN(Number(state.gasUsed)), effectiveGasPrice: tagN(Number(state.baseFee)), logs: result.ok ? result.logs.map((l, i) => ({ ...l, logIndex: tagN(i), transactionHash: h })) : [],
          ...d.l1DataFee ? { l1Fee: '0x0' } : {} };
        record({ ...full, blockHash: hash(state.head), blockNumber: tagN(state.head) }, receipt);
        return h;
      };
      if (opts.mineNow === false) { record(full, null); return { hash: h, land }; }
      return { hash: land(), land };
    },
  };
  /** The solver's delivery on this chain (ERC-20 Transfer to the recipient, or a direct native transfer carrying the order id). */
  function deliver(input: { recipient: string; token: string | null; amount: bigint; orderId: string }): string {
    const h = '0x' + sha(`${d.chain}-fill-${++txCounter}`), solver = '0xf70da97812cb96acdf810712aa562db8dfa3dbef';
    mine();
    const logs = input.token ? [{ address: input.token, topics: [TRANSFER, '0x' + addrWord(solver), '0x' + addrWord(input.recipient)], data: '0x' + word(input.amount) }] : [];
    if (input.token) state.balances.set(key(input.token, input.recipient), (state.balances.get(key(input.token, input.recipient)) ?? 0n) + input.amount);
    else state.native.set(input.recipient.toLowerCase(), (state.native.get(input.recipient.toLowerCase()) ?? 0n) + input.amount);
    record({ hash: h, from: solver, to: input.token ? '0x251e4b432d5c69d8f4d3d31aae4ae4f3c4816fc7' : input.recipient, input: input.token ? '0x6bf15957' + input.orderId.slice(2) : input.orderId,
      value: tagN(input.token ? 0 : Number(input.amount)), nonce: '0x1', chainId: tagN(d.chainId), blockHash: hash(state.head), blockNumber: tagN(state.head) },
      { transactionHash: h, status: '0x1', blockNumber: tagN(state.head), blockHash: hash(state.head), from: solver, to: input.recipient, gasUsed: '0x5208', effectiveGasPrice: '0x1',
        logs: logs.map((l, i) => ({ ...l, logIndex: tagN(i), transactionHash: h })) });
    return h;
  }
  const rpc: Rpc = async (method, params) => {
    const p = params as unknown[];
    switch (method) {
      case 'eth_chainId': return tagN(d.chainId);
      case 'eth_blockNumber': return tagN(state.head);
      case 'eth_getBlockByNumber': {
        const t = p[0];
        const n = t === 'latest' || t === 'pending' ? state.head : t === 'safe' || t === 'finalized' ? state.head - state.safeLag : Number(BigInt(String(t)));
        return n > state.head || n < 0 ? null : block(n, p[1] === true);
      }
      case 'eth_getCode': return state.code.get(String(p[0]).toLowerCase()) ?? '0x';
      case 'eth_call': {
        const c = p[0] as { to: string; data: string }, to = c.to.toLowerCase(), s = view(p[1]);
        if (to === '0x420000000000000000000000000000000000000f') return '0x' + word(1_000_000n);
        if (to === '0x00000000000000000000000000000000000000c8') return '0x' + word(20_000n) + word(1n) + word(0n);
        if (options.tokens[to] === undefined) throw new Error('MOCK_CALL_UNSUPPORTED');
        if (c.data === '0x313ce567') return '0x' + word(BigInt(options.tokens[to]!));
        if (c.data.startsWith('0x70a08231')) return '0x' + word(s.balances.get(key(to, '0x' + c.data.slice(34))) ?? 0n);
        if (c.data.startsWith('0xdd62ed3e')) return '0x' + word(state.allowances.get(`${to}:0x${c.data.slice(34, 74)}:0x${c.data.slice(98, 138)}`) ?? 0n);
        throw new Error('MOCK_CALL_UNSUPPORTED');
      }
      case 'eth_getBalance': return tagN(Number(view(p[1]).native.get(String(p[0]).toLowerCase()) ?? 0n));
      case 'eth_getTransactionCount': {
        const owner = String(p[0]).toLowerCase();
        if (p[1] === 'pending') return tagN(state.pending.get(owner) ?? state.nonces.get(owner) ?? 0);
        return tagN(view(p[1]).nonces.get(owner) ?? 0);
      }
      case 'eth_maxPriorityFeePerGas': return '0x1';
      case 'eth_gasPrice': return tagN(Number(state.baseFee));
      case 'eth_estimateGas': return tagN(Number(state.gasUsed));
      case 'eth_simulateV1': {
        if (state.simulateFails) throw new Error('MOCK_SIMULATION_UNAVAILABLE');
        const calls = ((p[0] as { blockStateCalls: { calls: { from: string; to: string; data: string; value: string }[] }[] }).blockStateCalls[0]!.calls);
        const copy = { balances: new Map(state.balances), allowances: new Map(state.allowances), native: new Map(state.native) };
        return [{ calls: calls.map(c => { const r = execute(copy, c.from.toLowerCase(), c.to.toLowerCase(), c.data.toLowerCase(), BigInt(c.value));
          return { status: r.ok ? '0x1' : '0x0', gasUsed: tagN(Number(state.gasUsed)), logs: r.logs }; }) }];
      }
      case 'eth_getTransactionReceipt': return state.receipts.get(String(p[0]).toLowerCase()) ?? null;
      case 'eth_getTransactionByHash': return state.txs.get(String(p[0]).toLowerCase()) ?? null;
      case 'eth_getLogs': {
        const f = p[0] as { address: string; fromBlock: string; toBlock: string };
        const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock)), out: unknown[] = [];
        for (const r of state.receipts.values()) {
          const n = Number(BigInt(r.blockNumber as string));
          if (n < from || n > to) continue;
          for (const l of r.logs as { address: string; topics: string[] }[]) if (l.address === f.address.toLowerCase() && ['0x49fed1d0', '0x80320665'].some(x => l.topics[0]!.startsWith(x)))
            out.push({ ...l, blockNumber: r.blockNumber, transactionHash: r.transactionHash });
        }
        return out;
      }
      default: throw new Error('MOCK_METHOD_UNSUPPORTED ' + method);
    }
  };
  return { state, rpc, wallet, deliver, mine, setToken: (token: string, owner: string, amount: bigint) => state.balances.set(key(token, owner), amount),
    setNative: (owner: string, amount: bigint) => state.native.set(owner.toLowerCase(), amount) };
}

// --- Solana ----------------------------------------------------------------------------------------------------------
const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const tokenAccountData = (mint: string, owner: string, amount: bigint) => {
  const b = Buffer.alloc(165); Buffer.from(base58Decode(mint)).copy(b, 0); Buffer.from(base58Decode(owner)).copy(b, 32); u64(amount).copy(b, 64); b[108] = 1; return b; };
const mintData = (decimals: number) => { const b = Buffer.alloc(82); b[44] = decimals; b[45] = 1; return b; };
export type SolanaMock = ReturnType<typeof createSolanaMock>;
export function createSolanaMock(s: UniversalSolanaDeployment, options: { mints: Record<string, number> }) {
  const state = { slot: 300_000_000, height: 280_000_000, lamports: new Map<string, bigint>(), tokens: new Map<string, { mint: string; owner: string; amount: bigint }>(),
    sent: new Map<string, { bytes: Uint8Array; landed: boolean; slot: number; meta: Record<string, unknown> | null }>(), transactions: new Map<string, Record<string, unknown>>(),
    blockhashCounter: 0, simulateFails: false, dropSends: false };
  const ata = (owner: string, mint: string) => associatedTokenAddress(owner, mint, SOLANA_TOKEN_PROGRAM_ID, SOLANA_ASSOCIATED_TOKEN_PROGRAM_ID);
  const programData = Buffer.concat([Buffer.from([2, 0, 0, 0]), Buffer.from(base58Decode(s.relayProgramData))]);
  const programDataHeader = Buffer.concat([Buffer.from([3, 0, 0, 0]), u64(BigInt(s.relayDeploymentSlot)), Buffer.from([1]), Buffer.from(base58Decode(s.relayUpgradeAuthority))]);
  function account(key: string, view = state): Record<string, unknown> | null {
    if (key === s.relayProgram) return { lamports: 1, owner: BPF_UPGRADEABLE_LOADER, data: [programData.toString('base64'), 'base64'], executable: true };
    if (key === s.relayProgramData) return { lamports: 1, owner: BPF_UPGRADEABLE_LOADER, data: [programDataHeader.toString('base64'), 'base64'], executable: false };
    if (options.mints[key] !== undefined) return { lamports: 1_461_600, owner: SOLANA_TOKEN_PROGRAM_ID, data: [mintData(options.mints[key]!).toString('base64'), 'base64'], executable: false };
    const t = view.tokens.get(key);
    if (t) return { lamports: 2_039_280, owner: SOLANA_TOKEN_PROGRAM_ID, data: [tokenAccountData(t.mint, t.owner, t.amount).toString('base64'), 'base64'], executable: false };
    const l = view.lamports.get(key);
    return l === undefined ? null : { lamports: Number(l), owner: SOLANA_SYSTEM_PROGRAM_ID, data: ['', 'base64'], executable: false };
  }
  /** Applies FloFi's deposit message to a state copy; returns fee and the result. */
  function apply(view: { lamports: Map<string, bigint>; tokens: Map<string, { mint: string; owner: string; amount: bigint }> }, message: Uint8Array) {
    const m = parseMessageV0(message), ixs = decompileMessageV0(m, {}), payer = m.staticKeys[0]!;
    let limit = 200_000, price = 0n;
    for (const ix of ixs) if (ix.programId === 'ComputeBudget111111111111111111111111111111') {
      if (ix.data[0] === 2) limit = Buffer.from(ix.data).readUInt32LE(1); else if (ix.data[0] === 3) price = Buffer.from(ix.data).readBigUInt64LE(1);
    }
    const fee = 5000n + (BigInt(limit) * price + 999_999n) / 1_000_000n;
    view.lamports.set(payer, (view.lamports.get(payer) ?? 0n) - fee);
    const relay = ixs.find(ix => ix.programId === RELAY_SOLANA_DEPOSITORY_PROGRAM);
    if (!relay) return { ok: false, fee, units: 10_000 };
    const data = Buffer.from(relay.data), amount = data.readBigUInt64LE(8), disc = data.subarray(0, 8).toString('hex');
    if (disc === RELAY_SOLANA_DISCRIMINATORS.depositNative) {
      if ((view.lamports.get(payer) ?? 0n) < amount) return { ok: false, fee, units: 12_000 };
      view.lamports.set(payer, (view.lamports.get(payer) ?? 0n) - amount);
      view.lamports.set(RELAY_SOLANA_VAULT, (view.lamports.get(RELAY_SOLANA_VAULT) ?? 0n) + amount);
      return { ok: true, fee, units: 12_000 };
    }
    const mint = relay.accounts[4]!.pubkey, from = relay.accounts[5]!.pubkey, to = relay.accounts[6]!.pubkey, src = view.tokens.get(from);
    if (!src || src.amount < amount) return { ok: false, fee, units: 30_000 };
    view.tokens.set(from, { ...src, amount: src.amount - amount });
    const dst = view.tokens.get(to) ?? { mint, owner: RELAY_SOLANA_VAULT, amount: 0n };
    view.tokens.set(to, { ...dst, amount: dst.amount + amount });
    return { ok: true, fee, units: 30_000 };
  }
  const copy = () => ({ lamports: new Map(state.lamports), tokens: new Map([...state.tokens].map(([k, v]) => [k, { ...v }])) });
  function balancesMeta(keys: string[], before: ReturnType<typeof copy>, after: ReturnType<typeof copy>) {
    const lam = (v: ReturnType<typeof copy>) => keys.map(k => Number(v.lamports.get(k) ?? (v.tokens.has(k) ? 2_039_280n : 0n)));
    const toks = (v: ReturnType<typeof copy>) => keys.flatMap((k, i) => { const t = v.tokens.get(k); return t ? [{ accountIndex: i, mint: t.mint, owner: t.owner,
      uiTokenAmount: { amount: t.amount.toString(), decimals: options.mints[t.mint] ?? 6 }, programId: SOLANA_TOKEN_PROGRAM_ID }] : []; });
    return { preBalances: lam(before), postBalances: lam(after), preTokenBalances: toks(before), postTokenBalances: toks(after) };
  }
  /** The solver's delivery to a Solana recipient (SPL to its ATA, or lamports), finalized; returns the signature. */
  function deliver(input: { recipient: string; mint: string | null; amount: bigint; orderId: string }): string {
    const solver = base58Encode(Uint8Array.from(randomBytes(32))), before = copy();
    if (input.mint) { const a = ata(input.recipient, input.mint), t = state.tokens.get(a) ?? { mint: input.mint, owner: input.recipient, amount: 0n }; state.tokens.set(a, { ...t, amount: t.amount + input.amount }); }
    else state.lamports.set(input.recipient, (state.lamports.get(input.recipient) ?? 0n) + input.amount);
    const keys = [solver, input.mint ? ata(input.recipient, input.mint) : input.recipient, RELAY_SOLANA_DEPOSITORY_PROGRAM];
    const message = serializeMessageV0(compileMessageV0(solver, [{ programId: RELAY_SOLANA_DEPOSITORY_PROGRAM, accounts: [{ pubkey: keys[1]!, isSigner: false, isWritable: true }],
      data: Uint8Array.from(Buffer.from(input.orderId.slice(2), 'hex')) }], base58Encode(Uint8Array.from(randomBytes(32))), {}));
    const sig = Uint8Array.from(randomBytes(64)), signature = base58Encode(sig), bytes = serializeSignedTransaction([sig], message);
    state.slot += 3;
    const m = parseMessageV0(message);
    state.transactions.set(signature, { slot: state.slot, blockTime: Math.floor(Date.now() / 1000), version: 0, transaction: [toBase64(bytes), 'base64'],
      meta: { err: null, fee: 5000, ...balancesMeta(m.staticKeys, before, copy()), loadedAddresses: { writable: [], readonly: [] } } });
    return signature;
  }
  /** Lands a sent transaction (finalized). */
  function land(signature: string) {
    const sent = state.sent.get(signature);
    if (!sent || sent.landed) return;
    const { message } = parseTransaction(sent.bytes), m = parseMessageV0(message), before = copy();
    const result = apply(state, message);
    state.slot += 2; state.height += 2;
    sent.landed = true; sent.slot = state.slot;
    state.transactions.set(signature, { slot: state.slot, blockTime: Math.floor(Date.now() / 1000), version: 0, transaction: [toBase64(sent.bytes), 'base64'],
      meta: { err: result.ok ? null : { InstructionError: [2, 'Custom'] }, fee: Number(result.fee), ...balancesMeta(m.staticKeys, before, copy()), loadedAddresses: { writable: [], readonly: [] } } });
  }
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const p = params as unknown[];
    switch (method) {
      case 'getGenesisHash': return s.genesisHash;
      case 'getSlot': return state.slot;
      case 'getBlockHeight': return state.height;
      case 'getMultipleAccounts': return { context: { slot: state.slot }, value: (p[0] as string[]).map(k => account(k)) };
      case 'getLatestBlockhash': return { context: { slot: state.slot }, value: { blockhash: base58Encode(Uint8Array.from(createHash('sha256').update('bh' + ++state.blockhashCounter).digest())),
        lastValidBlockHeight: state.height + 150 } };
      case 'simulateTransaction': {
        if (state.simulateFails) throw new Error('MOCK_SIMULATION_UNAVAILABLE');
        const bytes = fromBase64(p[0], 4096), { message } = parseTransaction(bytes), view = copy(), r = apply(view, message);
        const addrs = ((p[1] as { accounts: { addresses: string[] } }).accounts.addresses);
        return { context: { slot: state.slot }, value: { err: r.ok ? null : { InstructionError: [2, 'Custom'] }, logs: ['Program log: mock'], unitsConsumed: r.units,
          accounts: addrs.map(a => account(a, view as typeof state)) } };
      }
      case 'sendTransaction': {
        const bytes = fromBase64(p[0], 4096), { signatures } = parseTransaction(bytes), signature = base58Encode(signatures[0]!);
        if (state.dropSends) throw new Error('MOCK_SEND_FAILED');
        state.sent.set(signature, { bytes, landed: false, slot: 0, meta: null });
        return signature;
      }
      case 'getSignatureStatuses': {
        const sig = (p[0] as string[])[0]!, t = state.transactions.get(sig);
        return { context: { slot: state.slot }, value: [t ? { slot: t.slot, confirmations: null, err: (t.meta as { err: unknown }).err, confirmationStatus: 'finalized' } : null] };
      }
      case 'getTransaction': return state.transactions.get(String(p[0])) ?? null;
      default: throw new Error('MOCK_METHOD_UNSUPPORTED ' + method);
    }
  };
  return { state, rpc, ata, land, deliver, setLamports: (k: string, v: bigint) => state.lamports.set(k, v),
    setToken: (owner: string, mint: string, amount: bigint) => state.tokens.set(ata(owner, mint), { mint, owner, amount }) };
}
/** An in-memory owner key that signs exactly the message it is given (the test plays the Solana wallet). */
export function solanaTestWallet() {
  const pair = generateKeyPairSync('ed25519'), publicKey = base58Encode(Uint8Array.from(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12)));
  return { publicKey, sign(unsignedBase64: string, mutate?: (message: Uint8Array) => Uint8Array): string {
    const { message } = parseTransaction(fromBase64(unsignedBase64, 4096)), signed = mutate ? mutate(message) : message;
    return toBase64(serializeSignedTransaction([Uint8Array.from(signBytes(null, signed, pair.privateKey))], signed));
  } };
}

// --- Relay API -------------------------------------------------------------------------------------------------------
const SLUG = (n: UniversalNetwork) => n.providers.relay.slug;
const NATIVE = (n: UniversalNetwork) => n.ecosystem === 'EVM' ? '0x0000000000000000000000000000000000000000' : '11111111111111111111111111111111';
export type RelayMock = ReturnType<typeof createRelayMock>;
/**
 * Quotes priced by `rate` (output units per input unit, scaled 1e18) minus a relayer fee in input units; orders hashed for real.
 * `tamper` lets a test corrupt a response before the adapter sees it.
 */
export function createRelayMock(options: { now: () => number; feeUnits?: bigint; rate?: (input: string, output: string) => bigint;
  decimals: (chainId: number, currency: string) => number; symbol?: (chainId: number, currency: string) => string }) {
  const status = new Map<string, Record<string, unknown>>(), quotes: Record<string, unknown>[] = [];
  let tamper: ((raw: Record<string, any>) => void) | null = null, refuse: string | null = null, expectedFactor = 10_000n; // eslint-disable-line @typescript-eslint/no-explicit-any
  const network = (chainId: number) => Object.values(UNIVERSAL_NETWORKS).find(n => n.providers.relay.chainId === chainId)!;
  function quote(body: Record<string, any>): Record<string, unknown> { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (refuse) return { __httpStatus: 400, __body: { message: refuse } };
    const S = network(body.originChainId), Dn = network(body.destinationChainId), amount = BigInt(body.amount), slip = BigInt(body.slippageTolerance);
    const inDec = options.decimals(body.originChainId, body.originCurrency), outDec = options.decimals(body.destinationChainId, body.destinationCurrency);
    const fee = options.feeUnits ?? amount / 1000n, net = amount - fee;
    const rate = options.rate?.(body.originCurrency, body.destinationCurrency) ?? 10n ** 18n;
    const expected = net * rate * 10n ** BigInt(outDec) / 10n ** BigInt(inDec) / 10n ** 18n * expectedFactor / 10_000n;
    const minimum = expected * (10_000n - slip) / 10_000n, deadline = Math.floor(options.now() / 1000) + 7 * 86_400;
    const orderData: RelayOrderData = { version: 'v1', solverChainId: 'base', solver: '0xf70da97812cb96acdf810712aa562db8dfa3dbef', salt: '0x' + randomBytes(32).toString('hex'),
      inputs: [{ payment: { chainId: SLUG(S), currency: body.originCurrency, amount: body.amount, weight: '1' },
        refunds: [{ chainId: SLUG(S), recipient: body.user, currency: body.originCurrency, minimumAmount: '0', deadline, extraData: '0x' }] }],
      output: { chainId: SLUG(Dn), payments: [{ recipient: body.recipient, currency: body.destinationCurrency, minimumAmount: minimum.toString(), expectedAmount: expected.toString() }],
        calls: [], deadline, extraData: '0x' }, fees: [] };
    const orderId = relayOrderId(orderData, slug => slug === 'solana' ? 'solana-vm' : 'ethereum-vm');
    const requestId = '0x' + randomBytes(32).toString('hex');
    const native = body.originCurrency === NATIVE(S);
    let steps: unknown[];
    if (S.ecosystem === 'EVM') {
      const user = String(body.user).toLowerCase();
      const deposit = { id: 'deposit', kind: 'transaction', items: [{ status: 'incomplete', data: { from: user, to: RELAY_EVM_DEPOSITORY, chainId: S.evmChainId,
        data: native ? encodeRelayDepositNative(user, orderId) : encodeRelayDepositErc20(user, body.originCurrency, amount, orderId), value: native ? body.amount : '0' } }], requestId };
      steps = native ? [deposit] : [{ id: 'approve', kind: 'transaction', items: [{ status: 'incomplete', data: { from: user, to: body.originCurrency, chainId: S.evmChainId,
        data: encodeErc20ApproveExact(RELAY_EVM_DEPOSITORY, amount), value: '0' } }], requestId }, deposit];
    } else {
      const ix = relaySolanaDepositInstruction({ owner: body.user, mint: native ? null : body.originCurrency, tokenProgram: native ? null : SOLANA_TOKEN_PROGRAM_ID, amount, orderId });
      steps = [{ id: 'deposit', kind: 'transaction', items: [{ status: 'incomplete', data: { instructions: [{ keys: ix.accounts, programId: ix.programId,
        data: Buffer.from(ix.data).toString('hex') }], addressLookupTableAddresses: [] } }], requestId }];
    }
    const cur = (chainId: number, address: string, decimals: number) => ({ chainId, address, symbol: options.symbol?.(chainId, address) ?? 'TKN', name: 'Token', decimals, metadata: { verified: true } });
    const raw: Record<string, any> = { requestId, steps, // eslint-disable-line @typescript-eslint/no-explicit-any
      fees: { gas: { currency: cur(body.originChainId, NATIVE(S), S.native.decimals), amount: '30000', minimumAmount: '30000' },
        relayerService: { currency: cur(body.originChainId, body.originCurrency, inDec), amount: (fee / 2n).toString() },
        relayerGas: { currency: cur(body.originChainId, body.originCurrency, inDec), amount: (fee - fee / 2n).toString() },
        app: { currency: cur(body.originChainId, body.originCurrency, inDec), amount: '0' } },
      details: { operation: 'swap', sender: body.user, recipient: body.recipient, currencyIn: { currency: cur(body.originChainId, body.originCurrency, inDec), amount: body.amount },
        currencyOut: { currency: cur(body.destinationChainId, body.destinationCurrency, outDec), amount: expected.toString(), minimumAmount: minimum.toString() }, timeEstimate: 5 },
      protocol: { v2: { orderId, orderData, paymentDetails: { chainId: SLUG(S), depository: S.ecosystem === 'EVM' ? RELAY_EVM_DEPOSITORY : RELAY_SOLANA_DEPOSITORY_PROGRAM,
        currency: body.originCurrency, amount: body.amount } } } };
    tamper?.(raw);
    quotes.push(raw);
    status.set(requestId, { status: 'waiting' });
    return raw;
  }
  const http: UniversalHttp = {
    post: async (url, body) => { if (!url.endsWith('/quote/v2')) throw new Error('MOCK_URL'); return quote(body as Record<string, unknown>); },
    get: async url => { const id = new URL(url).searchParams.get('requestId')!; return status.get(id) ?? { __httpStatus: 404, __body: {} }; },
  };
  return { http, quotes, setStatus: (requestId: string, value: Record<string, unknown>) => status.set(requestId, value),
    setTamper: (f: typeof tamper) => { tamper = f; }, setRefusal: (message: string | null) => { refuse = message; },
    /** Scales the next quotes' expected output (basis points of the normal rate), e.g. to make a re-quote worse than the reviewed minimum. */
    setExpectedFactor: (bps: bigint) => { expectedFactor = bps; } };
}
export const networkKey = (key: UniversalNetworkKey) => UNIVERSAL_NETWORKS[key];
