// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import { activeNetworkScope, introducedTestNetworks, isTestNetwork, mainnetCounterpart, networkAllowed, realFundsNotice, scopeOfEnv, setActiveNetworkScope,
  testNetworkMessage, workflowAllowed, workflowTestNetworks } from './network-scope';
import { NETWORKS } from './network-registry';
import { networkScope } from '../server/network-scope';
import { isHostedDeployment } from '../server/deployment';

const node = (chainId: string, actionType = 'asset.swap.exact-input') => ({ chainId, actionType });
afterEach(() => setActiveNetworkScope(null));

describe('BUILD-FLOFI-MAINNET-PRODUCT-001: the public product is Mainnet-only', () => {
  it('classifies every registered network by its registry environment', () => {
    for (const network of NETWORKS) {
      expect(isTestNetwork(network.chain)).toBe(network.environment === 'TESTNET');
      expect(isTestNetwork(network.key)).toBe(network.environment === 'TESTNET');
      expect(networkAllowed(network.chain, 'PUBLIC_MAINNET')).toBe(network.environment === 'MAINNET');
      expect(networkAllowed(network.chain, 'ENGINEERING')).toBe(true);
    }
    // Every test network has a mainnet of its own family (the rebuild target), and a mainnet is its own counterpart.
    for (const network of NETWORKS) expect(mainnetCounterpart(network.key)?.environment).toBe('MAINNET');
    expect(mainnetCounterpart('base-sepolia')?.name).toBe('Base');
    expect(mainnetCounterpart('solana-devnet')?.name).toBe('Solana');
    expect(mainnetCounterpart('robinhood-testnet')?.name).toBe('Robinhood Chain');
  });
  it('names the test networks of a workflow, ignoring templates and the local fork', () => {
    const workflow = { nodes: [node('mock:local', 'mock-read'), node('eip155:31337'), node('eip155:84532'), node('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'), node('eip155:8453')] };
    expect(workflowTestNetworks(workflow).map(n => n.name)).toEqual(['Base Sepolia', 'Solana Devnet']);
    expect(workflowAllowed(workflow, 'PUBLIC_MAINNET')).toBe(false);
    expect(workflowAllowed(workflow, 'ENGINEERING')).toBe(true);
    expect(workflowAllowed({ nodes: [node('eip155:8453'), node('mock:local', 'mock-read')] }, 'PUBLIC_MAINNET')).toBe(true);
    expect(testNetworkMessage(workflowTestNetworks(workflow))).toBe(
      'Base Sepolia and Solana Devnet are test networks. FloFi runs on mainnets only, with real funds: rebuild this on Base or Solana.');
  });
  it('refuses only an edit that adds a test network, and nothing in engineering certification', () => {
    const empty = { nodes: [node('mock:local', 'mock-read')] }, testnet = { nodes: [node('eip155:84532')] }, mainnet = { nodes: [node('eip155:8453')] };
    expect(introducedTestNetworks(empty, testnet, 'PUBLIC_MAINNET').map(n => n.key)).toEqual(['base-sepolia']);
    expect(introducedTestNetworks(empty, testnet, 'ENGINEERING')).toEqual([]);
    expect(introducedTestNetworks(testnet, mainnet, 'PUBLIC_MAINNET')).toEqual([]);
    expect(introducedTestNetworks(testnet, testnet, 'PUBLIC_MAINNET')).toEqual([]);
    expect(introducedTestNetworks(mainnet, { nodes: [node('eip155:8453'), node('eip155:11155111')] }, 'PUBLIC_MAINNET').map(n => n.key)).toEqual(['ethereum-sepolia']);
  });
  it('opts into engineering only on a local server, and never on a hosted deployment whatever its configuration says', () => {
    const cases: Record<string, string | undefined>[] = [{}, { FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS' }, { FLOFI_NETWORK_SCOPE: 'engineering' },
      { FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS', VERCEL: '1' }, { FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS', RAILWAY_PROJECT_ID: 'p' },
      { FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS', RAILWAY_ENVIRONMENT_ID: 'e' }, { FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS', FLOFI_DEPLOYMENT: 'hosted' },
      { FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS', VERCEL_ENV: 'preview' }];
    expect(cases.map(scopeOfEnv)).toEqual(['PUBLIC_MAINNET', 'ENGINEERING', 'PUBLIC_MAINNET', 'PUBLIC_MAINNET', 'PUBLIC_MAINNET', 'PUBLIC_MAINNET', 'PUBLIC_MAINNET', 'ENGINEERING']);
    // The client-safe rule and the server's are the same rule.
    for (const env of cases) {
      expect(networkScope(env)).toBe(scopeOfEnv(env));
      expect(scopeOfEnv({ ...env, FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS' }) === 'PUBLIC_MAINNET').toBe(isHostedDeployment(env));
    }
  });
  it('uses the scope the server handed to the browser, and is Mainnet-only when it was never told', () => {
    setActiveNetworkScope('PUBLIC_MAINNET');
    expect(activeNetworkScope()).toBe('PUBLIC_MAINNET');
    setActiveNetworkScope('ENGINEERING');
    expect(activeNetworkScope()).toBe('ENGINEERING');
    setActiveNetworkScope(null);
    // This suite runs with the engineering opt-in (vitest.config.ts); a browser bundle carries no server environment.
    expect(activeNetworkScope()).toBe('ENGINEERING');
    const process = globalThis.process;
    try { (globalThis as { process?: unknown }).process = undefined; expect(activeNetworkScope()).toBe('PUBLIC_MAINNET'); }
    finally { globalThis.process = process; }
  });
  it('explains real funds and the network fee at Review for mainnets only', () => {
    expect(realFundsNotice('eip155:8453')).toBe('Real funds on Base: the amounts above leave your wallet, and your wallet also pays the network fee in ETH. ' +
      'Your wallet shows the exact transaction before you confirm.');
    expect(realFundsNotice('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toContain('network fee in SOL');
    expect(realFundsNotice('eip155:84532')).toBeNull();
    expect(realFundsNotice('mock:local')).toBeNull();
    expect(realFundsNotice(null)).toBeNull();
  });
});
