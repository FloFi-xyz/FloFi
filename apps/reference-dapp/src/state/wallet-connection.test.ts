// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookHarness } from '../test-utils/hook-harness';
import { useWalletConnection, walletNetworkTarget } from './wallet-connection';
import { EVM_WALLET_NETWORKS } from '../wallet/evm-networks';
import { SOLANA_MAINNET_TRANSFER, SOLANA_DEVNET_TRANSFER } from '@defi-workflow-engine/action-registry';

const f = vi.hoisted(() => ({ evm: { account: '0x' + '1'.repeat(40) as string | null, switchTo: vi.fn() },
  solana: { session: {} as object | null, walletChain: 'solana:mainnet', switchCluster: vi.fn() }, choose: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
vi.mock('./build009-wallet-store', () => ({ useBuild009Wallet: () => f.evm }));
vi.mock('./jupiter-store', () => ({ useJupiter: () => f.solana }));
vi.mock('./workflow-store', () => ({ useWorkflow: () => ({ state: { workflow: { nodes: [] } } }) }));
vi.mock('../components/wallet-selector', () => ({ useWalletSelector: () => ({ choose: f.choose }) }));

let host: HookHarness;
const read = () => host.render(() => useWalletConnection());
beforeEach(() => { host = new HookHarness(); vi.resetAllMocks(); vi.stubGlobal('window', { setTimeout, clearTimeout });
  f.evm.account = '0x' + '1'.repeat(40); f.solana.session = {}; f.solana.switchCluster.mockResolvedValue(null); });
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); });

describe('in-workflow network switching', () => {
  it.each(EVM_WALLET_NETWORKS.filter(network => network.switchable))('switches only the operational EVM wallet to $label', async network => {
    await read().switchNetwork(network.chain);
    expect(f.evm.switchTo).toHaveBeenCalledExactlyOnceWith(network.hex);
    expect(f.solana.switchCluster).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled(); expect(read().error).toBeNull();
  });
  it.each([[SOLANA_MAINNET_TRANSFER.chain, 'solana:mainnet'], [SOLANA_DEVNET_TRANSFER.chain, 'solana:devnet']])('keeps the Solana workflow on its required cluster (%s)', async (chain, walletChain) => {
    await read().switchNetwork(chain);
    expect(f.solana.switchCluster).toHaveBeenCalledExactlyOnceWith(walletChain);
    expect(f.evm.switchTo).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled();
  });
  it.each(['eip155:999999', 'eip155:421614', 'solana:unknown', ''])('does not substitute another network for an unavailable switch (%s)', async chain => {
    expect(walletNetworkTarget(chain)).toBeNull(); await read().switchNetwork(chain);
    expect(f.evm.switchTo).not.toHaveBeenCalled(); expect(f.solana.switchCluster).not.toHaveBeenCalled(); expect(read().error).toContain('Could not switch');
  });
  it.each(['evm', 'solana'] as const)('a saved address never connects or switches a disconnected %s signer', async ecosystem => {
    if (ecosystem === 'evm') f.evm.account = null; else f.solana.session = null;
    await read().switchNetwork(ecosystem === 'evm' ? 'eip155:1' : SOLANA_MAINNET_TRANSFER.chain);
    expect(f.evm.switchTo).not.toHaveBeenCalled(); expect(f.solana.switchCluster).not.toHaveBeenCalled(); expect(f.choose).not.toHaveBeenCalled();
  });
  it('keeps a rejected switch in the current flow and lets the owner retry explicitly', async () => {
    f.evm.switchTo.mockRejectedValueOnce({ code: 4001 });
    await read().switchNetwork('eip155:1'); expect(read().error).toContain('Could not switch');
    expect(f.evm.switchTo).toHaveBeenCalledTimes(1);
    await read().switchNetwork('eip155:1'); expect(read().error).toBeNull(); expect(f.evm.switchTo).toHaveBeenCalledTimes(2);
  });
});
