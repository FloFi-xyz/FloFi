// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-POST-257-HOTFIX-001: regressions for the incidents reported after PR #257 on the MCP surface.
 *  - P0-3: "0.0003 ETH on Base → USDC on Arbitrum One" became a swap plus a bridge with an invented 10 USDC cap, then "unsupported asset".
 *  - P1-5: native ETH advertised as transfer-only; extra compose/validate/simulate calls; repeated wallet-address requests; generic refusals;
 *    host-made rounding of FloFi's amounts.
 */
import { describe, expect, it } from 'vitest';
import { credential, gatewayEnv, session } from './gateway.test-harness';
import { goalBeneficiary, MCP_INSTRUCTIONS } from './tools';
import { previewDisplay } from './financial-display';
import { userFacingError } from '../platform/conversation-state';
import { composeStrategy } from '../engine/strategy-engine';
import { PublicStrategyInputSchema } from '../engine/strategy-spec';

const alice = { principal: 'dev-alice', token: credential(), wallets: ['0x' + 'a'.repeat(40)] };
const publicEnv = gatewayEnv([alice], { FLOFI_NETWORK_SCOPE: '' });
const INCIDENT = { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'ETH', outputAsset: 'USDC', amount: '0.0003' };

describe('BUILD-FLOFI-POST-257-HOTFIX-001 P0-3: a cross-asset bridge is one Universal Bridge step', () => {
  it('composes the reported request as exactly one bridge card with independent source and destination assets, no swap and no cap', async () => {
    const client = session({ env: publicEnv, token: alice.token });
    const composed = await client.callTool('compose_strategy', { strategy: INCIDENT });
    expect(composed.isError).toBe(false);
    expect(composed.output).toMatchObject({ ok: true, stepCount: 1, fundsClass: 'REAL_FUNDS', strategy: { action: 'bridge', asset: 'ETH', outputAsset: 'USDC', amount: '0.0003' } });
    const workflow = composed.output.workflow as { nodes: { actionType: string }[] };
    const financial = workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
    expect(financial).toHaveLength(1);
    expect(JSON.stringify(workflow)).not.toMatch(/swap/i);
    expect(JSON.stringify(composed.output.strategy)).not.toMatch(/"10"|cap/);
    // The engine itself agrees (the same hash as the canonical composition).
    const canonical = composeStrategy(INCIDENT);
    expect(canonical.ok && composed.output.workflowHash === canonical.workflowHash).toBe(true);
  });

  it('tells the host model, in the schema and the instructions, that outputAsset is converted in flight and never a second step', async () => {
    const bridge = JSON.stringify(PublicStrategyInputSchema);
    expect(bridge).toMatch(/ONE bridge step \(a Universal Bridge card\); never add a separate swap step and never invent an amount/);
    expect(MCP_INSTRUCTIONS).toMatch(/is ONE bridge step: `asset` is spent, `outputAsset` is received, and the route converts in flight/);
    expect(MCP_INSTRUCTIONS).toMatch(/Never split it into a swap plus a bridge, and never invent an amount, cap or limit/);
    const client = session({ env: publicEnv, token: alice.token });
    const listed = JSON.stringify((await client.request('tools/list')).result);
    expect(listed).toMatch(/one Universal Bridge step, never a swap plus a bridge/);
  });

  it('plans the same request from a goal as one bridge with outputAsset (FloFi\'s planner, never swap + bridge)', async () => {
    const client = session({ env: publicEnv, token: alice.token });
    const planned = await client.callTool('plan_strategy', { goal: { sourceNetwork: 'base', sourceAsset: 'ETH', amount: '0.0003', targetNetwork: 'arbitrum-one',
      targetAsset: 'USDC', use: 'HOLD' } });
    expect(planned.output).toMatchObject({ ok: true, kind: 'PLAN', stepCount: 1, strategy: { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one',
      asset: 'ETH', outputAsset: 'USDC', amount: '0.0003' } });
    expect(planned.output.workflowHash).toBe((await client.callTool('compose_strategy', { strategy: planned.output.strategy })).output.workflowHash);
  });

  it('discovers the Universal Bridge between EVM mainnets with its own destination asset', async () => {
    const client = session({ env: publicEnv, token: alice.token });
    const capabilities = (await client.callTool('get_capabilities', { network: 'base', action: 'bridge' })).output.capabilities as { network: string; destinationNetwork: string;
      deployment: { flow: string }; mcp: { compose: boolean }; example: { asset: string; outputAsset?: string } }[];
    const universal = capabilities.find(c => c.destinationNetwork === 'arbitrum-one' && c.deployment.flow === 'crosschain-universal');
    expect(universal).toMatchObject({ network: 'base', mcp: { compose: true }, example: { asset: 'ETH', outputAsset: 'USDC' } });
  });
});

