// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { credential, gatewayEnv, session } from './gateway.test-harness';
import { MCP_MAINNET_INSTRUCTIONS } from './tools';
import { PUBLIC_NETWORK_IDS } from '../engine/strategy-spec';

const alice = { principal: 'dev-alice', token: credential(), wallets: ['0x' + 'a'.repeat(40)] };
/** The deployment as it is hosted: no engineering opt-in (an empty value overrides this suite's own opt-in). */
const publicEnv = gatewayEnv([alice], { FLOFI_NETWORK_SCOPE: '' }), engineeringEnv = gatewayEnv([alice], { FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS' });
const testnetSwap = { action: 'swap', network: 'base-sepolia', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1', slippageBps: 50 };
const mainnetSwap = { action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1', slippageBps: 50 };

describe('BUILD-FLOFI-MAINNET-PRODUCT-001: MCP offers and composes mainnet strategies only', () => {
  it('advertises no test network in any tool schema, and says so in its instructions', async () => {
    const client = session({ env: publicEnv, token: alice.token });
    const listed = JSON.stringify((await client.request('tools/list')).result);
    expect(listed).not.toMatch(/sepolia|devnet|robinhood-testnet|devUSDC|lending_composition/i);
    const initialized = await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'flofi-test', version: '1' } });
    expect(JSON.stringify(initialized.result)).toContain(MCP_MAINNET_INSTRUCTIONS.trim().slice(0, 60));
    const networks = (await client.callTool('get_supported_networks', {})).output.networks as { id: string; class: string }[];
    expect(networks.map(n => n.id).sort()).toEqual([...PUBLIC_NETWORK_IDS].sort());
    expect(networks.every(n => n.class === 'MAINNET')).toBe(true);
  });
  it('refuses a test-network strategy (never moving it to a mainnet) and composes a mainnet one', async () => {
    const client = session({ env: publicEnv, token: alice.token });
    const refused = await client.callTool('compose_strategy', { strategy: testnetSwap });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/mainnetOnly/);
    const composed = await client.callTool('compose_strategy', { strategy: mainnetSwap });
    expect(composed.isError).toBe(false);
    expect(composed.output).toMatchObject({ ok: true, fundsClass: 'REAL_FUNDS', strategy: { network: 'base' } });
  });
  it('keeps every engine reachable for engineering certification', async () => {
    const client = session({ env: engineeringEnv, token: alice.token });
    const listed = JSON.stringify((await client.request('tools/list')).result);
    expect(listed).toContain('base-sepolia');
    expect((await client.callTool('compose_strategy', { strategy: testnetSwap })).output).toMatchObject({ ok: true, fundsClass: 'TEST_FUNDS' });
  });
});

it('MCP composes all 20 directed bridges with independent destination tokens and preserves their canonical hash', async () => {
  const { UNIVERSAL_DIRECTED_PAIRS, UNIVERSAL_NETWORKS } = await import('@defi-workflow-engine/workflow-contracts');
  const { composeStrategy } = await import('../engine/strategy-engine');
  const client = session({ env: publicEnv, token: alice.token });
  for (const { source, destination } of UNIVERSAL_DIRECTED_PAIRS) {
    const strategy = { action: 'bridge', sourceNetwork: source, destinationNetwork: destination, asset: source === 'robinhood' ? 'USDG' : 'USDC',
      outputAsset: UNIVERSAL_NETWORKS[destination].native.symbol, amount: '1' };
    const canonical = composeStrategy(strategy);
    expect(canonical).toMatchObject({ ok: true });
    const result = await client.callTool('compose_strategy', { strategy });
    expect(result.output).toMatchObject({ workflowHash: canonical.ok ? canonical.workflowHash : '' });
  }
});

describe('BUILD-FLOFI-BRIDGE-LIVE-FIX-003: MCP composes native ETH as native ETH (never WETH), and WETH9 wraps', () => {
  const nodeOf = (output: Record<string, unknown>) => (output.workflow as { nodes: { inputs: { name: string; value: Record<string, unknown> }[]; adapterConstraints: { protocols: string[] } }[] }).nodes[0]!;
  it('a native-ETH swap on Base, its reverse on Arbitrum One, and an ETH → WETH wrap on Ethereum', async () => {
    const client = session({ env: publicEnv, token: alice.token });
    const native = await client.callTool('compose_strategy', { strategy: { action: 'swap', network: 'base', inputAsset: 'ETH', outputAsset: 'USDC', amount: '0.001', slippageBps: 100 } });
    expect(native.isError).toBe(false);
    expect(nodeOf(native.output).inputs.find(input => input.name === 'amount-in')!.value).toMatchObject({ asset: { chainId: 'eip155:8453', nativeId: 'ETH', decimals: 18 } });
    expect(JSON.stringify(native.output)).not.toContain('0x4200000000000000000000000000000000000006');
    const reverse = await client.callTool('compose_strategy', { strategy: { action: 'swap', network: 'arbitrum-one', inputAsset: 'USDC', outputAsset: 'ETH', amount: '5' } });
    expect(reverse.isError).toBe(false);
    expect(nodeOf(reverse.output).inputs.find(input => input.name === 'asset-out')!.value).toEqual({ chainId: 'eip155:42161', nativeId: 'ETH', decimals: 18 });
    const wrap = await client.callTool('compose_strategy', { strategy: { action: 'swap', network: 'ethereum', inputAsset: 'ETH', outputAsset: 'WETH', amount: '0.01' } });
    expect(wrap.isError).toBe(false);
    expect(nodeOf(wrap.output).adapterConstraints.protocols).toEqual(['weth9']);
  });
});

