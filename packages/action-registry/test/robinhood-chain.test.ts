// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { executionCapabilityRegistry, resolveNodeCapability, resolveWorkflowCapability } from '../src/execution-capabilities.js';
import { ROBINHOOD_CHAIN_MAINNET, ROBINHOOD_CHAIN_TESTNET, ROBINHOOD_NETWORKS, ROBINHOOD_PROTOCOL_AVAILABILITY, ROBINHOOD_TESTNET_TRANSFER,
  robinhoodAddChainParameters, robinhoodDeploymentStatus, robinhoodNetwork } from '../src/robinhood-chain.js';

type Node = SemanticWorkflow['nodes'][number];
function node(actionType: string, chainId: string, adapter: string | null, protocols: string[]): Node {
  return { nodeId: actionType, actionType, actionSchemaVersion: '1.0.0', chainId,
    adapterConstraints: { adapters: adapter ? [{ id: adapter, version: '1.0.0' }] : [], protocols },
    requiredAuthorizationClass: 'MODE_A' } as Node;
}
const swap = (chain: string) => node('asset.swap.exact-input', chain, null, ['uniswap']);

describe('Robinhood Chain network identity', () => {
  it('pins the official chain IDs, CAIP-2 references, RPCs and explorers', () => {
    expect(ROBINHOOD_CHAIN_MAINNET).toMatchObject({ chain: 'eip155:4663', chainId: 4663, chainHex: '0x1237', environment: 'MAINNET',
      rpc: 'https://rpc.mainnet.chain.robinhood.com', explorer: 'https://robinhoodchain.blockscout.com' });
    expect(ROBINHOOD_CHAIN_TESTNET).toMatchObject({ chain: 'eip155:46630', chainId: 46630, chainHex: '0xb626', environment: 'PUBLIC_TESTNET',
      rpc: 'https://rpc.testnet.chain.robinhood.com', explorer: 'https://explorer.testnet.chain.robinhood.com' });
    for (const network of ROBINHOOD_NETWORKS) {
      expect(Number.parseInt(network.chainHex, 16)).toBe(network.chainId);
      expect(network.chain).toBe(`eip155:${network.chainId}`);
      expect(network.nativeCurrency).toEqual({ name: 'Ether', symbol: 'ETH', decimals: 18 });
      expect(Object.isFrozen(network) && Object.isFrozen(network.contracts)).toBe(true);
      for (const item of network.contracts) expect(item.address).toMatch(/^0x[0-9a-f]{40}$/);
    }
  });
  it('keeps mainnet and testnet contracts distinct; no mainnet token address is reused on testnet', () => {
    const weth = (network: typeof ROBINHOOD_CHAIN_MAINNET) => network.contracts.find(item => item.name === 'WETH')!.address;
    expect(weth(ROBINHOOD_CHAIN_MAINNET)).toBe('0x0bd7d308f8e1639fab988df18a8011f41eacad73');
    expect(weth(ROBINHOOD_CHAIN_TESTNET)).toBe('0x7943e237c7f95da44e0301572d358911207852fa');
    expect(ROBINHOOD_CHAIN_TESTNET.contracts.map(item => item.name)).not.toContain('USDG');
  });
  it('resolves CAIP-2 and hex identifiers only for Robinhood chains', () => {
    expect(robinhoodNetwork('eip155:46630')).toBe(ROBINHOOD_CHAIN_TESTNET);
    expect(robinhoodNetwork('0xB626')).toBe(ROBINHOOD_CHAIN_TESTNET);
    expect(robinhoodNetwork('0x1237')).toBe(ROBINHOOD_CHAIN_MAINNET);
    for (const other of ['eip155:8453', 'eip155:84532', '0x2105', 'eip155:466300', '46630', '', null, undefined])
      expect(robinhoodNetwork(other)).toBeNull();
  });
  it('builds EIP-3085 parameters from the official table', () => {
    expect(robinhoodAddChainParameters(ROBINHOOD_CHAIN_TESTNET)).toEqual({ chainId: '0xb626', chainName: 'Robinhood Chain Testnet',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.testnet.chain.robinhood.com'],
      blockExplorerUrls: ['https://explorer.testnet.chain.robinhood.com'] });
  });
});

