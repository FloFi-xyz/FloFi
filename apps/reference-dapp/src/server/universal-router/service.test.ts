// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: the universal router service on MOCKED in-memory chains (Base, Arbitrum One, Ethereum, Robinhood Chain,
 * Solana) and a MOCKED Relay API whose orders are hashed for real. No network, no real key, no public send path.
 * Scenarios follow the build directive (A–N).
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBaseSepoliaReviewContext } from '@defi-workflow-engine/reference-linter';
import { projectExecutionLifecycle, type ExecutionLifecycleSource } from '../../domain/execution-lifecycle';
import { projectExecutionEvidence } from '../../domain/execution-evidence';
import { projectExecutionStepEvidence } from '../../domain/execution-step-evidence';
import { projectDashboardRecord } from '../../lib/dashboard/record-projection';
import { projectDashboardRun } from '../../lib/dashboard/run-mapping';
import { financialRunStatus } from '../../domain/financial-run-status';
import type { Workflow } from '../../domain/initial-workflow';
import type { DashboardRunDetail } from '../../lib/dashboard/types';
import { createFileExecutionStorage } from '@defi-workflow-engine/reference-executor';
import { applyMockedPhantomLighthouseGuards, compileMessageV0, parseMessageV0, decompileMessageV0, serializeMessageV0, RELAY_SOLANA_VAULT } from '@defi-workflow-engine/reference-compiler';
import { createUniversalBridgeNode, UNIVERSAL_DIRECTED_PAIRS, UNIVERSAL_NETWORKS, type SemanticWorkflow, type UniversalAssetRef, type UniversalBridgeFields, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';
import { createRelayProvider } from './relay-provider.ts';
import { createUniversalRouterService, universalNeedsObservation, validateUniversalLog, type UniversalRecord } from './service.ts';
import { createEvmMockChain, createRelayMock, createSolanaMock, mockedUniversalDeployment, solanaTestWallet, type EvmMock } from './universal.test-harness.ts';
import { refreshBridgeAfterApproval } from '../../domain/bridge-review-recovery';

const T0 = Date.parse('2026-10-25T12:00:00.000Z');
const USDC = { base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'arbitrum-one': '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', robinhood: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } as const;
const EVM_OWNER = '0x1111111111111111111111111111111111111111', EVM_RECIPIENT = '0x2222222222222222222222222222222222222222';
const SOLANA_RECIPIENT = solanaTestWallet().publicKey;
const token = (key: UniversalNetworkKey): UniversalAssetRef => ({ kind: 'TOKEN', address: USDC[key], decimals: 6 });
const native = (key: UniversalNetworkKey): UniversalAssetRef => ({ kind: 'NATIVE', decimals: UNIVERSAL_NETWORKS[key].native.decimals });

function workflow(fields: Partial<UniversalBridgeFields> & Pick<UniversalBridgeFields, 'sourceChain' | 'destinationChain' | 'inputAsset' | 'outputAsset' | 'amount' | 'recipient'>,
  workflowId = 'wf-universal'): SemanticWorkflow {
  const node = createUniversalBridgeNode('node-bridge', { slippageBps: 50, providers: ['relay'], selection: 'BEST_MINIMUM_OUTPUT', ...fields });
  return { schemaVersion: '1.0.0', workflowId, revision: 1, nodes: [node], resourceEdges: [] } as SemanticWorkflow;
}
async function setup(options: { executionEnabled?: boolean; extraTokens?: Record<string, Record<string, number>> } = {}) {
  let clock = T0;
  const now = () => clock;
  const D = mockedUniversalDeployment();
  const tokens = (chain: string) => Object.fromEntries(Object.entries(USDC).filter(([k]) => UNIVERSAL_NETWORKS[k as UniversalNetworkKey].chain === chain).map(([, a]) => [a, 6]));
  const evm: Record<string, EvmMock> = Object.fromEntries(Object.keys(D.evm).map(chain => [chain, createEvmMockChain(D.evm[chain]!, { now, tokens: { ...tokens(chain), ...options.extraTokens?.[chain] } })]));
  const solana = createSolanaMock(D.solana, { mints: { [USDC.solana]: 6 } });
  const decimals = (chainId: number, currency: string) => options.extraTokens?.[`eip155:${chainId}`]?.[currency] ?? (currency === '0x0000000000000000000000000000000000000000' ? 18 : currency === '11111111111111111111111111111111' ? 9 : 6);
  // 1 SOL = 150 USDC; 1 ETH = 4,000 USDC; 1 SOL = 0.0375 ETH. Stablecoins 1:1.
  const price = (c: string) => c === '11111111111111111111111111111111' ? 150n : c === '0x0000000000000000000000000000000000000000' ? 4000n : 1n;
  const relayMock = createRelayMock({ now, decimals, rate: (i, o) => 10n ** 18n * price(i) / price(o),
    symbol: (chainId, c) => c === '11111111111111111111111111111111' ? 'SOL' : c === '0x0000000000000000000000000000000000000000' ? 'ETH' : c === USDC.robinhood ? 'USDG' : 'USDC' });
  const dir = await mkdtemp(join(tmpdir(), 'flofi-universal-'));
  const service = createUniversalRouterService({ storage: createFileExecutionStorage(dir, 'UNIVERSAL_BUSY'), evmRpcs: Object.fromEntries(Object.entries(evm).map(([c, m]) => [c, m.rpc])),
    solanaRpc: solana.rpc, providers: { relay: createRelayProvider({ http: relayMock.http }) }, provenance: 'MOCKED', executionEnabled: options.executionEnabled ?? true,
    now: () => new Date(clock), mockedDeployment: D });
  const wallet = solanaTestWallet();
  solana.setLamports(wallet.publicKey, 2_000_000_000n);
  solana.setToken(wallet.publicKey, USDC.solana, 500_000_000n);
  for (const [chain, m] of Object.entries(evm)) {
    m.setNative(EVM_OWNER, 10n ** 18n);
    for (const t of Object.keys(tokens(chain))) m.setToken(t, EVM_OWNER, 1_000_000_000n);
  }
  const chainOf = (key: UniversalNetworkKey) => evm[UNIVERSAL_NETWORKS[key].chain]!;
  return { service, evm, solana, relayMock, wallet, chainOf, storage: createFileExecutionStorage(dir, 'UNIVERSAL_BUSY'), tick: (ms: number) => { clock += ms; }, now };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
async function reviewed(c: Ctx, w: SemanticWorkflow, owner: string, destinationWallet?: string) {
  const run = await c.service.simulate(w, owner, destinationWallet);
  return c.service.review(run.id, run.review.commitment, w);
}
/** EVM Execute click(s): begin → durable handoff → wallet send → report; repeated while an approval is needed first. */
async function executeEvm(c: Ctx, chain: EvmMock, id: string, w: SemanticWorkflow): Promise<UniversalRecord> {
  for (let i = 0; i < 2; i++) {
    const begun = await c.service.begin(id, EVM_OWNER, w);
    if (begun.ecosystem !== 'EVM') throw new Error('expected EVM');
    await c.service.handoff(id);
    const { hash } = chain.wallet.send(begun.transaction);
    await c.service.report(id, { kind: 'HASH', hash });
    const record = await c.service.observe(id);
    if (begun.attempt.step === 'DEPOSIT') return record;
  }
  throw new Error('no deposit');
}
async function executeSolana(c: Ctx, id: string, w: SemanticWorkflow, mutate?: (unsigned: string) => string): Promise<UniversalRecord> {
  const begun = await c.service.begin(id, c.wallet.publicKey, w);
  if (begun.ecosystem !== 'SOLANA') throw new Error('expected Solana');
  const unsigned = mutate ? mutate(begun.unsignedTransaction) : begun.unsignedTransaction;
  const record = await c.service.submit(id, c.wallet.sign(unsigned));
  const signature = record.attempts.at(-1)!.transactionHash!;
  c.solana.land(signature);
  return c.service.observe(id);
}
/** The solver delivers what the reviewed order guarantees (or `amount`) and Relay reports it; then both chains reach finality. */
async function settle(c: Ctx, record: UniversalRecord, amount?: bigint): Promise<UniversalRecord> {
  const route = record.review.route, minimum = amount ?? BigInt(route.expectedOutput);
  const dst = UNIVERSAL_NETWORKS[(Object.keys(UNIVERSAL_NETWORKS) as UniversalNetworkKey[]).find(k => UNIVERSAL_NETWORKS[k].chain === route.destinationChain)!];
  const hash = dst.ecosystem === 'SOLANA' ? c.solana.deliver({ recipient: route.recipient, mint: route.outputToken.address, amount: minimum, orderId: route.order.orderId })
    : c.evm[dst.chain]!.deliver({ recipient: route.recipient, token: route.outputToken.address, amount: minimum, orderId: route.order.orderId });
  c.relayMock.setStatus(route.quote.id, { status: 'success', inTxHashes: [record.source?.transactionHash], txHashes: [hash] });
  await c.service.observe(record.id);
  for (const m of Object.values(c.evm)) { m.mine(); m.mine(); m.mine(); }
  return c.service.observe(record.id);
}
const roundTripLog = async (c: Ctx, id: string) => { const record = await c.service.load(id); expect(record.id).toBe(id); return record; };

describe('A–E: Solana ⇄ every EVM mainnet, verified source to verified delivery', () => {
  it('A. Solana USDC → Base USDC: one Solana signature, FloFi broadcasts once, Base delivery proven, evidence', async () => {
    const c = await setup(), w = workflow({ sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS.base.chain, inputAsset: token('solana'),
      outputAsset: token('base'), amount: '25000000', recipient: EVM_RECIPIENT });
    const run = await reviewed(c, w, c.wallet.publicKey);
    expect(run.review).toMatchObject({ owner: c.wallet.publicKey, recipient: EVM_RECIPIENT, recipientKind: 'EXPLICIT', authorizations: { sourceSignatures: 1, destinationAuthorization: 'NONE' },
      feePolicy: { flofiFee: 'WORKFLOW_0_1_PCT', flofiFeeRateBps: 10, flofiFeeBasis: 'COMPLETED_WORKFLOW_INPUT', flofiFeeCollection: 'OBLIGATION_RECORDED',
        networkFeeSymbol: 'SOL' }, selection: { selected: 'relay' }, source: { ecosystem: 'SOLANA', simulation: { ownerDebit: '25000000' } } });
    expect(run.phase).toBe('AUTHORIZED');
    const confirmed = await executeSolana(c, run.id, w);
    // Solana deposits are observed at finalized commitment, so the same observation moves the run on to IN_FLIGHT.
    expect(confirmed).toMatchObject({ phase: 'IN_FLIGHT', source: { ownerDebit: '25000000', final: true }, authorization: null });
    expect(c.solana.state.tokens.get(c.solana.ata(RELAY_SOLANA_VAULT, USDC.solana))?.amount).toBe(25_000_000n);
    const done = await settle(c, confirmed);
    expect(done).toMatchObject({ phase: 'RECONCILED', verdict: 'RECONCILED', received: done.review.route.expectedOutput, destination: { recipient: EVM_RECIPIENT, orderBound: true, final: true },
      feeObligation: { status: 'OBLIGATED', rateBps: 10, feeAmount: '25000', collection: 'NOT_SETTLED', notional: { amount: '25000000', symbol: 'USDC' } } });
    expect(done.evidence).toMatchObject({ evidenceClass: 'MOCKED', route: { provider: 'relay', orderId: done.review.route.order.orderId }, reconciliation: 'RECONCILED',
      feeObligation: { status: 'OBLIGATED', feeAmount: '25000' } });
    expect(universalNeedsObservation(done)).toBe(false);
    await roundTripLog(c, run.id);
  });
  it('B. Base USDC → Solana USDC: an exact approval, then the deposit (two signatures, shown at Review); Solana delivery proven', async () => {
    const c = await setup(), recipient = solanaTestWallet().publicKey;
    const w = workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.solana.chain, inputAsset: token('base'), outputAsset: token('solana'),
      amount: '40000000', recipient: 'CONNECTED_DESTINATION_WALLET' });
    await expect(c.service.simulate(w, EVM_OWNER)).rejects.toThrow('UNIVERSAL_DESTINATION_WALLET_REQUIRED');
    const run = await reviewed(c, w, EVM_OWNER, recipient);
    expect(run.review).toMatchObject({ recipient, recipientKind: 'CONNECTED_DESTINATION_WALLET', authorizations: { sourceSignatures: 2 },
      source: { ecosystem: 'EVM', approvals: [{ amount: '40000000', required: true }] } });
    const confirmed = await executeEvm(c, c.chainOf('base'), run.id, w);
    expect(confirmed.attempts.map(a => `${a.step}:${a.state}`)).toEqual(['APPROVAL:CONFIRMED', 'DEPOSIT:CONFIRMED']);
    const done = await settle(c, confirmed);
    expect(done).toMatchObject({ verdict: 'RECONCILED', destination: { recipient, final: true } });
  });
  it('C. Solana SOL → Arbitrum ETH and Arbitrum USDC → Solana USDC', async () => {
    const c = await setup();
    const w1 = workflow({ sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS['arbitrum-one'].chain, inputAsset: native('solana'),
      outputAsset: native('arbitrum-one'), amount: '500000000', recipient: EVM_RECIPIENT });
    const r1 = await reviewed(c, w1, c.wallet.publicKey);
    expect(r1.review.route.outputToken).toMatchObject({ kind: 'NATIVE', decimals: 18 });
    const d1 = await settle(c, await executeSolana(c, r1.id, w1));
    expect(d1.verdict).toBe('RECONCILED');
    const recipient = solanaTestWallet().publicKey;
    const w2 = workflow({ sourceChain: UNIVERSAL_NETWORKS['arbitrum-one'].chain, destinationChain: UNIVERSAL_NETWORKS.solana.chain, inputAsset: token('arbitrum-one'),
      outputAsset: token('solana'), amount: '30000000', recipient });
    const r2 = await reviewed(c, w2, EVM_OWNER);
    expect((await settle(c, await executeEvm(c, c.chainOf('arbitrum-one'), r2.id, w2))).verdict).toBe('RECONCILED');
  });
  it('D/G. Solana → Ethereum (USDC → ETH, a different destination asset) and Ethereum USDC → Solana SOL', async () => {
    const c = await setup();
    const w1 = workflow({ sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS.ethereum.chain, inputAsset: token('solana'), outputAsset: native('ethereum'),
      amount: '100000000', recipient: EVM_RECIPIENT });
    const r1 = await reviewed(c, w1, c.wallet.publicKey);
    expect([r1.review.route.inputToken.symbol, r1.review.route.outputToken.symbol]).toEqual(['USDC', 'ETH']);
    expect((await settle(c, await executeSolana(c, r1.id, w1))).verdict).toBe('RECONCILED');
    const w2 = workflow({ sourceChain: UNIVERSAL_NETWORKS.ethereum.chain, destinationChain: UNIVERSAL_NETWORKS.solana.chain, inputAsset: token('ethereum'), outputAsset: native('solana'),
      amount: '60000000', recipient: solanaTestWallet().publicKey });
    const r2 = await reviewed(c, w2, EVM_OWNER);
    const d2 = await settle(c, await executeEvm(c, c.chainOf('ethereum'), r2.id, w2));
    expect(d2).toMatchObject({ verdict: 'RECONCILED', destination: { token: 'native' } });
  });
  it('E. Solana USDC → Robinhood USDG and Robinhood USDG → Solana USDC', async () => {
    const c = await setup();
    const w1 = workflow({ sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS.robinhood.chain, inputAsset: token('solana'), outputAsset: token('robinhood'),
      amount: '20000000', recipient: EVM_RECIPIENT });
    expect((await settle(c, await executeSolana(c, (await reviewed(c, w1, c.wallet.publicKey)).id, w1))).verdict).toBe('RECONCILED');
    const w2 = workflow({ sourceChain: UNIVERSAL_NETWORKS.robinhood.chain, destinationChain: UNIVERSAL_NETWORKS.solana.chain, inputAsset: token('robinhood'), outputAsset: token('solana'),
      amount: '20000000', recipient: solanaTestWallet().publicKey });
    expect((await settle(c, await executeEvm(c, c.chainOf('robinhood'), (await reviewed(c, w2, EVM_OWNER)).id, w2))).verdict).toBe('RECONCILED');
  });
  it('F. EVM ⇄ EVM on the universal router: Base ETH → Robinhood ETH (native deposit, value = amount, no approval)', async () => {
    const c = await setup();
    const w = workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.robinhood.chain, inputAsset: native('base'), outputAsset: native('robinhood'),
      amount: '10000000000000000', recipient: 'CONNECTED_OWNER' });
    const run = await reviewed(c, w, EVM_OWNER);
    expect(run.review).toMatchObject({ recipient: EVM_OWNER, recipientKind: 'CONNECTED_OWNER', authorizations: { sourceSignatures: 1 }, source: { approvals: [] } });
    expect((await settle(c, await executeEvm(c, c.chainOf('base'), run.id, w))).verdict).toBe('RECONCILED');
  });
});

