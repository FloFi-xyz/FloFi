// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { disconnectToLogin } from '../accounts/disconnect';
import { useAccountsOffered, useFloFiPrivy } from '../accounts/privy-context';
import { useAccountWalletLifecycle } from '../state/account-wallet-provisioner';
import { walletSlotState } from '../state/account-wallet-lifecycle';
import { useProductBootstrap } from '../state/product-bootstrap';
import { WalletAddress } from './wallet-address';
import { useLocale } from '../i18n/locale';

import { product } from '../config/product';
import { useModeB } from '../state/mode-b-store';
import { useModeA } from '../state/mode-a-store';
import { StatusBadge } from './status-badge';
import { useBuild009Wallet, chainName } from '../state/build009-wallet-store';
import { withoutChainId } from '../domain/approved-ux';
/** Board 16: the visible network name never carries its chain id ("Base", not "Base (8453)"); the hover title keeps the full technical label. */
const networkName = (id: string | null) => withoutChainId(chainName(id));
import { isLendingComposition } from '@defi-workflow-engine/workflow-contracts';
import { useLending } from '../state/lending-store';
import { useBridgeSwap } from '../state/bridge-swap-store';
import { useWorkflow } from '../state/workflow-store';
import { workflowShellContext, type WorkflowStage } from '../domain/product-shell';
import { isPristineDraft } from '../domain/initial-workflow';
import { EVM_WALLET_NETWORKS } from '../wallet/evm-networks';
import { activeNetworkScope, networkAllowed } from '../domain/network-scope';
import { useRouter } from '../state/router-store';
import { ROUTER_NETWORK_OPTIONS } from '../domain/router-authoring';
import { useJupiter } from '../state/jupiter-store';
import { FloFiLogo } from './flofi-logo';
import { HeaderSettings } from './header-settings';
import { useExecutionEnvironment } from '../state/capability-store';
import { NavigationDrawer } from './navigation-drawer';
import { useWalletConnection } from '../state/wallet-connection';
import { WalletMark } from './wallet-selector';
import { BUILD_ENTRY, type BuildEntrySection } from '../domain/build-entry';
import { PRODUCT_AREAS, productArea } from '../domain/product-areas';
import type { ReactNode } from 'react';
import Link from 'next/link';

export type Tab = WorkflowStage;
/**
 * BUILD0-UX-001: Build 0 (the intent entry) precedes the existing Build (Build 1), Simulate and Execute stages.
 * BUILD-FLOFI-CHAT-EDITOR-UX-001: the navigation is Dashboard | Chat | Editor. Chat is the intent entry (`BUILD_ENTRY`); the Editor is the
 * existing Build workspace (Canvas and side chat), and Simulate and Execute remain its sections, reached through the shared lifecycle, never
 * through top-level tabs. The section values are unchanged, so every existing transition keeps its target.
 */
export type ProductSection = Tab | 'Dashboard' | BuildEntrySection;


/** `compact` (BUILD-SOLANA-TRANSFER-UX-001, the `/approve` signing surface): brand, wallet and settings only — no stage navigation and no
 * Mainnet/Testnet switch, because the proposal fixes its own network. `entry` (BUILD0-UX-001) offers Chat (the intent entry) before the Editor
 * in the public chat-first workspace only. */
/**
 * BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio's approved UX): beside the logo, the global navigation names the product areas — Operate | Dashboard |
 * My Workflows — with a discreet blue indication of the current one; the drawer keeps every other destination. The Editor's Create → Simulate →
 * Execute indicator moved into the Editor's own header (`editor-chrome.tsx`), so it never appears here. `center` remains for a caller that
 * still passes content (none does). The right side keeps the wallet identity and Settings. The passive "Workflow network" label is gone (the
 * Canvas header chip shows it); its row keeps the real jobs: the attention strip and switch button when the wallet is on another network, and
 * provider errors.
 */
