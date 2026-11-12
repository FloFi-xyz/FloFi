// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-WORKFLOW-002: the owner's ERC-4337 user operation (prepare → the owner's own signature → bundler simulation and
 * relay → reconciliation from the bundle receipt), Solana group submission order and owner-delta reconciliation, and gas isolation at volume.
 * Loopback fakes only (no network): what is proven is FloFi's logic, never a public execution.
 */
import { describe, expect, it } from 'vitest';
import { erc4337 } from '@defi-workflow-engine/reference-compiler';
import { requirementOf, type WorkflowRequirement } from '../delegation/steps.ts';
import { composeWorkflow, type WorkflowComposition } from '../engine/strategy-engine';
import { evmWallet } from '../delegation/delegation.test-harness.ts';
import type { ChainTransport } from '../delegation/chains.ts';
import { bundlerRefusal, type BundlerClient } from './bundler.ts';
import { advanceSolanaSubmission, authorizeGroup, checkUserOperation, opOf, prepareGroup, reconcileEvmGroup, reconcileSolanaGroup, relayUserOperation, solanaOwnerDeltas,
  SOLANA_BLOCKS_PER_GROUP_TRANSACTION, SOLANA_GROUP_SEND_BUDGET_MAX_BLOCKS, solanaPreparedTtlMs, solanaSendBudget, solanaSendBudgetBlocks, type Prepared, type SerialOp,
  type UserFundedDeps, USER_OPERATION_LOG_SCAN_BLOCKS, USER_OPERATION_LOG_SCAN_REQUESTS } from './groups.ts';
import { assertUserFundedSubmission, GAS_PAYER_CODES } from './gas-payer.ts';
import { TRANSFER_TOPIC } from './evm-reconcile.ts';
import type { EvmGroupCalls } from './evm-calls.ts';

const BASE = 'eip155:8453', SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const word = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
const topic = (a: string) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
function compose(input: unknown): { composition: WorkflowComposition; requirement: WorkflowRequirement } {
  const c = composeWorkflow(input);
  if (!c.ok) throw new Error(c.code);
  const r = requirementOf(c);
  if (!r.ok) throw new Error(r.code);
  return { composition: c, requirement: r.value };
}
/**
 * A loopback Base RPC: an upgraded owner account (the MetaMask 7702 delegator), EntryPoint nonce 0, fees, a balance, and stored receipts. USDC has
 * code and answers its catalog decimals (6): a batched ERC-20 transfer's token is verified on chain before anything is built.
 */
function chain(owner: string, balance: bigint, receipts: Map<string, unknown>, upgraded = true, usdcCode = '0x6080'): ChainTransport {
  return { chain: BASE, provenance: 'MOCKED', rpc: async (method, params) => {
    switch (method) {
      case 'eth_getCode': return String(params[0]).toLowerCase() === USDC ? usdcCode
        : upgraded && String(params[0]).toLowerCase() === owner ? '0xef0100' + erc4337.DELEGATOR_IMPLEMENTATION.slice(2) : '0x';
      case 'eth_call': {
        const call = params[0] as { to: string; data: string };
        // The EntryPoint answers getNonce as v0.7 does: `key << 64 | sequence` (this owner has used no nonce of any key yet).
        if (call.to.toLowerCase() === erc4337.ENTRY_POINT_V0_7.toLowerCase() && call.data.startsWith('0x35567e1a')) return word(BigInt('0x' + call.data.slice(-64)) << 64n);
        return call.to.toLowerCase() === USDC && call.data === '0x313ce567' ? word(6n) : word(0n);
      }
      case 'eth_maxPriorityFeePerGas': return '0x5f5e100';
      case 'eth_gasPrice': return '0x3b9aca00';
      case 'eth_getBalance': return '0x' + balance.toString(16);
      case 'eth_estimateGas': return '0x186a0';
      case 'eth_getTransactionReceipt': return receipts.get(String(params[0])) ?? null;
      default: throw new Error(`UNEXPECTED_${method}`);
    }
  } };
}
function bundler(sent: erc4337.PackedUserOperation[], receipt: () => erc4337.BundlerReceipt | null, opts: { need?: bigint; known?: () => boolean } = {}): BundlerClient {
  return { chainId: 8453, verify: async () => undefined,
    estimate: async () => ({ verificationGasLimit: 100_000n, callGasLimit: opts.need ?? 200_000n, preVerificationGas: 60_000n }),
    send: async op => { erc4337.assertUserFundedOperation(op); sent.push(op); return erc4337.userOpHash(op, 8453); },
    receipt: async () => receipt(), known: async () => opts.known?.() ?? true };
}
const TWO_TRANSFERS = { version: 2, steps: [
  { action: 'transfer', network: 'base', asset: 'USDC', amount: '1', recipient: '0x' + '2'.repeat(40) },
  { action: 'transfer', network: 'base', asset: 'USDC', amount: '2', recipient: '0x' + '3'.repeat(40) }] };