describe('I–K: independent and identical bridges, duplicate clicks and retries', () => {
  it('I/J. two independent bridges and two identical bridges from one wallet run side by side, each with its own order and delivery', async () => {
    const c = await setup(), base = c.chainOf('base');
    const same = () => workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS['arbitrum-one'].chain, inputAsset: token('base'),
      outputAsset: token('arbitrum-one'), amount: '5000000', recipient: 'CONNECTED_OWNER' });
    const w1 = same(), w2 = same(), w3 = workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.solana.chain, inputAsset: token('base'),
      outputAsset: token('solana'), amount: '7000000', recipient: solanaTestWallet().publicKey });
    const runs = [await reviewed(c, w1, EVM_OWNER), await reviewed(c, w2, EVM_OWNER), await reviewed(c, w3, EVM_OWNER)], flows = [w1, w2, w3];
    expect(new Set(runs.map(r => r.review.route.order.orderId)).size).toBe(3);
    // Only one wallet request may hold a nonce: while the first is open in the wallet, a second request on the same nonce is refused...
    const first = await c.service.begin(runs[0]!.id, EVM_OWNER, w1);
    await expect(c.service.begin(runs[1]!.id, EVM_OWNER, w2)).rejects.toThrow('UNIVERSAL_OWNER_NONCE_IN_USE');
    // ...and once it is sent (still pending), the next bridge prepares on the next nonce: pending bridges never block independent ones.
    await c.service.handoff(runs[0]!.id);
    const pending = base.wallet.send((first as { transaction: { from: string; to: string; data: string; value: string } }).transaction, { mineNow: false });
    await c.service.report(runs[0]!.id, { kind: 'HASH', hash: pending.hash });
    const second = await c.service.begin(runs[1]!.id, EVM_OWNER, w2);
    expect([first.attempt, second.attempt].map(a => a.ecosystem === 'EVM' ? a.nonce : null)).toEqual(['0', '1']);
    await c.service.handoff(runs[1]!.id);
    const pending2 = base.wallet.send((second as { transaction: { from: string; to: string; data: string; value: string } }).transaction, { mineNow: false });
    await c.service.report(runs[1]!.id, { kind: 'HASH', hash: pending2.hash });
    pending.land(); pending2.land();
    for (const [i, r] of runs.entries()) {
      let record = await c.service.observe(r.id);
      if (!record.source) record = await executeEvm(c, base, r.id, flows[i]!);
      expect(record.phase).toBe('SOURCE_CONFIRMED');
    }
    // The first deposit consumed the shared Depository allowance (ERC-20 approvals overwrite), so the second bridge asked for a fresh exact approval.
    expect((await c.service.load(runs[1]!.id)).attempts.map(a => `${a.step}:${a.state}`)).toEqual(['APPROVAL:CONFIRMED', 'APPROVAL:CONFIRMED', 'DEPOSIT:CONFIRMED']);
    // All three deposits are in flight at once; each settles on its own delivery.
    const settled = [];
    for (const r of runs) settled.push(await settle(c, await c.service.load(r.id)));
    expect(settled.map(r => r.verdict)).toEqual(['RECONCILED', 'RECONCILED', 'RECONCILED']);
    expect(new Set(settled.map(r => r.destination!.transactionHash)).size).toBe(3);
  });
  it('J. one delivery cannot reconcile two identical bridges', async () => {
    const c = await setup();
    const w = () => workflow({ sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS.base.chain, inputAsset: token('solana'), outputAsset: token('base'),
      amount: '10000000', recipient: EVM_RECIPIENT });
    const w1 = w(), w2 = w();
    const one = await executeSolana(c, (await reviewed(c, w1, c.wallet.publicKey)).id, w1), two = await executeSolana(c, (await reviewed(c, w2, c.wallet.publicKey)).id, w2);
    const done = await settle(c, one);
    expect(done.verdict).toBe('RECONCILED');
    // Relay (wrongly) points the second request at the first delivery: it is claimed by the first run and refused for the second.
    c.relayMock.setStatus(two.review.route.quote.id, { status: 'success', txHashes: [done.destination!.transactionHash] });
    expect(await c.service.observe(two.id)).toMatchObject({ verdict: 'DIVERGENT', error: 'UNIVERSAL_DELIVERY_CLAIMED_BY_ANOTHER_RUN' });
  });
  it('K. duplicate clicks and retries never create a second wallet request or broadcast', async () => {
    const c = await setup(), w = workflow({ sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS.base.chain, inputAsset: token('solana'),
      outputAsset: token('base'), amount: '10000000', recipient: EVM_RECIPIENT });
    const run = await reviewed(c, w, c.wallet.publicKey);
    const begun = await c.service.begin(run.id, c.wallet.publicKey, w);
    await expect(c.service.begin(run.id, c.wallet.publicKey, w)).rejects.toThrow('UNIVERSAL_ATTEMPT_ACTIVE_OBSERVE_EXISTING');
    if (begun.ecosystem !== 'SOLANA') throw new Error('expected Solana');
    const signed = c.wallet.sign(begun.unsignedTransaction);
    await c.service.submit(run.id, signed);
    await expect(c.service.submit(run.id, signed)).rejects.toThrow('UNIVERSAL_WALLET_HANDOFF_NOT_AUTHORIZED');
    expect(c.solana.state.sent.size).toBe(1);
    // EVM: the same reported hash twice is a no-op; a different one is divergent.
    const e = workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.ethereum.chain, inputAsset: native('base'), outputAsset: native('ethereum'),
      amount: '1000000000000000', recipient: 'CONNECTED_OWNER' });
    const r = await reviewed(c, e, EVM_OWNER), b = await c.service.begin(r.id, EVM_OWNER, e);
    await c.service.handoff(r.id);
    const { hash } = c.chainOf('base').wallet.send((b as { transaction: { from: string; to: string; data: string; value: string } }).transaction, { mineNow: false });
    await c.service.report(r.id, { kind: 'HASH', hash });
    expect((await c.service.report(r.id, { kind: 'HASH', hash })).attempts).toHaveLength(1);
    await expect(c.service.report(r.id, { kind: 'HASH', hash: '0x' + 'ab'.repeat(32) })).rejects.toThrow('UNIVERSAL_HASH_DIVERGENT');
    expect((await c.service.observe(r.id)).error).toBe('UNIVERSAL_TRANSACTION_PENDING');
  });
});

