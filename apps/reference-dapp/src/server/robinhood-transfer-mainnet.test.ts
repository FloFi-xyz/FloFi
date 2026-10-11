// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002: Robinhood Chain mainnet transfers on the shared transfer engine (native ETH and catalog ERC-20s, explicit
 * recipients) against a MOCKED in-memory chain. The "wallet" is the mock chain applying the exact prepared transaction; no
 * test reaches a network, signs or sends.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeTransferNode, createTokenTransferNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import type { AssetCatalog, CanonicalAsset } from '@defi-workflow-engine/action-registry';
import { createRobinhoodTransferService } from './robinhood-transfer-service';
import { asset, createRobinhoodMockChain, OFFICIAL_REGISTRY_TEXT, officialCatalog, type RobinhoodMockChain } from './robinhood-mainnet.test-harness';

const owner = '0x1111111111111111111111111111111111111111', friend = '0x3333333333333333333333333333333333333333';
const T0 = Date.parse('2026-10-11T03:00:00.000Z');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
let clock = T0, catalog: AssetCatalog, chain: RobinhoodMockChain, usdg: CanonicalAsset, tsla: CanonicalAsset;
const flow = (node: SemanticWorkflow['nodes'][number]): SemanticWorkflow => ({ schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, nodes: [node], resourceEdges: [] });
const tokenTransfer = (token: CanonicalAsset, amount: string, recipient: string = friend) => flow(createTokenTransferNode('node-002', { chain: 'eip155:4663', amount, recipient,
  token: { address: token.address!, decimals: token.decimals, officialId: token.stock?.officialId ?? null } }));
function service(options: { executionEnabled?: boolean; catalogFor?: () => Promise<AssetCatalog> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'flofi-rh-transfer-')); dirs.push(dir);
  return createRobinhoodTransferService({ rpcs: { 'eip155:4663': chain.rpc }, journalDir: dir, provenance: 'MOCKED', idPrefix: 'rht', now: () => clock,
    catalogFor: options.catalogFor ?? (async () => catalog), executionEnabled: options.executionEnabled ?? true });
}
beforeEach(() => {
  clock = T0; catalog = officialCatalog(); chain = createRobinhoodMockChain(catalog, { now: () => clock });
  usdg = asset(catalog, 'USDG'); tsla = asset(catalog, 'TSLA');
  chain.fundNative(owner, 10n ** 16n); chain.fund(usdg.address!, owner, 500_000_000n); chain.fund(tsla.address!, owner, 5n * 10n ** 18n);
});
/** The owner's full path: Simulate → Review → begin (PREPARED) → handoff (SUBMITTING) → wallet → report → observe → reconcile. */
async function execute(s: ReturnType<typeof service>, workflow: SemanticWorkflow) {
  const simulated = await s.simulate(workflow, owner);
  await s.review(simulated.id, simulated.review.commitment, workflow);
  const { transaction } = await s.begin(simulated.id, owner, workflow);
  await s.handoff(simulated.id);
  const hash = chain.apply(transaction);
  await s.report(simulated.id, { kind: 'HASH', hash });
  expect((await s.observe(simulated.id)).error).toBe('AWAITING_CONFIRMATIONS');
  chain.mine(2);
  return { simulated, transaction, record: await s.observe(simulated.id) };
}