describe('BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 owner user operation (ERC-4337 v0.7, no paymaster)', () => {
  it('prepares the owner\'s own operation, accepts only the owner\'s signature, relays it after simulation and reconciles the owner-paid gas', async () => {
    const owner = await evmWallet(), address = owner.address.toLowerCase();
    const receipts = new Map<string, unknown>(), sent: erc4337.PackedUserOperation[] = [];
    let bundled: erc4337.BundlerReceipt | null = null;
    const deps: UserFundedDeps = { chains: [BASE], evm: () => chain(address, 10n ** 18n, receipts), bundler: () => bundler(sent, () => bundled), solana: null, jupiter: null,
      now: () => new Date('2026-11-07T10:00:00Z') };
    const { composition, requirement } = compose(TWO_TRANSFERS);
    const g = { runId: 'wfr_' + 'a'.repeat(26), groupIndex: 1, strategy: 'EVM_USER_OPERATION' as const, chain: BASE, feePayer: address, stepFrom: 0, stepTo: 1 };
    const prepared = await prepareGroup(deps, composition, requirement, g);
    if (!prepared.ok) throw new Error(prepared.code);
    const p = prepared.value.prepared as Prepared & { op: SerialOp; typedData: { domain: { verifyingContract: string; chainId: number } }; userOpHash: string;
      fee: { payer: string; maxCost: string } };
    // The owner's own account, no factory, no paymaster; the EIP-712 domain is the owner's own 7702 account on Base.
    expect(p.op.sender).toBe(address);
    // Exactly the two transfers: a user operation is bounded otherwise (its signed fee words, relayed when due), never by a wallet batch's guard.
    expect((p as unknown as { group: EvmGroupCalls }).group.calls.map(c => c.kind)).toEqual(['ERC20_TRANSFER', 'ERC20_TRANSFER']);
    expect(p.typedData.domain).toMatchObject({ verifyingContract: address, chainId: 8453 });
    expect(p.fee.payer).toBe(address);
    const op = opOf(p.op);
    expect(op.paymasterAndData).toBe('0x');
    expect(erc4337.userOpNonceParts(op.nonce).key).toBe(erc4337.nonceKeyOf(`${g.runId}:g1`));
    // Final review: the sequence is read out of the EntryPoint's `key << 64 | sequence` answer (never the whole word, which no nonce can hold).
    expect(erc4337.userOpNonceParts(op.nonce).sequence).toBe(0n);
    expect(BigInt(p.fee.maxCost)).toBe(erc4337.maxPrefund(erc4337.userOperationGas(op)));
    // Only the owner's signature of exactly this operation is accepted.
    const signature = await owner.signDigest(erc4337.delegatorUserOpDigest(8453, op));
    const authorization = authorizeGroup(p, { kind: 'EVM_USER_OPERATION', signature }, address, deps.now());
    if (!authorization.ok) throw new Error(authorization.code);
    // The due-time check simulates and returns the submission record (FloFi's own hash) WITHOUT relaying: the record is written first, then
    // only the writer relays — exactly once, unchanged, with the owner's signature.
    const submitted = await checkUserOperation(deps, p, authorization.value, address);
    if (!submitted.ok) throw new Error(submitted.code);
    expect(sent).toHaveLength(0);
    expect(await relayUserOperation(deps, p, authorization.value)).toEqual({ ok: true, value: p.userOpHash });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sender: address, paymasterAndData: '0x', initCode: '0x', signature: signature.toLowerCase() });
    expect(submitted.value.userOpHash).toBe(p.userOpHash);
    // Not mined yet: pending.
    expect(await reconcileEvmGroup(deps, p, submitted.value)).toEqual({ status: 'PENDING' });
    // The bundle receipt: one UserOperationEvent (sender = owner, paymaster = 0, success), the two owner transfers.
    const txHash = '0x' + 'cd'.repeat(32);
    const event = { address: erc4337.ENTRY_POINT_V0_7, topics: [erc4337.USER_OPERATION_EVENT_TOPIC, p.userOpHash, topic(address), topic('0x' + '0'.repeat(40))],
      data: '0x' + [0n, 1n, 123_456_789n, 98_765n].map(v => v.toString(16).padStart(64, '0')).join('') };
    const transfer = (to: string, amount: bigint) => ({ address: USDC, topics: [TRANSFER_TOPIC, topic(address), topic(to)], data: word(amount) });
    receipts.set(txHash, { transactionHash: txHash, status: '0x1', from: '0x' + '9'.repeat(40), blockNumber: '0x10',
      logs: [transfer('0x' + '2'.repeat(40), 1_000_000n), transfer('0x' + '3'.repeat(40), 2_000_000n), event] });
    bundled = { userOpHash: p.userOpHash, sender: address, nonce: op.nonce, success: true, actualGasCost: 123_456_789n, actualGasUsed: 98_765n, transactionHash: txHash,
      blockNumber: 16n, logs: [], reason: null };
    const reconciled = await reconcileEvmGroup(deps, p, submitted.value);
    // The bundler that sent the transaction is not the payer: the EntryPoint charged the owner's account (actualGasCost).
    expect(reconciled).toMatchObject({ status: 'RECONCILED', gasPaid: { payer: address, amount: '123456789', unit: 'wei', source: 'USER_OPERATION_EVENT' },
      steps: [{ stepIndex: 0, spent: [{ amount: '1000000' }] }, { stepIndex: 1, spent: [{ amount: '2000000' }] }] });
  });

  it('refuses a sponsored or foreign operation on the chain, another signer, and an owner who cannot pay the fee ceiling', async () => {
    const owner = await evmWallet(), stranger = await evmWallet(), address = owner.address.toLowerCase();
    const receipts = new Map<string, unknown>();
    let bundled: erc4337.BundlerReceipt | null = null;
    const deps = (balance: bigint): UserFundedDeps => ({ chains: [BASE], evm: () => chain(address, balance, receipts), bundler: () => bundler([], () => bundled), solana: null,
      jupiter: null, now: () => new Date('2026-11-07T10:00:00Z') });
    const { composition, requirement } = compose(TWO_TRANSFERS);
    const g = { runId: 'wfr_' + 'b'.repeat(26), groupIndex: 0, strategy: 'EVM_USER_OPERATION' as const, chain: BASE, feePayer: address, stepFrom: 0, stepTo: 1 };
    const short = await prepareGroup(deps(1n), composition, requirement, g);
    expect(short).toMatchObject({ ok: false, code: 'USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE' });
    // P0 approved UX (board 07): the refusal carries the numbers this preparation already read (balance) and computed (fee ceiling + native value),
    // so the blocker screen states them; nothing else is read for it.
    if (short.ok || !short.evidence) throw new Error('EVIDENCE_EXPECTED');
    const e = short.evidence;
    expect(e).toMatchObject({ kind: 'NATIVE_FEE_SHORTFALL', chainId: BASE, owner: address, unit: 'wei', balance: '1', nativeSpend: '0' });
    expect(BigInt(e.required)).toBe(BigInt(e.maxFee) + BigInt(e.nativeSpend));
    expect(BigInt(e.shortfall)).toBe(BigInt(e.required) - 1n); expect(BigInt(e.maxFee) > 1n).toBe(true);
    const prepared = await prepareGroup(deps(10n ** 18n), composition, requirement, g);
    if (!prepared.ok) throw new Error(prepared.code);
    const p = prepared.value.prepared as Prepared & { op: SerialOp; userOpHash: string };
    const digest = erc4337.delegatorUserOpDigest(8453, opOf(p.op));
    expect(authorizeGroup(p, { kind: 'EVM_USER_OPERATION', signature: await stranger.signDigest(digest) }, address, new Date())).toMatchObject({ ok: false,
      code: 'USER_OPERATION_SIGNER_MISMATCH' });
    expect(authorizeGroup(p, { kind: 'EVM_WALLET_BATCH', batchId: 'x' }, address, new Date())).toMatchObject({ ok: false, code: 'USER_FUNDED_AUTHORIZATION_KIND_MISMATCH' });
    const txHash = '0x' + 'ee'.repeat(32);
    const eventWith = (sender: string, paymaster: string) => ({ address: erc4337.ENTRY_POINT_V0_7, topics: [erc4337.USER_OPERATION_EVENT_TOPIC, p.userOpHash, topic(sender), topic(paymaster)],
      data: '0x' + [0n, 1n, 1n, 1n].map(v => v.toString(16).padStart(64, '0')).join('') });
    bundled = { userOpHash: p.userOpHash, sender: address, nonce: 0n, success: true, actualGasCost: 1n, actualGasUsed: 1n, transactionHash: txHash, blockNumber: 1n, logs: [], reason: null };
    receipts.set(txHash, { transactionHash: txHash, status: '0x1', logs: [eventWith(address, '0x' + '5'.repeat(40))] });
    // Executed (not reverted) yet not what the owner signed: UNMATCHED (funds may have moved; the run needs attention), never FAILED.
    expect(await reconcileEvmGroup(deps(10n ** 18n), p, { userOpHash: p.userOpHash })).toMatchObject({ status: 'UNMATCHED', code: 'GAS_SPONSORSHIP_REFUSED' });
    receipts.set(txHash, { transactionHash: txHash, status: '0x1', logs: [eventWith(stranger.address.toLowerCase(), '0x' + '0'.repeat(40))] });
    expect(await reconcileEvmGroup(deps(10n ** 18n), p, { userOpHash: p.userOpHash })).toMatchObject({ status: 'UNMATCHED', code: 'GAS_PAYER_NOT_OWNER' });
  });

  it('never prepares an operation for a plain account, refuses one whose signed gas words are too low, and resends a recorded one the bundler lost', async () => {
    const owner = await evmWallet(), address = owner.address.toLowerCase(), receipts = new Map<string, unknown>(), sent: erc4337.PackedUserOperation[] = [];
    let need = 200_000n, known = true;
    const deps = (upgraded = true): UserFundedDeps => ({ chains: [BASE], evm: () => chain(address, 10n ** 18n, receipts, upgraded),
      bundler: () => bundler(sent, () => null, { need, known: () => known }), solana: null, jupiter: null, now: () => new Date('2026-11-07T10:00:00Z') });
    const { composition, requirement } = compose(TWO_TRANSFERS);
    const g = { runId: 'wfr_' + 'c'.repeat(26), groupIndex: 1, strategy: 'EVM_USER_OPERATION' as const, chain: BASE, feePayer: address, stepFrom: 0, stepTo: 1 };
    // A typed-data signature cannot upgrade an account: a plain account never gets an operation to sign.
    expect(await prepareGroup(deps(false), composition, requirement, g)).toMatchObject({ ok: false, code: 'EVM_SMART_ACCOUNT_REQUIRED' });
    // The transferred token is verified on chain before any operation is built, as in a wallet batch: no code at its catalog address refuses.
    const noCode: UserFundedDeps = { ...deps(), evm: () => chain(address, 10n ** 18n, receipts, true, '0x') };
    expect(await prepareGroup(noCode, composition, requirement, g)).toMatchObject({ ok: false, code: 'CONTRACT_CODE_MISSING', stepIndex: 0 });
    const prepared = await prepareGroup(deps(), composition, requirement, g);
    if (!prepared.ok) throw new Error(prepared.code);
    const p = prepared.value.prepared as Prepared & { op: SerialOp; userOpHash: string };
    const signature = await owner.signDigest(erc4337.delegatorUserOpDigest(8453, opOf(p.op)));
    const authorization = authorizeGroup(p, { kind: 'EVM_USER_OPERATION', signature }, address, new Date());
    if (!authorization.ok) throw new Error(authorization.code);
    // When due, the bundler needs more call gas than the owner signed: refused before anything is relayed (the words cannot change unsigned).
    need = 10n ** 9n;
    expect(await checkUserOperation(deps(), p, authorization.value, address)).toMatchObject({ ok: false, code: 'USER_OPERATION_GAS_LIMIT_TOO_LOW' });
    expect(sent).toHaveLength(0);
    // Recorded, then the relay was lost: neither the chain nor the bundler knows it, so reconciliation relays the SAME signed operation.
    need = 200_000n; known = false;
    const record = await checkUserOperation(deps(), p, authorization.value, address);
    if (!record.ok) throw new Error(record.code);
    expect(await reconcileEvmGroup(deps(), p, record.value, authorization.value)).toEqual({ status: 'PENDING' });
    expect(sent).toHaveLength(1);
    expect(erc4337.userOpHash(sent[0]!, 8453)).toBe(p.userOpHash);
    // Known to the bundler: nothing is resent.
    known = true;
    expect(await reconcileEvmGroup(deps(), p, record.value, authorization.value)).toEqual({ status: 'PENDING' });
    expect(sent).toHaveLength(1);
  });
});