describe('L: pending, delayed, reverted, expired and refunded bridges', () => {
  const sol = () => workflow({ sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS.base.chain, inputAsset: token('solana'), outputAsset: token('base'),
    amount: '10000000', recipient: EVM_RECIPIENT });
  it('pending, then delayed past the attention window, then a late delivery is still verified and reconciled', async () => {
    const c = await setup(), w = sol(), confirmed = await executeSolana(c, (await reviewed(c, w, c.wallet.publicKey)).id, w);
    expect((await c.service.observe(confirmed.id))).toMatchObject({ phase: 'IN_FLIGHT', error: 'UNIVERSAL_DESTINATION_PENDING' });
    c.tick(3_601_000);
    expect(await c.service.observe(confirmed.id)).toMatchObject({ phase: 'RECOVERY_REQUIRED', error: 'UNIVERSAL_DELIVERY_DELAYED' });
    expect((await settle(c, await c.service.load(confirmed.id))).verdict).toBe('RECONCILED');
  });
  it('a reverted deposit fails the run; nothing is bridged', async () => {
    const c = await setup(), w = workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.solana.chain, inputAsset: native('base'),
      outputAsset: native('solana'), amount: '1000000000000000', recipient: solanaTestWallet().publicKey });
    const run = await reviewed(c, w, EVM_OWNER);
    const begun = await c.service.begin(run.id, EVM_OWNER, w);
    await c.service.handoff(run.id);
    c.chainOf('base').state.depositRevert = true;
    const { hash } = c.chainOf('base').wallet.send((begun as { transaction: { from: string; to: string; data: string; value: string } }).transaction);
    await c.service.report(run.id, { kind: 'HASH', hash });
    expect(await c.service.observe(run.id)).toMatchObject({ phase: 'FAILED', verdict: 'FAILED', error: 'UNIVERSAL_DEPOSIT_REVERTED' });
  });
  it('an expired Solana transaction that never landed is not executed; a fresh quote and Review are required', async () => {
    const c = await setup(), w = sol(), run = await reviewed(c, w, c.wallet.publicKey);
    const begun = await c.service.begin(run.id, c.wallet.publicKey, w);
    if (begun.ecosystem !== 'SOLANA') throw new Error('expected Solana');
    c.solana.state.dropSends = true;
    expect((await c.service.submit(run.id, c.wallet.sign(begun.unsignedTransaction))).attempts.at(-1)!.state).toBe('SUBMISSION_RESULT_UNKNOWN');
    c.solana.state.height += 1_000;
    const expired = await c.service.observe(run.id);
    expect(expired).toMatchObject({ phase: 'PREPARED', requote: true, error: 'UNIVERSAL_TRANSACTION_EXPIRED_NOT_EXECUTED', authorization: null });
    expect(expired.attempts.at(-1)!.state).toBe('NOT_FOUND');
    await expect(c.service.review(run.id, run.review.commitment, w)).rejects.toThrow('UNIVERSAL_REQUOTE_REQUIRED');
    const fresh = await c.service.refresh(run.id);
    expect((await c.service.review(run.id, fresh.review.commitment, w)).phase).toBe('AUTHORIZED');
  });
  it('a provider-reported refund is verified on chain before the run is REFUNDED', async () => {
    const c = await setup(), w = sol(), confirmed = await executeSolana(c, (await reviewed(c, w, c.wallet.publicKey)).id, w);
    const refund = c.solana.deliver({ recipient: c.wallet.publicKey, mint: USDC.solana, amount: 10_000_000n, orderId: confirmed.review.route.order.orderId });
    c.relayMock.setStatus(confirmed.review.route.quote.id, { status: 'refund', txHashes: [refund], failReason: 'EXECUTION_REVERTED' });
    expect(await c.service.observe(confirmed.id)).toMatchObject({ phase: 'REFUNDED', verdict: 'REFUNDED', refund: { recipient: c.wallet.publicKey, amount: '10000000' } });
  });
  it('a delivery below the reviewed minimum is divergent, never success', async () => {
    const c = await setup(), w = sol(), confirmed = await executeSolana(c, (await reviewed(c, w, c.wallet.publicKey)).id, w);
    const done = await settle(c, confirmed, BigInt(confirmed.review.route.minimumOutput) - 1n);
    expect(done).toMatchObject({ verdict: 'DIVERGENT', error: 'UNIVERSAL_DELIVERY_BELOW_MINIMUM' });
  });
});

