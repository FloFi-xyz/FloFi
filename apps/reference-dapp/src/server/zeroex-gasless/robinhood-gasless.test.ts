// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003 (ADR-0010 §5): 0x Gasless swaps on Robinhood Chain through the existing `rhs-` catalog swap service,
 * against the MOCKED in-memory chain and a deterministic in-process double of 0x's Gasless API (no network, no provider, no real key). The
 * "owner's wallet" is a disposable test key signing the reviewed typed data; the "relayer" is the double mutating the mock chain.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalogSwapNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { eip712 } from '@defi-workflow-engine/reference-compiler';
import type { AssetCatalog, CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { createTestWallet, type TestWallet } from '../../../../../packages/reference-reconciler/test/test-wallet.ts';
import { createPublicTestnetService, type PublicRun, type PublicTestnetService, type Rpc } from '../public-testnet-service.ts';
import { UNISWAP_V3_ROBINHOOD } from '@defi-workflow-engine/action-registry';
import { asset, createRobinhoodMockChain, mockCatalogRuntime, officialCatalog, type RobinhoodMockChain } from '../robinhood-mainnet.test-harness.ts';
import { createZeroExDouble, MOCK_PREVIOUS_SETTLER, MOCK_RELAYER, MOCK_SETTLER, type ZeroExDouble } from './zeroex.test-harness.ts';
import { createZeroExGaslessClient } from './client.ts';
import { PERMIT2 } from './quote.ts';
import { amountsFromOwnerRecord } from '../../workflow-runs/received-amounts.ts';
import { deliveredByRecord } from '../../domain/workflow-sequence.ts';
import type { ZeroExGaslessConfig } from '../../gas-abstraction/config.ts';

const T0 = Date.parse('2026-10-11T03:00:00.000Z');
function catalogSwapWorkflow(input: CanonicalAsset, output: CanonicalAsset, amount: string, slippageBps = 50): SemanticWorkflow {
  const ref = (a: CanonicalAsset) => ({ chain: a.chain, address: a.address!, decimals: a.decimals, officialId: a.stock?.officialId ?? null });
  return { schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, resourceEdges: [],
    nodes: [createCatalogSwapNode('node-002', { chain: 'eip155:4663', amount, slippageBps, input: ref(input), output: ref(output) })] };
}
/** The service's own manifest digest (sha-256 of the canonical JSON), for a tampered record that is otherwise self-consistent. */
const canonicalJson = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? '[' + value.map(canonicalJson).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
const canonicalDigest = (value: unknown) => '0x' + createHash('sha256').update(canonicalJson(value)).digest('hex');
const ENABLED: ZeroExGaslessConfig = { enabled: true, apiUrl: 'http://127.0.0.1:8561', apiKey: 'loopback-key', chains: ['eip155:4663'], loopback: true };
const dirs: string[] = [];
let clock = T0, catalog: AssetCatalog, chain: RobinhoodMockChain, zx: ZeroExDouble, usdg: CanonicalAsset, tsla: CanonicalAsset, owner: TestWallet;
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });
beforeEach(() => {
  clock = T0;
  catalog = officialCatalog();
  chain = createRobinhoodMockChain(catalog, { now: () => clock });
  zx = createZeroExDouble(chain, { now: () => clock });
  usdg = asset(catalog, 'USDG'); tsla = asset(catalog, 'TSLA');
  owner = createTestWallet();
  chain.addPool(usdg.address!, tsla.address!, { fee: 3000, liquidity: 10n ** 20n, rate: { [usdg.address!]: 2_600_000_000_000_000_000_000_000_000n, [tsla.address!]: 384_000_000n } });
  chain.fund(usdg.address!, owner.address, 1_000_000_000n);
  // No ETH at all: the native path's fee is not covered.
  chain.fundNative(owner.address, 0n);
  zx.script.permitTokens = new Set([usdg.address!]);
});
function service(options: { config?: ZeroExGaslessConfig; executionEnabled?: boolean; dir?: string | undefined; gasless?: boolean; rpc?: Rpc } = {}): PublicTestnetService {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'flofi-rh-gasless-'));
  if (!options.dir) dirs.push(dir);
  const runtime = { ...mockCatalogRuntime(catalog, options.executionEnabled ?? true),
    ...options.gasless === false ? {} : { gasless: { config: options.config ?? ENABLED, client: createZeroExGaslessClient(zx.http, () => clock) } } };
  return createPublicTestnetService({ rpc: async () => { throw new Error('PUBLIC_NETWORK_UNAVAILABLE'); }, rpcs: { 'eip155:4663': options.rpc ?? zx.rpc }, journalDir: dir,
    idPrefix: 'rhs', now: () => new Date(clock), catalog: runtime });
}
/** The owner's wallet: signs exactly the typed data it is handed (`eth_signTypedData_v4`). */
const sign = (typed: eip712.TypedData | null, wallet = owner) => typed ? wallet.signDigest(eip712.hashTypedData(typed)) : null;
async function reviewed(s: PublicTestnetService, workflow = catalogSwapWorkflow(usdg, tsla, '100000000')): Promise<PublicRun> {
  const run = await s.prepare(workflow, owner.address);
  return s.review(run.quote.executionId, run.quote.manifestHash);
}
async function execute(s: PublicTestnetService, run: PublicRun): Promise<PublicRun> {
  const begun = await s.beginGasless(run.quote.executionId, owner.address);
  return s.submitGasless(run.quote.executionId, begun.attempt.attemptId, { approval: sign(begun.approval), trade: sign(begun.trade)! });
}