/**
 * A recorded (authorized, simulated) owner operation that the bundler neither has a receipt for nor knows, on a loopback chain whose EntryPoint
 * answers `getNonce` as v0.7 does (`key << 64 | sequence`) and serves `eth_getLogs` over the blocks it holds. `refusal`: what the bundler answers a
 * resend (null: accepted); `onSend`: what happens on the chain while a resend reaches the bundler.
 */
async function lostOperation(runId: string) {
  const owner = await evmWallet(), address = owner.address.toLowerCase(), receipts = new Map<string, unknown>(), sent: erc4337.PackedUserOperation[] = [];
  const state: { sequence: bigint | Error; head: bigint; logs: { blockNumber: bigint; log: Record<string, unknown> }[]; getLogs: Error | null; refusal: string | null;
    nonceReads: number; ranges: [bigint, bigint][]; onSend: (() => void) | null } = { sequence: 0n, head: 1_000_000n, logs: [], getLogs: null, refusal: null, nonceReads: 0,
    ranges: [], onSend: null };
  const plain = chain(address, 10n ** 18n, receipts);
  let key = 0n;
  const transport: ChainTransport = { chain: BASE, provenance: 'MOCKED', rpc: async (method, params) => {
    const call = params[0] as { to?: string; data?: string; address?: string; topics?: string[]; fromBlock?: string; toBlock?: string };
    if (method === 'eth_call' && call.to === erc4337.ENTRY_POINT_V0_7 && key !== 0n) {
      state.nonceReads++;
      expect(call.data).toBe(erc4337.getNonceCall(address, key));
      if (state.sequence instanceof Error) throw state.sequence;
      return word(key << 64n | state.sequence);
    }
    if (method === 'eth_blockNumber') return '0x' + state.head.toString(16);
    if (method === 'eth_getLogs') {
      if (state.getLogs) throw state.getLogs;
      expect([call.address, call.topics]).toEqual([erc4337.ENTRY_POINT_V0_7, [erc4337.USER_OPERATION_EVENT_TOPIC, p.userOpHash]]);
      const from = BigInt(call.fromBlock!), to = BigInt(call.toBlock!);
      state.ranges.push([from, to]);
      return state.logs.filter(l => l.blockNumber >= from && l.blockNumber <= to).map(l => l.log);
    }
    return plain.rpc(method, params);
  } };
  const lostBundler: BundlerClient = { chainId: 8453, verify: async () => undefined,
    estimate: async () => ({ verificationGasLimit: 100_000n, callGasLimit: 200_000n, preVerificationGas: 60_000n }),
    send: async op => { sent.push(op); state.onSend?.(); if (state.refusal) throw bundlerRefusal(state.refusal); return erc4337.userOpHash(op, 8453); },
    receipt: async () => null, known: async () => false };
  const deps: UserFundedDeps = { chains: [BASE], evm: () => transport, bundler: () => lostBundler, solana: null, jupiter: null, now: () => new Date('2026-11-07T10:00:00Z') };
  const { composition, requirement } = compose(TWO_TRANSFERS);
  const prepared = await prepareGroup(deps, composition, requirement, { runId, groupIndex: 0, strategy: 'EVM_USER_OPERATION', chain: BASE, feePayer: address, stepFrom: 0, stepTo: 1 });
  if (!prepared.ok) throw new Error(prepared.code);
  const p = prepared.value.prepared as Prepared & { op: SerialOp; userOpHash: string };
  key = erc4337.userOpNonceParts(BigInt(p.op.nonce)).key;
  const signature = await owner.signDigest(erc4337.delegatorUserOpDigest(8453, opOf(p.op)));
  const authorization = authorizeGroup(p, { kind: 'EVM_USER_OPERATION', signature }, address, new Date());
  if (!authorization.ok) throw new Error(authorization.code);
  const record = await checkUserOperation(deps, p, authorization.value, address);
  if (!record.ok) throw new Error(record.code);
  /** The bundle transaction of the operation at `blockNumber`: its UserOperationEvent (owner, no paymaster, success) and the two owner transfers. */
  const mine = (blockNumber: bigint, txHash = '0x' + 'ab'.repeat(32)) => {
    const event = { address: erc4337.ENTRY_POINT_V0_7, topics: [erc4337.USER_OPERATION_EVENT_TOPIC, p.userOpHash, topic(address), topic('0x' + '0'.repeat(40))],
      data: '0x' + [0n, 1n, 4_242n, 98_765n].map(v => v.toString(16).padStart(64, '0')).join('') };
    const transfer = (to: string, amount: bigint) => ({ address: USDC, topics: [TRANSFER_TOPIC, topic(address), topic(to)], data: word(amount) });
    receipts.set(txHash, { transactionHash: txHash, status: '0x1', from: '0x' + '9'.repeat(40), blockNumber: '0x' + blockNumber.toString(16),
      logs: [transfer('0x' + '2'.repeat(40), 1_000_000n), transfer('0x' + '3'.repeat(40), 2_000_000n), event] });
    state.logs.push({ blockNumber, log: { ...event, blockNumber: '0x' + blockNumber.toString(16), transactionHash: txHash, removed: false } });
    state.sequence = 1n;
    return txHash;
  };
  const reconcile = (prep: Prepared = p) => reconcileEvmGroup(deps, prep, record.value, authorization.value);
  return { address, p, state, sent, mine, reconcile };
}