describe('M: Phantom with legitimate Lighthouse protections', () => {
  it('accepts the reviewed message plus verified Lighthouse assertions; the guard is recorded', async () => {
    const c = await setup(), w = workflow({ sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS.base.chain, inputAsset: token('solana'),
      outputAsset: token('base'), amount: '10000000', recipient: EVM_RECIPIENT });
    const run = await reviewed(c, w, c.wallet.publicKey);
    const confirmed = await executeSolana(c, run.id, w, unsigned => applyMockedPhantomLighthouseGuards(unsigned, { lamportsAtLeast: 1_000_000n,
      tokenAccount: c.solana.ata(c.wallet.publicKey, USDC.solana), tokenAmountAtLeast: 1n }));
    expect(confirmed.phase).toBe('IN_FLIGHT');
    const attempt = confirmed.attempts.at(-1)!;
    expect(attempt.ecosystem === 'SOLANA' && attempt.walletGuard?.instructions.map(i => i.kind)).toEqual(['AssertAccountInfoMulti', 'AssertTokenAccountMulti']);
  });
});

describe('N: wrong chain, wrong recipient, modified quote, changed bytes, unexpected spender, invalid minimum, stale authorization', () => {
  const evmBridge = () => workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.solana.chain, inputAsset: token('base'),
    outputAsset: token('solana'), amount: '10000000', recipient: SOLANA_RECIPIENT });
  it('a Relay answer for another recipient, a modified order, changed calldata, another spender or a low minimum leaves no executable route', async () => {
    const c = await setup();
    const cases: [string, (raw: Record<string, any>) => void][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
      ['wrong recipient', raw => { raw.protocol.v2.orderData.output.payments[0].recipient = '6NTyH8FQ3sQqsqYXiDPHEDfQZjjqhwnUg8wH9Y1UgJWk'; }],
      ['modified quote', raw => { raw.protocol.v2.orderData.output.payments[0].minimumAmount = '1'; }],
      ['changed calldata', raw => { raw.steps[1].items[0].data.data = raw.steps[1].items[0].data.data.slice(0, -4) + 'beef'; }],
      ['unexpected spender', raw => { raw.steps[0].items[0].data.data = '0x095ea7b3' + '0'.repeat(24) + '9'.repeat(40) + raw.steps[0].items[0].data.data.slice(74); }],
      ['invalid minimum', raw => { raw.details.currencyOut.minimumAmount = '1'; }]];
    for (const [name, tamper] of cases) {
      c.relayMock.setTamper(tamper);
      await expect(c.service.simulate(evmBridge(), EVM_OWNER), name).rejects.toThrow(/^RELAY_.*MISMATCH$/);
    }
  });
  it('a source RPC on the wrong chain is refused', async () => {
    const c = await setup();
    const rpc = c.chainOf('base').rpc;
    c.chainOf('base').state.code.set('0x0', '');
    const wrong = createUniversalRouterService({ storage: createFileExecutionStorage(await mkdtemp(join(tmpdir(), 'flofi-universal-')), 'UNIVERSAL_BUSY'),
      evmRpcs: { [UNIVERSAL_NETWORKS.base.chain]: c.chainOf('arbitrum-one').rpc, [UNIVERSAL_NETWORKS.solana.chain]: rpc }, solanaRpc: c.solana.rpc,
      providers: { relay: createRelayProvider({ http: c.relayMock.http }) }, provenance: 'MOCKED', executionEnabled: true, now: () => new Date(c.now()), mockedDeployment: mockedUniversalDeployment() });
    await expect(wrong.simulate(evmBridge(), EVM_OWNER)).rejects.toThrow();
  });
  it('a re-quote worse than the reviewed minimum clears the authorization (ROUTE_CHANGED); nothing reaches the wallet', async () => {
    const c = await setup(), w = evmBridge(), run = await reviewed(c, w, EVM_OWNER);
    c.relayMock.setExpectedFactor(9_000n);
    await expect(c.service.begin(run.id, EVM_OWNER, w)).rejects.toThrow('ROUTE_CHANGED');
    expect(await c.service.load(run.id)).toMatchObject({ phase: 'PREPARED', authorization: null, requote: true, routeChanges: ['MINIMUM_OUTPUT_DECREASED'] });
  });
  it('a stale (expired) Review is refused and cleared', async () => {
    const c = await setup(), w = evmBridge(), run = await reviewed(c, w, EVM_OWNER);
    c.tick(121_000);
    await expect(c.service.begin(run.id, EVM_OWNER, w)).rejects.toThrow('UNIVERSAL_REVIEW_EXPIRED');
    expect((await c.service.load(run.id)).authorization).toBeNull();
  });
  it('P0: an approval confirmed after Review expiry is retained; a fresh Review resumes the same run at the deposit without another approval', async () => {
    const c = await setup(), w = evmBridge(), run = await reviewed(c, w, EVM_OWNER), chain = c.chainOf('base');
    const approval = await c.service.begin(run.id, EVM_OWNER, w);
    if (approval.ecosystem !== 'EVM') throw Error('expected EVM');
    expect(approval.attempt.step).toBe('APPROVAL');
    await c.service.handoff(run.id);
    const { hash } = chain.wallet.send(approval.transaction);
    await c.service.report(run.id, { kind: 'HASH', hash });
    expect(refreshBridgeAfterApproval(await c.service.load(run.id), w, false)).toBe(false);
    c.tick(121_000); chain.mine(); chain.mine(); chain.mine();
    const confirmed = await c.service.observe(run.id);
    expect(confirmed.attempts[0]).toMatchObject({ step: 'APPROVAL', state: 'CONFIRMED', transactionHash: hash, reconciled: true });
    expect(confirmed).toMatchObject({ verdict: 'PENDING', source: null, destination: null, evidence: null });
    expect(refreshBridgeAfterApproval(confirmed, w, false)).toBe(true);
    expect(refreshBridgeAfterApproval(confirmed, w, true)).toBe(false);
    expect(refreshBridgeAfterApproval(confirmed, { ...w, revision: w.revision + 1 }, false)).toBe(false);
    await expect(c.service.begin(run.id, EVM_OWNER, w)).rejects.toThrow('UNIVERSAL_REVIEW_EXPIRED');
    const fresh = await c.service.refresh(run.id);
    expect(fresh.id).toBe(run.id); expect(fresh.attempts).toEqual(confirmed.attempts);
    expect(fresh.authorization).toBeNull(); expect(Date.parse(fresh.review.expiresAt)).toBeGreaterThan(c.now());
    await expect(c.service.begin(run.id, EVM_OWNER, w)).rejects.toThrow('UNIVERSAL_REVIEW_REQUIRED');
    await c.service.review(run.id, fresh.review.commitment, w);
    const next = await c.service.begin(run.id, EVM_OWNER, w);
    expect(next.attempt.step).toBe('DEPOSIT');
    const durable = await c.service.load(run.id);
    expect(durable.attempts.filter(a => a.step === 'APPROVAL')).toHaveLength(1);
    expect(refreshBridgeAfterApproval(durable, w, false)).toBe(false);
    expect(durable).toMatchObject({ verdict: 'PENDING', source: null, destination: null, evidence: null });
  });
  it('Solana bytes changed by the wallet (an extra instruction) are refused, recorded and never broadcast', async () => {
    const c = await setup(), w = workflow({ sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS.base.chain, inputAsset: token('solana'),
      outputAsset: token('base'), amount: '10000000', recipient: EVM_RECIPIENT });
    const run = await reviewed(c, w, c.wallet.publicKey), begun = await c.service.begin(run.id, c.wallet.publicKey, w);
    if (begun.ecosystem !== 'SOLANA') throw new Error('expected Solana');
    const record = await c.service.submit(run.id, c.wallet.sign(begun.unsignedTransaction, message => {
      const m = parseMessageV0(message), ixs = decompileMessageV0(m, {});
      const transfer = { programId: '11111111111111111111111111111111', accounts: [{ pubkey: c.wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: 'HjcWJor6kDs1WtUp9CqaxiC3pq3pZyToQU7rPU5kbbqi', isSigner: false, isWritable: true }], data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]) };
      return serializeMessageV0(compileMessageV0(c.wallet.publicKey, [...ixs, transfer], m.blockhash, {}));
    }));
    expect(record.attempts.at(-1)).toMatchObject({ state: 'CANCELLED', note: 'UNIVERSAL_TRANSACTION_CHANGED' });
    expect(record.authorization).toBeNull();
    expect(c.solana.state.sent.size).toBe(0);
  });
  it('execution stays off unless the deployment opts in; the wrong owner is refused', async () => {
    const off = await setup({ executionEnabled: false }), w = evmBridge(), run = await reviewed(off, w, EVM_OWNER);
    await expect(off.service.begin(run.id, EVM_OWNER, w)).rejects.toThrow('UNIVERSAL_EXECUTION_NOT_ENABLED');
    const on = await setup(), r = await reviewed(on, w, EVM_OWNER);
    await expect(on.service.begin(r.id, EVM_RECIPIENT, w)).rejects.toThrow('UNIVERSAL_WRONG_OWNER');
  });
  it('the run log is append-only and validated', async () => {
    const c = await setup(), w = evmBridge(), run = await reviewed(c, w, EVM_OWNER);
    const line = JSON.stringify(run) + '\n', tampered = JSON.stringify({ ...run, review: { ...run.review, recipient: EVM_RECIPIENT } }) + '\n';
    expect(() => validateUniversalLog(new TextEncoder().encode(line))).not.toThrow();
    expect(() => validateUniversalLog(new TextEncoder().encode(tampered))).toThrow('UNIVERSAL_STORE_CORRUPT');
    expect(() => validateUniversalLog(new TextEncoder().encode(line + JSON.stringify({ ...run, phase: 'RECONCILED' }) + '\n'))).toThrow('UNIVERSAL_STORE_CORRUPT');
  });
});

