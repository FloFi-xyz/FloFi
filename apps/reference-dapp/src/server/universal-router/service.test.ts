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
import { UNIVERSAL_ROUTER_DEPLOYMENT } from '@defi-workflow-engine/action-registry';
import { applyMockedPhantomLighthouseGuards, compileMessageV0, parseMessageV0, decompileMessageV0, serializeMessageV0, RELAY_SOLANA_VAULT } from '@defi-workflow-engine/reference-compiler';
import { createUniversalBridgeNode, UNIVERSAL_DIRECTED_PAIRS, UNIVERSAL_NETWORKS, UNIVERSAL_QUOTE_SUBJECTS, type SemanticWorkflow, type UniversalAssetRef, type UniversalBridgeFields, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';
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
/** BUILD-FLOFI-MAINNET-EXEC-002: each network's pinned wrapped-native token (Base: WETH9; Arbitrum One: aeWETH) and how it logs a burn. */
const WETH = { base: '0x4200000000000000000000000000000000000006', 'arbitrum-one': '0x82af49447d8a07e3bd95bd0d56f35241523fbab1' } as const;
async function setup(options: { executionEnabled?: boolean; extraTokens?: Record<string, Record<string, number>>; wethPaidInNative?: boolean } = {}) {
  let clock = T0;
  const now = () => clock;
  const D = mockedUniversalDeployment();
  const tokens = (chain: string) => Object.fromEntries(Object.entries(USDC).filter(([k]) => UNIVERSAL_NETWORKS[k as UniversalNetworkKey].chain === chain).map(([, a]) => [a, 6]));
  const weth = (chain: string) => chain === 'eip155:8453' ? { [WETH.base]: 18 } : chain === 'eip155:42161' ? { [WETH['arbitrum-one']]: 18 } : {};
  const wrapped = (chain: string) => chain === 'eip155:8453' ? { [WETH.base]: 'WETH9' as const } : chain === 'eip155:42161' ? { [WETH['arbitrum-one']]: 'MINT_BURN' as const } : {};
  const evm: Record<string, EvmMock> = Object.fromEntries(Object.keys(D.evm).map(chain => [chain, createEvmMockChain(D.evm[chain]!, { now,
    tokens: { ...tokens(chain), ...options.wethPaidInNative ? weth(chain) : {}, ...options.extraTokens?.[chain] }, wrapped: options.wethPaidInNative ? wrapped(chain) : {} })]));
  const solana = createSolanaMock(D.solana, { mints: { [USDC.solana]: 6 } });
  const isWeth = (c: string) => (Object.values(WETH) as string[]).includes(c.toLowerCase());
  const decimals = (chainId: number, currency: string) => options.extraTokens?.[`eip155:${chainId}`]?.[currency] ?? (currency === '0x0000000000000000000000000000000000000000' || isWeth(currency) ? 18
    : currency === '11111111111111111111111111111111' ? 9 : 6);
  // 1 SOL = 150 USDC; 1 ETH (and WETH) = 4,000 USDC; 1 SOL = 0.0375 ETH. Stablecoins 1:1.
  const price = (c: string) => c === '11111111111111111111111111111111' ? 150n : c === '0x0000000000000000000000000000000000000000' || isWeth(c) ? 4000n : 1n;
  const relayMock = createRelayMock({ now, decimals, rate: (i, o) => 10n ** 18n * price(i) / price(o),
    symbol: (chainId, c) => c === '11111111111111111111111111111111' ? 'SOL' : c === '0x0000000000000000000000000000000000000000' ? 'ETH' : isWeth(c) ? 'WETH' : c === USDC.robinhood ? 'USDG' : 'USDC',
    ...options.wethPaidInNative ? { paidInNative: (_chainId: number, currency: string) => isWeth(currency) } : {} });
  const dir = await mkdtemp(join(tmpdir(), 'flofi-universal-'));
  const restart = () => createUniversalRouterService({ storage: createFileExecutionStorage(dir, 'UNIVERSAL_BUSY'), evmRpcs: Object.fromEntries(Object.entries(evm).map(([c, m]) => [c, m.rpc])),
    solanaRpc: solana.rpc, providers: { relay: createRelayProvider({ http: relayMock.http }) }, provenance: 'MOCKED', executionEnabled: options.executionEnabled ?? true,
    now: () => new Date(clock), mockedDeployment: D });
  const wallet = solanaTestWallet();
  solana.setLamports(wallet.publicKey, 2_000_000_000n);
  solana.setToken(wallet.publicKey, USDC.solana, 500_000_000n);
  for (const [chain, m] of Object.entries(evm)) {
    m.setNative(EVM_OWNER, 10n ** 18n);
    for (const t of Object.keys(tokens(chain))) m.setToken(t, EVM_OWNER, 1_000_000_000n);
    if (options.wethPaidInNative) for (const t of Object.keys(weth(chain))) m.setToken(t, EVM_OWNER, 10n ** 16n);
  }
  const chainOf = (key: UniversalNetworkKey) => evm[UNIVERSAL_NETWORKS[key].chain]!;
  return { service: restart(), restart, evm, solana, relayMock, wallet, chainOf, storage: createFileExecutionStorage(dir, 'UNIVERSAL_BUSY'), tick: (ms: number) => { clock += ms; }, now };
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
function financialView(record: UniversalRecord) {
  const source = { kind: 'universal', state: { record, busy: false, signing: false, recovered: false } } as ExecutionLifecycleSource;
  const progress = projectExecutionLifecycle(record.workflow as unknown as Workflow, createBaseSepoliaReviewContext(), source);
  return { progress, evidence: projectExecutionEvidence(source, progress) };
}

describe('native contract settlement', () => {
  const relayRouter = '0x0729e2a4716d9f7dd17858d5d504426d228697f7';
  const relayExecutor = '0x6d0a66df5f4a32be3656f63750e0253eb59d9399';
  async function inFlight(code = '0xef0100' + '63'.repeat(20)) {
    const c = await setup(), base = c.chainOf('base'), source = c.chainOf('arbitrum-one');
    base.state.code.set(EVM_OWNER, code);
    const w = workflow({ sourceChain: UNIVERSAL_NETWORKS['arbitrum-one'].chain, destinationChain: UNIVERSAL_NETWORKS.base.chain,
      inputAsset: native('arbitrum-one'), outputAsset: native('base'), amount: '500000000000000', recipient: 'CONNECTED_OWNER' });
    const run = await reviewed(c, w, EVM_OWNER);
    const confirmed = await executeEvm(c, source, run.id, w);
    return { c, base, source, confirmed, route: confirmed.review.route };
  }

  it('recovers a persisted FILLED hint with a Base Relay executor trace after a restart', async () => {
    const { c, base, source, confirmed, route } = await inFlight();
    expect(confirmed.review.recipientHasCode).toBe(true);
    const amount = BigInt(route.expectedOutput);
    const hash = base.deliver({ recipient: EVM_OWNER, token: null, amount, orderId: route.order.orderId, via: relayRouter, sender: relayExecutor });
    const trace = base.state.traces.get(hash), callTrace = base.state.callTraces.get(hash);
    // Neither trace namespace is available yet (as on a public node): nothing is proven.
    base.state.traces.delete(hash);
    base.state.callTraces.delete(hash);
    c.relayMock.setStatus(route.quote.id, { status: 'success', inTxHashes: [confirmed.source!.transactionHash], txHashes: [hash] });
    const unverified = await c.service.observe(confirmed.id);
    expect(unverified).toMatchObject({ error: 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE',
      verdict: 'PENDING', evidence: null, destination: null, lastHint: { status: 'FILLED' } });
    // Canvas, execution panels and history show the provider's claim as unverified; nothing reads as settled.
    const destinationOp = (record: UniversalRecord) => financialView(record).progress.steps.flatMap(step => step.operations).find(op => op.id.endsWith('destination'));
    expect(destinationOp(unverified)).toMatchObject({ state: 'pending', label: 'Provider reports delivery · awaiting independent verification', hash: null });
    expect(financialView(unverified).progress.state).not.toBe('completed');
    const listed = { runId: unverified.id, workflowId: 'w', flow: 'crosschain-universal', status: unverified.phase, provenance: 'MOCKED', ownerAccount: EVM_OWNER,
      errorCode: unverified.error, needsObservation: universalNeedsObservation(unverified), attentionRequired: false, hasEvidence: false, createdAt: null, updatedAt: null };
    expect(projectDashboardRun(listed)).toMatchObject({ status: 'In progress', message: 'Provider reports delivery · awaiting independent verification',
      attention: ['Awaiting an execution status check'] });
    c.tick(3_601_000);
    expect(await c.service.observe(confirmed.id)).toMatchObject({ phase: 'RECOVERY_REQUIRED', verdict: 'PENDING' });
    c.relayMock.setStatus(route.quote.id, { status: 'unknown' });
    base.state.traces.set(hash, trace);
    base.state.callTraces.set(hash, callTrace);
    const restarted = c.restart();
    expect(await restarted.observe(confirmed.id)).toMatchObject({ phase: 'DESTINATION_OBSERVED', verdict: 'PENDING', error: 'UNIVERSAL_AWAITING_FINALITY',
      received: amount.toString(), evidence: null, destination: { orderBound: true, final: false } });
    for (let i = 0; i < 3; i++) { source.mine(); base.mine(); }
    const reconciled = await restarted.observe(confirmed.id);
    expect(reconciled).toMatchObject({ phase: 'RECONCILED', verdict: 'RECONCILED', received: amount.toString(), destination: { transactionHash: hash, final: true },
      evidence: { received: amount.toString() }, attempts: confirmed.attempts });
    expect(destinationOp(reconciled)).toMatchObject({ state: 'confirmed', hash });
    expect(universalNeedsObservation(reconciled)).toBe(false);
    expect((await c.restart().observe(confirmed.id)).evidence?.bundleHash).toBe(reconciled.evidence?.bundleHash);
  });

  it.each([
    ['the trace reverted', 'reverted', 'UNIVERSAL_DELIVERY_RECIPIENT_MISMATCH'],
    ['the call paid a different wallet', 'wrong', 'UNIVERSAL_DELIVERY_RECIPIENT_MISMATCH'],
    ['the trace belongs to a different block', 'block', 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE'],
    ['a subtrace is missing', 'incomplete', 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE'],
    ['a recipient forwards part of the credit', 'debit', 'UNIVERSAL_DELIVERY_BELOW_MINIMUM'],
    ['the sender lacks solver authority', 'sender', 'UNIVERSAL_DELIVERY_ORDER_NOT_BOUND'],
    ['the tail identifies a different order', 'order', 'UNIVERSAL_DELIVERY_ORDER_NOT_BOUND'],
  ])('withholds evidence when %s', async (_description, change, error) => {
    const { c, base, confirmed, route } = await inFlight('0x6000');
    const amount = BigInt(route.minimumOutput);
    const hash = base.deliver({ recipient: change === 'wrong' ? EVM_RECIPIENT : EVM_OWNER, token: null, amount,
      orderId: change === 'order' ? '0x' + 'a1'.repeat(32) : route.order.orderId, via: relayRouter,
      ...(change === 'sender' ? { sender: EVM_RECIPIENT } : {}) });
    type Frame = { action: { from: string; to: string; value: string }; traceAddress: number[]; subtraces: number; blockHash: string; error?: string };
    const trace = base.state.traces.get(hash) as Frame[];
    // Exercise the Parity validator alone; the callTracer validator has its own cases below.
    base.state.callTraces.delete(hash);
    if (change === 'reverted') trace[2]!.error = 'Reverted';
    if (change === 'block') trace[2]!.blockHash = '0x' + '22'.repeat(32);
    if (change === 'incomplete') trace.pop();
    if (change === 'debit') {
      trace[2]!.subtraces = 1;
      trace.push({ ...trace[2]!, traceAddress: [1, 0], subtraces: 0, action: { ...trace[2]!.action, from: EVM_OWNER, to: EVM_RECIPIENT, value: '0x1' } });
    }
    c.relayMock.setStatus(route.quote.id, { status: 'success', txHashes: [hash] });
    expect(await c.service.observe(confirmed.id)).toMatchObject({ error, evidence: null, destination: null });
  });

  it.each([
    ['the recipient call reverted', 'reverted', 'UNIVERSAL_DELIVERY_RECIPIENT_MISMATCH'],
    ['the root frame is not this transaction', 'root', 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE'],
    ['a nested frame is malformed', 'malformed', 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE'],
    ['the recipient forwards part of the credit', 'debit', 'UNIVERSAL_DELIVERY_BELOW_MINIMUM'],
  ])('withholds callTracer evidence when %s', async (_description, change, error) => {
    const { c, base, confirmed, route } = await inFlight('0x6000');
    const hash = base.deliver({ recipient: EVM_OWNER, token: null, amount: BigInt(route.minimumOutput), orderId: route.order.orderId, via: relayRouter });
    type Call = { type: string; from: string; to: string; value: string; input: string; error?: string; calls?: Call[] };
    base.state.traces.delete(hash);
    const root = base.state.callTraces.get(hash) as Call, recipientCall = root.calls![1]!;
    if (change === 'reverted') recipientCall.error = 'execution reverted';
    if (change === 'root') root.value = '0x1';
    if (change === 'malformed') (root.calls as unknown[])[0] = { type: 'CALL', from: 'nope' };
    if (change === 'debit') recipientCall.calls = [{ type: 'CALL', from: EVM_OWNER, to: EVM_RECIPIENT, value: '0x1', input: '0x' }];
    c.relayMock.setStatus(route.quote.id, { status: 'success', txHashes: [hash] });
    expect(await c.service.observe(confirmed.id)).toMatchObject({ error, evidence: null, destination: null });
  });

  it.each(Object.values(UNIVERSAL_NETWORKS).filter(n => n.ecosystem === 'EVM' && n.key !== 'arbitrum-one').map(n => n.key))(
    'reconciles a RelayRouter fill to an EIP-7702 recipient on %s with only callTracer support', async key => {
      const c = await setup(), destination = c.chainOf(key), source = c.chainOf('arbitrum-one');
      destination.state.code.set(EVM_OWNER, '0xef0100' + '63'.repeat(20));
      const w = workflow({ sourceChain: UNIVERSAL_NETWORKS['arbitrum-one'].chain, destinationChain: UNIVERSAL_NETWORKS[key].chain,
        inputAsset: native('arbitrum-one'), outputAsset: native(key), amount: '500000000000000', recipient: 'CONNECTED_OWNER' });
      const confirmed = await executeEvm(c, source, (await reviewed(c, w, EVM_OWNER)).id, w), route = confirmed.review.route;
      const executors = UNIVERSAL_ROUTER_DEPLOYMENT.evm[route.destinationChain]!.relaySettlement!.executors;
      const hash = destination.deliver({ recipient: EVM_OWNER, token: null, amount: BigInt(route.expectedOutput), orderId: route.order.orderId,
        via: relayRouter, sender: executors.at(-1)! });
      destination.state.traces.delete(hash);
      c.relayMock.setStatus(route.quote.id, { status: 'success', txHashes: [hash] });
      for (let i = 0; i < 3; i++) { await c.service.observe(confirmed.id); source.mine(); destination.mine(); }
      expect(await c.service.observe(confirmed.id)).toMatchObject({ verdict: 'RECONCILED', received: route.expectedOutput,
        destination: { transactionHash: hash, orderBound: true, final: true }, evidence: { received: route.expectedOutput } });
    });

  it('derives a traced native credit again at finality: a changed trace diverges, an unavailable one keeps waiting', async () => {
    type Frame = { action: { value: string }; traceAddress: number[] };
    for (const change of ['changed', 'unavailable'] as const) {
      const { c, base, source, confirmed, route } = await inFlight();
      const hash = base.deliver({ recipient: EVM_OWNER, token: null, amount: BigInt(route.expectedOutput), orderId: route.order.orderId, via: relayRouter });
      c.relayMock.setStatus(route.quote.id, { status: 'success', txHashes: [hash] });
      expect(await c.service.observe(confirmed.id)).toMatchObject({ phase: 'DESTINATION_OBSERVED', destination: { final: false } });
      const parity = base.state.traces.get(hash), call = base.state.callTraces.get(hash);
      if (change === 'changed') {
        (parity as Frame[]).find(frame => frame.traceAddress.join() === '1')!.action.value = '0x' + (BigInt(route.minimumOutput) + 1n).toString(16);
        base.state.callTraces.delete(hash);
      } else { base.state.traces.delete(hash); base.state.callTraces.delete(hash); }
      for (let i = 0; i < 3; i++) { source.mine(); base.mine(); }
      const final = await c.service.observe(confirmed.id);
      if (change === 'changed') { expect(final).toMatchObject({ verdict: 'DIVERGENT', error: 'UNIVERSAL_DESTINATION_REORGANIZED', evidence: null }); continue; }
      expect(final).toMatchObject({ verdict: 'PENDING', error: 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE', destination: { final: false }, evidence: null });
      base.state.traces.set(hash, parity); base.state.callTraces.set(hash, call);
      expect(await c.service.observe(confirmed.id)).toMatchObject({ verdict: 'RECONCILED', destination: { final: true } });
    }
  });

  it('observes a contract-mediated native refund after source and refund finality', async () => {
    const { c, source, confirmed, route } = await inFlight();
    const hash = source.deliver({ recipient: EVM_OWNER, token: null, amount: 499_000_000_000_000n, orderId: route.order.orderId, via: relayRouter });
    c.relayMock.setStatus(route.quote.id, { status: 'refund', txHashes: [hash] });
    expect(await c.service.observe(confirmed.id)).toMatchObject({ phase: 'RECOVERY_REQUIRED', verdict: 'PENDING', refund: null });
    for (let i = 0; i < 3; i++) source.mine();
    expect(await c.service.observe(confirmed.id)).toMatchObject({ phase: 'REFUNDED', refund: { transactionHash: hash, token: 'native' }, destination: null, evidence: null });
  });

  it('rechecks a previously safe destination if the source was waiting for finality', async () => {
    const { c, base, source, confirmed, route } = await inFlight();
    const hash = base.deliver({ recipient: EVM_OWNER, token: null, amount: BigInt(route.expectedOutput), orderId: route.order.orderId, via: relayRouter });
    c.relayMock.setStatus(route.quote.id, { status: 'success', txHashes: [hash] });
    for (let i = 0; i < 3; i++) base.mine();
    const observed = await c.service.observe(confirmed.id);
    expect(observed).toMatchObject({ phase: 'DESTINATION_OBSERVED', source: { final: false }, destination: { final: true }, evidence: null });
    base.state.hashes.set(observed.destination!.position.height, '0x' + '2b'.repeat(32));
    for (let i = 0; i < 3; i++) source.mine();
    expect(await c.restart().observe(confirmed.id)).toMatchObject({ verdict: 'DIVERGENT', error: 'UNIVERSAL_DESTINATION_REORGANIZED', evidence: null });
  });
});

describe('direct destination executor settlement', () => {
  it.each([
    ['reviewed solver', null],
    ['registered Ethereum executor', null],
    ['unregistered sender', 'UNIVERSAL_DELIVERY_ORDER_NOT_BOUND'],
    ['different order', 'UNIVERSAL_DELIVERY_ORDER_NOT_BOUND'],
    ['different recipient', 'UNIVERSAL_DELIVERY_ORDER_NOT_BOUND'],
    ['below the reviewed minimum', 'UNIVERSAL_DELIVERY_BELOW_MINIMUM'],
  ])('checks a Base to Ethereum native payout from %s', async (scenario, error) => {
    const c = await setup(), source = c.chainOf('base'), destination = c.chainOf('ethereum');
    const w = workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.ethereum.chain,
      inputAsset: native('base'), outputAsset: native('ethereum'), amount: '1000000000000000', recipient: 'CONNECTED_OWNER' });
    const confirmed = await executeEvm(c, source, (await reviewed(c, w, EVM_OWNER)).id, w);
    const route = confirmed.review.route;
    const executor = UNIVERSAL_ROUTER_DEPLOYMENT.evm[route.destinationChain]!.relaySettlement!.executors.find(address => address !== route.order.solver)!;
    const amount = scenario === 'below the reviewed minimum' ? BigInt(route.minimumOutput) - 1n : BigInt(route.expectedOutput);
    const hash = destination.deliver({ recipient: scenario === 'different recipient' ? EVM_RECIPIENT : EVM_OWNER, token: null, amount,
      orderId: scenario === 'different order' ? '0x' + 'ab'.repeat(32) : route.order.orderId,
      sender: scenario === 'reviewed solver' ? route.order.solver : scenario === 'unregistered sender' ? EVM_RECIPIENT : executor });
    destination.state.txs.get(hash)!.type = '0x2';
    destination.state.receipts.get(hash)!.gasUsed = '0x5708';
    destination.state.traces.delete(hash); destination.state.callTraces.delete(hash);
    c.relayMock.setStatus(route.quote.id, { status: 'success', inTxHashes: [confirmed.source!.transactionHash], txHashes: [hash] });
    const early = await c.service.observe(confirmed.id);
    expect(early.evidence).toBeNull();
    if (error) {
      expect(early).toMatchObject({ error, destination: null, received: null });
      return;
    }
    expect(early).toMatchObject({ phase: 'DESTINATION_OBSERVED', destination: { transactionHash: hash, orderBound: true, final: false } });
    for (let i = 0; i < 3; i++) { source.mine(); destination.mine(); }
    const restarted = c.restart();
    const verified = await restarted.observe(confirmed.id);
    expect(verified).toMatchObject({ id: confirmed.id, verdict: 'RECONCILED', received: amount.toString(),
      source: { transactionHash: confirmed.source!.transactionHash }, destination: { transactionHash: hash, orderBound: true, final: true },
      evidence: { received: amount.toString() } });
    expect(verified.attempts.map(attempt => attempt.transactionHash)).toEqual(confirmed.attempts.map(attempt => attempt.transactionHash));
    expect((await restarted.observe(confirmed.id)).evidence?.bundleHash).toBe(verified.evidence?.bundleHash);
  });

  it('incident replay: a RECOVERY_REQUIRED run with a persisted FILLED hint reconciles in one ordinary observation once its final direct payout binds', async () => {
    // Shape of production run xuni-02c5…d970 (Base → Ethereum native; registered Ethereum executor; type 0x2; data === order id; 22,280 gas; no
    // logs; already final). The earlier verifier could not bind it; here that phase is emulated by an unsigned (type-less) transaction, which the
    // verifier refuses as ORDER_NOT_BOUND, and the later deploy by the canonical type-2 transaction. No deposit is resubmitted, no state forced.
    const c = await setup(), source = c.chainOf('base'), destination = c.chainOf('ethereum');
    const w = workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.ethereum.chain,
      inputAsset: native('base'), outputAsset: native('ethereum'), amount: '1000000000000000', recipient: 'CONNECTED_OWNER' });
    const confirmed = await executeEvm(c, source, (await reviewed(c, w, EVM_OWNER)).id, w);
    const route = confirmed.review.route, amount = BigInt(route.expectedOutput);
    const executor = UNIVERSAL_ROUTER_DEPLOYMENT.evm[route.destinationChain]!.relaySettlement!.executors.find(address => address !== route.order.solver)!;
    const hash = destination.deliver({ recipient: EVM_OWNER, token: null, amount, orderId: route.order.orderId, sender: executor });
    const tx = destination.state.txs.get(hash)!;
    delete (tx as { type?: string }).type;
    destination.state.receipts.get(hash)!.gasUsed = '0x5708';
    destination.state.traces.delete(hash); destination.state.callTraces.delete(hash);
    c.relayMock.setStatus(route.quote.id, { status: 'success', inTxHashes: [confirmed.source!.transactionHash], txHashes: [hash] });
    expect(await c.service.observe(confirmed.id)).toMatchObject({ error: 'UNIVERSAL_DELIVERY_ORDER_NOT_BOUND', verdict: 'PENDING', evidence: null,
      destination: null, lastHint: { status: 'FILLED' } });
    c.tick(3_601_000);
    const stuck = await c.service.observe(confirmed.id);
    expect(stuck).toMatchObject({ phase: 'RECOVERY_REQUIRED', verdict: 'PENDING', evidence: null });
    expect(universalNeedsObservation(stuck)).toBe(true);
    // Later: the delivery is past the safety depth before the first observation that can bind it, and the provider no longer answers.
    tx.type = '0x2';
    for (let i = 0; i < 3; i++) { source.mine(); destination.mine(); }
    c.relayMock.setStatus(route.quote.id, { status: 'unknown' });
    const restarted = c.restart();
    const reconciled = await restarted.observe(confirmed.id);
    expect(reconciled).toMatchObject({ phase: 'RECONCILED', verdict: 'RECONCILED', received: amount.toString(),
      destination: { transactionHash: hash, orderBound: true, final: true }, evidence: { received: amount.toString() } });
    // Native delivery: never an ERC-20 order proof.
    expect(reconciled.destination).not.toHaveProperty('orderProof');
    expect(reconciled.attempts.map(attempt => attempt.transactionHash)).toEqual(confirmed.attempts.map(attempt => attempt.transactionHash));
    expect(universalNeedsObservation(reconciled)).toBe(false);
    expect((await c.restart().observe(confirmed.id)).evidence?.bundleHash).toBe(reconciled.evidence?.bundleHash);
  });

  it.each([
    ['type 0x4', { type: '0x4' }, 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE'],
    ['gas above the direct cap', { gasUsed: '0x5a00' }, 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE'],
    ['recipient contract code', { code: '0x6000' }, 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE'],
    ['missing transaction type', { type: undefined }, 'UNIVERSAL_DELIVERY_ORDER_NOT_BOUND'],
  ])('refuses a registered-executor direct pay with %s when traces are unavailable', async (_label, change, error) => {
    const c = await setup(), source = c.chainOf('base'), destination = c.chainOf('ethereum');
    const w = workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.ethereum.chain,
      inputAsset: native('base'), outputAsset: native('ethereum'), amount: '1000000000000000', recipient: 'CONNECTED_OWNER' });
    const confirmed = await executeEvm(c, source, (await reviewed(c, w, EVM_OWNER)).id, w);
    const route = confirmed.review.route;
    const executor = UNIVERSAL_ROUTER_DEPLOYMENT.evm[route.destinationChain]!.relaySettlement!.executors.find(address => address !== route.order.solver)!;
    const hash = destination.deliver({ recipient: EVM_OWNER, token: null, amount: BigInt(route.expectedOutput), orderId: route.order.orderId, sender: executor });
    const tx = destination.state.txs.get(hash)!;
    if ('type' in change) {
      if (change.type === undefined) delete (tx as { type?: string }).type;
      else tx.type = change.type;
    } else tx.type = '0x2';
    destination.state.receipts.get(hash)!.gasUsed = 'gasUsed' in change ? change.gasUsed! : '0x5708';
    if ('code' in change) destination.state.code.set(EVM_OWNER, change.code!);
    destination.state.traces.delete(hash); destination.state.callTraces.delete(hash);
    c.relayMock.setStatus(route.quote.id, { status: 'success', inTxHashes: [confirmed.source!.transactionHash], txHashes: [hash] });
    expect(await c.service.observe(confirmed.id)).toMatchObject({ error, destination: null, received: null, evidence: null });
  });
});

describe('A–E: Solana ⇄ every EVM mainnet, verified source to verified delivery', () => {
  it('binds a bridge begin to the displayed Review and ignores an invalidation of an older commitment', async () => {
    const c = await setup();
    const w = workflow({ sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS.base.chain,
      inputAsset: token('solana'), outputAsset: token('base'), amount: '25000000', recipient: EVM_RECIPIENT });
    const run = await reviewed(c, w, c.wallet.publicKey);
    const stale = '0x' + '9'.repeat(64);
    await expect(c.service.invalidate(run.id, 'WALLET_CHANGED', stale)).resolves.toMatchObject({ authorization: run.review.commitment });
    await expect(c.service.begin(run.id, c.wallet.publicKey, w, stale)).rejects.toThrow('UNIVERSAL_REVIEW_CHANGED');
    expect((await c.service.load(run.id)).attempts).toEqual([]);
    await expect(c.service.begin(run.id, c.wallet.publicKey, w, run.review.commitment)).resolves.toMatchObject({
      attempt: { reviewCommitment: run.review.commitment, state: 'PREPARED' },
    });
  });
  it('refuses the quote subjects as owner and as an explicit or implicit destination', async () => {
    const c = await setup();
    const input = { sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.solana.chain,
      inputAsset: token('base'), outputAsset: token('solana'), amount: '5000000' };
    const implicit = workflow({ ...input, recipient: 'CONNECTED_DESTINATION_WALLET' });
    await expect(c.service.simulate(implicit, UNIVERSAL_QUOTE_SUBJECTS.EVM, c.wallet.publicKey)).rejects.toThrow('UNIVERSAL_OWNER_INVALID');
    await expect(c.service.simulate(implicit, EVM_OWNER, UNIVERSAL_QUOTE_SUBJECTS.SOLANA)).rejects.toThrow('UNIVERSAL_DESTINATION_WALLET_INVALID');
    await expect(c.service.simulate(workflow({ ...input, recipient: UNIVERSAL_QUOTE_SUBJECTS.SOLANA }), EVM_OWNER)).rejects.toThrow('UNIVERSAL_RECIPIENT_INVALID');
  });
  it('A. Solana USDC → Base USDC: one Solana signature, FloFi broadcasts once, Base delivery proven, evidence', async () => {
    const c = await setup(), w = workflow({ sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS.base.chain, inputAsset: token('solana'),
      outputAsset: token('base'), amount: '25000000', recipient: EVM_RECIPIENT });
    const run = await reviewed(c, w, c.wallet.publicKey);
    expect(run.review).toMatchObject({ owner: c.wallet.publicKey, recipient: EVM_RECIPIENT, recipientKind: 'EXPLICIT', authorizations: { sourceSignatures: 1, destinationAuthorization: 'NONE' },
      feePolicy: { flofiFee: 'WORKFLOW_0_80_PCT', flofiFeeRateBps: 80, flofiFeeBasis: 'COMPLETED_WORKFLOW_INPUT', flofiFeeCollection: 'OBLIGATION_RECORDED',
        networkFeeSymbol: 'SOL' }, selection: { selected: 'relay' }, source: { ecosystem: 'SOLANA', simulation: { ownerDebit: '25000000' } } });
    expect(run.phase).toBe('AUTHORIZED');
    const confirmed = await executeSolana(c, run.id, w);
    // Solana deposits are observed at finalized commitment, so the same observation moves the run on to IN_FLIGHT.
    expect(confirmed).toMatchObject({ phase: 'IN_FLIGHT', source: { ownerDebit: '25000000', final: true }, authorization: null });
    expect(c.solana.state.tokens.get(c.solana.ata(RELAY_SOLANA_VAULT, USDC.solana))?.amount).toBe(25_000_000n);
    const done = await settle(c, confirmed);
    expect(done).toMatchObject({ phase: 'RECONCILED', verdict: 'RECONCILED', received: done.review.route.expectedOutput, destination: { recipient: EVM_RECIPIENT, orderBound: true, final: true },
      feeObligation: { status: 'OBLIGATED', rateBps: 80, feeAmount: '200000', collection: 'NOT_SETTLED', notional: { amount: '25000000', symbol: 'USDC' } } });
    expect(done.evidence).toMatchObject({ evidenceClass: 'MOCKED', route: { provider: 'relay', orderId: done.review.route.order.orderId }, reconciliation: 'RECONCILED',
      feeObligation: { status: 'OBLIGATED', feeAmount: '200000' } });
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
  it('I/J. two independent bridges and two identical bridges from one wallet run side by side, each with its own order and delivery', { timeout: 20_000 }, async () => {
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
  it('J. one delivery cannot reconcile two identical bridges', { timeout: 15_000 }, async () => {
    const c = await setup();
    const w = () => workflow({ sourceChain: UNIVERSAL_NETWORKS.solana.chain, destinationChain: UNIVERSAL_NETWORKS.base.chain, inputAsset: token('solana'), outputAsset: token('base'),
      amount: '10000000', recipient: EVM_RECIPIENT });
    const w1 = w(), w2 = w();
    const one = await executeSolana(c, (await reviewed(c, w1, c.wallet.publicKey)).id, w1), two = await executeSolana(c, (await reviewed(c, w2, c.wallet.publicKey)).id, w2);
    const done = await settle(c, one);
    expect(done.verdict).toBe('RECONCILED');
    // The first payout is independently bound to another order, so the second run never attempts to claim it.
    c.relayMock.setStatus(two.review.route.quote.id, { status: 'success', txHashes: [done.destination!.transactionHash] });
    expect(await c.service.observe(two.id)).toMatchObject({ verdict: 'PENDING', error: 'UNIVERSAL_DELIVERY_ORDER_NOT_BOUND', destination: null });
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
  it('shows verified source debit, actual Solana cost and non-final destination amount without claiming reconciliation', async () => {
    const c = await setup(), w = sol(), confirmed = await executeSolana(c, (await reviewed(c, w, c.wallet.publicKey)).id, w);
    const pending = financialView(confirmed);
    expect(pending.progress.state).toBe('active');
    expect(pending.evidence.operations.DEPOSIT?.values).toContainEqual({ label: 'Executed input', value: '10 USDC' });
    expect(pending.evidence.knownCosts).toContainEqual(expect.objectContaining({ value: '0.00000705 SOL' }));
    expect(pending.evidence.operations.destination?.values ?? []).toEqual([]);
    const route = confirmed.review.route, base = c.chainOf('base');
    const hash = base.deliver({ recipient: route.recipient, token: route.outputToken.address, amount: BigInt(route.expectedOutput), orderId: route.order.orderId });
    c.relayMock.setStatus(route.quote.id, { status: 'success', inTxHashes: [confirmed.source!.transactionHash], txHashes: [hash] });
    const observed = await c.service.observe(confirmed.id), view = financialView(observed);
    expect(observed).toMatchObject({ verdict: 'PENDING', destination: { final: false } });
    expect(view.progress.steps[0]?.operations.at(-1)?.label).toBe('Destination observed · awaiting finality');
    expect(view.evidence.operations.destination?.values).toContainEqual(expect.objectContaining({ label: 'Destination amount observed · awaiting reconciliation' }));
    expect(view.evidence.operations.destination?.comparisons).toEqual([]);
    expect(view.progress.state).toBe('active');
  });
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
    const refunded = await c.service.observe(confirmed.id);
    expect(refunded).toMatchObject({ phase: 'REFUNDED', verdict: 'REFUNDED', refund: { recipient: c.wallet.publicKey, amount: '10000000' } });
    const view = financialView(refunded);
    expect(view.evidence.operations.destination?.values).toContainEqual({ label: 'Verified refund', value: '10 USDC' });
    expect(view.evidence.knownCosts).toContainEqual(expect.objectContaining({ value: '0.00000705 SOL' }));
    expect(view.progress.state).not.toBe('complete');
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
  it('BUILD-FLOFI-MAINNET-EXEC-002 (review round 3): a declined request superseded by the in-place re-quote leaves the run waiting for the fresh Review, not needing attention', async () => {
    const c = await setup(), w = evmBridge(), run = await reviewed(c, w, EVM_OWNER);
    const approval = await c.service.begin(run.id, EVM_OWNER, w); if (approval.ecosystem !== 'EVM') throw Error('EVM');
    await c.service.handoff(run.id);
    const declined = await c.service.walletFailure(run.id, { invoked: true, attemptId: approval.attempt.attemptId, rejectionCode: 4001, code: 'UNIVERSAL_REJECTED',
      calls: [{ method: 'eth_sendTransaction', submission: true, error: { code: 4001 } }] });
    // Under its own Review a declined request still needs the owner's attention (nothing is retried by itself).
    expect(financialView(declined).progress.state).toBe('attention');
    c.tick(121_000); for (const m of Object.values(c.evm)) m.mine();
    const fresh = await c.service.refresh(run.id);
    expect(fresh.id).toBe(run.id); expect(fresh.attempts.at(-1)).toMatchObject({ step: 'APPROVAL', state: 'CANCELLED' });
    // Re-quoted in place: the never-sent attempt stays recorded (and in the evidence), and the run waits for the fresh Review's authorization.
    const view = financialView(fresh);
    expect(view.progress).toMatchObject({ started: false, state: 'idle', message: 'An earlier wallet request was not sent and the route was re-quoted. Review the fresh quote and authorize it again.' });
    expect(view.progress.steps[0]?.label).toBe('Awaiting authorization');
    // The declined request stays in the evidence as an earlier request, never as the failure of the fresh approval.
    expect(view.evidence.operations.APPROVAL?.failure).toBeUndefined();
    expect(JSON.stringify(view.evidence)).toContain('APPROVAL · UNIVERSAL_REJECTED');
    await c.service.review(run.id, fresh.review.commitment, w);
    expect((await c.service.begin(run.id, EVM_OWNER, w)).attempt.step).toBe('APPROVAL');
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
      expect(done.feeObligation).toMatchObject({ rateBps: 80, status: 'OBLIGATED', collection: 'NOT_SETTLED' });
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
    // Review round 3: proven on chain, the attempt no longer carries the earlier uncertainty note (its evidence would call it uncertain).
    sent.land(); expect((await c.service.observe(run.id)).attempts[0]).toMatchObject({ state: 'CONFIRMED', note: null });
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
    // P0 hotfix: the approval's own, already-recorded hash delivered again (the browser outbox) is an idempotent no-op answered with the record
    // (before the hotfix it was refused, so the outbox re-delivered it forever); it is never bound to the deposit, and any other hash is refused.
    const before = await c.service.load(run.id);
    expect(await c.service.report(run.id, { kind: 'HASH', hash, attemptId: approval.attempt.attemptId })).toEqual(before);
    await expect(c.service.report(run.id, { kind: 'HASH', hash: '0x' + 'cd'.repeat(32), attemptId: approval.attempt.attemptId })).rejects.toThrow('UNIVERSAL_ATTEMPT_ID_MISMATCH');
    await expect(c.service.report(run.id, { kind: 'UNKNOWN', attemptId: approval.attempt.attemptId })).rejects.toThrow('UNIVERSAL_ATTEMPT_ID_MISMATCH');
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

describe('BUILD-FLOFI-MAINNET-EXEC-002 WETH paid to Relay as native ETH (the owner\'s own unwrap, then the native deposit)', () => {
  it('Arbitrum One WETH → Solana USDC: Review plans the unwrap and the deposit; each executes in order and is proven; delivery reconciles', async () => {
    const c = await setup({ wethPaidInNative: true }), arb = c.chainOf('arbitrum-one');
    const w = workflow({ sourceChain: 'eip155:42161', destinationChain: UNIVERSAL_NETWORKS.solana.chain, inputAsset: { kind: 'TOKEN', address: WETH['arbitrum-one'], decimals: 18 },
      outputAsset: token('solana'), amount: '500000000000000', recipient: 'CONNECTED_DESTINATION_WALLET' });
    const run = await reviewed(c, w, EVM_OWNER, SOLANA_RECIPIENT);
    const route = run.review.route, src = run.review.source;
    expect(route.inputToken).toMatchObject({ kind: 'TOKEN', address: WETH['arbitrum-one'], symbol: 'WETH' });
    expect(route.source).toMatchObject({ ecosystem: 'EVM', approval: null, unwrap: { token: WETH['arbitrum-one'], amount: '500000000000000' }, deposit: { value: '500000000000000' } });
    expect(src.ecosystem === 'EVM' && src.calls.map(call => [call.purpose, call.value])).toEqual([['UNWRAP', '0'], ['BRIDGE_DEPOSIT', '500000000000000']]);
    expect(src.ecosystem === 'EVM' && src.approvals).toEqual([]);
    expect(run.review.authorizations.sourceSignatures).toBe(2);
    expect(run.review.recipient).toBe(SOLANA_RECIPIENT);
    // First request: the unwrap only, proven from aeWETH's own burn; the owner now holds the input as native ETH.
    const first = await c.service.begin(run.id, EVM_OWNER, w);
    expect(first.attempt.step).toBe('UNWRAP');
    if (first.ecosystem !== 'EVM') throw new Error('expected EVM');
    expect(first.transaction).toMatchObject({ to: WETH['arbitrum-one'], value: '0x0' });
    await c.service.handoff(run.id);
    await c.service.report(run.id, { kind: 'HASH', hash: arb.wallet.send(first.transaction).hash });
    const unwrapped = await c.service.observe(run.id);
    expect(unwrapped.attempts[0]).toMatchObject({ step: 'UNWRAP', state: 'CONFIRMED', reconciled: true });
    // Review P2: the owner's native balance rose by exactly the input minus the fee they paid (proven, so no note).
    expect(unwrapped.attempts[0]!.note ?? null).toBeNull();
    // Review round 2: the observation says the WETH is ETH now and the deposit still needs its own request (never "source confirmed").
    expect(unwrapped.observation).toMatchObject({ outcome: 'UNWRAP_CONFIRMED' });
    expect(unwrapped).toMatchObject({ phase: 'AUTHORIZED', verdict: 'PENDING', source: null });
    // Second request: the exact native deposit of the order.
    const second = await c.service.begin(run.id, EVM_OWNER, w);
    if (second.ecosystem !== 'EVM') throw new Error('expected EVM');
    expect(second.attempt.step).toBe('DEPOSIT');
    expect(second.transaction).toMatchObject({ to: route.source.ecosystem === 'EVM' ? route.source.deposit.to : '', value: '0x' + 500000000000000n.toString(16) });
    await c.service.handoff(run.id);
    await c.service.report(run.id, { kind: 'HASH', hash: arb.wallet.send(second.transaction).hash });
    const deposited = await c.service.observe(run.id);
    expect(deposited.phase).toMatch(/SOURCE_CONFIRMED|IN_FLIGHT/);
    expect(deposited.source).toMatchObject({ ownerDebit: '500000000000000', orderId: route.order.orderId });
    const done = await settle(c, deposited);
    expect(done).toMatchObject({ phase: 'RECONCILED', verdict: 'RECONCILED' });
    expect(financialView(done).progress.steps.flatMap(step => step.operations.map(operation => operation.title))).toEqual(expect.arrayContaining(['Unwrap WETH to ETH', 'Bridge deposit']));
  });
  it('after a confirmed unwrap, a re-quote reviews only the native deposit (the owner holds ETH now); nothing is unwrapped twice', async () => {
    const c = await setup({ wethPaidInNative: true }), base = c.chainOf('base');
    const w = workflow({ sourceChain: 'eip155:8453', destinationChain: 'eip155:42161', inputAsset: { kind: 'TOKEN', address: WETH.base, decimals: 18 },
      outputAsset: token('arbitrum-one'), amount: '1000000000000000', recipient: 'CONNECTED_OWNER' });
    const run = await reviewed(c, w, EVM_OWNER);
    const first = await c.service.begin(run.id, EVM_OWNER, w);
    if (first.ecosystem !== 'EVM') throw new Error('expected EVM');
    await c.service.handoff(run.id);
    await c.service.report(run.id, { kind: 'HASH', hash: base.wallet.send(first.transaction).hash });
    expect((await c.service.observe(run.id)).attempts[0]).toMatchObject({ step: 'UNWRAP', state: 'CONFIRMED', reconciled: true }); // WETH9 Withdrawal proven
    c.tick(10 * 60_000); for (const m of Object.values(c.evm)) m.mine(); // the Review expires: the run is re-quoted in place
    await expect(c.service.begin(run.id, EVM_OWNER, w)).rejects.toThrow('UNIVERSAL_REVIEW_EXPIRED');
    const fresh = await c.service.refresh(run.id);
    expect(fresh.review.source.ecosystem === 'EVM' && fresh.review.source.calls.map(call => call.purpose)).toEqual(['BRIDGE_DEPOSIT']);
    await c.service.review(run.id, fresh.review.commitment, w);
    const next = await c.service.begin(run.id, EVM_OWNER, w);
    expect(next.attempt.step).toBe('DEPOSIT');
    expect(next.record.attempts.filter(a => a.step === 'UNWRAP')).toHaveLength(1);
  });
  it('review P1: a refund of an unwrapped order is verified in what was paid — native ETH to the owner on the source chain', async () => {
    const c = await setup({ wethPaidInNative: true }), base = c.chainOf('base');
    const w = workflow({ sourceChain: 'eip155:8453', destinationChain: 'eip155:42161', inputAsset: { kind: 'TOKEN', address: WETH.base, decimals: 18 },
      outputAsset: token('arbitrum-one'), amount: '1000000000000000', recipient: 'CONNECTED_OWNER' });
    const run = await reviewed(c, w, EVM_OWNER);
    const deposited = await executeEvm(c, base, run.id, w);
    expect(deposited.source).toMatchObject({ ownerDebit: '1000000000000000' });
    const refund = base.deliver({ recipient: EVM_OWNER, token: null, amount: 1_000_000_000_000_000n, orderId: deposited.review.route.order.orderId });
    c.relayMock.setStatus(deposited.review.route.quote.id, { status: 'refund', txHashes: [refund], failReason: 'EXECUTION_REVERTED' });
    base.mine(); base.mine(); base.mine();
    const refunded = await c.service.observe(run.id);
    expect(refunded).toMatchObject({ phase: 'REFUNDED', verdict: 'REFUNDED', refund: { chainId: 'eip155:8453', recipient: EVM_OWNER, token: 'native', amount: '1000000000000000' } });
  });
  it('review P2: after a confirmed unwrap, a fresh route that no longer takes ETH is refused with what happened (the ETH stays the owner\'s)', async () => {
    const c = await setup({ wethPaidInNative: true }), base = c.chainOf('base');
    const w = workflow({ sourceChain: 'eip155:8453', destinationChain: 'eip155:42161', inputAsset: { kind: 'TOKEN', address: WETH.base, decimals: 18 },
      outputAsset: token('arbitrum-one'), amount: '1000000000000000', recipient: 'CONNECTED_OWNER' });
    const run = await reviewed(c, w, EVM_OWNER);
    const first = await c.service.begin(run.id, EVM_OWNER, w);
    if (first.ecosystem !== 'EVM') throw new Error('expected EVM');
    await c.service.handoff(run.id);
    await c.service.report(run.id, { kind: 'HASH', hash: base.wallet.send(first.transaction).hash });
    expect((await c.service.observe(run.id)).attempts[0]).toMatchObject({ step: 'UNWRAP', state: 'CONFIRMED' });
    // Relay now answers this WETH order as an ERC-20 payment (no native unwrap path).
    c.relayMock.setPaidInNative(() => false);
    await expect(c.service.refresh(run.id)).rejects.toThrow('UNIVERSAL_UNWRAP_DONE_ROUTE_CHANGED');
  });
  it('the unwrap is only for the pinned wrapped-native token: a native-paid answer for another token stays a mismatch', async () => {
    const c = await setup({ wethPaidInNative: true });
    c.relayMock.setTamper(raw => { raw.protocol.v2.paymentDetails.currency = '0x0000000000000000000000000000000000000000'; });
    const w = workflow({ sourceChain: 'eip155:8453', destinationChain: 'eip155:42161', inputAsset: token('base'), outputAsset: token('arbitrum-one'), amount: '2000000', recipient: 'CONNECTED_OWNER' });
    await expect(c.service.simulate(w, EVM_OWNER)).rejects.toThrow('RELAY_PAYMENT_MISMATCH');
  });
});

describe('BUILD-P0-MAINNET-EXECUTION-RELIABILITY: pre-send wallet nonce refusals (Incident A, D)', () => {
  // Base USDC → Solana USDC (the incident route category); an ERC-20 input, so the first wallet request is the exact approval.
  const evmBridge = () => workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.solana.chain, inputAsset: token('base'),
    outputAsset: token('solana'), amount: '10000000', recipient: SOLANA_RECIPIENT });
  const nonceRefusal = (attemptId: string, nonce: { reviewed: string; wallet: string | null; relation: 'WALLET_AHEAD' | 'WALLET_BEHIND' | 'INVALID'; reads: number }, code: string) =>
    ({ invoked: false, attemptId, code, nonce, calls: [{ method: 'eth_accounts' }, { method: 'eth_chainId' }, { method: 'eth_getTransactionCount', result: nonce.wallet === null ? null : '0x' + BigInt(nonce.wallet).toString(16) }] });

  it('records both sides of the disagreement, never as a submission, and the same run and workflow continue after a fresh Review (same reserved nonce)', async () => {
    const c = await setup(), base = c.chainOf('base'), w = evmBridge(), run = await reviewed(c, w, EVM_OWNER);
    // The incident sequence: an Aave transaction confirmed just before (nonce 15) → FloFi reads 16 as next.
    base.state.nonces.set(EVM_OWNER, 16); base.mine();
    const begun = await c.service.begin(run.id, EVM_OWNER, w); if (begun.ecosystem !== 'EVM' || begun.attempt.ecosystem !== 'EVM') throw Error('EVM');
    expect(begun.attempt.nonce).toBe('16');
    const refused = await c.service.walletFailure(run.id, nonceRefusal(begun.attempt.attemptId, { reviewed: '16', wallet: '17', relation: 'WALLET_AHEAD', reads: 1 }, 'UNIVERSAL_WALLET_NONCE_AHEAD'));
    const cancelled = refused.attempts.at(-1)!;
    expect(cancelled).toMatchObject({ state: 'CANCELLED', note: 'UNIVERSAL_WALLET_NONCE_AHEAD', transactionHash: null,
      nonceCheck: { reviewed: '16', wallet: '17', walletRelation: 'WALLET_AHEAD', reads: 1, chainLatest: '16', chainPending: '16', chainRelation: 'UNCHANGED' } });
    expect(refused).toMatchObject({ verdict: 'PENDING', phase: 'PREPARED', authorization: null, error: 'UNIVERSAL_WALLET_NONCE_AHEAD' });
    // Nothing is observed for it (no hash, nothing in flight) and every consumer view says "not submitted", never "needs on-chain recovery".
    expect(universalNeedsObservation(refused)).toBe(false);
    expect(financialRunStatus(refused)).not.toMatch(/UNKNOWN|PENDING|SUBMITTING/);
    const { progress } = financialView(refused);
    const op = progress.steps.flatMap(s => s.operations).find(o => o.id === 'APPROVAL')!;
    expect(op).toMatchObject({ state: 'not-submitted', hash: null, reason: 'UNIVERSAL_WALLET_NONCE_AHEAD' });
    const { projectExecutionResult, refreshableAfterNothingSent } = await import('../../domain/execution-result');
    expect(projectExecutionResult(progress)).toMatchObject({ label: 'Transaction not submitted',
      message: 'Your wallet shows a pending transaction that FloFi does not see on the network yet, so nothing was sent by FloFi. Check pending transactions in your wallet, then refresh and review this step again.' });
    expect(refreshableAfterNothingSent(progress)).toBe(true);
    // The log round-trips (the new evidence passes the store validator) and the run is re-reviewable in place.
    await roundTripLog(c, run.id);
    await c.service.review(run.id, refused.review.commitment, w);
    const again = await c.service.begin(run.id, EVM_OWNER, w); if (again.ecosystem !== 'EVM' || again.attempt.ecosystem !== 'EVM') throw Error('EVM');
    // The nonce reservation was released with the refusal: the second attempt reserves the same, still-next nonce — never skips ahead.
    expect(again.attempt).toMatchObject({ step: 'APPROVAL', nonce: '16', state: 'PREPARED' });
    await c.service.handoff(run.id);
    const { hash } = base.wallet.send(again.transaction);
    await c.service.report(run.id, { kind: 'HASH', hash });
    expect((await c.service.observe(run.id)).attempts.at(-1)).toMatchObject({ step: 'APPROVAL', state: 'CONFIRMED', transactionHash: hash });
  });

  it('a slot really consumed by another transaction is classified from the chain itself, not from the wallet', async () => {
    const c = await setup(), base = c.chainOf('base'), w = evmBridge(), run = await reviewed(c, w, EVM_OWNER);
    const begun = await c.service.begin(run.id, EVM_OWNER, w); if (begun.attempt.ecosystem !== 'EVM') throw Error('EVM');
    const reviewedNonce = Number(begun.attempt.nonce);
    base.state.nonces.set(EVM_OWNER, reviewedNonce + 1); base.state.pending.delete(EVM_OWNER); base.mine();
    const refused = await c.service.walletFailure(run.id, nonceRefusal(begun.attempt.attemptId, { reviewed: begun.attempt.nonce, wallet: String(reviewedNonce + 1), relation: 'WALLET_AHEAD', reads: 1 }, 'UNIVERSAL_WALLET_NONCE_AHEAD'));
    expect((refused.attempts.at(-1) as { nonceCheck?: unknown }).nonceCheck).toMatchObject({ chainRelation: 'CONSUMED', chainLatest: String(reviewedNonce + 1) });
    // A fresh preparation reads the new next nonce; it never reuses the consumed one.
    await c.service.review(run.id, refused.review.commitment, w);
    const again = await c.service.begin(run.id, EVM_OWNER, w); if (again.attempt.ecosystem !== 'EVM') throw Error('EVM');
    expect(again.attempt.nonce).toBe(String(reviewedNonce + 1));
  });

  it('drops browser evidence that is not for the attempt’s own nonce or not a canonical count', async () => {
    const c = await setup(), w = evmBridge(), run = await reviewed(c, w, EVM_OWNER);
    const begun = await c.service.begin(run.id, EVM_OWNER, w); if (begun.attempt.ecosystem !== 'EVM') throw Error('EVM');
    const forged = await c.service.walletFailure(run.id, { ...nonceRefusal(begun.attempt.attemptId, { reviewed: '999', wallet: '1000', relation: 'WALLET_AHEAD', reads: 7 }, 'UNIVERSAL_WALLET_NONCE_MISMATCH') });
    expect((forged.attempts.at(-1) as { nonceCheck?: unknown }).nonceCheck).toMatchObject({ reviewed: begun.attempt.nonce, wallet: null, walletRelation: 'INVALID', reads: 1 });
  });

  it('a proven wallet refusal is named by the server from its refusal code, never by the client label (security review)', async () => {
    const c = await setup(), w = evmBridge(), run = await reviewed(c, w, EVM_OWNER);
    const begun = await c.service.begin(run.id, EVM_OWNER, w); if (begun.attempt.ecosystem !== 'EVM') throw Error('EVM');
    await c.service.handoff(run.id);
    const refused = await c.service.walletFailure(run.id, { invoked: true, attemptId: begun.attempt.attemptId, rejectionCode: 4001, code: 'UNIVERSAL_WALLET_NONCE_AHEAD',
      calls: [{ method: 'eth_sendTransaction', submission: true, error: { code: 4001 } }] });
    expect(refused.attempts.at(-1)).toMatchObject({ state: 'CANCELLED', note: 'UNIVERSAL_REJECTED' });
    expect((refused.attempts.at(-1) as { nonceCheck?: unknown }).nonceCheck).toBeUndefined();
  });
  it('a submitted request can never be recorded as a pre-send nonce refusal', async () => {
    const c = await setup(), w = evmBridge(), run = await reviewed(c, w, EVM_OWNER);
    const begun = await c.service.begin(run.id, EVM_OWNER, w); if (begun.attempt.ecosystem !== 'EVM') throw Error('EVM');
    await c.service.handoff(run.id);
    await expect(c.service.walletFailure(run.id, nonceRefusal(begun.attempt.attemptId, { reviewed: begun.attempt.nonce, wallet: begun.attempt.nonce, relation: 'INVALID', reads: 1 },
      'UNIVERSAL_WALLET_NONCE_MISMATCH'))).rejects.toThrow('UNIVERSAL_DIAGNOSTIC_NOT_PRE_SUBMISSION');
  });

  it('repeated pre-send refusals stop cleanly at the run’s attempt limit (a fresh simulation starts a new run)', async () => {
    const c = await setup(), w = evmBridge();
    let run = await reviewed(c, w, EVM_OWNER);
    for (let i = 0; i < 16; i++) {
      const begun = await c.service.begin(run.id, EVM_OWNER, w); if (begun.attempt.ecosystem !== 'EVM') throw Error('EVM');
      run = await c.service.walletFailure(run.id, nonceRefusal(begun.attempt.attemptId, { reviewed: begun.attempt.nonce, wallet: '0', relation: 'WALLET_BEHIND', reads: 3 }, 'UNIVERSAL_WALLET_NONCE_BEHIND'));
      run = await c.service.review(run.id, run.review.commitment, w);
    }
    await expect(c.service.begin(run.id, EVM_OWNER, w)).rejects.toThrow('UNIVERSAL_ATTEMPT_LIMIT_SIMULATE_AGAIN');
    expect((await roundTripLog(c, run.id)).attempts).toHaveLength(16);
    const fresh = await c.service.simulate(w, EVM_OWNER);
    expect(fresh.id).not.toBe(run.id);
  }, 60_000);

  it('Base USDC → Solana USDC records whether the explicit recipient already holds a USDC token account (Incident C); EVM deliveries record none', async () => {
    const c = await setup(), w = workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.solana.chain, inputAsset: token('base'),
      outputAsset: token('solana'), amount: '1000000', recipient: SOLANA_RECIPIENT });
    const missing = await c.service.simulate(w, EVM_OWNER);
    expect(missing.review.destination.recipientTokenAccount).toBe('MISSING');
    c.solana.setToken(SOLANA_RECIPIENT, USDC.solana, 1n);
    const exists = await c.service.simulate(w, EVM_OWNER);
    expect(exists.review.destination.recipientTokenAccount).toBe('EXISTS');
    expect(exists.review.recipient).toBe(SOLANA_RECIPIENT);
    const toEvm = await c.service.simulate(workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS['arbitrum-one'].chain, inputAsset: token('base'),
      outputAsset: token('arbitrum-one'), amount: '1000000', recipient: 'CONNECTED_OWNER' }), EVM_OWNER);
    expect(toEvm.review.destination.recipientTokenAccount).toBeUndefined();
  });
  it('Base USDC → Solana USDC with an explicit recipient: the approval refusal keeps the explicit Solana recipient and Base-native gas', async () => {
    const c = await setup(), w = workflow({ sourceChain: UNIVERSAL_NETWORKS.base.chain, destinationChain: UNIVERSAL_NETWORKS.solana.chain, inputAsset: token('base'),
      outputAsset: token('solana'), amount: '1000000', recipient: SOLANA_RECIPIENT });
    const run = await reviewed(c, w, EVM_OWNER);
    expect(run.review).toMatchObject({ recipient: SOLANA_RECIPIENT, recipientKind: 'EXPLICIT' });
    expect(run.review.feePolicy.networkFeeSymbol).toBe('ETH');
    const begun = await c.service.begin(run.id, EVM_OWNER, w); if (begun.attempt.ecosystem !== 'EVM') throw Error('EVM');
    expect(begun.attempt.step).toBe('APPROVAL');
    const refused = await c.service.walletFailure(run.id, nonceRefusal(begun.attempt.attemptId, { reviewed: begun.attempt.nonce, wallet: '0', relation: 'WALLET_BEHIND', reads: 3 }, 'UNIVERSAL_WALLET_NONCE_BEHIND'));
    expect(refused.review).toMatchObject({ recipient: SOLANA_RECIPIENT, recipientKind: 'EXPLICIT' });
    expect(refused.review.route.recipient).toBe(SOLANA_RECIPIENT);
    // A refresh (re-quote in place) keeps the reviewed explicit recipient; it is never replaced by the connected EVM wallet.
    c.tick(121_000); for (const m of Object.values(c.evm)) m.mine();
    const fresh = await c.service.refresh(run.id);
    expect(fresh.review).toMatchObject({ recipient: SOLANA_RECIPIENT, recipientKind: 'EXPLICIT' });
  });
});

describe('BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 R01/R05: Nitro destinations fold L1 posting gas into gasUsed', () => {
  // A direct registered-executor native payout on an Arbitrum Nitro chain: 21,000 + one calldata word of execution, plus L1 posting gas the
  // receipt itemizes as gasUsedForL1 (RH-DEMO-001 recorded 25,359 = 21,000 + 4,359 on Robinhood Chain). No trace namespace is served.
  const payout = async (from: UniversalNetworkKey, to: UniversalNetworkKey, receipt: { gasUsed: string; gasUsedForL1?: string }) => {
    const c = await setup(), source = c.chainOf(from), destination = c.chainOf(to);
    const w = workflow({ sourceChain: UNIVERSAL_NETWORKS[from].chain, destinationChain: UNIVERSAL_NETWORKS[to].chain,
      inputAsset: native(from), outputAsset: native(to), amount: '1000000000000000', recipient: 'CONNECTED_OWNER' });
    const confirmed = await executeEvm(c, source, (await reviewed(c, w, EVM_OWNER)).id, w);
    const route = confirmed.review.route;
    const executor = UNIVERSAL_ROUTER_DEPLOYMENT.evm[route.destinationChain]!.relaySettlement!.executors.find(address => address !== route.order.solver)!;
    const hash = destination.deliver({ recipient: EVM_OWNER, token: null, amount: BigInt(route.expectedOutput), orderId: route.order.orderId, sender: executor });
    destination.state.txs.get(hash)!.type = '0x2';
    const stored = destination.state.receipts.get(hash)!;
    stored.gasUsed = receipt.gasUsed;
    if (receipt.gasUsedForL1 === undefined) delete stored.gasUsedForL1; else stored.gasUsedForL1 = receipt.gasUsedForL1;
    destination.state.traces.delete(hash); destination.state.callTraces.delete(hash);
    c.relayMock.setStatus(route.quote.id, { status: 'success', inTxHashes: [confirmed.source!.transactionHash], txHashes: [hash] });
    return { c, source, destination, confirmed, hash, amount: BigInt(route.expectedOutput) };
  };

  it.each([['ethereum', 'robinhood'], ['base', 'robinhood'], ['base', 'arbitrum-one']] as const)(
    'reconciles a %s -> %s native payout without traces once its execution gas (gasUsed - gasUsedForL1) is within the direct bound', async (from, to) => {
      const { c, source, destination, confirmed, hash, amount } = await payout(from, to, { gasUsed: '0x6317', gasUsedForL1: '0x1107' });
      expect(await c.service.observe(confirmed.id)).toMatchObject({ phase: 'DESTINATION_OBSERVED', error: 'UNIVERSAL_AWAITING_FINALITY',
        destination: { transactionHash: hash, orderBound: true, final: false } });
      for (let i = 0; i < 3; i++) { source.mine(); destination.mine(); }
      // A worker restart between observations changes nothing: the durable record is re-read and the same delivery reconciles once.
      const reconciled = await c.restart().observe(confirmed.id);
      expect(reconciled).toMatchObject({ verdict: 'RECONCILED', received: amount.toString(), destination: { transactionHash: hash, final: true } });
      expect(reconciled.attempts.map(a => a.transactionHash)).toEqual(confirmed.attempts.map(a => a.transactionHash));
      expect((await c.restart().observe(confirmed.id)).evidence?.bundleHash).toBe(reconciled.evidence?.bundleHash);
    });

  it.each([
    ['no gasUsedForL1 on a Nitro chain', 'robinhood', { gasUsed: '0x6317' }],
    ['gasUsedForL1 above gasUsed', 'robinhood', { gasUsed: '0x6317', gasUsedForL1: '0x7000' }],
    ['execution gas still above the bound', 'arbitrum-one', { gasUsed: '0x7000', gasUsedForL1: '0x0400' }],
    ['a non-Nitro chain that reports gasUsedForL1', 'ethereum', { gasUsed: '0x6317', gasUsedForL1: '0x1107' }],
  ] as const)('stays not independently verifiable with %s (never a looser bound)', async (_label, to, receipt) => {
    const { c, confirmed } = await payout('base', to, receipt);
    expect(await c.service.observe(confirmed.id)).toMatchObject({ error: 'UNIVERSAL_DELIVERY_NOT_INDEPENDENTLY_VERIFIABLE', destination: null, evidence: null });
  });
});