describe('P1 review fix: a user operation the bundler forgot is decided by the chain (EntryPoint nonce, its own event), never by the bundler alone', () => {
  it('mined and forgotten (nonce consumed): reconciled from its own UserOperationEvent found on the chain, never resent', async () => {
    const o = await lostOperation('wfr_' + 'l'.repeat(26));
    // Mined 5,000 blocks ago and forgotten; the owner then spent the ETH, so a resend would be refused AA21 (the red-team case).
    const txHash = o.mine(o.state.head - 5_000n);
    o.state.refusal = 'AA21 didn\'t pay prefund';
    const r = await o.reconcile();
    expect(r).toMatchObject({ status: 'RECONCILED', transactions: [txHash], gasPaid: { payer: o.address, amount: '4242', unit: 'wei', source: 'USER_OPERATION_EVENT' },
      steps: [{ stepIndex: 0, spent: [{ amount: '1000000' }] }, { stepIndex: 1, spent: [{ amount: '2000000' }] }] });
    expect(o.sent).toHaveLength(0);
    // Searched newest first, in contiguous ranges of the bounded size, until the event.
    expect(o.state.ranges).toEqual([[o.state.head - 1_999n, o.state.head], [o.state.head - 3_999n, o.state.head - 2_000n], [o.state.head - 5_999n, o.state.head - 4_000n]]);
    expect(USER_OPERATION_LOG_SCAN_BLOCKS).toBe(2_000n);
  });

  it('nonce consumed without its event (a revocation, or a range that cannot be searched): UNMATCHED, never resent, never FAILED', async () => {
    const o = await lostOperation('wfr_' + 'm'.repeat(26));
    o.state.sequence = 1n;
    o.state.refusal = 'AA25 invalid account nonce';
    const unmatched = { status: 'UNMATCHED', code: 'USER_OPERATION_NONCE_CONSUMED_UNRECONCILED', gasPaid: null, transactions: [] };
    expect(await o.reconcile()).toEqual(unmatched);
    expect(o.sent).toHaveLength(0);
    // The search is bounded: at most USER_OPERATION_LOG_SCAN_REQUESTS ranges back from the head ...
    expect(o.state.ranges).toHaveLength(USER_OPERATION_LOG_SCAN_REQUESTS);
    expect(o.state.ranges.at(-1)).toEqual([o.state.head - USER_OPERATION_LOG_SCAN_BLOCKS * BigInt(USER_OPERATION_LOG_SCAN_REQUESTS) + 1n,
      o.state.head - USER_OPERATION_LOG_SCAN_BLOCKS * BigInt(USER_OPERATION_LOG_SCAN_REQUESTS - 1)]);
    // ... and never below the preparation's block when the artifact records one.
    o.state.ranges.length = 0;
    expect(await o.reconcile({ ...o.p, fromBlock: (o.state.head - 2_500n).toString() })).toEqual(unmatched);
    expect(o.state.ranges).toEqual([[o.state.head - 1_999n, o.state.head], [o.state.head - 2_500n, o.state.head - 2_000n]]);
    // A transport or provider that refuses the search (eth_getLogs outside its allowlist, a range above its cap) cannot prove anything: UNMATCHED.
    for (const refusal of ['DELEGATION_RPC_METHOD_FORBIDDEN', 'query exceeds max block range 1000']) {
      o.state.getLogs = new Error(refusal);
      expect(await o.reconcile()).toEqual(unmatched);
    }
    // An unreachable chain decides nothing.
    o.state.getLogs = new Error('DELEGATION_RPC_UNAVAILABLE');
    expect(await o.reconcile()).toEqual({ status: 'PENDING' });
    expect(o.sent).toHaveLength(0);
  });

  it('nonce unconsumed: the same signed bytes are resent; a refusal FAILS only while the nonce is still unconsumed after it, AA25 stays pending', async () => {
    const o = await lostOperation('wfr_' + 'n'.repeat(26));
    // Accepted: pending (the existing "relayed again" behaviour, the same operation).
    expect(await o.reconcile()).toEqual({ status: 'PENDING' });
    expect(o.sent.map(op => erc4337.userOpHash(op, 8453))).toEqual([o.p.userOpHash]);
    // AA21 and the nonce still unconsumed after it: provably never executed, FAILED.
    o.state.refusal = 'AA21 didn\'t pay prefund';
    const reads = o.state.nonceReads;
    expect(await o.reconcile()).toEqual({ status: 'FAILED', code: 'USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE', gasPaid: null, transactions: [] });
    expect(o.state.nonceReads - reads).toBe(2);
    expect(o.sent).toHaveLength(2);
    // AA25 while the chain still reads the nonce unconsumed: pending (read again on the next pass).
    o.state.refusal = 'AA25 invalid account nonce';
    expect(await o.reconcile()).toEqual({ status: 'PENDING' });
    // Mined between the nonce read and the resend (another bundler instance), whose resend is then refused AA21 on the spent prefund: the nonce
    // is read again before any FAILED — consumed now, so the operation is reconciled from its own event instead.
    o.state.refusal = 'AA21 didn\'t pay prefund';
    const txHash = '0x' + 'cd'.repeat(32);
    o.state.onSend = () => { o.state.onSend = null; o.mine(o.state.head - 10n, txHash); };
    expect(await o.reconcile()).toMatchObject({ status: 'RECONCILED', transactions: [txHash], gasPaid: { payer: o.address, amount: '4242' } });
    expect(o.sent).toHaveLength(4);
    // Consumed from now on: never resent again.
    expect(await o.reconcile()).toMatchObject({ status: 'RECONCILED', transactions: [txHash] });
    expect(o.sent).toHaveLength(4);
  });

  it('an unreadable EntryPoint nonce decides nothing: PENDING, nothing resent', async () => {
    const o = await lostOperation('wfr_' + 'o'.repeat(26));
    o.state.refusal = 'AA21 didn\'t pay prefund';
    o.state.sequence = new Error('DELEGATION_RPC_UNAVAILABLE');
    expect(await o.reconcile()).toEqual({ status: 'PENDING' });
    expect(o.sent).toHaveLength(0);
    // Nor does an artifact without the signed operation.
    o.state.sequence = 0n;
    expect(await o.reconcile({ ...o.p, op: undefined })).toEqual({ status: 'PENDING' });
    expect(o.sent).toHaveLength(0);
  });
});

