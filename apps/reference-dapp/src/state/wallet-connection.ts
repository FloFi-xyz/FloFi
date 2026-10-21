// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * One connection path for every ecosystem: the canonical selector resolves the owner's choice, then exactly that wallet
 * is asked to connect through the existing EVM or Solana session store. Connecting shares a public address; it signs
 * nothing and authorizes nothing. Account, provider or network changes reach Review through the existing invalidation.
 */
import { useCallback, useEffect, useState } from 'react';
import { useWalletSelector } from '../components/wallet-selector';
import { useBuild009Wallet } from './build009-wallet-store';
import { useJupiter } from './jupiter-store';
import { useWorkflow } from './workflow-store';
import type { SolanaWalletChain } from '../wallet/solana-wallet';
import type { WalletEcosystem } from '../wallet/wallet-registry';
import { EVM_WALLET_NETWORKS } from '../wallet/evm-networks';
import { networkIdentity } from '../domain/network-registry';

/** A switch destination comes only from the same registered network as the requested action. */
export function walletNetworkTarget(chain: string | null | undefined) {
  const identity = networkIdentity(chain);
  if (identity?.key === 'solana' || identity?.key === 'solana-devnet') return { ecosystem: 'solana' as const, label: identity.name,
    walletChain: identity.key === 'solana' ? 'solana:mainnet' as const : 'solana:devnet' as const };
  const evm = EVM_WALLET_NETWORKS.find(value => value.chain === chain && value.switchable);
  return evm ? { ecosystem: 'evm' as const, label: identity?.name ?? evm.label, hex: evm.hex } : null;
}

export type ConnectedWallet = { readonly ecosystem: WalletEcosystem; readonly address: string; readonly providerKey: string;
  readonly providerName: string; readonly network: string | null };

/** Testnet-first: without a Solana workflow, a Solana wallet connects on Devnet; a Solana workflow names its own cluster. */
export function connectionSolanaChain(workflowChains: readonly string[], workflowWalletChain: SolanaWalletChain): SolanaWalletChain {
  return workflowChains.some(chain => chain.startsWith('solana:')) ? workflowWalletChain : 'solana:devnet';
}
export const evmNetworkRef = (hex: string | null) => hex && /^0x[0-9a-f]+$/i.test(hex) && BigInt(hex) > 0n ? `eip155:${BigInt(hex).toString()}` : null;

export function useWalletConnection() {
  const selector = useWalletSelector(), evm = useBuild009Wallet(), solana = useJupiter(), { state } = useWorkflow();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!error) return; const timer = window.setTimeout(() => setError(null), 6000); return () => window.clearTimeout(timer); }, [error]);
  const solanaChain = connectionSolanaChain(state.workflow.nodes.map(node => node.chainId), solana.walletChain);
  const connect = useCallback(async (request: { readonly title?: string; readonly ecosystems?: readonly WalletEcosystem[] } = {}): Promise<ConnectedWallet | null> => {
    setError(null);
    const chains = state.workflow.nodes.filter(node => !node.actionType.startsWith('mock-')).map(node => node.chainId);
    const ecosystems: readonly WalletEcosystem[] | undefined = chains.some(chain => chain.startsWith('solana:')) ? ['solana']
      : chains.some(chain => chain.startsWith('eip155:')) ? ['evm'] : undefined;
    const choice = await selector.choose({ ...ecosystems ? { ecosystems } : {}, ...request, solanaChain });
    if (!choice) return null;
    if (choice.ecosystem === 'evm') {
      const session = await evm.connectWith(choice.id);
      return session ? { ecosystem: 'evm', address: session.account, providerKey: choice.key, providerName: choice.name, network: evmNetworkRef(session.chainId) } : null;
    }
    const session = await solana.connectWith(choice.key, solanaChain);
    if (!session) { setError('Could not connect your Solana wallet. Check your wallet and try again.'); return null; }
    return { ecosystem: 'solana', address: session.account.address, providerKey: choice.key, providerName: choice.name, network: session.chain };
  }, [selector, evm, solana, solanaChain, state.workflow]);
  // Explicit owner action only. Reuse the operational session; switching never accepts Review or signs a transaction.
  const switchNetwork = async (chain: string) => {
    setError(null);
    try {
      const target = walletNetworkTarget(chain);
      if (!target) throw new Error('WALLET_NETWORK_NOT_SWITCHABLE');
      if (target.ecosystem === 'solana') {
        if (!solana.session) throw new Error('SOLANA_WALLET_REQUIRED');
        const failure = await solana.switchCluster(target.walletChain);
        if (failure) throw new Error(failure);
      } else {
        if (!evm.account) throw new Error('EVM_WALLET_REQUIRED');
        await evm.switchTo(target.hex as Parameters<typeof evm.switchTo>[0]);
      }
    } catch { setError('Could not switch your wallet to the workflow network. Check your wallet and try again.'); }
  };
  return { connect, switchNetwork, error, clearError: () => setError(null), solanaChain };
}
