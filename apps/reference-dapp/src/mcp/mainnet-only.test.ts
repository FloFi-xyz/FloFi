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