describe('BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 Solana sign-all preparation (MOCKED mainnet transfer chain)', () => {
  it('prepares one exact, simulated transaction per step with the owner as fee payer; only the owner\'s signatures of exactly those messages are taken', async () => {
    const { createMockedSolanaTransferChain, createMockedSolanaWallet, parseMessageV0, parseTransaction, fromBase64 } = await import('@defi-workflow-engine/reference-compiler');
    const chain = createMockedSolanaTransferChain(), wallet = createMockedSolanaWallet(), stranger = createMockedSolanaWallet();
    chain.fundWallet(wallet.owner, 2_000_000_000n);
    const deps: UserFundedDeps = { chains: [SOLANA], evm: () => null, bundler: () => null, jupiter: null, solana: chain.rpc, now: () => new Date('2026-11-07T10:00:00Z') };
    const send = (recipient: string, amount: string) => ({ action: 'transfer', network: 'solana', asset: 'SOL', amount, recipient });
    const a = createMockedSolanaWallet().owner, b = createMockedSolanaWallet().owner;
    const { composition, requirement } = compose({ version: 2, steps: [send(a, '0.01'), send(b, '0.02')] });
    const g = { runId: 'wfr_' + 'd'.repeat(26), groupIndex: 0, strategy: 'SOLANA_SIGN_ALL' as const, chain: SOLANA, feePayer: wallet.owner, stepFrom: 0, stepTo: 1 };
    const prepared = await prepareGroup(deps, composition, requirement, g);
    if (!prepared.ok) throw new Error(prepared.code);
    const p = prepared.value.prepared as Prepared & { transactions: { stepIndex: number; message: string; unsignedTransaction: string; spend: { amount: string } }[]; fee: { payer: string } };
    expect(p.transactions.map(t => [t.stepIndex, t.spend.amount])).toEqual([[0, '10000000'], [1, '20000000']]);
    expect(p.fee.payer).toBe(wallet.owner);
    // Honoured for the blockhash lifetime (60 s) minus the 2-transaction send budget (50 blocks ≈ 20 s): a later signature is refused at
    // authorization (the owner prepares again) rather than accepted and then stopped, unsent, for lack of budget.
    expect(prepared.value.validUntil.getTime() - deps.now().getTime()).toBe(40_000);
    // S1: static key 0 (the fee payer) of every message is the owner.
    for (const t of p.transactions) expect(parseMessageV0(fromBase64(t.message)).staticKeys[0]).toBe(wallet.owner);
    // The owner's signatures of exactly those messages are accepted; anyone else's are not.
    const signed = p.transactions.map(t => wallet.sign(t.unsignedTransaction));
    expect(authorizeGroup(p, { kind: 'SOLANA_SIGN_ALL', transactions: signed }, wallet.owner, deps.now())).toMatchObject({ ok: true });
    expect(parseTransaction(fromBase64(signed[0]!, 2048)).signatures).toHaveLength(1);
    const foreign = p.transactions.map(t => stranger.sign(t.unsignedTransaction));
    expect(authorizeGroup(p, { kind: 'SOLANA_SIGN_ALL', transactions: foreign }, wallet.owner, deps.now())).toMatchObject({ ok: false });
    expect(authorizeGroup(p, { kind: 'SOLANA_SIGN_ALL', transactions: signed.slice(0, 1) }, wallet.owner, deps.now())).toMatchObject({ ok: false, code: 'SOLANA_SIGNED_COUNT_MISMATCH' });
    // Two byte-identical transfers would carry ONE signature (the chain runs it once): refused before anything is signed.
    const twice = compose({ version: 2, steps: [send(a, '0.01'), send(a, '0.01')] });
    expect(await prepareGroup(deps, twice.composition, twice.requirement, g)).toMatchObject({ ok: false, code: 'SOLANA_GROUP_DUPLICATE_TRANSACTION' });
  });
});