describe('selection: native gas stays the default', () => {
  it('keeps the Uniswap v3 native path exactly when the owner\'s ETH covers its worst case (0x is never asked)', async () => {
    chain.fundNative(owner.address, 10n ** 17n);
    const run = await service().prepare(catalogSwapWorkflow(usdg, tsla, '100000000'), owner.address);
    expect(run.quote.gas).toMatchObject({ owner: owner.address, mechanism: 'NATIVE_WALLET_GAS', nativeShort: false, unavailable: [], zeroEx: null,
      payment: { mechanism: 'NATIVE_WALLET_GAS', signatures: 2 } });
    expect(run.quote).toMatchObject({ expectedOut: '260000000000000000', minimumOut: '258700000000000000', fee: 3000 });
    expect(zx.calls).toEqual([]);
    // The native path then runs exactly as before: a finite router approval from the owner's wallet.
    const s = service({ dir: dirs.at(-1) });
    s.review(run.quote.executionId, run.quote.manifestHash);
    const begun = await s.begin(run.quote.executionId, owner.address);
    expect(begun.attempt.step).toBe('approval');
    // A native Review is never executed gaslessly.
    await expect(s.beginGasless(run.quote.executionId, owner.address)).rejects.toThrow('TOKEN_GAS_MECHANISM_MISMATCH');
  });
  it('quotes without an owner exactly as before (no gas binding, nothing read for an owner)', async () => {
    const run = await service().prepare(catalogSwapWorkflow(usdg, tsla, '100000000'));
    expect(run.quote.gas).toBeUndefined();
    expect(zx.calls).toEqual([]);
  });
  it('is off unless FLOFI_ZEROX_GASLESS is enabled: native, short, with the reason shown before anything is signed', async () => {
    const run = await service({ config: { enabled: false, code: 'ZEROX_GASLESS_NOT_ENABLED' } }).prepare(catalogSwapWorkflow(usdg, tsla, '100000000'), owner.address);
    expect(run.quote.gas).toMatchObject({ mechanism: 'NATIVE_WALLET_GAS', nativeShort: true, unavailable: [{ mechanism: 'ZEROX_GASLESS_SWAP', code: 'ZEROX_GASLESS_NOT_ENABLED' }] });
    const s = service({ dir: dirs.at(-1), config: { enabled: false, code: 'ZEROX_GASLESS_NOT_ENABLED' } });
    s.review(run.quote.executionId, run.quote.manifestHash);
    await expect(s.begin(run.quote.executionId, owner.address)).rejects.toThrow('INSUFFICIENT_GAS_FUNDS');
  });
});