describe('selection and honest unavailability', () => {
  it('non-executable providers are stated, never silently used; BEST_MINIMUM_OUTPUT picks among executable routes', async () => {
    const c = await setup(), w = workflow({ sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS.base.chain, inputAsset: token('solana'),
      outputAsset: token('base'), amount: '10000000', recipient: EVM_RECIPIENT, providers: ['lifi', 'relay', 'mayan'] });
    const run = await c.service.simulate(w, c.wallet.publicKey);
    expect(run.review.selection.considered.map(x => [x.provider, x.outcome, x.code])).toEqual([['lifi', 'NOT_EXECUTABLE', 'LIFI_BRIDGE_VERIFIER_NOT_IMPLEMENTED'],
      ['relay', 'SELECTED', null], ['mayan', 'NOT_EXECUTABLE', 'MAYAN_TRANSACTION_BUILDER_NOT_VERIFIED']]);
    const only = workflow({ sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS.base.chain, inputAsset: token('solana'),
      outputAsset: token('base'), amount: '10000000', recipient: EVM_RECIPIENT, providers: ['mayan'] });
    await expect(c.service.simulate(only, c.wallet.publicKey)).rejects.toThrow('MAYAN_TRANSACTION_BUILDER_NOT_VERIFIED');
    c.relayMock.setRefusal('Insufficient liquidity');
    await expect(c.service.simulate(w, c.wallet.publicKey)).rejects.toThrow('RELAY_INSUFFICIENT_LIQUIDITY');
  });
  it('a recipient that is not a wallet key is refused on Solana', async () => {
    const c = await setup(), w = workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.solana.chain, inputAsset: token('base'),
      outputAsset: token('solana'), amount: '10000000', recipient: RELAY_SOLANA_VAULT });
    await expect(c.service.simulate(w, EVM_OWNER)).rejects.toThrow('UNIVERSAL_RECIPIENT_OFF_CURVE');
  });
});


