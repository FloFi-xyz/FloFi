// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { AAVE_V3_BASE_SEPOLIA, AAVE_V3_ETHEREUM_SEPOLIA, CROSSCHAIN_ROUTER_BASE_SEPOLIA_ARBITRUM_SEPOLIA } from '@defi-workflow-engine/action-registry';
import { codeCapabilities, supportedAssets, supportedNetworks } from './capability-catalog';

describe('BUILD-MCP-001 discovery derived from registries', () => {
  it('lists networks with registry chain ids and honest fund classes', () => {
    const networks = Object.fromEntries(supportedNetworks('ENGINEERING').map(n => [n.id, n]));
    expect(networks['base-sepolia']).toMatchObject({ chainId: 'eip155:84532', class: 'TESTNET', funds: 'TEST_FUNDS' });
    expect(networks['arbitrum-sepolia']).toMatchObject({ chainId: CROSSCHAIN_ROUTER_BASE_SEPOLIA_ARBITRUM_SEPOLIA.destination.chain, actions: ['bridge'] });
    expect(networks['base']).toMatchObject({ chainId: 'eip155:8453', class: 'MAINNET', funds: 'REAL_FUNDS' });
    expect(networks['solana-devnet']!.class).toBe('DEVNET');
    expect(networks['robinhood-testnet']).toMatchObject({ chainId: 'eip155:46630', class: 'TESTNET', actions: ['transfer'] });
    expect(networks['ethereum-sepolia']!.actions).toEqual(expect.arrayContaining(['swap', 'supply', 'add_liquidity']));
  });

  it('distinguishes the two Base Sepolia USDC tokens by the actions that use each', () => {
    const usdc = supportedAssets('ENGINEERING', 'base-sepolia').filter(a => a.symbol === 'USDC');
    expect(usdc.map(a => a.address).sort()).toEqual([AAVE_V3_BASE_SEPOLIA.asset, '0x036cbd53842c5426634e7929541ec2318f3dcf7e'].sort());
    expect(usdc.find(a => a.address === AAVE_V3_BASE_SEPOLIA.asset)!.actions).toEqual(['borrow', 'lending_composition', 'repay', 'supply', 'withdraw']);
    expect(usdc.find(a => a.address !== AAVE_V3_BASE_SEPOLIA.asset)!.actions).toEqual(['add_liquidity', 'bridge', 'swap']);
    expect(supportedAssets('ENGINEERING', 'ethereum-sepolia').find(a => a.symbol === 'WBTC')).toMatchObject({ address: AAVE_V3_ETHEREUM_SEPOLIA.asset, decimals: 8 });
    expect(supportedAssets('ENGINEERING').every(a => a.sources.length > 0)).toBe(true);
  });

  it('derives code capabilities from the registry on the composed IR, never claiming more than it records', () => {
    const rows = Object.fromEntries(codeCapabilities('ENGINEERING').map(c => [`${c.action}:${c.network}`, c]));
    // Router testnet: owner execution implemented, nothing demonstrated.
    expect(rows['bridge:base-sepolia']).toMatchObject({ adapters: ['flofi.router'], publicEnvironment: 'PUBLIC_TESTNET', ownerWalletExecutionImplemented: true,
      demonstratedEvidence: null, funds: 'TEST_FUNDS' });
    // The exact Base Sepolia Uniswap swap path is the one with recorded public testnet execution.
    expect(rows['swap:base-sepolia']!.demonstratedEvidence).toBe('TESTNET_EXECUTED');
    // BUILD-BASE-001 (intentional change): the Base mainnet Uniswap swap is an owner-wallet capability (real funds) beside its MOCK and
    // LOCAL_FORK rows; nothing is demonstrated on mainnet, so no evidence is claimed.
    expect(rows['swap:base']).toMatchObject({ ownerWalletExecutionImplemented: true, demonstratedEvidence: null, funds: 'REAL_FUNDS' });
    expect(rows['swap:base']!.registryEnvironments).toEqual(expect.arrayContaining(['MOCK', 'LOCAL_FORK', 'MAINNET']));
    expect(rows['bridge:base']).toMatchObject({ publicEnvironment: 'MAINNET', funds: 'REAL_FUNDS' });
    expect(rows['transfer:ethereum-sepolia']).toMatchObject({ ownerWalletExecutionImplemented: true, funds: 'TEST_FUNDS' });
    expect(rows['transfer:robinhood-testnet']).toMatchObject({ ownerWalletExecutionImplemented: true, funds: 'TEST_FUNDS' });
    expect(rows['add_liquidity:solana']).toMatchObject({ ownerWalletExecutionImplemented: true, funds: 'REAL_FUNDS' });
    for (const row of codeCapabilities('ENGINEERING')) expect(row.supportedByCode.AUTHOR).toBe(true);
  });
});
