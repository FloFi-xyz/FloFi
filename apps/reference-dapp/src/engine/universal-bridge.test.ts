// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-CROSSCHAIN-UNIVERSAL-001: the strategy engine composes universal bridges for every non-certified mainnet bridge. */
import { describe, expect, it } from 'vitest';
import { readUniversalBridgeNode, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { composeStrategy, isUniversalBridgeSpec } from './strategy-engine';
import { previewPlan } from '../mcp/simulation';

const SOL_WALLET = 'GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq', EVM = '0x' + 'ab'.repeat(20);
const ok = (input: unknown) => { const c = composeStrategy(input); if (!c.ok) throw new Error(c.code); return c; };
const fields = (c: ReturnType<typeof ok>) => readUniversalBridgeNode((c.workflow as unknown as SemanticWorkflow).nodes[0]!);

describe('BUILD-CROSSCHAIN-UNIVERSAL-001 strategy composition', () => {
  it('"Bridge my USDC from Solana to Base": USDC → USDC, best route, the connected EVM wallet bound at Review', () => {
    const c = ok({ action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'base', asset: 'USDC', amount: '25' });
    expect(c.strategy).toEqual({ version: 1, action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'base', asset: 'USDC', outputAsset: 'USDC', amount: '25',
      routing: 'best', slippageBps: 100 });
    expect(c.fundsClass).toBe('REAL_FUNDS');
    expect(fields(c)).toMatchObject({ sourceChain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', destinationChain: 'eip155:8453', amount: '25000000',
      recipient: 'CONNECTED_DESTINATION_WALLET', selection: 'BEST_MINIMUM_OUTPUT', providers: ['relay', 'lifi', 'mayan', 'across'],
      inputAsset: { kind: 'TOKEN', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 } });
    expect(c.notes.join(' ')).toMatch(/EVM wallet you connect in the FloFi app receives the funds/);
    expect(previewPlan(c.strategy)).toEqual({ flow: 'crosschain-universal', subject: 'SOLANA', destinationSubject: 'EVM' });
  });
  it('"Move ETH from Arbitrum to Robinhood Chain": native ETH → native ETH, same ecosystem, the signing wallet receives', () => {
    const c = ok({ action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'robinhood', asset: 'ETH', amount: '0.01' });
    expect(c.strategy).toMatchObject({ asset: 'ETH', outputAsset: 'ETH', routing: 'best' });
    expect(fields(c)).toMatchObject({ inputAsset: { kind: 'NATIVE', decimals: 18 }, outputAsset: { kind: 'NATIVE', decimals: 18 }, recipient: 'CONNECTED_OWNER', amount: '10000000000000000' });
    expect(previewPlan(c.strategy)).toEqual({ flow: 'crosschain-universal', subject: 'EVM' });
  });
  it('"Bridge USDC from Base to Solana and receive SOL": the destination asset is the owner\'s choice', () => {
    const c = ok({ action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'solana', asset: 'USDC', outputAsset: 'SOL', amount: '40', recipient: SOL_WALLET });
    expect(c.strategy).toMatchObject({ asset: 'USDC', outputAsset: 'SOL', recipient: SOL_WALLET });
    expect(fields(c)).toMatchObject({ outputAsset: { kind: 'NATIVE', decimals: 9 }, recipient: SOL_WALLET });
    expect(previewPlan(c.strategy)).toEqual({ flow: 'crosschain-universal', subject: 'EVM' });
  });
  it('Robinhood Chain receives its dollar stablecoin by default; SOL ⇄ ETH default to the destination native coin (stated in the notes)', () => {
    expect(ok({ action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'robinhood', asset: 'USDC', amount: '10' }).strategy).toMatchObject({ outputAsset: 'USDG' });
    const sol = ok({ action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'ethereum', asset: 'SOL', amount: '1' });
    expect(sol.strategy).toMatchObject({ outputAsset: 'ETH' });
    expect(sol.notes.join(' ')).toMatch(/No destination asset given: ETH on Ethereum is proposed and shown at Review/);
  });
  it('the certified Router pairs keep their command, routing and hash; another asset, best or relay routing make a universal bridge', () => {
    const certified = ok({ action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USDC', amount: '10' });
    expect(certified.command.type).toBe('ADD_ROUTER_BRIDGE');
    expect(certified.strategy).toMatchObject({ routing: 'auto' });
    expect(previewPlan(certified.strategy)).toEqual({ flow: 'crosschain-router', subject: 'EVM' });
    expect(ok({ action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USD Coin', amount: '10' }).workflowHash).toBe(certified.workflowHash);
    for (const patch of [{ routing: 'relay' }, { routing: 'best' }, { asset: 'WETH' }]) {
      const c = ok({ action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USDC', amount: '10', ...patch });
      expect(c.command.type).toBe('ADD_UNIVERSAL_BRIDGE');
    }
    expect(isUniversalBridgeSpec({ action: 'bridge', sourceNetwork: 'base-sepolia', destinationNetwork: 'arbitrum-sepolia', asset: 'USDC', amount: '1' })).toBe(false);
  });
  it('refuses a recipient in the wrong address format, the same network and unknown assets', () => {
    expect(composeStrategy({ action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'solana', asset: 'USDC', amount: '1', recipient: EVM })).toMatchObject({ ok: false,
      code: 'UNIVERSAL_RECIPIENT_INVALID' });
    expect(composeStrategy({ action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'base', asset: 'USDC', amount: '1', recipient: SOL_WALLET })).toMatchObject({ ok: false,
      code: 'UNIVERSAL_RECIPIENT_INVALID' });
    expect(composeStrategy({ action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'solana', asset: 'USDC', amount: '1' })).toMatchObject({ ok: false });
    expect(composeStrategy({ action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'base', asset: 'NOTATOKEN', amount: '1' })).toMatchObject({ ok: false,
      code: 'UNIVERSAL_ASSET_UNKNOWN' });
  });
});