describe('BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 Solana group submission and reconciliation', () => {
  const owner = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', other = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2';
  const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  it('owner deltas: fee separated from the SOL spent, token deltas only for the owner\'s own accounts', () => {
    const facts = solanaOwnerDeltas(SOLANA, owner, { err: null, fee: 5000, preBalances: [1_000_000_000, 0], postBalances: [989_995_000, 10_000_000],
      preTokenBalances: [{ accountIndex: 2, mint: USDC_SOL, owner, uiTokenAmount: { amount: '0' } }, { accountIndex: 3, mint: USDC_SOL, owner: other, uiTokenAmount: { amount: '9' } }],
      postTokenBalances: [{ accountIndex: 2, mint: USDC_SOL, owner, uiTokenAmount: { amount: '24848243' } }, { accountIndex: 3, mint: USDC_SOL, owner: other, uiTokenAmount: { amount: '0' } }] });
    expect(facts).toEqual({ fee: 5000n, spent: [{ asset: `${SOLANA}/token:So11111111111111111111111111111111111111112`, amount: '10000000' }],
      received: [{ asset: `${SOLANA}/token:${USDC_SOL}`, amount: '24848243' }] });
  });
  it('sends each owner-signed transaction only after its predecessor confirmed, never past its blockhash, and reconciles the fees the owner paid', async () => {
    const sent: string[] = [];
    let height = 100;
    const statuses = new Map<string, { confirmationStatus: string; err: unknown }>();
    const { compileMessageV0, serializeMessageV0, serializeTransaction, toBase64 } = await import('@defi-workflow-engine/reference-compiler');
    const tx = (payer: string) => toBase64(serializeTransaction(new Uint8Array(64).fill(1), serializeMessageV0(compileMessageV0(payer, [{ programId: '11111111111111111111111111111111',
      accounts: [{ pubkey: payer, isSigner: true, isWritable: true }], data: new Uint8Array([2, 0, 0, 0]) }], 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', {}))));
    const prepared = { kind: 'SOLANA_SIGN_ALL', transactions: [{ stepIndex: 0, lastValidBlockHeight: 150, minimumOut: null }, { stepIndex: 1, lastValidBlockHeight: 150, minimumOut: null }] } as unknown as Prepared;
    const authorization = { transactions: [{ signature: 'sig0', transaction: tx(owner) }, { signature: 'sig1', transaction: tx(owner) }] };
    const deps: UserFundedDeps = { chains: [SOLANA], evm: () => null, bundler: () => null, jupiter: null, now: () => new Date(), solana: async (method, params) => {
      if (method === 'getSignatureStatuses') return { value: (params[0] as string[]).map(s => statuses.get(s) ?? null) };
      if (method === 'getBlockHeight') return height;
      if (method === 'sendTransaction') { sent.push(String(params[0])); return 'ok'; }
      if (method === 'getTransaction') return { meta: { err: null, fee: 5000, preBalances: [100_000, 0], postBalances: [95_000, 0], preTokenBalances: [], postTokenBalances: [] } };
      throw new Error(method);
    } };
    expect(await advanceSolanaSubmission(deps, prepared, authorization, owner)).toMatchObject({ state: 'SENT', index: 0 });
    statuses.set('sig0', { confirmationStatus: 'processed', err: null });
    expect(await advanceSolanaSubmission(deps, prepared, authorization, owner)).toMatchObject({ state: 'WAITING', index: 0 });
    statuses.set('sig0', { confirmationStatus: 'confirmed', err: null });
    expect(await advanceSolanaSubmission(deps, prepared, authorization, owner)).toMatchObject({ state: 'SENT', index: 1 });
    expect(sent).toHaveLength(2);
    statuses.set('sig1', { confirmationStatus: 'finalized', err: null });
    expect(await advanceSolanaSubmission(deps, prepared, authorization, owner)).toMatchObject({ state: 'DONE' });
    expect(await reconcileSolanaGroup(deps, prepared, { hashes: ['sig0', 'sig1'] }, SOLANA, owner)).toMatchObject({ status: 'RECONCILED',
      gasPaid: { payer: owner, amount: '10000', unit: 'lamports', source: 'SOLANA_META' } });
    // An expired blockhash: the transaction can never land, and nothing later is sent.
    statuses.clear(); sent.length = 0; height = 151;
    expect(await advanceSolanaSubmission(deps, prepared, authorization, owner)).toMatchObject({ state: 'EXPIRED', index: 0, code: 'SOLANA_BLOCKHASH_EXPIRED' });
    expect(sent).toEqual([]);
    // A transaction whose fee payer is anyone but the owner is never sent (S1).
    height = 100;
    await expect(advanceSolanaSubmission(deps, prepared, { transactions: [{ signature: 'x', transaction: tx(other) }, ...authorization.transactions.slice(1)] }, owner))
      .rejects.toThrow(GAS_PAYER_CODES.notOwner);
    expect(sent).toEqual([]);
  });
  it('P0: a signed group is never half-sent: too little blockhash budget sends nothing, and "expired" is only declared when provable', async () => {
    const sent: string[] = [];
    let confirmed = 100, finalized = 100;
    const statuses = new Map<string, { confirmationStatus: string; err: unknown }>();
    let landedOnReread: string | null = null;
    const { compileMessageV0, serializeMessageV0, serializeTransaction, toBase64 } = await import('@defi-workflow-engine/reference-compiler');
    const tx = (payer: string) => toBase64(serializeTransaction(new Uint8Array(64).fill(1), serializeMessageV0(compileMessageV0(payer, [{ programId: '11111111111111111111111111111111',
      accounts: [{ pubkey: payer, isSigner: true, isWritable: true }], data: new Uint8Array([2, 0, 0, 0]) }], 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', {}))));
    const three = { kind: 'SOLANA_SIGN_ALL', transactions: [0, 1, 2].map(i => ({ stepIndex: i, lastValidBlockHeight: 150, minimumOut: null })) } as unknown as Prepared;
    const authorization = { transactions: [0, 1, 2].map(i => ({ signature: `sig${i}`, transaction: tx(owner) })) };
    let reads = 0;
    const deps: UserFundedDeps = { chains: [SOLANA], evm: () => null, bundler: () => null, jupiter: null, now: () => new Date(), solana: async (method, params) => {
      if (method === 'getSignatureStatuses') {
        reads++;
        return { value: (params[0] as string[]).map(s => statuses.get(s) ?? (reads > 1 && s === landedOnReread ? { confirmationStatus: 'confirmed', err: null } : null)) };
      }
      if (method === 'getBlockHeight') return (params[0] as { commitment: string }).commitment === 'finalized' ? finalized : confirmed;
      if (method === 'sendTransaction') { sent.push(String(params[0])); return 'ok'; }
      throw new Error(method);
    } };
    // Signed with 3 transactions to send but only 40 blocks of blockhash left (75 needed): the budget is SHORT while the group is still
    // AUTHORIZED (provably nothing sent), so the pass blocks it before anything is sent (user-funded-pass.test.ts).
    confirmed = 110;
    expect(await solanaSendBudget(deps, three)).toBe('SHORT');
    expect(sent).toEqual([]);
    // With the budget, the group starts: the first is sent.
    confirmed = 70;
    expect(await solanaSendBudget(deps, three)).toBe('OK');
    expect(await advanceSolanaSubmission(deps, three, authorization, owner)).toMatchObject({ state: 'SENT', index: 0 });
    // Past its last valid height on a lagging 'confirmed' read, but not yet provably so at 'finalized': it is waited for, never dropped.
    statuses.set('sig0', { confirmationStatus: 'finalized', err: null });
    confirmed = 151; finalized = 140;
    expect(await advanceSolanaSubmission(deps, three, authorization, owner)).toMatchObject({ state: 'WAITING', index: 1 });
    // Finalized past it, but a fresh status read finds it landed after all: still never declared expired.
    finalized = 152; landedOnReread = 'sig1'; reads = 0;
    expect(await advanceSolanaSubmission(deps, three, authorization, owner)).toMatchObject({ state: 'WAITING', index: 1 });
    // Provably expired: finalized past it and unknown on a fresh read.
    landedOnReread = null;
    expect(await advanceSolanaSubmission(deps, three, authorization, owner)).toMatchObject({ state: 'EXPIRED', index: 1, code: 'SOLANA_BLOCKHASH_EXPIRED' });
    expect(sent).toHaveLength(1);
  });
  it('P0 regression: a first transaction already SENT is never declared expired for lack of budget while its blockhash is still valid', async () => {
    const sent: string[] = [];
    let confirmed = 70;
    const { compileMessageV0, serializeMessageV0, serializeTransaction, toBase64 } = await import('@defi-workflow-engine/reference-compiler');
    const tx = (payer: string) => toBase64(serializeTransaction(new Uint8Array(64).fill(1), serializeMessageV0(compileMessageV0(payer, [{ programId: '11111111111111111111111111111111',
      accounts: [{ pubkey: payer, isSigner: true, isWritable: true }], data: new Uint8Array([2, 0, 0, 0]) }], 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', {}))));
    const three = { kind: 'SOLANA_SIGN_ALL', transactions: [0, 1, 2].map(i => ({ stepIndex: i, lastValidBlockHeight: 150, minimumOut: null })) } as unknown as Prepared;
    const authorization = { transactions: [0, 1, 2].map(i => ({ signature: `sig${i}`, transaction: tx(owner) })) };
    const deps: UserFundedDeps = { chains: [SOLANA], evm: () => null, bundler: () => null, jupiter: null, now: () => new Date(), solana: async (method, params) => {
      // A sent transaction stays unknown (status null) until it is processed.
      if (method === 'getSignatureStatuses') return { value: (params[0] as string[]).map(() => null) };
      if (method === 'getBlockHeight') return confirmed;
      if (method === 'sendTransaction') { sent.push(String(params[0])); return 'ok'; }
      throw new Error(method);
    } };
    // Pass 1: the group had its budget and the first transaction was sent.
    expect(await advanceSolanaSubmission(deps, three, authorization, owner)).toMatchObject({ state: 'SENT', index: 0 });
    // Pass 2: still unknown, the budget for the whole group is now short (30 < 75) but its blockhash is still valid (120 ≤ 150). It may land:
    // the group is never EXPIRED (that would record it FAILED and never reconcile the landed transaction). At most the SAME signed bytes are resent.
    confirmed = 120;
    expect(await solanaSendBudget(deps, three)).toBe('SHORT');
    const again = await advanceSolanaSubmission(deps, three, authorization, owner);
    expect(again.state).not.toBe('EXPIRED');
    expect(again).toMatchObject({ index: 0, code: null });
    expect(['SENT', 'WAITING']).toContain(again.state);
    expect(new Set(sent)).toEqual(new Set([authorization.transactions[0]!.transaction]));
    // Right at its last valid height it is still not expired.
    confirmed = 150;
    expect((await advanceSolanaSubmission(deps, three, authorization, owner)).state).not.toBe('EXPIRED');
  });
  it('solanaSendBudget: OK with the budget left, SHORT without it, the 100-block cap for a large group, UNAVAILABLE when the height cannot be read', async () => {
    let height: unknown = 100, fail = false;
    const commitments: unknown[] = [];
    const rpc = async (method: string, params: readonly unknown[]) => {
      if (method !== 'getBlockHeight') throw new Error(method);
      commitments.push(params[0]);
      if (fail) throw new Error('SOLANA_RPC_UNAVAILABLE');
      return height;
    };
    const deps = (solana: UserFundedDeps['solana'] = rpc): UserFundedDeps => ({ chains: [SOLANA], evm: () => null, bundler: () => null, jupiter: null, now: () => new Date(), solana });
    const group = (n: number, last = 150) => ({ kind: 'SOLANA_SIGN_ALL', transactions: Array.from({ length: n }, (_, i) => ({ stepIndex: i, lastValidBlockHeight: last })) }) as unknown as Prepared;
    // Two transactions need 50 blocks: exactly 50 left is enough, 49 is not. The shortest blockhash of the group decides.
    expect(await solanaSendBudget(deps(), group(2))).toBe('OK');
    expect(commitments).toEqual([{ commitment: 'confirmed' }]);
    height = 101;
    expect(await solanaSendBudget(deps(), group(2))).toBe('SHORT');
    const mixed = { kind: 'SOLANA_SIGN_ALL', transactions: [{ stepIndex: 0, lastValidBlockHeight: 200 }, { stepIndex: 1, lastValidBlockHeight: 150 }] } as unknown as Prepared;
    expect(await solanaSendBudget(deps(), mixed)).toBe('SHORT');
    // Eight transactions would need 200 blocks, more than a blockhash ever has (~150): capped at 100, a large group is sendable when fresh...
    expect(solanaSendBudgetBlocks(8)).toBe(SOLANA_GROUP_SEND_BUDGET_MAX_BLOCKS);
    expect(SOLANA_GROUP_SEND_BUDGET_MAX_BLOCKS).toBe(100);
    expect(solanaSendBudgetBlocks(2)).toBe(2 * SOLANA_BLOCKS_PER_GROUP_TRANSACTION);
    height = 50;
    expect(await solanaSendBudget(deps(), group(8))).toBe('OK');
    expect(await solanaSendBudget(deps(), group(6))).toBe('OK');
    // ... and still refused once its blockhash is nearly spent.
    height = 51;
    expect(await solanaSendBudget(deps(), group(8))).toBe('SHORT');
    // Nothing is decided without a readable height: no RPC, a failed read, a garbage answer.
    expect(await solanaSendBudget(deps(null), group(2))).toBe('UNAVAILABLE');
    fail = true;
    expect(await solanaSendBudget(deps(), group(2))).toBe('UNAVAILABLE');
    fail = false;
    for (const garbage of [null, undefined, 'abc', '100', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, { height: 100 }]) {
      height = garbage;
      expect(await solanaSendBudget(deps(), group(2))).toBe('UNAVAILABLE');
    }
    // A group without a known last valid height for every transaction has no provable budget: nothing is sent.
    height = 0;
    expect(await solanaSendBudget(deps(), { kind: 'SOLANA_SIGN_ALL', transactions: [{ stepIndex: 0 }] } as unknown as Prepared)).toBe('SHORT');
    expect(await solanaSendBudget(deps(), { kind: 'SOLANA_SIGN_ALL', transactions: [] } as unknown as Prepared)).toBe('SHORT');
  });
  it('a prepared Solana group is offered for its blockhash lifetime minus the send budget, never under 15 seconds', () => {
    expect([1, 2, 3, 4, 6, 8].map(solanaPreparedTtlMs)).toEqual([50_000, 40_000, 30_000, 20_000, 20_000, 20_000]);
    for (let n = 1; n <= 64; n++) expect(solanaPreparedTtlMs(n)).toBeGreaterThanOrEqual(15_000);
  });
});

describe('BUILD-FLOFI-UNIVERSAL-WORKFLOW-002 gas isolation at volume', () => {
  it('1,000 submissions of several users: each is paid only by its own wallet; FloFi-controlled, foreign and sponsored payers are always refused', () => {
    const users = Array.from({ length: 7 }, (_, i) => '0x' + (i + 1).toString(16).repeat(40).slice(0, 40));
    const flofi = '0x' + 'f'.repeat(40);
    let accepted = 0;
    for (let i = 0; i < 1000; i++) {
      const owner = users[i % users.length]!, other = users[(i + 1) % users.length]!;
      expect(() => assertUserFundedSubmission({ kind: 'EVM_USER_OPERATION', feePayer: owner, ownerWallet: owner, sponsorship: '0x', flofiControlled: [flofi] })).not.toThrow();
      accepted++;
      expect(() => assertUserFundedSubmission({ kind: 'EVM_TRANSACTION', feePayer: other, ownerWallet: owner })).toThrow(GAS_PAYER_CODES.notOwner);
      expect(() => assertUserFundedSubmission({ kind: 'EVM_TRANSACTION', feePayer: flofi, ownerWallet: flofi, flofiControlled: [flofi] })).toThrow(GAS_PAYER_CODES.flofiControlled);
      expect(() => assertUserFundedSubmission({ kind: 'EVM_USER_OPERATION', feePayer: owner, ownerWallet: owner, sponsorship: '0x' + 'ab'.repeat(20) })).toThrow(GAS_PAYER_CODES.sponsored);
    }
    expect(accepted).toBe(1000);
  });
});

describe('P0 review fixes: a swap whose output the group spends is never a user operation signed upfront', () => {
  it('a stored EVM_USER_OPERATION group [swap → transfer bound to it] is refused at the consuming step before anything is built or estimated', async () => {
    const owner = await evmWallet(), address = owner.address.toLowerCase();
    let reads = 0;
    const deps: UserFundedDeps = { chains: [BASE], evm: () => ({ chain: BASE, purpose: 'read', environment: 'MOCKED', rpc: async () => { reads += 1; throw new Error('NOT_EXPECTED'); } }) as never,
      bundler: () => null, solana: null, jupiter: null, now: () => new Date('2026-11-07T10:00:00Z') };
    const { composition, requirement } = compose({ version: 2, steps: [
      { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 },
      { action: 'transfer', network: 'base', asset: 'WETH', amount: '0.001', recipient: '0x' + '2'.repeat(40) }], bindings: [{ step: 1, amountFrom: 0 }] });
    expect(requirement.bindings.map(b => [b.step, b.amountFrom])).toEqual([[1, 0]]);
    const g = { runId: 'wfr_' + 'e'.repeat(26), groupIndex: 1, strategy: 'EVM_USER_OPERATION' as const, chain: BASE, feePayer: address, stepFrom: 0, stepTo: 1 };
    expect(await prepareGroup(deps, composition, requirement, g)).toMatchObject({ ok: false, code: 'USER_OPERATION_SWAP_OUTPUT_SIGNED_WHEN_DUE', stepIndex: 1 });
    expect(reads).toBe(0);
  });
});
