// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { baseAssetRegistry, referenceRegistry } from '@defi-workflow-engine/action-registry';
import { AppShell } from './app-shell';
import { ApprovalHandoff } from './approval-handoff';
import { ChannelProgressPing } from './channel-progress-ping';
import { EmbeddedApproval } from './embedded-approval';
import { WorkflowProvider } from '../state/workflow-store';
import { BridgeProvider } from '../state/bridge-store';
import { Build009WalletProvider } from '../state/build009-wallet-store';
import { WalletSelectorProvider } from './wallet-selector';
import { PublicTestnetProvider } from '../state/public-testnet-store';
import { SupplyProvider } from '../state/supply-store';
import { LendingProvider } from '../state/lending-store';
import { RobinhoodTransferProvider } from '../state/robinhood-transfer-store';
import { JupiterProvider } from '../state/jupiter-store';
import { SolanaTransferProvider } from '../state/solana-transfer-store';
import { AcrossProvider } from '../state/across-store';
import { BridgeSwapProvider } from '../state/bridge-swap-store';
import { ModeAProvider } from '../state/mode-a-store';
import { CowProvider } from '../state/cow-store';
import { LiquidityProvider } from '../state/liquidity-store';
import { SolanaLiquidityProvider } from '../state/solana-liquidity-store';
import { SolanaCompositionProvider } from '../state/solana-composition-store';
import { UniswapLiquidityProvider } from '../state/uniswap-liquidity-store';
import { EngineeringProbe } from '../test-utils/engineering-probe';
import { RouterProvider } from '../state/router-store';
import { UniversalRouterProvider } from '../state/universal-router-store';
import { setActiveNetworkScope, type NetworkScope } from '../domain/network-scope';
import { ProductBootstrapProvider, type ProductBootstrap } from '../state/product-bootstrap';

const initialContext = { registryId: referenceRegistry.registryId, capabilityId: referenceRegistry.capabilities[0]!.id,
  actionId: referenceRegistry.actions[0]!.id, assets: baseAssetRegistry };
/** The existing provider hierarchy is shared by all product routes, keeping current runs mounted. */
const NO_BOOTSTRAP: ProductBootstrap = { walletHint: [], copilotMode: null };
export function ProductWorkspace({ initialWorkflowId, engineeringEnabled = false, networkScope = 'PUBLIC_MAINNET', bootstrap = NO_BOOTSTRAP }: { initialWorkflowId: string; engineeringEnabled?: boolean;
  /** BUILD-FLOFI-MAINNET-PRODUCT-001: the server's network scope, set before any store or card renders (never a user choice). */
  networkScope?: NetworkScope;
  /** BUILD-FLOFI-PRODUCT-UX-001: what the server rendered with (wallet restoration hint, Copilot mode), so hydration changes nothing. */
  bootstrap?: ProductBootstrap }) {
  setActiveNetworkScope(networkScope);
  const pathname = usePathname(), router = useRouter();
  const [approvalAvailable, setApprovalAvailable] = useState(false);
  const [approvalGate, setApprovalGate] = useState(false);
  const [approvalSlot, setApprovalSlot] = useState<HTMLDivElement | null>(null);
  // MCP account management owns its page; approval exposes the existing product
  // only after the server resolves a usable handoff. Product routes keep AppShell unchanged.
  // BUILD-FLOFI-UX-UI-002: on /approve the proposal's notice renders inside the workspace (no separate panel), and Simulate/Execute stay
  // closed until the proposal is loaded for the proven wallet.
  const embedded = pathname === '/mcp/approve';
  const approving = pathname === '/approve' || embedded;
  const showWorkspace = pathname !== '/connections' && (!approving || approvalAvailable);
  // BUILD-SOLANA-TRANSFER-UX-001: a proposal opens on the minimal signing surface ("Authorize"); `?view=canvas` or "Open Canvas" shows it on
  // the Canvas instead. Both are the same stores and orchestration; only the presentation differs.
  const [surface, setSurface] = useState<'signing' | 'canvas'>('signing');
  const [approvalWallet, setApprovalWallet] = useState<string | null>(null);
  useEffect(() => { if (approving) setSurface(!embedded && new URLSearchParams(window.location.search).get('view') === 'canvas' ? 'canvas' : 'signing'); }, [approving, embedded]);
  return <ProductBootstrapProvider value={bootstrap}><WalletSelectorProvider embedded={embedded}><WorkflowProvider initialContext={initialContext} initialWorkflowId={initialWorkflowId}><BridgeProvider><Build009WalletProvider><PublicTestnetProvider><SupplyProvider><LendingProvider><RobinhoodTransferProvider><JupiterProvider><SolanaTransferProvider><AcrossProvider><BridgeSwapProvider><ModeAProvider><CowProvider><LiquidityProvider><SolanaLiquidityProvider><SolanaCompositionProvider><UniswapLiquidityProvider><RouterProvider><UniversalRouterProvider>{engineeringEnabled && <EngineeringProbe/>}{embedded && <EmbeddedApproval/>}{approving && <><ApprovalHandoff slot={approvalSlot} surface={embedded ? 'signing' : surface} onSurfaceChange={embedded ? undefined : setSurface} onAvailabilityChange={setApprovalAvailable} onGateChange={setApprovalGate} onClaimedWallet={setApprovalWallet}/><ChannelProgressPing/></>}{showWorkspace && <AppShell engineering={engineeringEnabled && pathname === '/__engineering'} pathname={pathname} navigate={path => router.push(path)} approvalSlot={approving ? setApprovalSlot : undefined} approvalGate={approving && approvalGate}
  surface={embedded || approving && surface === 'signing' ? 'signing' : 'workspace'} approvalWallet={approving ? approvalWallet : null} autoPrepare={approving} onViewInFloFi={approving && !embedded ? () => setSurface('canvas') : undefined}/>}</UniversalRouterProvider></RouterProvider></UniswapLiquidityProvider></SolanaCompositionProvider></SolanaLiquidityProvider></LiquidityProvider></CowProvider></ModeAProvider></BridgeSwapProvider></AcrossProvider></SolanaTransferProvider></JupiterProvider></RobinhoodTransferProvider></LendingProvider></SupplyProvider></PublicTestnetProvider></Build009WalletProvider></BridgeProvider></WorkflowProvider></WalletSelectorProvider></ProductBootstrapProvider>;
}
