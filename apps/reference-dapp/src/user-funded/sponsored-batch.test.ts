// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-MAINNET-EXEC-002 (ADR-0009): a user-funded wallet batch whose network fee FloFi's pinned paymaster sponsors — the preparation carries
 * a single-use grant for exactly its calls (REQUIRED when the owner's balance cannot pay the fee), the wallet may send it as a sponsored ERC-4337
 * operation, and reconciliation accepts the bundle only through the EntryPoint's own event of an operation the grant sponsored, from the owner,
 * paid by the pinned paymaster. Without a grant the invariant is unchanged: a transaction the owner did not send never reconciles.
 *
 * MOCKED loopback chain double (Arbitrum One identities); the sponsorship port is an in-memory double. Nothing reaches a network or is signed.
 */
import { describe, expect, it } from 'vitest';
import { ARBITRUM_MAINNET_SWAP } from '../domain/public-testnet-swap.ts';
import { guarded } from '../delegation/chains.ts';
import { createEvmDouble } from '../delegation/harness/evm-double.ts';
import { workflowRequirement } from '../delegation/steps.ts';
import { composeWorkflowBound } from '../engine/strategy-engine.ts';
import { evmCallsOf, type EvmGroupCalls } from './evm-calls.ts';
import { prepareGroup, reconcileEvmGroup, supersede, type Prepared, type UserFundedDeps } from './groups.ts';
import type { SponsorshipPort } from '../gas-sponsorship/runtime.ts';

const CHAIN = 'eip155:42161', OWNER = '0x1111111111111111111111111111111111111111', PAYMASTER = '0x' + '7a'.repeat(20), BUNDLER = '0x' + '0b'.repeat(20);
const USDC = ARBITRUM_MAINNET_SWAP.usdc;
const OP_HASH = '0x' + 'ab'.repeat(32), GRANT = 'c0ffee'.padEnd(32, '0');

function setup(nativeBalance = 10n ** 17n, sponsored = true) {
  const chain = createEvmDouble(42161, () => Math.floor(Date.parse('2026-11-13T12:00:00Z') / 1000), { profile: ARBITRUM_MAINNET_SWAP });
  chain.control.fundToken(OWNER, USDC, 10_000_000n); chain.control.fundNative(OWNER, nativeBalance);
  const s = { version: 2, steps: [{ action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3', slippageBps: 50 }] };
  const requirement = workflowRequirement(s), composition = composeWorkflowBound(s as never, undefined);
  if (!requirement.ok || !composition.ok) throw new Error('STRATEGY_INVALID');
  const transport = guarded(CHAIN, 'read', 'MOCKED', chain.rpc);
  const offers: { preview: boolean; calls: number }[] = [], settled: [string, string, bigint][] = [];
  let hashes: string[] = [OP_HASH];
  const port: SponsorshipPort = {
    offer: async input => { offers.push({ preview: input.preview, calls: input.calls.length });
      return { grantId: input.preview ? null : GRANT, chain: input.chain, paymaster: PAYMASTER, url: 'https://flofi.example/api/gas/paymaster/42161',
        context: input.preview ? null : { flofiGrant: GRANT } }; },
    operations: async id => id === GRANT ? hashes : null,
    settle: async (id, hash, cost) => { settled.push([id, hash, cost]); },
  };
  const deps: UserFundedDeps = { chains: [CHAIN], evm: c => c === CHAIN ? transport : null, bundler: () => null, solana: null, jupiter: null,
    now: () => new Date('2026-11-13T12:00:00Z'), ...sponsored ? { sponsorship: port } : {} };
  const prepare = (preview = false) => prepareGroup(deps, composition, requirement.value, { runId: 'wfr_sponsor', groupIndex: 0, strategy: 'EVM_WALLET_BATCH', chain: CHAIN,
    feePayer: OWNER, stepFrom: 0, stepTo: 0, preview });
  return { chain, deps, prepare, offers, settled, setHashes: (h: string[]) => { hashes = h; } };
}
type BatchPrepared = Prepared & { group: EvmGroupCalls; fromBlock: string; request: Record<string, unknown>;
  sponsorship?: { grantId: string | null; paymaster: string; url: string; context: { flofiGrant: string } | null; required: boolean };
  fee: { payer: string; maxCost: string; sponsorship: 'OFFERED' | 'REQUIRED' | null } };
const prepared = async (s: ReturnType<typeof setup>, preview = false) => {
  const r = await s.prepare(preview);
  if (!r.ok) throw new Error(r.code);
  return r.value.prepared as unknown as BatchPrepared;
};

describe('BUILD-FLOFI-MAINNET-EXEC-002: a sponsored owner wallet batch (ADR-0009)', () => {
  it('a preparation carries a grant for exactly its calls; the wallet request itself is unchanged (the browser adds the capability)', async () => {
    const s = setup(), p = await prepared(s);
    expect(p.sponsorship).toEqual({ grantId: GRANT, chain: CHAIN, paymaster: PAYMASTER, url: 'https://flofi.example/api/gas/paymaster/42161', context: { flofiGrant: GRANT }, required: false });
    expect(p.fee.sponsorship).toBe('OFFERED');
    expect(p.request).not.toHaveProperty('capabilities');
    expect(s.offers).toEqual([{ preview: false, calls: evmCallsOf(p.group).length }]);
    // A review's preparation creates no grant (nothing is handed to a wallet).
    const preview = await prepared(s, true);
    expect(preview.sponsorship).toMatchObject({ grantId: null, context: null });
    expect(s.offers.at(-1)!.preview).toBe(true);
  });
  it('an owner who cannot pay the fee ceiling is offered a REQUIRED sponsorship; without any offer the shortfall is refused exactly as before', async () => {
    const p = await prepared(setup(1n));
    expect(p.sponsorship?.required).toBe(true);
    expect(p.fee.sponsorship).toBe('REQUIRED');
    const none = await setup(1n, false).prepare();
    expect(none).toMatchObject({ ok: false, code: 'USER_FUNDED_INSUFFICIENT_NATIVE_BALANCE' });
  });
  it('reconciles the sponsored bundle from the EntryPoint event: the steps from the operation\'s own logs, the fee as paid by the paymaster, the ledger settled', async () => {
    const s = setup(), p = await prepared(s);
    const tx = s.chain.control.sponsoredOperation(OWNER, evmCallsOf(p.group), { userOpHash: OP_HASH, paymaster: PAYMASTER, bundler: BUNDLER, actualGasCost: 42_000_000_000_000n });
    const r = await reconcileEvmGroup(s.deps, p, { hashes: [tx] });
    if (r.status !== 'RECONCILED') throw new Error(JSON.stringify(r));
    expect(r.gasPaid).toEqual({ payer: PAYMASTER, amount: '42000000000000', unit: 'wei', source: 'USER_OPERATION_EVENT', sponsored: true });
    expect(r.steps[0]).toMatchObject({ stepIndex: 0, spent: [{ asset: `${CHAIN}/erc20:${USDC}`, amount: '3000000' }] });
    expect(s.settled).toEqual([[GRANT, OP_HASH, 42_000_000_000_000n]]);
    // The owner paid no gas: their native balance is untouched.
    expect(await s.deps.evm(CHAIN)!.rpc('eth_getBalance', [OWNER, 'latest'])).toBe('0x' + (10n ** 17n).toString(16));
  });
  it('refuses a bundle the grant did not sponsor, another sender, another paymaster; a failed sponsored operation is REVERTED with its fee recorded', async () => {
    const s = setup(), p = await prepared(s), calls = evmCallsOf(p.group);
    const foreign = s.chain.control.sponsoredOperation(OWNER, calls, { userOpHash: '0x' + 'cd'.repeat(32), paymaster: PAYMASTER, bundler: BUNDLER, actualGasCost: 1n });
    expect(await reconcileEvmGroup(s.deps, p, { hashes: [foreign] })).toMatchObject({ status: 'UNMATCHED', code: 'RECONCILIATION_CALLS_MISMATCH' });
    const other = setup(), q = await prepared(other);
    const wrongPaymaster = other.chain.control.sponsoredOperation(OWNER, evmCallsOf(q.group), { userOpHash: OP_HASH, paymaster: '0x' + '66'.repeat(20), bundler: BUNDLER, actualGasCost: 1n });
    expect(await reconcileEvmGroup(other.deps, q, { hashes: [wrongPaymaster] })).toMatchObject({ status: 'UNMATCHED', code: 'GAS_SPONSORSHIP_REFUSED' });
    const third = setup(), r = await prepared(third);
    const wrongSender = third.chain.control.sponsoredOperation(OWNER, evmCallsOf(r.group), { userOpHash: OP_HASH, paymaster: PAYMASTER, bundler: BUNDLER, actualGasCost: 1n,
      sender: '0x' + '22'.repeat(20) });
    expect(await reconcileEvmGroup(third.deps, r, { hashes: [wrongSender] })).toMatchObject({ status: 'UNMATCHED', code: 'GAS_PAYER_NOT_OWNER' });
    const fourth = setup(), f = await prepared(fourth);
    const failed = fourth.chain.control.sponsoredOperation(OWNER, evmCallsOf(f.group), { userOpHash: OP_HASH, paymaster: PAYMASTER, bundler: BUNDLER, actualGasCost: 9n, success: false });
    expect(await reconcileEvmGroup(fourth.deps, f, { hashes: [failed] })).toMatchObject({ status: 'FAILED', code: 'USER_OPERATION_REVERTED',
      gasPaid: { payer: PAYMASTER, amount: '9', sponsored: true } });
    expect(fourth.settled).toEqual([[GRANT, OP_HASH, 9n]]);
  });
  it('without a grant a bundle the owner did not send never reconciles (S1 unchanged); a sponsored offer still reconciles an owner-paid batch', async () => {
    const plain = setup(10n ** 17n, false), p = await prepared(plain);
    expect(p).not.toHaveProperty('sponsorship');
    const bundle = plain.chain.control.sponsoredOperation(OWNER, evmCallsOf(p.group), { userOpHash: OP_HASH, paymaster: PAYMASTER, bundler: BUNDLER, actualGasCost: 1n });
    expect(await reconcileEvmGroup(plain.deps, p, { hashes: [bundle] })).toMatchObject({ status: 'UNMATCHED', code: 'GAS_PAYER_NOT_OWNER' });
    // The wallet ignored the optional capability and sent the batch itself: the owner paid, as always.
    const s = setup(), q = await prepared(s);
    const own = s.chain.control.walletBatch(OWNER, evmCallsOf(q.group));
    const r = await reconcileEvmGroup(s.deps, q, { hashes: [own] });
    expect(r).toMatchObject({ status: 'RECONCILED', gasPaid: { payer: OWNER } });
    expect((r as { gasPaid: { sponsored?: true } }).gasPaid.sponsored).toBeUndefined();
    expect(s.settled).toEqual([]);
  });
  it('review P2: a grant that cannot be read now (storage down, or a process without the sponsorship port) keeps the group PENDING, never UNMATCHED', async () => {
    const s = setup(), p = await prepared(s);
    const tx = s.chain.control.sponsoredOperation(OWNER, evmCallsOf(p.group), { userOpHash: OP_HASH, paymaster: PAYMASTER, bundler: BUNDLER, actualGasCost: 7n });
    const down = { ...s.deps, sponsorship: { ...s.deps.sponsorship!, operations: async () => { throw new Error('GAS_SPONSOR_BUSY'); } } };
    expect(await reconcileEvmGroup(down, p, { hashes: [tx] })).toEqual({ status: 'PENDING' });
    const { sponsorship: _port, ...without } = s.deps; void _port;
    expect(await reconcileEvmGroup(without, p, { hashes: [tx] })).toEqual({ status: 'PENDING' });
    // Review round 2: a grant the artifact names that the port does not find (null) is unreadable too, never "no grant" (that would judge the
    // sponsored bundle as a transaction the owner did not send: UNMATCHED GAS_PAYER_NOT_OWNER).
    const unknown = { ...s.deps, sponsorship: { ...s.deps.sponsorship!, operations: async () => null } };
    expect(await reconcileEvmGroup(unknown, p, { hashes: [tx] })).toEqual({ status: 'PENDING' });
    expect(s.settled).toEqual([]);
    // Once it can be read, the same batch reconciles.
    expect(await reconcileEvmGroup(s.deps, p, { hashes: [tx] })).toMatchObject({ status: 'RECONCILED', gasPaid: { sponsored: true } });
  });
  it('review round 2: the reconciled receipt carries the operation\'s own logs only, never another sender\'s operation in the same bundle', async () => {
    const s = setup(), p = await prepared(s), OTHER = '0x' + '22'.repeat(20), SPOKE = '0x' + '5c'.repeat(20), OTHER_OP = '0x' + 'ef'.repeat(32);
    // Another sender's operation executed earlier in the same bundle, with a deposit-like log of its own (e.g. its Across FundsDeposited).
    const foreign = { address: SPOKE, topics: ['0x' + 'fd'.repeat(32), '0x' + '1'.padStart(64, '0'), '0x' + OTHER.slice(2).padStart(64, '0')], data: '0x' + '00'.repeat(32) };
    const tx = s.chain.control.sponsoredOperation(OWNER, evmCallsOf(p.group), { userOpHash: OP_HASH, paymaster: PAYMASTER, bundler: BUNDLER, actualGasCost: 7n,
      before: [{ userOpHash: OTHER_OP, sender: OTHER, logs: [foreign] }] });
    const onChain = await s.deps.evm(CHAIN)!.rpc('eth_getTransactionReceipt', [tx]) as { logs: { address: string; topics: string[]; data: string }[] };
    expect(onChain.logs.some(l => l.address === SPOKE)).toBe(true); // the bundle itself does hold it
    const r = await reconcileEvmGroup(s.deps, p, { hashes: [tx] });
    if (r.status !== 'RECONCILED') throw new Error(JSON.stringify(r));
    const logs = r.receipts![0]!.logs;
    // Exactly this operation's execution logs: after the previous operation's UserOperationEvent, before its own (the EntryPoint's events excluded).
    const own = onChain.logs.slice(onChain.logs.findIndex(l => l.topics[1] === OTHER_OP) + 1, -1);
    expect(own.length).toBeGreaterThan(0);
    expect(logs).toEqual(own.map(l => ({ address: l.address, topics: l.topics, data: l.data })));
    expect(logs.some(l => l.address === SPOKE || l.topics.includes(OTHER_OP))).toBe(false);
    expect(r.steps[0]).toMatchObject({ stepIndex: 0, spent: [{ asset: `${CHAIN}/erc20:${USDC}`, amount: '3000000' }] });
  });
  it('a self-bundling wallet (the owner sends the bundle to the EntryPoint) reconciles through the sponsored operation too', async () => {
    const s = setup(), p = await prepared(s);
    const tx = s.chain.control.sponsoredOperation(OWNER, evmCallsOf(p.group), { userOpHash: OP_HASH, paymaster: PAYMASTER, bundler: OWNER, actualGasCost: 11n });
    expect(await reconcileEvmGroup(s.deps, p, { hashes: [tx] })).toMatchObject({ status: 'RECONCILED', gasPaid: { payer: PAYMASTER, amount: '11', sponsored: true } });
  });
  it('a re-preparation keeps the earlier grant, so a sponsored batch of the earlier preparation still reconciles against it', async () => {
    const s = setup(), first = await prepared(s);
    const history = supersede(first);
    expect(history[0]).toMatchObject({ sponsor: { grantId: GRANT, paymaster: PAYMASTER } });
    const second = { ...await prepared(s), sponsorship: undefined, superseded: history } as unknown as Prepared;
    const tx = s.chain.control.sponsoredOperation(OWNER, evmCallsOf(first.group), { userOpHash: OP_HASH, paymaster: PAYMASTER, bundler: BUNDLER, actualGasCost: 5n });
    expect(await reconcileEvmGroup(s.deps, second, { hashes: [tx] })).toMatchObject({ status: 'RECONCILED', gasPaid: { sponsored: true } });
  });
});