describe('P0-D: a network named the way discovery names it composes to the same strategy and hash', () => {
  const ethereumSwap = { action: 'swap', inputAsset: 'WETH', outputAsset: 'USDC', amount: '0.0012' };
  it('accepts the discovery name, registry aliases and CAIP-2 ids, case-insensitively, and returns the canonical id', async () => {
    const client = session({ env: publicEnv, token: alice.token });
    const canonical = await client.callTool('compose_strategy', { strategy: { ...ethereumSwap, network: 'ethereum' } });
    expect(canonical.isError).toBe(false);
    const networks = (await client.callTool('get_supported_networks', {})).output.networks as { id: string; name: string; chainId: string }[];
    const ethereum = networks.find(n => n.id === 'ethereum')!;
    for (const network of [ethereum.name, ethereum.chainId, 'ETHEREUM', ' Ethereum Mainnet ']) {
      const composed = await client.callTool('compose_strategy', { strategy: { ...ethereumSwap, network } });
      expect(composed.isError).toBe(false);
      expect(composed.output).toMatchObject({ ok: true, strategy: { network: 'ethereum' }, workflowHash: canonical.output.workflowHash });
    }
    const bridged = await client.callTool('compose_strategy', { strategy: { action: 'bridge', sourceNetwork: 'Arbitrum', destinationNetwork: 'Robinhood Chain', asset: 'USDC', amount: '5' } });
    expect(bridged.output).toMatchObject({ ok: true, strategy: { sourceNetwork: 'arbitrum-one', destinationNetwork: 'robinhood' } });
    const workflow = await client.callTool('compose_strategy', { strategy: { version: 2, steps: [{ ...ethereumSwap, network: 'Ethereum' }, { action: 'transfer', network: 'eip155:1', asset: 'USDC', amount: '1' }] } });
    expect(workflow.isError).toBe(false);
    expect((workflow.output.strategy as { steps: { network: string }[] }).steps.map(step => step.network)).toEqual(['ethereum', 'ethereum']);
    const filtered = await client.callTool('get_capabilities', { network: 'Arbitrum One', action: 'swap' });
    expect(filtered.isError).toBe(false);
  });
  it('never guesses or crosses scopes, and names the accepted ids when it refuses', async () => {
    const client = session({ env: publicEnv, token: alice.token });
    for (const network of ['eth', 'mainnet', 'Ethereum Sepolia', 'eip155:11155111', 'base-sepolia']) {
      const refused = await client.callTool('compose_strategy', { strategy: { ...ethereumSwap, network } });
      expect(refused.isError).toBe(true);
    }
    const refused = await client.callTool('compose_strategy', { strategy: { ...ethereumSwap, network: 'eth' } });
    const swapNetworks = (await client.callTool('get_supported_networks', {})).output.networks as { id: string; actions: string[] }[];
    expect(refused.text).toContain(`one of: ${swapNetworks.filter(n => n.actions.includes('swap')).map(n => n.id).join(', ')}`);
    expect(refused.text.match(/one of:/g)).toHaveLength(1);
    expect(refused.text).not.toContain('"eth"');
    // The hint names the networks of the refused field's own action: Aave is not on Solana, so Solana is not offered for a supply.
    const supply = await client.callTool('compose_strategy', { strategy: { action: 'supply', network: 'solana', asset: 'USDC', amount: '1', beneficiary: '0x' + '1'.repeat(40) } });
    expect(supply.isError).toBe(true);
    expect(supply.text).toMatch(/one of: [^)]*ethereum/);
    expect(supply.text).not.toMatch(/one of: [^)]*solana/);
  });
});

describe('P0-D: compose explains what was composed (never another action\'s text)', () => {
  it('a Solana → Base bridge names Solana, Base and USDC; a mainnet USDC transfer is not described as a test-ETH self-transfer', async () => {
    const client = session({ env: publicEnv, token: alice.token });
    const bridge = await client.callTool('compose_strategy', { strategy: { action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'base', asset: 'USDC', amount: '5' } });
    expect(bridge.isError).toBe(false);
    const text = JSON.stringify([bridge.output.summary, bridge.output.explanation]);
    expect(text).not.toMatch(/Optimism/);
    expect(text).toContain('Solana'); expect(text).toContain('Base'); expect(text).toContain('USDC');
    const visual = bridge.output.visual as { steps: { amounts: { asset: string }[]; toAsset: string | null }[] };
    expect(visual.steps[0]!.amounts[0]!.asset).toBe('USDC');
    expect(JSON.stringify(visual)).not.toMatch(/@6/);
    const transfer = await client.callTool('compose_strategy', { strategy: { action: 'transfer', network: 'ethereum', asset: 'USDC', amount: '1' } });
    expect(transfer.isError).toBe(false);
    const transferText = JSON.stringify(transfer.output.explanation);
    expect(transferText).not.toMatch(/test ETH|1 ETH|Chain execution proof/);
    expect(transferText).toContain('1 USDC');
  });
});