describe('selection: 0x Gasless when ETH is short and 0x proves eligible', () => {
  it('binds 0x\'s trade, approval, fees, Settler and amounts into the reviewed manifest', async () => {
    const run = await service().prepare(catalogSwapWorkflow(usdg, tsla, '100000000'), owner.address), gas = run.quote.gas!;
    expect(gas).toMatchObject({ mechanism: 'ZEROX_GASLESS_SWAP', nativeShort: true, unavailable: [],
      payment: { mechanism: 'ZEROX_GASLESS_SWAP', signatures: 2, maxFee: { token: usdg.address, symbol: 'USDG', decimals: 6, amount: '420000' }, zeroExFee: null } });
    expect(gas.zeroEx).toMatchObject({ taker: owner.address, sellToken: usdg.address, buyToken: tsla.address, sellAmount: '100000000', settler: MOCK_SETTLER,
      settlerSource: 'ownerOf', permit2: PERMIT2, approval: { type: 'permit', value: '100000000', unlimited: false }, gasFee: { token: usdg.address, amount: '420000' } });
    // The Review's amounts are 0x's, net of the fee taken out of the swap; the Review closes before the signed deadline.
    expect(run.quote.expectedOut).toBe(((100_000_000n - 420_000n) * 2_600_000_000n).toString());
    expect(run.quote.minimumOut).toBe(gas.zeroEx!.minBuyAmount);
    expect(Date.parse(run.quote.expiresAt)).toBeLessThanOrEqual(gas.zeroEx!.trade.deadline * 1000 - 30_000);
    expect(gas.zeroEx!.trade.hash).toBe(eip712.hashTypedData(gas.zeroEx!.trade.eip712));
    // No integrator fee, surplus or recipient parameter is ever sent to 0x.
    expect(Object.keys(zx.calls.find(c => c.path === '/gasless/quote')!.query!).sort()).toEqual(['buyToken', 'chainId', 'sellAmount', 'sellToken', 'slippageBps', 'taker']);
  });
  it('accepts the previous Settler during 0x\'s dwell period and flags an unlimited approval explicitly', async () => {
    zx.script.settler = MOCK_PREVIOUS_SETTLER; zx.script.approvalValue = 'unlimited';
    const gas = (await service().prepare(catalogSwapWorkflow(usdg, tsla, '100000000'), owner.address)).quote.gas!;
    expect(gas.zeroEx).toMatchObject({ settler: MOCK_PREVIOUS_SETTLER, settlerSource: 'prev', approval: { unlimited: true, value: ((1n << 256n) - 1n).toString() } });
  });
  it('needs one signature when the Permit2 allowance already covers the sell amount', async () => {
    chain.state.allowances.set(`${usdg.address}:${owner.address}:${PERMIT2}`, 10n ** 12n);
    const gas = (await service().prepare(catalogSwapWorkflow(usdg, tsla, '100000000'), owner.address)).quote.gas!;
    expect(gas).toMatchObject({ mechanism: 'ZEROX_GASLESS_SWAP', payment: { signatures: 1 }, zeroEx: { approval: null } });
  });
  it.each([
    ['no gasless approval exists for the sell token (a no-ETH owner cannot approve)', () => { zx.script.permitTokens = new Set(); }, 'ZEROX_GASLESS_APPROVAL_UNAVAILABLE'],
    ['0x offers an approval type FloFi does not verify', () => { zx.script.approvalType = 'daiPermit'; }, 'ZEROX_GASLESS_APPROVAL_UNAVAILABLE'],
    ['0x has no liquidity', () => { zx.script.liquidity = false; }, 'ZEROX_NO_LIQUIDITY'],
    ['the quote carries no gas fee (it would be sponsored)', () => { zx.script.gasFee = null; }, 'ZEROX_SPONSORED_QUOTE_REFUSED'],
    ['the quote carries a zero gas fee', () => { zx.script.gasFee = 0n; }, 'ZEROX_SPONSORED_QUOTE_REFUSED'],
    ['the trade is signed for a Settler the registry does not name', () => { zx.script.settler = '0x' + '5'.repeat(40); }, 'ZEROX_SETTLER_MISMATCH'],
    ['the registry says the Settler is paused', () => { zx.registry.current = null; }, 'ZEROX_SETTLER_PAUSED'],
    ['the slippage struct is zeroed', () => { zx.script.zeroSlippageStruct = true; }, 'ZEROX_TRADE_UNVERIFIABLE'],
    ['the deadline is too close to sign', () => { zx.script.deadlineSeconds = 20; }, 'ZEROX_QUOTE_EXPIRED'],
    ['0x reports a balance issue', () => { zx.script.balanceIssue = true; }, 'ZEROX_INSUFFICIENT_BALANCE'],
    ['0x could not simulate the trade', () => { zx.script.simulationIncomplete = true; }, 'ZEROX_SIMULATION_INCOMPLETE'],
    ['0x does not list Robinhood Chain', () => { zx.script.chains = [1, 8453]; }, 'ZEROX_GASLESS_CHAIN_UNSUPPORTED'],
    ['the Stock Token is not authorized for this integrator', () => { zx.script.quoteError = { status: 403, name: 'XSTOCKS_NOT_AUTHORIZED' }; }, 'ZEROX_STOCK_TOKEN_NOT_AUTHORIZED'],
    ['the amount is below 0x\'s minimum', () => { zx.script.quoteError = { status: 400, name: 'SELL_AMOUNT_TOO_SMALL' }; }, 'ZEROX_SELL_AMOUNT_TOO_LOW'],
    ['the owner is a contract account', () => { chain.state.codeOverride.set(owner.address.toLowerCase(), '0x6080'); }, 'ZEROX_OWNER_NOT_EOA'],
  ])('keeps native gas, short, when %s', async (_name, mutate, code) => {
    mutate();
    const run = await service().prepare(catalogSwapWorkflow(usdg, tsla, '100000000'), owner.address);
    expect(run.quote.gas).toMatchObject({ mechanism: 'NATIVE_WALLET_GAS', nativeShort: true, zeroEx: null, unavailable: [{ mechanism: 'ZEROX_GASLESS_SWAP', code }] });
  });
  it('never sells native ETH gaslessly', async () => {
    const ETH = { chain: 'eip155:4663', address: null, decimals: 18, officialId: null };
    const USDG = { chain: 'eip155:4663', address: usdg.address!, decimals: 6, officialId: null };
    chain.addPool(usdg.address!, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', { fee: 100, liquidity: 10n ** 20n,
      rate: { [usdg.address!]: 430_000_000_000_000_000_000_000n, '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 2_326_000_000_000_000_000_000n } });
    chain.fundNative(owner.address, 10n ** 15n);
    const workflow: SemanticWorkflow = { schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, resourceEdges: [],
      nodes: [createCatalogSwapNode('node-002', { chain: 'eip155:4663', input: ETH, output: USDG, amount: '1000000000000000', slippageBps: 100 })] };
    const run = await service().prepare(workflow, owner.address);
    expect(run.quote.gas).toMatchObject({ mechanism: 'NATIVE_WALLET_GAS', nativeShort: true, unavailable: [{ mechanism: 'ZEROX_GASLESS_SWAP', code: 'ZEROX_GASLESS_NATIVE_SELL_UNSUPPORTED' }] });
    expect(zx.calls).toEqual([]);
  });
});

describe('execution: typed data signed by the owner, relayed once, reconciled from chain', () => {
  it('approves and swaps gaslessly; the owner pays the fee in USDG, no ETH moves, and the evidence is MOCKED', async () => {
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    const begun = await s.beginGasless(id, owner.address);
    expect(begun.attempt).toMatchObject({ state: 'SIGNING', account: owner.address, tradeHash: run.quote.gas!.zeroEx!.trade.hash });
    expect(begun.trade).toEqual(run.quote.gas!.zeroEx!.trade.eip712);
    expect(begun.approval).toEqual(run.quote.gas!.zeroEx!.approval!.eip712);
    const submitted = await s.submitGasless(id, begun.attempt.attemptId, { approval: sign(begun.approval), trade: sign(begun.trade)! });
    expect(submitted.gasless!.at(-1)).toMatchObject({ state: 'SUBMITTED', signedAt: expect.any(String) });
    expect(JSON.stringify(submitted)).not.toMatch(/"signature"|"r":|"s":/);
    const posted = zx.calls.filter(c => c.method === 'POST');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatchObject({ chainId: 4663, trade: { type: 'settler_metatransaction', signature: { signatureType: 2 } }, approval: { type: 'permit' } });
    const done = await s.observe(id);
    expect(done.divergence).toBeUndefined();
    expect(done.outcome).toMatchObject({ inputSpent: '100000000', outputReceived: run.quote.expectedOut, gasCostWei: '0',
      gasPaid: { payer: MOCK_RELAYER, unit: 'wei', source: 'RECEIPT', paidInToken: { mechanism: 'ZEROX_GASLESS_SWAP', token: usdg.address, symbol: 'USDG', amount: '420000', payee: MOCK_SETTLER } } });
    expect(done.outcome!.evidence).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
    expect(done.outcome!.evidence.reconciliation.fees).toEqual([{ asset: { chainId: 'eip155:4663', address: usdg.address, decimals: 6 }, amount: '420000' }]);
    expect(done.outcome!.evidence.reconciliation.limitations).toEqual(['OWNER_WALLET_MAINNET', 'MOCKED_LOOPBACK_CHAIN', 'NETWORK_FEE_PAID_IN_TOKEN_VIA_0X_GASLESS',
      'GASLESS_SETTLEMENT_RECEIPT_RECONCILED', 'TOKEN_FEE_AMOUNT_FROM_SIGNED_QUOTE']);
    expect(done.gasless!.at(-1)).toMatchObject({ state: 'CONFIRMED', receipt: { gasPayer: MOCK_RELAYER, submissionKind: 'ZEROX_GASLESS', to: MOCK_SETTLER } });
    expect(chain.state.native.get(owner.address.toLowerCase()) ?? 0n).toBe(0n);
    expect(chain.balance(tsla.address!, owner.address)).toBe(BigInt(run.quote.expectedOut));
    // One run, one swap: nothing can be prepared, signed or submitted again.
    await expect(s.beginGasless(id, owner.address)).rejects.toThrow('ATTEMPT_ALREADY_ACTIVE');
    await expect(s.begin(id, owner.address)).rejects.toThrow(/ATTEMPT_ALREADY_ACTIVE|SWAP_ALREADY_ATTEMPTED|TOKEN_GAS_MECHANISM_MISMATCH/);
    expect(zx.calls.filter(c => c.method === 'POST')).toHaveLength(1);
  });
  it('feeds the reconciled output to the next workflow step exactly as a native swap does (USDG → TSLA → next step)', async () => {
    const s = service(), run = await reviewed(s), done = await (async () => { await execute(s, run); return s.observe(run.quote.executionId); })();
    const record = JSON.parse(JSON.stringify(done)) as unknown;
    expect(amountsFromOwnerRecord(record)).toEqual({ spent: [{ asset: expect.stringContaining(usdg.address!), amount: '100000000' }],
      received: [{ asset: expect.stringContaining(tsla.address!), amount: done.outcome!.outputReceived }] });
    expect(deliveredByRecord('public', record, { chainId: 'eip155:4663', address: tsla.address!, decimals: 18 })).toBe(done.outcome!.outputReceived);
  });
  it('re-quotes for a new Review when the quote window no longer leaves the signing margin', async () => {
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    clock = Date.parse(run.quote.expiresAt) - 5_000;
    await expect(s.beginGasless(id, owner.address)).rejects.toThrow('QUOTE_EXPIRED_REVIEW_REQUIRED');
    const renewed = s.load(id);
    expect(renewed.reviewedManifestHash).toBeNull();
    expect(renewed.quote.gas!.zeroEx!.trade.hash).not.toBe(run.quote.gas!.zeroEx!.trade.hash);
    s.review(id, renewed.quote.manifestHash);
    const done = await execute(s, s.load(id));
    expect(done.gasless!.at(-1)!.state).toBe('SUBMITTED');
  });
  it('refuses a signature that is not the owner\'s and lets the owner decline without anything being submitted', async () => {
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    const begun = await s.beginGasless(id, owner.address), stranger = createTestWallet();
    await expect(s.submitGasless(id, begun.attempt.attemptId, { approval: sign(begun.approval, stranger), trade: sign(begun.trade, stranger)! })).rejects.toThrow('ZEROX_SIGNER_MISMATCH');
    await expect(s.submitGasless(id, begun.attempt.attemptId, { approval: sign(begun.approval), trade: '0x1234' })).rejects.toThrow('ZEROX_SIGNATURE_INVALID');
    await expect(s.submitGasless(id, begun.attempt.attemptId, { approval: null, trade: sign(begun.trade)! })).rejects.toThrow('ZEROX_SIGNATURE_INVALID');
    expect((await s.reportGasless(id, begun.attempt.attemptId, { kind: 'REJECTED' })).gasless!.at(-1)!.state).toBe('REJECTED');
    expect(zx.calls.filter(c => c.method === 'POST')).toEqual([]);
    // The owner may try again on the same Review.
    expect((await execute(s, s.load(id))).gasless!.at(-1)!.state).toBe('SUBMITTED');
  });
  it('a submission whose answer is lost is observed by trade hash and reconciled, never posted again', async () => {
    zx.script.submit = 'timeout';
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    const unknown = await execute(s, run);
    expect(unknown.gasless!.at(-1)!.state).toBe('UNKNOWN');
    await expect(s.beginGasless(id, owner.address)).rejects.toThrow('ATTEMPT_ALREADY_ACTIVE');
    expect(() => s.review(id, run.quote.manifestHash)).toThrow('REVIEW_EXPIRED');
    const done = await s.observe(id);
    expect(done.outcome?.inputSpent).toBe('100000000');
    expect(zx.calls.filter(c => c.method === 'POST')).toHaveLength(1);
  });
  it('TRADE_ALREADY_SUBMITTED is observation, not a failure', async () => {
    zx.script.submit = 'already'; zx.script.settle = false;
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    expect((await execute(s, run)).gasless!.at(-1)!.state).toBe('SUBMITTED');
    expect((await s.observe(id)).gasless!.at(-1)!.state).toBe('PENDING');
    zx.settle(run.quote.gas!.zeroEx!.trade.hash);
    expect((await s.observe(id)).outcome).not.toBeNull();
  });
  it('a definitive 0x refusal is recorded and the run presents a fresh quote for a new Review', async () => {
    zx.script.submit = { status: 400, name: 'INSUFFICIENT_BALANCE_OR_ALLOWANCE' };
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    await expect(execute(s, run)).rejects.toThrow('ZEROX_INSUFFICIENT_BALANCE');
    const after = s.load(id);
    expect(after.gasless!.at(-1)).toMatchObject({ state: 'REFUSED', code: 'ZEROX_INSUFFICIENT_BALANCE' });
    expect(after.reviewedManifestHash).toBeNull();
    expect(after.quote.gas!.zeroEx!.trade.hash).not.toBe(run.quote.gas!.zeroEx!.trade.hash);
  });
  it.each([
    ['order_expired', 'ZEROX_ORDER_EXPIRED'], ['insufficient_balance', 'ZEROX_INSUFFICIENT_BALANCE'], ['transaction_simulation_failed', 'ZEROX_TRADE_SIMULATION_FAILED'],
  ])('surfaces 0x\'s failure reason %s, final only once the signed deadline passed with the Permit2 nonce unused', async (reason, code) => {
    zx.script.settle = false; zx.script.status = { status: 'failed', reason, transactions: [] };
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    await execute(s, run);
    expect((await s.observe(id)).gasless!.at(-1)).toMatchObject({ state: 'FAILED', code, final: false });
    clock = (run.quote.gas!.zeroEx!.trade.deadline + 61) * 1000;
    const final = await s.observe(id);
    expect(final.gasless!.at(-1)).toMatchObject({ state: 'FAILED', code, final: true });
    expect(final.outcome).toBeNull();
    await expect(s.observe(id)).rejects.toThrow('NO_SUBMITTED_ATTEMPT');
  });
  it('a reverted settlement is a failure the owner paid nothing for', async () => {
    zx.script.revert = true;
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    await execute(s, run);
    const failed = await s.observe(id);
    expect(failed.gasless!.at(-1)).toMatchObject({ state: 'FAILED', code: 'ZEROX_TRADE_REVERTED' });
    expect(chain.balance(usdg.address!, owner.address)).toBe(1_000_000_000n);
  });
  it('reconciles after a reload from the durable record alone', async () => {
    zx.script.settle = false;
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    await execute(s, run);
    zx.settle(run.quote.gas!.zeroEx!.trade.hash);
    const reloaded = service({ dir: dirs.at(-1) });
    const done = await reloaded.observe(id);
    expect(done.outcome?.outputReceived).toBe(run.quote.expectedOut);
  });
  it('a settlement sent to another contract than the reviewed Settler is never reconciled', async () => {
    zx.script.settle = false;
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    await execute(s, run);
    const hash = zx.settle(run.quote.gas!.zeroEx!.trade.hash);
    (chain.state.transactions.get(hash) as Record<string, unknown>).to = '0x' + '6'.repeat(40);
    const diverged = await s.observe(id);
    expect(diverged.divergence).toBe('TRANSACTION_MISMATCH');
    expect(diverged.outcome).toBeNull();
  });
  it('a settlement that credits less than the signed minimum is a reconciliation mismatch', async () => {
    const s = service(), run = await reviewed(s);
    zx.script.received = BigInt(run.quote.minimumOut) - 1n;
    await execute(s, run);
    expect((await s.observe(run.quote.executionId)).divergence).toBe('RECONCILIATION_MISMATCH');
  });
});

describe('review Z2/Z3: 0x is compared with FloFi\'s own Uniswap quote, and the native re-check never estimates 0x\'s minimum', () => {
  /** The pool's output for 100 USDG (the mock pool's rate): what the Uniswap router can pay at most. */
  const POOL_OUT = 260_000_000_000_000_000n;
  /**
   * The chain as a real node answers `eth_estimateGas` for the router's `exactInputSingle`: it reverts ("Too little received") when the call's
   * amountOutMinimum is above what the pool pays (the mock chain itself never simulates an estimate). `estimate: 'down'` plays a node that does
   * not answer estimates at all. The production read client's revert shape (public-testnet-rpc.ts).
   */
  function nodeRpc(control: { estimate: 'up' | 'down' }): Rpc {
    return async (method, params, context) => {
      if (method === 'eth_estimateGas') {
        if (control.estimate === 'down') throw new Error('PUBLIC_RPC_UNAVAILABLE');
        const call = params[0] as { to: string; data: string };
        if (call.to.toLowerCase() === UNISWAP_V3_ROBINHOOD.router.toLowerCase() && call.data.startsWith('0x04e45aaf') &&
            BigInt('0x' + call.data.slice(10 + 5 * 64, 10 + 6 * 64)) > POOL_OUT)
          throw Object.assign(new Error('PUBLIC_RPC_RESPONSE_INVALID'), { rpcErrorCode: 3, rpcReverted: true });
      }
      return zx.rpc(method, params, context);
    };
  }
  it('Z2: 0x quoting above the pool (owner already allowed the router) keeps the reviewed gasless swap at begin and submit; it settles', async () => {
    zx = createZeroExDouble(chain, { now: () => clock, price: { numerator: 2_700_000_000n, denominator: 1n } });
    zx.script.permitTokens = new Set([usdg.address!]);
    chain.state.allowances.set(`${usdg.address}:${owner.address.toLowerCase()}:${UNISWAP_V3_ROBINHOOD.router.toLowerCase()}`, 10n ** 12n);
    const control = { estimate: 'up' as 'up' | 'down' }, s = service({ rpc: nodeRpc(control) }), run = await reviewed(s), id = run.quote.executionId;
    const zeroEx = run.quote.gas!.zeroEx!;
    expect(run.quote.gas!.mechanism).toBe('ZEROX_GASLESS_SWAP');
    // 0x's minimum is above what the pool pays: an estimate built on it would revert. FloFi's own reference stays beside it.
    expect(BigInt(zeroEx.minBuyAmount)).toBeGreaterThan(POOL_OUT);
    expect(zeroEx.reference).toMatchObject({ source: 'uniswap-v3', pool: run.quote.pool, fee: 3000, expectedOut: POOL_OUT.toString(), minimumOut: '258700000000000000' });
    const begun = await s.beginGasless(id, owner.address);
    expect(begun.attempt.state).toBe('SIGNING');
    const submitted = await s.submitGasless(id, begun.attempt.attemptId, { approval: sign(begun.approval), trade: sign(begun.trade)! });
    expect(submitted.gasless!.at(-1)!.state).toBe('SUBMITTED');
    expect((await s.observe(id)).outcome?.outputReceived).toBe(run.quote.expectedOut);
  });
  it('Z2: an estimate the node cannot give now never flips a reviewed gasless swap (only ETH that proves to cover it does)', async () => {
    const control = { estimate: 'up' as 'up' | 'down' }, s = service({ rpc: nodeRpc(control) }), run = await reviewed(s), id = run.quote.executionId;
    expect(run.quote.gas!.mechanism).toBe('ZEROX_GASLESS_SWAP');
    control.estimate = 'down';
    const begun = await s.beginGasless(id, owner.address);
    expect(begun.attempt.state).toBe('SIGNING');
    expect(s.load(id).reviewedManifestHash).toBe(run.quote.manifestHash);
    expect((await s.submitGasless(id, begun.attempt.attemptId, { approval: sign(begun.approval), trade: sign(begun.trade)! })).gasless!.at(-1)!.state).toBe('SUBMITTED');
  });
  it('Z3: a 0x quote worse than FloFi\'s own Uniswap quote beyond its disclosed fees is refused before anything is signed (native, short, with the reason)', async () => {
    zx = createZeroExDouble(chain, { now: () => clock, price: { numerator: 2_500_000_000n, denominator: 1n } });
    zx.script.permitTokens = new Set([usdg.address!]);
    const run = await service().prepare(catalogSwapWorkflow(usdg, tsla, '100000000'), owner.address);
    expect(run.quote.gas).toMatchObject({ mechanism: 'NATIVE_WALLET_GAS', nativeShort: true, zeroEx: null,
      unavailable: [{ mechanism: 'ZEROX_GASLESS_SWAP', code: 'ZEROX_QUOTE_WORSE_THAN_REFERENCE' }] });
    // The Review keeps FloFi's own figures (nothing of 0x's worse quote is bound).
    expect(run.quote).toMatchObject({ expectedOut: POOL_OUT.toString(), minimumOut: '258700000000000000' });
  });
  it('Z3: a stored gasless binding without FloFi\'s reference, or one whose minimum is below its floor, is never authority', async () => {
    const s = service(), run = await reviewed(s), id = run.quote.executionId, dir = dirs.at(-1)!;
    const { writeFileSync } = await import('node:fs');
    const withoutReference: Record<string, unknown> = { ...run.quote.gas!.zeroEx! };
    delete withoutReference.reference;
    for (const zeroEx of [withoutReference, { ...run.quote.gas!.zeroEx!, reference: { ...run.quote.gas!.zeroEx!.reference, floor: (BigInt(run.quote.minimumOut) + 1n).toString() } }]) {
      const tampered = { ...run, quote: { ...run.quote, gas: { ...run.quote.gas!, zeroEx } } };
      const fields: Record<string, unknown> = { ...tampered.quote };
      delete fields.manifestHash;
      writeFileSync(join(dir, id + '.json'), JSON.stringify({ ...tampered, quote: { ...fields, manifestHash: canonicalDigest(fields) } }));
      await expect(s.beginGasless(id, owner.address)).rejects.toThrow('QUOTE_BINDING_INVALID');
    }
  });
});

describe('authorization gates', () => {
  it('refuses when ETH arrived after the Review: the policy would now pick native gas (GAS_MECHANISM_CHANGED_REVIEW_REQUIRED)', async () => {
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    chain.fundNative(owner.address, 10n ** 17n);
    await expect(s.beginGasless(id, owner.address)).rejects.toThrow('GAS_MECHANISM_CHANGED_REVIEW_REQUIRED');
    const renewed = s.load(id);
    expect(renewed.reviewedManifestHash).toBeNull();
    expect(renewed.quote.gas!.mechanism).toBe('NATIVE_WALLET_GAS');
  });
  it('refuses a native Review whose ETH left when 0x Gasless would now be chosen', async () => {
    chain.fundNative(owner.address, 10n ** 17n);
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    expect(run.quote.gas!.mechanism).toBe('NATIVE_WALLET_GAS');
    chain.fundNative(owner.address, 0n);
    await expect(s.begin(id, owner.address)).rejects.toThrow('GAS_MECHANISM_CHANGED_REVIEW_REQUIRED');
    expect(s.load(id).quote.gas!.mechanism).toBe('ZEROX_GASLESS_SWAP');
    expect(s.load(id).attempts).toEqual([]);
  });
  it('refuses another wallet, a missing Review, the deployment without real-funds execution, and the kill switch', async () => {
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    await expect(s.beginGasless(id, createTestWallet().address)).rejects.toThrow('OWNER_REVIEW_MISMATCH');
    const off = service({ dir: dirs.at(-1), executionEnabled: false });
    await expect(off.beginGasless(id, owner.address)).rejects.toThrow('OWNER_EXECUTION_NOT_ENABLED');
    const begun = await s.beginGasless(id, owner.address);
    vi.stubEnv('FLOFI_EXECUTION_PAUSED', 'true');
    await expect(s.submitGasless(id, begun.attempt.attemptId, { approval: sign(begun.approval), trade: sign(begun.trade)! })).rejects.toThrow('EXECUTION_PAUSED');
    expect(zx.calls.filter(c => c.method === 'POST')).toEqual([]);
    vi.unstubAllEnvs();
    const unreviewed = await s.prepare(catalogSwapWorkflow(usdg, tsla, '100000000'), owner.address);
    await expect(s.beginGasless(unreviewed.quote.executionId, owner.address)).rejects.toThrow('REVIEW_REQUIRED');
  });
  it('never submits a second trade for the same trade hash (create-once claim)', async () => {
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    const begun = await s.beginGasless(id, owner.address);
    const signatures = { approval: sign(begun.approval), trade: sign(begun.trade)! };
    await s.submitGasless(id, begun.attempt.attemptId, signatures);
    await expect(s.submitGasless(id, begun.attempt.attemptId, signatures)).rejects.toThrow('ATTEMPT_STATE_INVALID');
    expect(zx.calls.filter(c => c.method === 'POST')).toHaveLength(1);
  });
  it('a tampered stored gas binding is never authority', async () => {
    const s = service(), run = await reviewed(s), id = run.quote.executionId;
    const tampered = { ...run, quote: { ...run.quote, gas: { ...run.quote.gas!, zeroEx: { ...run.quote.gas!.zeroEx!, minBuyAmount: '1' } } } };
    const dir = dirs.at(-1)!;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, id + '.json'), JSON.stringify(tampered));
    await expect(s.beginGasless(id, owner.address)).rejects.toThrow('QUOTE_BINDING_INVALID');
  });
});