export function TopBar({ tab, setTab, pathname, engineering = false, compact = false, entry = false, center, newWorkflow }: { tab: ProductSection; setTab: (value: ProductSection) => void; pathname?: string | null; engineering?: boolean; compact?: boolean; entry?: boolean;
  /**
   * BUILD-P0-MAINNET-EXECUTION-RELIABILITY (Incident F): the drawer's "New workflow" starts a genuinely new workflow (new identity, clean Canvas and
   * conversation) and opens Chat on it. Before, it only switched to the Chat section, which kept talking to the previous Canvas and its run.
   */
  newWorkflow?: () => void;
  /** The Editor stepper, only while the Editor (Create, Simulate, Execute) is open. */ center?: ReactNode }) {
  const { t: tr } = useLocale();
  const { walletKind } = useExecutionEnvironment();
  const { info, wallet } = useModeA();
  const modeB = useModeB();
  const build009 = useBuild009Wallet();
  const bridgeSwap = useBridgeSwap();
  const { state } = useWorkflow();
  const workflow = state.workflow;
  const context = workflowShellContext(workflow);
  const router = useRouter();
  const jupiter = useJupiter();
  const lending = useLending();
  // BUILD-FLOFI-PRODUCT-UX-001: only a genuinely empty / untouched draft may inherit a recovered run's network; a canvas with real actions
  // always takes `requiredChain` from those actions. An empty canvas never invents a workflow network.
  const pristine = isPristineDraft(workflow);
  const lendingActive = isLendingComposition(workflow) || Boolean(pristine && lending.recovered && lending.record && !lending.retired);
  const build009Active = workflow.nodes[0]?.nodeId === 'build009-bridge' || Boolean(pristine && bridgeSwap.recovered && bridgeSwap.run);
  const destination = bridgeSwap.run && ['PARTIAL_COMPLETION','SWAP_QUOTED','SWAP_AUTHORIZED','SWAP_UNKNOWN','SWAP_SUBMITTED','SWAP_RECONCILED'].includes(bridgeSwap.run.state);
  const routerRecovery = router.recovered && router.record && pristine;
  const requiredChain = destination && build009Active ? 'eip155:42161' : context.requiredChain
    ?? (routerRecovery ? ROUTER_NETWORK_OPTIONS[router.network].pair.source.chainId : lendingActive ? 'eip155:84532'
      : pristine && jupiter.recovered && jupiter.record ? jupiter.record.review.chain : null);
  // This is only a shortcut to existing user-driven wallet switching, never a capability or execution decision.
  // BUILD-FLOFI-MAINNET-PRODUCT-001: never a test network (a legacy test-network workflow is rebuilt on its mainnet, not switched to).
  const switchTarget = networkAllowed(requiredChain, activeNetworkScope()) ? EVM_WALLET_NETWORKS.find(network => network.chain === requiredChain && network.switchable) : undefined;
  const solanaActive = walletKind === 'solana';
  const connection = useWalletConnection();
  const solanaDisconnect = () => { void jupiter.disconnect(); };
  const closeWallet = solanaActive ? solanaDisconnect : build009.reset;
  // BUILD-FLOFI-PRIVY-UX-001: where FloFi accounts exist, Disconnect always ends the FloFi session and Privy too and lands on the sign-in
  // page; a deployment without accounts has no sign-in to return to, so there it only closes the wallet connection, as before.
  const privy = useFloFiPrivy(), accounts = useAccountsOffered();
  const disconnect = accounts ? () => { void disconnectToLogin(privy, closeWallet); } : closeWallet;
  // BUILD-FLOFI-MAINNET-PRODUCT-001: there is no Mainnet/Testnet selector. FloFi runs on mainnets; a wallet on another network is offered the
  // workflow's own network below ("Switch to …"), and nothing moves a wallet to a test network.
  const disconnectDisabled = accounts ? (solanaActive ? jupiter.busy : build009.busy)
    : solanaActive ? !jupiter.session || jupiter.busy : !build009.account || build009.busy;
  const walletError = solanaActive ? connection.error : build009.error ?? connection.error;
  // P0 hotfix (locale contract): the notice as a catalog message and its values, in the current language (never English spliced into Portuguese).
  const walletNotice = solanaActive ? connection.notice : build009.notice ?? connection.notice;
  const provider = solanaActive ? jupiter.session ? { name: jupiter.session.wallet.name, icon: jupiter.session.wallet.icon ?? null } : null
    : build009.account ? build009.provider : null;
  const restoring = (solanaActive ? jupiter.restoring : build009.restoring)
    || (!build009.account && !jupiter.session && jupiter.restoring);
  // BUILD-FLOFI-BETA-UX-INTELLIGENCE-001 (WS01): while FloFi reads, recovers or creates the account's own wallets the slot says so, never
  // "Wallet not connected"; a failure offers Try again (no Credentials visit needed).
  const lifecycle = useAccountWalletLifecycle(), bootstrap = useProductBootstrap();
  // A ready lifecycle whose auto-connect is still connecting is still "setting up" (no brief false "Wallet not connected").
  // The compact approval header never shows or retries the account wallet lifecycle (channels review).
  const slot = !accounts || compact ? 'disconnected' : lifecycle.status === 'ready' && lifecycle.provisioned.length && (build009.busy || jupiter.busy) ? 'initializing'
    : walletSlotState(lifecycle, bootstrap.accountPresence?.signedIn ?? null, Boolean(privy && !privy.ready));
  const fork = info?.available ? info : null;
  const solanaAddress = jupiter.session?.account.address;
  const solanaTitle = solanaAddress && jupiter.session
    ? `${jupiter.session.wallet.name} · ${solanaAddress} · ${jupiter.session.chain === 'solana:devnet' ? 'Solana Devnet' : jupiter.session.chain === 'solana:mainnet' ? 'Solana mainnet-beta' : jupiter.session.chain}`
    : undefined;
  const evmTitle = build009.account ? `${provider?.name ?? 'EVM'} · ${build009.account} · ${chainName(build009.chainId)}` : undefined;
  // The wallet is on another network than the workflow's: the one attention strip with the existing user-driven switch (never automatic).
  const networkAttention = Boolean(!solanaActive && build009.account && switchTarget && build009.chainId !== switchTarget.hex);
  const walletProviderError = Boolean(!solanaActive && !build009.account && build009.providerError);
  const area = productArea(pathname, tab);
  return <header className={`top-bar${compact ? ' top-bar-compact' : ''}`}>
    <div className="brand">{!compact && <NavigationDrawer pathname={pathname ?? null} section={tab === BUILD_ENTRY ? 'Chat' : tab} onBuild={() => setTab('Build')} onChat={entry ? newWorkflow ?? (() => setTab(BUILD_ENTRY)) : undefined}
      onDisconnect={disconnect} disconnectDisabled={disconnectDisabled}/>}
      {/* BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio, A2/B2/C2): the symbol and name open Operate (/app), a client navigation inside this persistent
          workspace: the open workflow, its Canvas, the chat and the session stay. The compact /approve signing header keeps the logo inert. */}
      {compact ? <FloFiLogo/> : <Link href="/app" className="flofi-logo-link" aria-label={tr('FloFi — go to Operate')}><FloFiLogo/></Link>}
      {/* The global navigation names product areas (Operate | Dashboard | My Workflows); the Create → Simulate → Execute indicator lives only in the
          Editor's own header. The selected area has a discreet blue indication. */}
      {!compact && <nav className="product-areas" aria-label={tr('Product areas')}>
        {PRODUCT_AREAS.map(item => <Link key={item.id} href={item.href} className="product-area" aria-current={area === item.id ? 'page' : undefined}>{tr(item.label)}</Link>)}
      </nav>}</div>
    {!compact && center ? <div className="top-bar-center">{center}</div> : null}
    <div className="top-meta">
      <div className="header-wallet" role="group" aria-label={tr("Wallet connection")}>
      {provider && <span className="header-wallet-provider" title={provider.name}><WalletMark icon={provider.icon}/><span className="sr-only">{provider.name}</span></span>}
      {solanaActive && solanaAddress ? <span className="wallet-connection" title={solanaTitle}><WalletAddress address={solanaAddress} ecosystem="solana"/></span>
        : !solanaActive && build009.account ? <span className="build009-wallet-info wallet-connection" title={evmTitle}><span className="wallet-status-dot" aria-hidden="true"/><WalletAddress address={build009.account} ecosystem="evm" showEcosystem={false}/>
          {build009.chainId && <span className="wallet-network">{' · '}{tr(networkName(build009.chainId))}</span>}</span>
          : restoring ? <span className="wallet-connection" role="status">{tr("Restoring wallet…")}</span>
          : slot === 'initializing' ? <span className="wallet-connection" role="status" data-wallet-lifecycle="initializing">{tr("Setting up your wallet…")}</span>
          : slot === 'failed' ? <><span className="wallet-connection" role="status" data-wallet-lifecycle="failed">{tr(lifecycle.code === 'ACCOUNT_WALLET_LINKED_ELSEWHERE' ? 'That wallet already belongs to another FloFi account. Nothing was merged or moved.' : "Your wallet couldn't be set up.")}</span>
            {lifecycle.code !== 'ACCOUNT_WALLET_LINKED_ELSEWHERE' && <button type="button" onClick={lifecycle.retry}>{tr(lifecycle.code === 'PRIVY_ACCOUNT_MISMATCH' ? 'Sign in again' : 'Try again')}</button>}
            {/* Any other wallet (MetaMask, Phantom) can still be connected: it does not depend on FloFi's own wallets. */}
            <button type="button" onClick={() => void connection.connect()} disabled={build009.busy || jupiter.busy}>{tr("Connect Wallet")}</button></>
            : <><span className="wallet-connection">{tr(solanaActive ? 'Solana wallet not connected' : 'Wallet not connected')}</span><button type="button" onClick={() => void connection.connect()} disabled={build009.busy || jupiter.busy}>{tr("Connect Wallet")}</button></>}
      </div>
      {/* BUILD-P0-MAINNET-EXECUTION-RELIABILITY (Incident F): Log out is under the gear on every surface again (the drawer keeps its own entry to
          the same flow). */}
      <HeaderSettings onDisconnect={disconnect} disconnectDisabled={disconnectDisabled}/>
    </div>
    {!compact && <div className="shell-network-row" data-empty={networkAttention || walletProviderError || engineering ? undefined : 'true'}>
      {networkAttention && <p className="network-attention" role="status"><span>{tr('Your wallet is on {0}. Switch to {1} to continue.', tr(networkName(build009.chainId)), tr(networkName(switchTarget!.hex)))}</span>
        <button type="button" className="secondary" onClick={() => void connection.switchNetwork(switchTarget!.chain)} disabled={build009.busy}>{tr('Switch to {0}', tr(networkName(switchTarget!.hex)))}</button></p>}
      {walletProviderError && <span role="status">{tr(build009.providerError!)}</span>}
      {engineering && (fork || modeB.info?.available) && <details className="shell-technical"><summary>{tr("Technical connection details")}</summary><div>
        {fork && <span className="fork-badge"><StatusBadge label={`Local fork · ${fork.environment}`} tone="warning"/></span>}
        {modeB.info?.available && <StatusBadge label="Wallet permissions · local fork" tone="warning"/>}
        <span>{tr("EVM Default: ")}{tr(modeB.wallet ? `injected · ${modeB.wallet.account.slice(0, 6)}…${modeB.wallet.account.slice(-4)}` : wallet ? `injected · ${wallet.account.slice(0, 6)}…${wallet.account.slice(-4)}` : product.forkWallet)}</span>
        <span>{tr("Chain 31337 · local environment")}</span>
      </div></details>}
    </div>}
    {walletError && <div role="alert" className="wallet-toast">{tr("Wallet: ")}{walletNotice ? tr(...walletNotice) : tr(walletError)}</div>}
  </header>;
}
