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
import type { BundlerClient } from './bundler.ts';
import { advanceSolanaSubmission, authorizeGroup, checkUserOperation, opOf, prepareGroup, reconcileEvmGroup, reconcileSolanaGroup, relayUserOperation, solanaOwnerDeltas,
  type Prepared, type SerialOp, type UserFundedDeps } from './groups.ts';
import { assertUserFundedSubmission, GAS_PAYER_CODES } from './gas-payer.ts';
import { TRANSFER_TOPIC } from './evm-reconcile.ts';

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
/** A loopback Base RPC: an upgraded owner account (the MetaMask 7702 delegator), EntryPoint nonce 0, fees, a balance, and stored receipts. */
function chain(owner: string, balance: bigint, receipts: Map<string, unknown>, upgraded = true): ChainTransport {
  return { chain: BASE, provenance: 'MOCKED', rpc: async (method, params) => {
    switch (method) {
      case 'eth_getCode': return upgraded && String(params[0]).toLowerCase() === owner ? '0xef0100' + erc4337.DELEGATOR_IMPLEMENTATION.slice(2) : '0x';
      case 'eth_call': return word(0n);
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
    expect(p.typedData.domain).toMatchObject({ verifyingContract: address, chainId: 8453 });
    expect(p.fee.payer).toBe(address);
    const op = opOf(p.op);
    expect(op.paymasterAndData).toBe('0x');
    expect(erc4337.userOpNonceParts(op.nonce).key).toBe(erc4337.nonceKeyOf(`${g.runId}:g1`));
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
    expect(await prepareGroup(deps(1n), composition, requirement, g)).toMatchObject({ ok: false, code: 'USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE' });
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
    expect(await reconcileEvmGroup(deps(10n ** 18n), p, { userOpHash: p.userOpHash })).toMatchObject({ status: 'FAILED', code: 'GAS_SPONSORSHIP_REFUSED' });
    receipts.set(txHash, { transactionHash: txHash, status: '0x1', logs: [eventWith(stranger.address.toLowerCase(), '0x' + '0'.repeat(40))] });
    expect(await reconcileEvmGroup(deps(10n ** 18n), p, { userOpHash: p.userOpHash })).toMatchObject({ status: 'FAILED', code: 'GAS_PAYER_NOT_OWNER' });
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