describe('the robinhood-swap cloud flow carries the gasless methods', () => {
  it('validates gasless arguments strictly, projects gasless attempts and observes only submitted trades', async () => {
    const { FLOWS } = await import('../../../backend/flows.ts');
    const flow = FLOWS['robinhood-swap'], id = 'rhs-' + 'a'.repeat(24), attempt = id + '.gasless.1', sig = '0x' + '1'.repeat(130);
    expect(flow.methods.beginGasless!.validate([id, owner.address])).toBe(true);
    expect(flow.methods.submitGasless!.validate([id, attempt, { trade: sig, approval: null }])).toBe(true);
    expect(flow.methods.submitGasless!.validate([id, attempt, { trade: sig, approval: null, extra: 1 }])).toBe(false);
    expect(flow.methods.submitGasless!.validate([id, id + '.swap.1', { trade: sig, approval: sig }])).toBe(false);
    expect(flow.methods.reportGasless!.validate([id, attempt, { kind: 'REJECTED' }])).toBe(true);
    expect(flow.methods.reportGasless!.validate([id, attempt, { kind: 'HASH' }])).toBe(false);
    // Other catalog networks offer no gasless execution.
    expect(FLOWS['base-swap'].methods.submitGasless).toBeUndefined();
    const s = service(), run = await reviewed(s), runId = run.quote.executionId;
    const project = (value: PublicRun) => flow.projector(runId + '.jsonl', new TextEncoder().encode(JSON.stringify(value) + '\n'))!;
    const begun = await s.beginGasless(runId, owner.address);
    expect(project(s.load(runId)).run).toMatchObject({ status: 'SIGNING', ownerAccount: owner.address, needsObservation: false });
    zx.script.settle = false;
    const submitted = await s.submitGasless(runId, begun.attempt.attemptId, { approval: sign(begun.approval), trade: sign(begun.trade)! });
    expect(project(submitted).run).toMatchObject({ status: 'SUBMITTED', needsObservation: true });
    zx.settle(run.quote.gas!.zeroEx!.trade.hash);
    const done = await s.observe(runId), projected = project(done);
    expect(projected.run).toMatchObject({ status: 'RECONCILED', needsObservation: false, hasEvidence: true, errorCode: null });
    expect(projected.run.attempts).toEqual([expect.objectContaining({ attemptId: begun.attempt.attemptId, step: 'SWAP', state: 'CONFIRMED',
      transactionHash: done.gasless![0]!.txHash, reconciled: true })]);
    expect(flow.evidence(done)).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
  });
});

