// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-GAS-ABSTRACTION-MULTICHAIN-003: the page asks the owner's wallet for a 0x Gasless signature only when the typed data FloFi's server
 * handed back is exactly the reviewed one, and keeps only a signature by that wallet of exactly that digest. MOCKED chain and 0x double; the
 * "wallet" is a disposable test key behind an in-process EIP-1193 stand-in.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCatalogSwapNode } from '@defi-workflow-engine/workflow-contracts';
import { eip712 } from '@defi-workflow-engine/reference-compiler';
import { createTestWallet } from '../../../../packages/reference-reconciler/test/test-wallet.ts';
import { createPublicTestnetService } from '../server/public-testnet-service';
import { asset, createRobinhoodMockChain, mockCatalogRuntime, officialCatalog } from '../server/robinhood-mainnet.test-harness';
import { createZeroExDouble } from '../server/zeroex-gasless/zeroex.test-harness';
import { createZeroExGaslessClient } from '../server/zeroex-gasless/client';
import { gaslessRequestMatches, signGaslessTypedData, walletTypedData } from './zeroex-gasless-signing';
import type { EvmProvider } from './evm-discovery';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function begun() {
  const clock = Date.parse('2026-10-11T03:00:00.000Z'), catalog = officialCatalog(), chain = createRobinhoodMockChain(catalog, { now: () => clock });
  const zx = createZeroExDouble(chain, { now: () => clock }), usdg = asset(catalog, 'USDG'), tsla = asset(catalog, 'TSLA'), owner = createTestWallet();
  chain.addPool(usdg.address!, tsla.address!, { fee: 3000, liquidity: 10n ** 20n, rate: { [usdg.address!]: 2_600_000_000_000_000_000_000_000_000n, [tsla.address!]: 1n } });
  chain.fund(usdg.address!, owner.address, 10n ** 9n);
  zx.script.permitTokens = new Set([usdg.address!]);
  const dir = mkdtempSync(join(tmpdir(), 'flofi-gasless-page-')); dirs.push(dir);
  const s = createPublicTestnetService({ rpc: async () => { throw new Error('UNUSED'); }, rpcs: { 'eip155:4663': zx.rpc }, journalDir: dir, idPrefix: 'rhs', now: () => new Date(clock),
    catalog: { ...mockCatalogRuntime(catalog), gasless: { config: { enabled: true, apiUrl: 'http://127.0.0.1:8561', apiKey: 'loopback-key', chains: ['eip155:4663'], loopback: true },
      client: createZeroExGaslessClient(zx.http, () => clock) } } });
  const ref = (a: typeof usdg) => ({ chain: a.chain, address: a.address!, decimals: a.decimals, officialId: a.stock?.officialId ?? null });
  const run = await s.prepare({ schemaVersion: '1.0.0', workflowId: 'w', revision: 1, resourceEdges: [],
    nodes: [createCatalogSwapNode('node-002', { chain: 'eip155:4663', amount: '100000000', slippageBps: 50, input: ref(usdg), output: ref(tsla) })] }, owner.address);
  s.review(run.quote.executionId, run.quote.manifestHash);
  return { quote: s.load(run.quote.executionId).quote, begun: await s.beginGasless(run.quote.executionId, owner.address), owner };
}
/** An EIP-1193 stand-in that signs exactly the JSON it is handed (as `eth_signTypedData_v4` does) with `signer`'s key. */
const provider = (signer: ReturnType<typeof createTestWallet>, seen: unknown[] = []): EvmProvider => ({
  request: async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method !== 'eth_signTypedData_v4') throw new Error('UNEXPECTED ' + method);
    const typed = JSON.parse(String(params![1])) as eip712.TypedData; seen.push(typed);
    return signer.signDigest(eip712.hashTypedData(typed));
  } }) as EvmProvider;

describe('the page\'s 0x Gasless signing', () => {
  it('accepts exactly the reviewed typed data, and refuses any changed value, another owner or another Review', async () => {
    const { quote, begun: request, owner } = await begun();
    expect(gaslessRequestMatches(quote, request, owner.address)).toBe(true);
    expect(gaslessRequestMatches(quote, request, createTestWallet().address)).toBe(false);
    const message = request.trade.message as { slippageAndActions: Record<string, unknown> };
    expect(gaslessRequestMatches(quote, { ...request, trade: { ...request.trade, message: { ...message, slippageAndActions: { ...message.slippageAndActions, minAmountOut: '1' } } } }, owner.address)).toBe(false);
    expect(gaslessRequestMatches(quote, { ...request, approval: null }, owner.address)).toBe(false);
    expect(gaslessRequestMatches({ ...quote, manifestHash: '0x' + '0'.repeat(64) }, request, owner.address)).toBe(false);
  });
  it('asks the wallet with EIP712Domain declared and keeps only the owner\'s signature of exactly that digest', async () => {
    const { begun: request, owner } = await begun(), seen: unknown[] = [];
    const signature = await signGaslessTypedData(provider(owner, seen), owner.address, request.trade);
    expect(eip712.recoverTypedDataSigner(eip712.hashTypedData(request.trade), signature)).toBe(owner.address);
    expect((seen[0] as eip712.TypedData).types.EIP712Domain).toEqual([{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }]);
    await expect(signGaslessTypedData(provider(createTestWallet()), owner.address, request.trade)).rejects.toThrow('ZEROX_SIGNER_MISMATCH');
    const types = Object.fromEntries(Object.entries(request.trade.types).filter(([name]) => name !== 'EIP712Domain'));
    expect(walletTypedData({ ...request.trade, types }).types.EIP712Domain).toHaveLength(3);
  });
});