describe('BUILD-FLOFI-POST-257-HOTFIX-001 P1-5: MCP capability and conversational corrections', () => {
  it('advertises native ETH for swaps and bridges, not transfer-only', async () => {
    const client = session({ env: publicEnv, token: alice.token });
    for (const network of ['base', 'arbitrum-one', 'ethereum'] as const) {
      const assets = (await client.callTool('get_supported_assets', { network })).output.assets as { symbol: string; address: string | null; actions: string[] }[];
      const eth = assets.find(asset => asset.symbol === 'ETH' && asset.address === null);
      expect(eth?.actions, network).toEqual(expect.arrayContaining(['swap', 'bridge', 'transfer']));
      expect(assets.find(asset => asset.symbol === 'USDC')?.actions, network).toEqual(expect.arrayContaining(['swap', 'bridge']));
      // Only the native coin, the dollar stablecoins and WETH are advertised for bridges (flofi-bridge review), never e.g. a Stock Token.
      expect(assets.filter(asset => asset.actions.includes('bridge')).every(asset => asset.address === null || ['USDC', 'USDG', 'USDT', 'WETH'].includes(asset.symbol)), network).toBe(true);
    }
  });

  it('asks for compose then request_user_approval only: review, validate and simulate are optional because the request re-checks the review', async () => {
    expect(MCP_INSTRUCTIONS).not.toMatch(/call compose_strategy, review_strategy and request_user_approval/);
    expect(MCP_INSTRUCTIONS).toMatch(/request_user_approval itself re-composes, re-checks every review blocker/);
    const client = session({ env: publicEnv, token: alice.token });
    const composed = await client.callTool('compose_strategy', { strategy: { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1', slippageBps: 50 } });
    // A static credential cannot request approvals, so it keeps the review/simulate path (flofi-mcp review); validate_strategy is never a required step.
    const next = composed.output.nextSteps as string[];
    expect(next.some(step => step.startsWith('validate_strategy'))).toBe(false);
    expect(next[0]).toMatch(/^review_strategy with this strategy and workflowHash/);
  });

  it('uses the account\'s linked wallet as the beneficiary instead of asking for an address', () => {
    const one = [{ namespace: 'eip155', address: '0x' + 'A'.repeat(40) }, { namespace: 'solana', address: 'CtV2foUoy5uJaK5Wybz8Nf1xmC6TgDv93itdja7n9yvH' }];
    expect(goalBeneficiary(undefined, one)).toEqual({ address: '0x' + 'a'.repeat(40), options: [] });
    const two = [...one, { namespace: 'eip155', address: '0x' + 'b'.repeat(40) }];
    expect(goalBeneficiary(undefined, two)).toEqual({ address: null, options: ['0x' + 'a'.repeat(40), '0x' + 'b'.repeat(40)] });
    expect(goalBeneficiary('0x' + 'c'.repeat(40), two)).toEqual({ address: '0x' + 'c'.repeat(40), options: [] });
    expect(goalBeneficiary(undefined, [])).toEqual({ address: null, options: [] });
  });

  it('says what actually happened: a deployment gate is not an unsupported asset, and a preview never needs a typed address', () => {
    for (const code of ['FLOW_NOT_ENABLED_IN_DEPLOYMENT', 'OWNER_EXECUTION_NOT_ENABLED_IN_DEPLOYMENT', 'MAINNET_HANDOFF_DISABLED_BY_POLICY'])
      expect(userFacingError(code).EN, code).toMatch(/does not hand it off for signing right now/);
    expect(userFacingError('ROUTER_PAIR_UNSUPPORTED').EN).toMatch(/not available on FloFi right now/);
    for (const code of ['EVM_WALLET_REQUIRED', 'SOLANA_WALLET_REQUIRED']) {
      const message = userFacingError(code);
      expect(message.EN).toMatch(/requesting approval needs no address/);
      expect(message.PT).toMatch(/pedir a aprovação não exige endereço/);
    }
  });

  it('gives the host FloFi\'s own amount lines (six significant digits, minimum rounded down) instead of base units to convert', () => {
    // The owner incident of 24-11-2026: 1 USDC → WETH on Arbitrum One.
    const quote = { amountIn: '1000000', expectedOut: '570195181991234', minimumOut: '567344205843789', inputDecimals: 6, outputDecimals: 18, inputSymbol: 'USDC', outputSymbol: 'WETH' };
    const swap = previewDisplay('SWAP_QUOTE', quote, 'PUBLIC_MAINNET');
    expect(swap?.EN).toEqual(['You pay: 1 USDC', 'You receive (estimated): ≈ 0.000570195 WETH', 'Minimum received: 0.000567344 WETH']);
    expect(previewDisplay('SWAP_QUOTE', quote, 'MOCKED')?.EN[0]).toBe('Simulated with test data, not a live quote.');
    const bridge = previewDisplay('CROSS_CHAIN_ROUTE', { quote: { provider: 'relay', inputAmount: '300000000000000', expectedOutput: '1012345', minimumOutput: '1002222',
      inputToken: { decimals: 18, symbol: 'ETH' }, outputToken: { decimals: 6, symbol: 'USDC' } } });
    expect(bridge?.PT).toEqual(['Você paga: 0,0003 ETH', 'Você recebe (estimado): ≈ 1,01235 USDC', 'Mínimo recebido: 1,00222 USDC', 'Rota: relay']);
    expect(previewDisplay('AAVE_V3', {})).toBeNull();
    expect(previewDisplay('SWAP_QUOTE', { amountIn: '1', inputDecimals: 6 })).toBeNull();
  });
});