describe('Robinhood decision gate in the capability registry', () => {
  it('records no canonical testnet deployment for any protocol', () => {
    expect(ROBINHOOD_PROTOCOL_AVAILABILITY.every(row => row.testnet === 'NO_CANONICAL_DEPLOYMENT')).toBe(true);
    expect(robinhoodDeploymentStatus('eip155:4663', 'uniswap.v3')).toBe('CANONICAL_DEPLOYMENT');
    expect(robinhoodDeploymentStatus('eip155:46630', 'uniswap.v3')).toBe('NO_CANONICAL_DEPLOYMENT');
    expect(robinhoodDeploymentStatus('eip155:8453', 'uniswap.v3')).toBeNull();
    expect(robinhoodDeploymentStatus('eip155:46630', 'unknown.adapter')).toBeNull();
  });
  it('keeps the RH-DEMO-001 testnet self-transfer and adds the BUILD-RH-002 mainnet rows with no evidence ceiling', () => {
    const rows = executionCapabilityRegistry.filter(row => robinhoodNetwork(row.chainId));
    expect(rows.map(row => [row.actionType, row.adapterId, row.chainId, row.environment, row.evidenceMaturity])).toEqual([
      ['asset.transfer', 'evm.native-transfer', 'eip155:46630', 'PUBLIC_TESTNET', 'TESTNET_EXECUTED'],
      ['asset.swap.exact-input', 'uniswap.v3', 'eip155:4663', 'MAINNET', null],
      ['asset.liquidity.concentrated', 'uniswap.v3', 'eip155:4663', 'MAINNET', null],
      ['asset.transfer', 'evm.native-transfer', 'eip155:4663', 'MAINNET', null],
      ['asset.transfer', 'evm.token-transfer', 'eip155:4663', 'MAINNET', null],
      ['asset.bridge', 'flofi.router', 'eip155:4663', 'MAINNET', null],
      // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: native ETH ⇄ WETH9 conversions (no evidence ceiling)
      ['asset.swap.exact-input', 'weth9.wrap', 'eip155:4663', 'MAINNET', null],
      // BUILD-CROSSCHAIN-UNIVERSAL-001
      ['asset.bridge', 'flofi.router.universal', 'eip155:4663', 'MAINNET', null]]);
    for (const row of rows) {
      expect(row.authorizationModes).toEqual(['A']);
      expect(row.requirements).toEqual(['INJECTED_WALLET', 'QUOTE_PROVIDER', 'REVIEWED_ARTIFACTS']);
    }
    expect(ROBINHOOD_TESTNET_TRANSFER).toMatchObject({ chain: 'eip155:46630', chainHex: '0xb626', adapterId: 'evm.native-transfer', maximumValueWei: '1000000000000000' });
  });
  it('resolves the self-transfer only on Robinhood Testnet and only in PUBLIC_TESTNET', () => {
    const transfer = (chain: string) => ({ ...node('asset.transfer', chain, 'evm.native-transfer', ['native']), requiredAuthorizationClass: 'MODE_A' }) as Node;
    expect(resolveNodeCapability(transfer('eip155:46630'), { environment: 'PUBLIC_TESTNET' }).profile?.adapterId).toBe('evm.native-transfer');
    expect(resolveNodeCapability(transfer('eip155:46630'), { environment: 'MAINNET' }).blockers[0]?.code).toBe('MAINNET_EXECUTION_NOT_ENABLED');
    expect(resolveNodeCapability(transfer('eip155:4663'), { environment: 'MAINNET' }).profile?.environment).toBe('MAINNET');
    expect(resolveNodeCapability(transfer('eip155:4663'), { environment: 'PUBLIC_TESTNET' }).blockers[0]?.code).toBe('PUBLIC_EXECUTION_NOT_ENABLED');
    expect(resolveNodeCapability(transfer('eip155:84532'), { environment: 'PUBLIC_TESTNET' }).blockers[0]?.code).toBe('CHAIN_NOT_SUPPORTED');
    const ready = resolveWorkflowCapability({ nodes: [transfer('eip155:46630')] }, { environment: 'PUBLIC_TESTNET', runtime: {
      walletConnected: true, walletChainId: 'eip155:46630', artifacts: 'CURRENT', simulationReady: true, authorizationReady: true } });
    expect(ready).toMatchObject({ executionSupported: true, executionReady: true, evidenceCeiling: 'TESTNET_EXECUTED' });
    const wrongChain = resolveWorkflowCapability({ nodes: [transfer('eip155:46630')] }, { environment: 'PUBLIC_TESTNET', runtime: {
      walletConnected: true, walletChainId: 'eip155:4663', artifacts: 'CURRENT', simulationReady: true, authorizationReady: true } });
    expect(wrongChain.blockers.map(b => b.code)).toContain('WRONG_WALLET_CHAIN');
    expect(wrongChain.executionReady).toBe(false);
  });
  it('reports a missing testnet deployment precisely, in every environment', () => {
    for (const environment of ['MOCK', 'LOCAL_FORK', 'PUBLIC_TESTNET', 'MAINNET']) {
      const result = resolveNodeCapability(swap('eip155:46630'), { environment });
      expect(result.blockers.map(blocker => blocker.code)).toEqual(['PROTOCOL_NOT_DEPLOYED']);
      expect(result.profile).toBeNull();
      expect(result.evidenceCeiling).toBeNull();
      expect(result.capabilities.EXECUTE || result.capabilities.SIMULATE || result.capabilities.AUTHORIZE).toBe(false);
    }
    const bridge = node('asset.bridge', 'eip155:46630', 'across.direct', ['across']);
    expect(resolveNodeCapability(bridge, { environment: 'PUBLIC_TESTNET' }).blockers[0]?.code).toBe('PROTOCOL_NOT_DEPLOYED');
  });
  it('resolves Robinhood mainnet swaps to the Uniswap v3 MAINNET profile with no evidence ceiling', () => {
    const result = resolveNodeCapability(swap('eip155:4663'), { environment: 'MAINNET' });
    expect(result.profile).toMatchObject({ adapterId: 'uniswap.v3', chainId: 'eip155:4663', environment: 'MAINNET', evidenceMaturity: null });
    expect(result.capabilities.EXECUTE).toBe(true);
    expect(result.evidenceCeiling).toBeNull();
    for (const environment of ['MOCK', 'LOCAL_FORK', 'PUBLIC_TESTNET'])
      expect(resolveNodeCapability(swap('eip155:4663'), { environment }).profile).toBeNull();
  });
  it('makes a Robinhood mainnet swap ready only with the wallet on 4663 and current Review artifacts; the testnet never', () => {
    const ready = (walletChainId: string, artifacts: 'CURRENT' | 'MISSING' | 'STALE') => resolveWorkflowCapability({ nodes: [swap('eip155:4663')] }, { environment: 'MAINNET',
      runtime: { walletConnected: true, walletChainId, artifacts, simulationReady: true, authorizationReady: true } });
    expect(ready('eip155:4663', 'CURRENT')).toMatchObject({ executionSupported: true, executionReady: true, evidenceCeiling: null });
    expect(ready('eip155:8453', 'CURRENT').blockers.map(b => b.code)).toContain('WRONG_WALLET_CHAIN');
    expect(ready('eip155:4663', 'STALE').executionReady).toBe(false);
    expect(ready('eip155:4663', 'MISSING').executionReady).toBe(false);
    const testnet = resolveWorkflowCapability({ nodes: [swap('eip155:46630')] }, { environment: 'PUBLIC_TESTNET', runtime: {
      walletConnected: true, walletChainId: 'eip155:46630', artifacts: 'CURRENT', simulationReady: true, authorizationReady: true } });
    expect(testnet).toMatchObject({ executionSupported: false, executionReady: false, evidenceCeiling: null });
  });
  it('leaves existing chains unchanged', () => {
    expect(resolveNodeCapability(node('asset.liquidity.uniswap-v3', 'eip155:10', null, ['uniswap-v3']), { environment: 'MOCK' })
      .blockers[0]?.code).toBe('CHAIN_NOT_SUPPORTED');
    expect(resolveNodeCapability(swap('eip155:84532'), { environment: 'PUBLIC_TESTNET' }).profile?.evidenceMaturity).toBe('TESTNET_EXECUTED');
  });
  it('rejects a Base Sepolia execution while the wallet is on a Robinhood chain', () => {
    for (const walletChainId of ['eip155:46630', 'eip155:4663']) {
      const result = resolveWorkflowCapability({ nodes: [swap('eip155:84532')] }, { environment: 'PUBLIC_TESTNET', runtime: {
        walletConnected: true, walletChainId, artifacts: 'CURRENT', simulationReady: true, authorizationReady: true } });
      expect(result.executionSupported).toBe(true);
      expect(result.blockers.map(blocker => blocker.code)).toContain('WRONG_WALLET_CHAIN');
      expect(result.executionReady).toBe(false);
    }
  });
});