describe('P0: all 20 directions reach verified simulation and Review on MOCKED chains', () => {
  for (const { source, destination } of UNIVERSAL_DIRECTED_PAIRS) for (const crossToken of [false, true]) {
    it(`${source} → ${destination}: ${crossToken ? 'stablecoin → native' : 'native → native'}, authorization and reconciled delivery`, async () => {
      const c = await setup(), owner = source === 'solana' ? c.wallet.publicKey : EVM_OWNER;
      const w = workflow({ sourceChain: UNIVERSAL_NETWORKS[source].chain, destinationChain: UNIVERSAL_NETWORKS[destination].chain,
        inputAsset: crossToken ? token(source) : native(source), outputAsset: native(destination),
        amount: crossToken ? '25000000' : source === 'solana' ? '100000000' : '10000000000000000',
        recipient: source === 'solana' || destination === 'solana' ? 'CONNECTED_DESTINATION_WALLET' : 'CONNECTED_OWNER', slippageBps: 100 });
      const run = await reviewed(c, w, owner, destination === 'solana' ? SOLANA_RECIPIENT : EVM_RECIPIENT);
      expect(run.review.intent).toMatchObject({ inputAsset: crossToken ? token(source) : native(source), outputAsset: native(destination), slippageBps: 100 });
      expect(run.review.source.simulation.provenance).toBe('TRANSACTION_SIMULATION');
      expect(run.review.workflowHash).toMatch(/^0x[a-f0-9]{64}$/);
      expect(run.attempts).toEqual([]);
      const submitted = source === 'solana' ? await executeSolana(c, run.id, w) : await executeEvm(c, c.chainOf(source), run.id, w);
      const done = await settle(c, submitted);
      expect(done.verdict).toBe('RECONCILED');
      expect(done.evidence?.evidenceClass).toBe('MOCKED');
      expect(done.feeObligation).toMatchObject({ rateBps: 10, status: 'OBLIGATED', collection: 'NOT_SETTLED' });
    });
  }
  it('mandatory 1 Base USDC → Arbitrum WETH preserves token identities through quote, simulation, Review and mocked settlement', async () => {
    const weth: UniversalAssetRef = { kind: 'TOKEN', address: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', decimals: 18 };
    const c = await setup({ extraTokens: { 'eip155:42161': { [weth.address!]: 18 } } });
    const w = workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS['arbitrum-one'].chain,
      inputAsset: token('base'), outputAsset: weth, amount: '1000000', recipient: 'CONNECTED_OWNER', slippageBps: 100 });
    const run = await reviewed(c, w, EVM_OWNER);
    expect(run.review.tokens).toMatchObject({ input: { address: USDC.base, decimals: 6 }, output: { address: weth.address, decimals: 18 } });
    expect(run.review.route.outputToken).toMatchObject({ address: weth.address, decimals: 18 });
    expect(run.review.source.simulation.ownerDebit).toBe('1000000');
    expect((await settle(c, await executeEvm(c, c.chainOf('base'), run.id, w))).verdict).toBe('RECONCILED');
  });
});