describe('Robinhood Chain mainnet transfers', () => {
  it('transfers native ETH to an explicit recipient and reconciles value + fee exactly', async () => {
    const workflow = flow(createNativeTransferNode('node-002', { chain: 'eip155:4663', amount: '1000000000000000', recipient: friend }));
    const { simulated, transaction, record } = await execute(service(), workflow);
    expect(simulated.id).toMatch(/^rht-[0-9a-f]{32}$/);
    expect(simulated.review).toMatchObject({ chain: 'eip155:4663', recipient: friend, value: '1000000000000000' });
    expect(simulated.review.asset).toBeUndefined();
    expect(transaction).toMatchObject({ from: owner, to: friend, value: '0x38d7ea4c68000', data: '0x', chainId: '0x1237' });
    expect(record).toMatchObject({ verdict: 'RECONCILED', error: null });
    expect(record.evidence!.bundle).toMatchObject({ environment: 'MOCKED', outcome: 'RECONCILED' });
    expect(chain.state.native.get(friend)).toBe(1_000_000_000_000_000n);
  });
  it('transfers USDG with the exact transfer(recipient, amount) call and both token balances reconciled', async () => {
    const { transaction, record } = await execute(service(), tokenTransfer(usdg, '25000000'));
    expect(transaction).toMatchObject({ to: usdg.address, value: '0x0' });
    expect(transaction.data).toBe('0xa9059cbb' + friend.slice(2).padStart(64, '0') + (25_000_000n).toString(16).padStart(64, '0'));
    expect(record.verdict).toBe('RECONCILED');
    expect(record.observations.at(-1)!.facts).toMatchObject({ tokenBalanceBefore: '500000000', tokenBalanceAfter: '475000000',
      recipientTokenBalanceBefore: '0', recipientTokenBalanceAfter: '25000000' });
    expect(chain.balance(usdg.address!, friend)).toBe(25_000_000n);
  });
  it('transfers a Stock Token, binding its uid and multiplier, accepting its TransferWithScaledUI log', async () => {
    const { simulated, record } = await execute(service(), tokenTransfer(tsla, '3000000000000000000'));
    expect(simulated.review.asset).toMatchObject({ kind: 'ERC20', token: tsla.address, decimals: 18, officialId: tsla.stock!.officialId, multiplierWad: '1000000000000000000' });
    expect(record.verdict).toBe('RECONCILED');
    expect(chain.balance(tsla.address!, friend)).toBe(3n * 10n ** 18n);
  });
  it('invalidates the reviewed authority when a Stock Token multiplier changes after Review', async () => {
    const s = service(), workflow = tokenTransfer(tsla, '1000000000000000000');
    const simulated = await s.simulate(workflow, owner);
    await s.review(simulated.id, simulated.review.commitment, workflow);
    chain.state.stocks.get(tsla.address!)!.multiplierWad = 1_010_000_000_000_000_000n;
    await expect(s.begin(simulated.id, owner, workflow)).rejects.toThrow('TRANSFER_STOCK_MULTIPLIER_CHANGED_REVIEW_REQUIRED');
    expect((await s.load(simulated.id)).attempt).toBeNull();
  });
  it('fails closed when the official registry no longer maps the token, or disagrees with the chain on the multiplier', async () => {
    const changed = JSON.parse(OFFICIAL_REGISTRY_TEXT) as { assets: Record<string, unknown>[] };
    const index = changed.assets.findIndex(a => a.tokenSymbol === 'TSLA');
    changed.assets[index] = { ...changed.assets[index], status: 'ASSET_STATUS_INACTIVE' };
    await expect(service({ catalogFor: async () => officialCatalog(JSON.stringify(changed)) }).simulate(tokenTransfer(tsla, '1'), owner)).rejects.toThrow('TRANSFER_ASSET_IDENTITY_CHANGED');
    chain.state.stocks.get(tsla.address!)!.multiplierWad = 3n * 10n ** 18n;
    await expect(service().simulate(tokenTransfer(tsla, '1'), owner)).rejects.toThrow('TRANSFER_STOCK_MULTIPLIER_MISMATCH');
    await expect(service({ catalogFor: async () => { throw new Error('STOCK_REGISTRY_UNAVAILABLE'); } }).simulate(tokenTransfer(tsla, '1'), owner)).rejects.toThrow('STOCK_REGISTRY_UNAVAILABLE');
  });
  it('fails closed on a wrong token identity onchain, insufficient balance or a contract recipient for ETH', async () => {
    chain.state.stocks.get(tsla.address!)!.uid = '0x' + '1'.repeat(64);
    await expect(service().simulate(tokenTransfer(tsla, '1'), owner)).rejects.toThrow('TRANSFER_TOKEN_IDENTITY_MISMATCH');
    await expect(service().simulate(tokenTransfer(usdg, '600000000'), owner)).rejects.toThrow('TRANSFER_INSUFFICIENT_TOKEN_BALANCE');
    const contract = usdg.address!;
    await expect(service().simulate(flow(createNativeTransferNode('node-002', { chain: 'eip155:4663', amount: '1', recipient: contract })), owner)).rejects.toThrow('TRANSFER_RECIPIENT_NOT_EOA');
    chain.state.native.set(owner, 1n);
    await expect(service().simulate(tokenTransfer(usdg, '1'), owner)).rejects.toThrow('TRANSFER_INSUFFICIENT_ETH');
  });
  it('refuses begin without the real-funds opt-in, before any nonce is reserved or attempt prepared', async () => {
    const s = service({ executionEnabled: false }), workflow = tokenTransfer(usdg, '1000000');
    const simulated = await s.simulate(workflow, owner);
    await s.review(simulated.id, simulated.review.commitment, workflow);
    await expect(s.begin(simulated.id, owner, workflow)).rejects.toThrow('OWNER_EXECUTION_NOT_ENABLED');
    expect((await s.load(simulated.id)).attempt).toBeNull();
    // With the opt-in, the same Review proceeds: nothing was reserved by the refused call.
    const enabled = createRobinhoodTransferService({ rpcs: { 'eip155:4663': chain.rpc }, journalDir: dirs.at(-1)!, provenance: 'MOCKED', idPrefix: 'rht', now: () => clock,
      catalogFor: async () => catalog, executionEnabled: true });
    expect((await enabled.begin(simulated.id, owner, workflow)).record.attempt?.state).toBe('PREPARED');
  });
  it('keeps an uncertain wallet result observation-only and never prepares a second attempt', async () => {
    const s = service(), workflow = tokenTransfer(usdg, '1000000');
    const simulated = await s.simulate(workflow, owner);
    await s.review(simulated.id, simulated.review.commitment, workflow);
    await s.begin(simulated.id, owner, workflow); await s.handoff(simulated.id);
    await s.report(simulated.id, { kind: 'UNKNOWN' });
    await expect(s.begin(simulated.id, owner, workflow)).rejects.toThrow(/TRANSFER_REVIEW_REQUIRED|TRANSFER_EXISTING_ATTEMPT_OBSERVE_ONLY/);
    expect((await s.load(simulated.id)).attempt?.state).toBe('SUBMISSION_RESULT_UNKNOWN');
    expect(chain.state.receipts.size).toBe(0);
  });
  it('detects a different transaction on the reviewed token as divergent, never reconciled', async () => {
    const s = service(), workflow = tokenTransfer(usdg, '1000000');
    const simulated = await s.simulate(workflow, owner);
    await s.review(simulated.id, simulated.review.commitment, workflow);
    const { transaction } = await s.begin(simulated.id, owner, workflow); await s.handoff(simulated.id);
    // The wallet sends a different amount than reviewed.
    const hash = chain.apply({ ...transaction, data: transaction.data.slice(0, -2) + '02' });
    await s.report(simulated.id, { kind: 'HASH', hash });
    chain.mine(2);
    const record = await s.observe(simulated.id);
    expect(record.verdict).toBe('DIVERGENT');
    expect(record.evidence).toBeNull();
  });
});
