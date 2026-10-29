// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BRIDGE-LIVE-FIX-003 — native ETH on a LOCAL Anvil fork of Ethereum mainnet (category B evidence: fork-based, never mainnet
 * execution). The real swap service runs against the fork: real SwapRouter02, QuoterV2, WETH9, USDC and pools, the strict owner-bound Review
 * (eth_call simulation + estimateGas), the wallet request applied by Anvil as a fork-only impersonated, codeless owner, and reconciliation from
 * the real receipt logs. Upstream traffic is read-only state from a public RPC; nothing reaches mainnet. Opt-in only (never in CI):
 *   FLOFI_NATIVE_ETH_FORK=PUBLIC_READ_ONLY_UPSTREAM GRYLOO_ANVIL_BIN=<foundry-v1.8.3/anvil> pnpm vitest run apps/reference-dapp/src/server/native-eth.fork.test.ts
 * Evidence is labelled MOCKED by the service (a fork is not a public network), never MAINNET_EXECUTED.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseEthereumTokenList, UNISWAP_V3_ETHEREUM as UNI } from '@defi-workflow-engine/action-registry';
import { createCatalogSwapNode, type CatalogAssetRef, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { createPublicTestnetService, type PublicTestnetService, type Rpc } from './public-testnet-service';

const enabled = process.env.FLOFI_NATIVE_ETH_FORK === 'PUBLIC_READ_ONLY_UPSTREAM' && Boolean(process.env.GRYLOO_ANVIL_BIN);
const UPSTREAM = process.env.FLOFI_NATIVE_ETH_FORK_UPSTREAM ?? 'https://ethereum-rpc.publicnode.com', PORT = 8591, CHAIN = 'eip155:1';
/**
 * A fresh codeless address, funded and impersonated on the local fork only (anvil_setBalance / anvil_impersonateAccount never reach mainnet).
 * Anvil's own development account is not used: on mainnet it carries code today, and FloFi correctly refuses it (OWNER_NOT_EOA).
 */
const OWNER = '0x00000000000000000000000000000000f10f1004';
let anvil: ChildProcess | null = null, dir = '';
const rpc: Rpc = async (method, params) => {
  const response = await fetch(`http://127.0.0.1:${PORT}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
};
const ETH: CatalogAssetRef = { chain: CHAIN, address: null, decimals: 18, officialId: null };
const USDC: CatalogAssetRef = { chain: CHAIN, address: UNI.usdc, decimals: 6, officialId: null };
const WETH: CatalogAssetRef = { chain: CHAIN, address: UNI.weth, decimals: 18, officialId: null };
const flow = (input: CatalogAssetRef, output: CatalogAssetRef, amount: string, slippageBps: number): SemanticWorkflow =>
  ({ schemaVersion: '1.0.0', workflowId: 'workflow-local', revision: 1, nodes: [createCatalogSwapNode('node-002', { chain: CHAIN, input, output, amount, slippageBps })], resourceEdges: [] });
const balanceOf = async (token: string) => BigInt(await rpc('eth_call', [{ to: token, data: '0x70a08231' + OWNER.slice(2).padStart(64, '0') }, 'latest']) as string);
const nativeBalance = async () => BigInt(await rpc('eth_getBalance', [OWNER, 'latest']) as string);

function service(): PublicTestnetService {
  const catalog = parseEthereumTokenList(readFileSync(new URL('../../../../packages/action-registry/test/fixtures/ethereum-token-list-fixture.json', import.meta.url), 'utf8'), new Date().toISOString());
  return createPublicTestnetService({ rpc: async () => { throw new Error('NO_FALLBACK'); }, rpcs: { [CHAIN]: rpc }, journalDir: dir, idPrefix: 'ets', now: () => new Date(),
    catalog: { catalogFor: async () => catalog, provenance: 'MOCKED', executionEnabled: true } });
}
/** One reviewed wallet request, sent by Anvil from its unlocked account exactly as prepared, then reconciled from the fork's receipt. */
async function execute(s: PublicTestnetService, id: string) {
  const begun = await s.begin(id, OWNER);
  const hash = await rpc('eth_sendTransaction', [begun.tx]) as string;
  // The reviewed request carries no priority tip; mine it explicitly on the local fork (evm_mine is a fork-only call).
  await rpc('evm_mine', []);
  s.report(id, begun.attempt.attemptId, { kind: 'HASH', txHash: hash });
  const run = await s.observe(id);
  if (run.outcome) console.info('[native-eth-fork]', JSON.stringify({ quote: { native: run.quote.native ?? null, conversion: run.quote.conversion ?? null, fee: run.quote.fee,
    expectedOut: run.quote.expectedOut, minimumOut: run.quote.minimumOut }, tx: { to: begun.tx.to, value: begun.tx.value }, outcome: { inputSpent: run.outcome.inputSpent,
    outputReceived: run.outcome.outputReceived, gasCostWei: run.outcome.gasCostWei, evidence: run.outcome.evidence.environment, limitations: run.outcome.evidence.reconciliation.limitations } }));
  return { begun, run };
}

describe.skipIf(!enabled)('native ETH on an Anvil fork of Ethereum mainnet (real contracts; nothing reaches mainnet)', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'flofi-native-eth-fork-'));
    anvil = spawn(process.env.GRYLOO_ANVIL_BIN!, ['--fork-url', UPSTREAM, '--port', String(PORT), '--chain-id', '1', '--silent'], { stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) { try { await rpc('eth_chainId', []); ready = true; } catch { await new Promise(resolve => setTimeout(resolve, 500)); } }
    if (!ready) throw new Error('ANVIL_FORK_UNAVAILABLE');
    expect(await rpc('eth_getCode', [OWNER, 'latest'])).toBe('0x');
    await rpc('anvil_setBalance', [OWNER, '0x' + (10n ** 19n).toString(16)]);
    await rpc('anvil_impersonateAccount', [OWNER]);
  }, 90_000);
  afterAll(() => { anvil?.kill(); rmSync(dir, { recursive: true, force: true }); });

  it('E — 0.01 ETH → USDC: no approval, value = amount, real pool output reconciled from the real receipt', async () => {
    const s = service(), prepared = await s.prepare(flow(ETH, USDC, '10000000000000000', 100), OWNER), id = prepared.quote.executionId;
    expect(prepared.quote).toMatchObject({ native: 'INPUT', ownerReview: { step: 'swap', transaction: { to: UNI.router, value: '0x2386f26fc10000' } } });
    s.review(id, prepared.quote.manifestHash);
    const [usdcBefore, ethBefore] = [await balanceOf(UNI.usdc), await nativeBalance()];
    const { run } = await execute(s, id);
    expect(run.outcome).toMatchObject({ inputSpent: '10000000000000000' });
    const received = BigInt(run.outcome!.outputReceived), gas = BigInt(run.attempts.at(-1)!.receipt!.gasCostWei);
    expect(received).toBeGreaterThanOrEqual(BigInt(prepared.quote.minimumOut));
    expect(await balanceOf(UNI.usdc) - usdcBefore).toBe(received);
    expect(ethBefore - await nativeBalance()).toBe(10n ** 16n + gas);
    expect(run.outcome!.evidence.environment).toBe('MOCKED');
  }, 120_000);
  it('F — USDC → native ETH: exact approval, then the router unwraps WETH9 and pays the owner native ETH (gas kept apart)', async () => {
    const s = service(), first = await s.prepare(flow(USDC, ETH, '5000000', 100), OWNER), id = first.quote.executionId;
    s.review(id, first.quote.manifestHash);
    await execute(s, id);
    const next = await s.refresh(id); s.review(id, next.quote.manifestHash);
    const ethBefore = await nativeBalance();
    const { run } = await execute(s, id);
    const received = BigInt(run.outcome!.outputReceived), gas = BigInt(run.attempts.at(-1)!.receipt!.gasCostWei);
    expect(received).toBeGreaterThanOrEqual(BigInt(next.quote.minimumOut));
    expect(await nativeBalance() - ethBefore).toBe(received - gas);
  }, 120_000);
  it('G/H — wrap 0.01 ETH into WETH9 and unwrap it again, exactly 1:1', async () => {
    const s = service(), wethBefore = await balanceOf(UNI.weth);
    const wrap = await s.prepare(flow(ETH, WETH, '10000000000000000', 0), OWNER);
    s.review(wrap.quote.executionId, wrap.quote.manifestHash);
    expect((await execute(s, wrap.quote.executionId)).run.outcome).toMatchObject({ outputReceived: '10000000000000000' });
    expect(await balanceOf(UNI.weth) - wethBefore).toBe(10n ** 16n);
    const unwrap = await s.prepare(flow(WETH, ETH, '10000000000000000', 0), OWNER);
    s.review(unwrap.quote.executionId, unwrap.quote.manifestHash);
    expect((await execute(s, unwrap.quote.executionId)).run.outcome).toMatchObject({ outputReceived: '10000000000000000' });
    expect(await balanceOf(UNI.weth)).toBe(wethBefore);
  }, 120_000);
});