describe('FIX-FINANCIAL-EXECUTION-TRUTH-001 submission safety', () => {
  const bridge = () => workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.solana.chain,
    inputAsset: token('base'), outputAsset: token('solana'), amount: '1000000', recipient: SOLANA_RECIPIENT });
  it('keeps an unresolved approval fenced after 15 minutes even when a node sees no pending transaction', async () => {
    const c = await setup(), w = bridge(), run = await reviewed(c, w, EVM_OWNER);
    await c.service.begin(run.id, EVM_OWNER, w); await c.service.handoff(run.id);
    await c.service.report(run.id, { kind: 'UNKNOWN' }); c.tick(16 * 60_000);
    const recovered = await c.service.observe(run.id);
    expect(recovered.attempts[0]?.state).toBe('SUBMISSION_RESULT_UNKNOWN');
    expect(universalNeedsObservation(recovered)).toBe(true);
    await expect(c.service.begin(run.id, EVM_OWNER, w)).rejects.toThrow();
  });
  it('binds the wallet request to the durable reserved nonce', async () => {
    const c = await setup(), w = bridge(), run = await reviewed(c, w, EVM_OWNER);
    const begun = await c.service.begin(run.id, EVM_OWNER, w);
    expect(begun.ecosystem === 'EVM' && begun.transaction).toMatchObject({ nonce: '0x' + BigInt(begun.attempt.ecosystem === 'EVM' ? begun.attempt.nonce : '0').toString(16) });
  });
  it('discovers the exact pending transaction after a lost wallet response without waiting for mining', async () => {
    const c = await setup(), base = c.chainOf('base'), w = bridge(), run = await reviewed(c, w, EVM_OWNER);
    const begun = await c.service.begin(run.id, EVM_OWNER, w); if (begun.ecosystem !== 'EVM') throw Error('EVM');
    await c.service.handoff(run.id);
    const sent = base.wallet.send(begun.transaction, { mineNow: false });
    await c.service.report(run.id, { kind: 'UNKNOWN' });
    const recovered = await c.service.observe(run.id);
    expect(recovered.attempts[0]).toMatchObject({ state: 'PENDING', transactionHash: sent.hash });
    await expect(c.service.begin(run.id, EVM_OWNER, w)).rejects.toThrow();
    sent.land(); expect((await c.service.observe(run.id)).attempts[0]?.state).toBe('CONFIRMED');
  });
  it('quarantines and reopens a legacy approval closed only by the unsafe timeout, preserving its original log', async () => {
    const c = await setup(), w = bridge(), run = await reviewed(c, w, EVM_OWNER);
    await c.service.begin(run.id, EVM_OWNER, w); await c.service.handoff(run.id);
    const unknown = await c.service.report(run.id, { kind: 'UNKNOWN' });
    const legacy = { ...unknown, phase: 'PREPARED', authorization: null, error: 'UNIVERSAL_SUBMISSION_EXPIRED_NOT_EXECUTED',
      attempts: unknown.attempts.map(a => ({ ...a, state: 'NOT_FOUND', note: 'UNIVERSAL_SUBMISSION_EXPIRED_NOT_EXECUTED' })) };
    const name = run.id + '.jsonl', before = await c.storage.log.read(name);
    await c.storage.log.extend(name, new TextEncoder().encode(new TextDecoder().decode(before!) + JSON.stringify(legacy) + '\n'), validateUniversalLog);
    await expect(c.service.refresh(run.id)).rejects.toThrow('UNIVERSAL_REFRESH_NOT_ALLOWED');
    const restored = await c.service.observe(run.id);
    expect(restored.attempts[0]).toMatchObject({ state: 'SUBMISSION_RESULT_UNKNOWN', note: 'UNIVERSAL_LEGACY_TIMEOUT_UNPROVEN' });
    expect(restored.observation?.outcome).toBe('UNDETERMINED');
    expect(universalNeedsObservation(restored)).toBe(true);
    await expect(c.service.begin(run.id, EVM_OWNER, w)).rejects.toThrow();
    expect(new TextDecoder().decode((await c.storage.log.read(name))!)).toContain(JSON.stringify(legacy));
  });
  it('observes a reverted approval with receipt costs and never treats it as a successful deposit', async () => {
    const c = await setup(), base = c.chainOf('base'), w = bridge(), run = await reviewed(c, w, EVM_OWNER);
    const begun = await c.service.begin(run.id, EVM_OWNER, w); if (begun.ecosystem !== 'EVM') throw Error('EVM');
    await c.service.handoff(run.id);
    const sent = base.wallet.send(begun.transaction); const receipt = base.state.receipts.get(sent.hash)!;
    base.state.receipts.set(sent.hash, { ...receipt, status: '0x0', logs: [] });
    await c.service.report(run.id, { kind: 'HASH', hash: sent.hash, attemptId: begun.attempt.attemptId });
    const observed = await c.service.observe(run.id);
    expect(observed.observation?.outcome).toBe('REVERTED');
    expect(observed.attempts[0]?.ecosystem === 'EVM' && observed.attempts[0].receipt?.gasCostWei).toBeTruthy();
    expect(observed.source).toBeNull(); expect(observed.evidence).toBeNull();
  });
  it('binds late wallet reports to their original attempt instead of the next deposit', async () => {
    const c = await setup(), base = c.chainOf('base'), w = bridge(), run = await reviewed(c, w, EVM_OWNER);
    const approval = await c.service.begin(run.id, EVM_OWNER, w); if (approval.ecosystem !== 'EVM') throw Error('EVM');
    await c.service.handoff(run.id); const hash = base.wallet.send(approval.transaction).hash;
    await c.service.report(run.id, { kind: 'HASH', hash }); await c.service.observe(run.id);
    const deposit = await c.service.begin(run.id, EVM_OWNER, w); await c.service.handoff(run.id);
    await expect(c.service.report(run.id, { kind: 'HASH', hash, attemptId: approval.attempt.attemptId })).rejects.toThrow('UNIVERSAL_ATTEMPT_ID_MISMATCH');
    expect((await c.service.load(run.id)).attempts.at(-1)?.attemptId).toBe(deposit.attempt.attemptId);
    expect((await c.service.load(run.id)).attempts.at(-1)?.transactionHash).toBeNull();
  });
  it('uses the same financial facts in Execute and saved history from PREPARED through partial execution and reconciliation', async () => {
    const c = await setup(), base = c.chainOf('base'), w = bridge();
    const project = (r: UniversalRecord) => {
      const source = { kind: 'universal', state: { record: r, busy: false, signing: false, recovered: false } } as ExecutionLifecycleSource;
      const context = createBaseSepoliaReviewContext();
      const life = projectExecutionLifecycle(w as unknown as Workflow, context, source);
      const current = { ...life, evidence: projectExecutionEvidence(source, life), stepEvidence: projectExecutionStepEvidence(source, life) };
      const detail: DashboardRunDetail = { run: { runId: r.id, workflowId: w.workflowId, flow: 'crosschain-universal', status: financialRunStatus(r),
        provenance: r.provenance, ownerAccount: r.owner, errorCode: r.error, needsObservation: universalNeedsObservation(r), attentionRequired: false,
        hasEvidence: !!r.evidence, createdAt: null, updatedAt: null }, record: r, attempts: [], evidence: [], evidenceUnavailable: false, recordUnavailable: false };
      const saved = projectDashboardRecord(detail, context)!;
      expect(saved).not.toBeNull(); expect(saved.state).toBe(current.state); expect(saved.evidence).toEqual(current.evidence);
      expect(projectDashboardRun(detail.run, saved).status).toBe(projectDashboardRun(detail.run, current).status);
      return current;
    };
    let r = await c.service.simulate(w, EVM_OWNER); expect(project(r).state).toBe('idle');
    r = await c.service.review(r.id, r.review.commitment, w);
    const begun = await c.service.begin(r.id, EVM_OWNER, w); if (begun.ecosystem !== 'EVM') throw Error('EVM');
    await c.service.handoff(r.id); r = await c.service.report(r.id, { kind: 'UNKNOWN' }); expect(project(r).state).toBe('uncertain');
    const hash = base.wallet.send(begun.transaction).hash; await c.service.report(r.id, { kind: 'HASH', hash }); r = await c.service.observe(r.id);
    const approval = project(r);
    expect(approval.evidence.knownCosts).toHaveLength(1);
    expect(approval.evidence.operations.APPROVAL?.values).toContainEqual({ label: 'Observed allowance', value: '1 USDC' });
    expect(approval.evidence.operations.DEPOSIT?.values).toEqual([]);
    const deposit = await c.service.begin(r.id, EVM_OWNER, w); if (deposit.ecosystem !== 'EVM') throw Error('EVM');
    await c.service.handoff(r.id);
    r = await c.service.walletFailure(r.id, { invoked: true, attemptId: deposit.attempt.attemptId, rejectionCode: 4001, code: 'UNIVERSAL_REJECTED',
      calls: [{ method: 'eth_sendTransaction', submission: true, error: { code: 4001 } }] });
    const partial = project(r); expect(partial.state).toBe('attention');
    expect(partial.evidence.knownCosts).toEqual(approval.evidence.knownCosts); expect(partial.evidence.operations.DEPOSIT?.failure).toBe('declined');
    expect(r.source).toBeNull();
    // A separate run has its own Review and explicit wallet requests. Recovery of the partial run never submits it.
    const next = await reviewed(c, { ...w, workflowId: 'another-workflow' }, EVM_OWNER);
    r = await executeEvm(c, base, next.id, next.workflow);
    expect(project(r).state).toBe('active'); expect(project(r).evidence.operations.DEPOSIT?.values.length).toBeGreaterThan(0);
    r = await settle(c, r); const done = project(r);
    expect(done.state).toBe('complete'); expect(done.evidence.operations.destination?.values.some(v => v.label === 'Actual received')).toBe(true);
  });
  it('records a definite wallet rejection separately and preserves it across repeated observation', async () => {
    const c = await setup(), w = bridge(), run = await reviewed(c, w, EVM_OWNER);
    await c.service.begin(run.id, EVM_OWNER, w); await c.service.handoff(run.id);
    const rejected = await c.service.walletFailure(run.id, { invoked: true, code: 'UNIVERSAL_REJECTED', rejectionCode: 4001,
      calls: [{ method: 'eth_sendTransaction', submission: true, error: { code: 4001 } }] });
    expect(rejected.attempts[0]).toMatchObject({ state: 'CANCELLED', note: 'UNIVERSAL_REJECTED', transactionHash: null });
    expect((await c.service.observe(run.id)).attempts).toEqual(rejected.attempts);
  });
});