describe('FloFi Wallet signs a gasless swap only through the reviewed attempt', () => {
  it('re-derives the exact approval and trade from the SIGNING attempt, summarises the fee in the swap\'s token, refuses anything else', async () => {
    const { resolveManagedSigning, parseSigningRequest } = await import('../managed-signing.ts');
    const s = service(), run = await reviewed(s), runId = run.quote.executionId;
    const deps = { load: async () => s.load(runId), managed: (_e: string, address: string) => address === owner.address, now: () => clock };
    const context = { flow: 'robinhood-swap', runId };
    const ask = (typedData: unknown, address = owner.address) =>
      resolveManagedSigning(context, { ecosystem: 'evm-typed-data', address, typedData: typedData as eip712.TypedData }, deps);
    // Before beginGasless there is no attempt waiting for signatures.
    expect(await ask(run.quote.gas!.zeroEx!.trade.eip712)).toEqual({ ok: false, code: 'FLOFI_WALLET_NO_MATCHING_REVIEW' });
    const begun = await s.beginGasless(runId, owner.address);
    const trade = await ask(begun.trade), approval = await ask(begun.approval);
    expect(trade).toMatchObject({ ok: true, value: { attempt: `robinhood-swap:${begun.attempt.attemptId}:trade`, owner: owner.address,
      typedData: { kind: 'trade', digest: run.quote.gas!.zeroEx!.trade.hash }, summary: { action: 'Swap (signature)', network: 'Robinhood Chain' } } });
    expect(trade.ok && trade.value.summary.lines).toEqual([{ label: 'Swap', value: '100 USDG → TSLA on Robinhood Chain' },
      { label: 'Minimum received', value: expect.stringMatching(/ TSLA$/) }, { label: 'Fees included in the swap', value: '0.42 USDG' },
      { label: 'Executed by', value: `0x Settler ${MOCK_SETTLER}` }]);
    expect(approval).toMatchObject({ ok: true, value: { typedData: { kind: 'approval' }, summary: { lines: expect.arrayContaining([{ label: 'Approve', value: '100 USDG' }]) } } });
    // The same digest without the declared EIP712Domain is the same payload; any changed value, another wallet or a stale Review is not.
    const types = Object.fromEntries(Object.entries(begun.trade.types).filter(([name]) => name !== 'EIP712Domain'));
    expect((await ask({ ...begun.trade, types })).ok).toBe(true);
    const message = begun.trade.message as { slippageAndActions: Record<string, unknown> };
    expect(await ask({ ...begun.trade, message: { ...message, slippageAndActions: { ...message.slippageAndActions, minAmountOut: '1' } } }))
      .toEqual({ ok: false, code: 'FLOFI_WALLET_NO_MATCHING_REVIEW' });
    expect(await ask(begun.trade, createTestWallet().address)).toEqual({ ok: false, code: 'FLOFI_WALLET_NO_MATCHING_REVIEW' });
    clock = Date.parse(s.load(runId).quote.expiresAt) + 1;
    expect(await ask(begun.trade)).toEqual({ ok: false, code: 'FLOFI_WALLET_REVIEW_EXPIRED' });
    // The page's request body, exactly as FloFi Wallet's provider builds it.
    expect(parseSigningRequest({ op: 'evm_sign_typed_data', address: owner.address, typedData: begun.trade, signing: context }))
      .toEqual({ context, request: { ecosystem: 'evm-typed-data', address: owner.address, typedData: begun.trade } });
    expect(parseSigningRequest({ op: 'evm_sign_typed_data', address: owner.address, typedData: { ...begun.trade, extra: 1 }, signing: context })).toBeNull();
  });
});
