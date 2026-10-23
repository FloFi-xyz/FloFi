// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { selectOwnerRuntime } from '../domain/runtime-selection';
import { BASE_MAINNET } from '@defi-workflow-engine/action-registry';
import { useLocale } from '../i18n/locale';

import { WithdrawPanel } from './withdraw-panel';
import { RobinhoodTransferPanel } from './robinhood-transfer-panel';
import { SolanaTransferPanel } from './solana-transfer-panel';
import { useSolanaTransfer } from '../state/solana-transfer-store';
import { useRobinhoodTransfer } from '../state/robinhood-transfer-store';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToolboxMode } from '../domain/canvas-layout';
import { CowPanel } from './cow-panel';
import { useCow } from '../state/cow-store';
import { ModeBProvider, useModeB } from '../state/mode-b-store';
import { CompositionProvider, useComposition } from '../state/composition-store';
import { CompositionPanel } from './composition-panel';
import { useModeA } from '../state/mode-a-store';
import { useWorkflow } from '../state/workflow-store';
import { useLiquidity } from '../state/liquidity-store';
import { LiquidityPanel } from './liquidity-panel';
import { BridgePanel } from './bridge-panel';
import { BridgeSwapPanel } from './bridge-swap-panel';
import { CrossChainLiquidityPanel } from './cross-chain-liquidity-panel';
import { AcrossPanel } from './across-panel';
import { useAcross } from '../state/across-store';
import { useBridgeSwap } from '../state/bridge-swap-store';
import { useBridge } from '../state/bridge-store';
import { EngineeringAuthoring } from '../test-utils/engineering-authoring';
import { ReviewPanel } from './review-panel';
import { ReviewWorkspace, ReviewTechnicalDetails } from './review-workspace';
import { SimulatePanel } from './simulate-panel';
import { ObservationPanel } from './observation-panel';
import { ForkSimulationPanel } from './fork-simulation-panel';
import { useExecutionControls } from '../state/execution-controls';
import { CanvasLifecycleAction } from './canvas-lifecycle-action';
import { ArtifactInspector } from './artifact-inspector';
import { CopilotPanel } from './copilot-panel';
import { MobileBuildNavigation } from './mobile-build-navigation';
import { ExecutionPanel } from './execution-panel';
import { ModeBPanel } from './mode-b-panel';
import { ExecuteWorkspace } from './execute-workspace';
import { useExecutionLifecycle } from '../state/execution-lifecycle';
import { useExecutionStart } from '../state/execution-start';
import { restoredLocalExecutionKind } from '../domain/execution-recovery';
import { currentExecution } from '../domain/execution-result';
import { ReviewAuthorizationDetails } from './review-workspace';
import { workflowBoundAuthorization } from '../domain/review-presentation';
import { useReviewAuthorization } from '../state/review-authorization';
import { useWalletConnection, walletNetworkTarget } from '../state/wallet-connection';
import { SummaryBar } from './summary-bar';
import type { SimulationSource } from '../domain/simulation-presentation';
import { SimulateWorkspace } from './simulate-workspace';
import { SigningSurface } from './signing-surface';
import { TopBar, type ProductSection } from './top-bar';
import { WorkflowCanvas } from './workflow-canvas';
import { PoolPriceRangeProvider } from './pool-price-range';
import { CanvasCardInputsProvider } from './canvas-card-inputs';
import { useWorkflowCapability } from '../state/capability-store';
import { usePublicTestnet } from '../state/public-testnet-store';
import { PublicTestnetPanel } from './public-testnet-panel';

import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import {useLending} from '../state/lending-store';
import {LendingPanel} from './lending-panel';
import { useSupply } from '../state/supply-store';
import { RepayPanel } from './repay-panel';
import { BorrowPanel } from './borrow-panel';
import { SupplyPanel } from './supply-panel';
import { useJupiter } from '../state/jupiter-store';
import { JupiterPanel } from './jupiter-panel';
import { SolanaLiquidityPanel } from './solana-liquidity-panel';
import { SolanaCompositionPanel } from './solana-composition-panel';
import { useSolanaComposition } from '../state/solana-composition-store';
import { useSolanaLiquidity } from '../state/solana-liquidity-store';
import { UniswapLiquidityPanel } from './uniswap-liquidity-panel';
import { useUniswapLiquidity } from '../state/uniswap-liquidity-store';
import { RouterPanel } from './router-panel';
import { useRouter } from '../state/router-store';
import { DashboardWorkspace } from './dashboard/dashboard-workspace';
import { dashboardRoute as resolveDashboardRoute } from '../lib/dashboard/routes';
import { secondaryWorkspaceRoute } from '../domain/secondary-workspaces';
import { SecondaryProductWorkspace } from './secondary-product-workspace';
import { AutomationInbox } from './automations-workspace';
import { automationsAvailability } from '../app/automation-action';

import { useSavedWorkflows } from '../state/saved-workflows';
import { useExecutionEnvironment } from '../state/capability-store';
import { useBuild009Wallet } from '../state/build009-wallet-store';
import { useWalletProof } from './wallet-proof';
import { WorkflowVerification } from './saved-workflows';

/** `approvalSlot`/`approvalGate` (BUILD-FLOFI-UX-UI-002, `/approve` only): where the proposal's notice renders, and whether Simulate and
 * Execute stay closed until the proposal is loaded for the proven wallet.
 * BUILD-SOLANA-TRANSFER-UX-001 (`/approve` only): `surface: 'signing'` presents the same orchestration as the minimal signing surface instead of
 * the Canvas; `approvalWallet` is the proven wallet the proposal was loaded for (only that signer may authorize it); `autoPrepare` runs the
 * proposal's fresh read-only simulation once it is loaded for that signer; `onViewInFloFi` switches to the Canvas presentation. */
type ProductNavigation = { engineering?: boolean; pathname?: string | null; navigate?: (path: string) => void;
  approvalSlot?: ((element: HTMLDivElement | null) => void) | undefined; approvalGate?: boolean;
  surface?: 'workspace' | 'signing'; approvalWallet?: string | null; autoPrepare?: boolean; onViewInFloFi?: (() => void) | undefined };
export function AppShell(props: ProductNavigation = {}) { return <ModeBProvider><CompositionProvider><CanvasCardInputsProvider><PoolPriceRangeProvider><AppShellContent {...props}/></PoolPriceRangeProvider></CanvasCardInputsProvider></CompositionProvider></ModeBProvider>; }

const sameAccount = (a: string, b: string) => a === b || /^0x/i.test(a) && a.toLowerCase() === b.toLowerCase();
const shortAccount = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
function AppShellContent({ engineering = false, pathname, navigate, approvalSlot, approvalGate = false, surface = 'workspace', approvalWallet = null, autoPrepare = false, onViewInFloFi }: ProductNavigation) {
  const { t: tr } = useLocale();
  // Server HTML is visible before handlers and initial canvas preferences are ready.
  const [interactive, setInteractive] = useState(false);
  useEffect(() => { setInteractive(true); }, []);
  const { state, context, reviewError, authoringIncomplete, restoreWorkflow, restorationEpoch, propose, createNewWorkflow, newWorkflow } = useWorkflow();
  // UX-004: a run recovered (or just finished) into the visit's initial draft is not re-attached to a workflow the owner created afresh.
  const recoveryShell = !newWorkflow;
  const modeA = useModeA();
  const { prepared, info } = modeA;
  const modeB = useModeB();
  const composition = useComposition();
  const cow = useCow();
  const liquidity = useLiquidity();
  const bridge = useBridge();
  const bridgeSwap = useBridgeSwap();
  const across = useAcross();
  const [section, setSection] = useState<ProductSection>('Build');
  const dashboardRoute = resolveDashboardRoute(pathname);
  const secondaryRoute = secondaryWorkspaceRoute(pathname);
  const tab = dashboardRoute ? 'Dashboard' : section;
  const setTab = useCallback((section: ProductSection) => {
    if ((authoringIncomplete || approvalGate) && (section === 'Simulate' || section === 'Execute')) return;
    if (navigate && section === 'Dashboard') { navigate('/app/dashboard'); return; }
    setSection(section);
    if (navigate && (dashboardRoute || secondaryRoute)) navigate('/app');
  }, [authoringIncomplete, approvalGate, navigate, dashboardRoute, secondaryRoute]);
  const [workflowName, setWorkflowName] = useState('Your Workflow');
  const connectedWallet = useBuild009Wallet();
  const walletIdentity = useExecutionEnvironment();
  const solanaSession = useJupiter().session;
  const owner = walletIdentity.walletKind === 'solana'
    ? solanaSession ? { namespace: 'solana' as const, address: solanaSession.account.address } : null
    : connectedWallet.account ? { namespace: 'eip155' as const, address: connectedWallet.account } : null;
  const proof = useWalletProof(owner?.namespace ?? null, solanaSession?.chain ?? 'solana:devnet');
  // BUILD-AUTOMATION-002: "Automate this workflow" is offered only where automations run; it carries the exact Canvas workflow (shared state).
  const [automationsReady, setAutomationsReady] = useState(false), [automateCanvas, setAutomateCanvas] = useState(false);
  useEffect(() => { void automationsAvailability().then(r => setAutomationsReady(r.enabled)).catch(() => setAutomationsReady(false)); }, []);
  const library = useSavedWorkflows(owner);
  const refreshLibrary = library.refresh;
  useEffect(() => { if (proof.proven === owner?.address) refreshLibrary(); }, [proof.proven, owner?.address, refreshLibrary]);
  const [saveNotice, setSaveNotice] = useState<{ owner: string | null; message: string } | null>(null);
  const [showVerification, setShowVerification] = useState(false);
  const ownerKey = owner ? `${owner.namespace}:${owner.address}` : null;
  async function saveCurrentWorkflow() {
    if (!owner) { setSaveNotice({ owner: null, message: 'Connect your wallet to save workflows.' }); return; }
    if (authoringIncomplete) { setSaveNotice({ owner: ownerKey, message: 'Configure the workflow before saving.' }); return; }
    if (proof.proven !== owner.address) { setShowVerification(true); return; }
    const saved = await library.save(state.workflow as SemanticWorkflow, workflowName);
    if (saved) setSaveNotice({ owner: ownerKey, message: 'Workflow saved.' });
  }
  async function reopenWorkflow(id: string) {
    const document = await library.open(id);
    if (!document) return;
    restoreWorkflow(document.workflow); setWorkflowName(document.name ?? 'Your Workflow');
    setSaveNotice({ owner: ownerKey, message: 'Workflow restored. Simulate again before reviewing.' });
    setTab('Build');
  }
  const workflows = { list: library.list, busy: library.busy, error: library.error,
    open: (id: string) => { void reopenWorkflow(id); }, refresh: () => { void proof.refresh(); library.refresh(); } };
  useEffect(() => { if (secondaryRoute?.id === 'workflows') refreshLibrary(); }, [secondaryRoute?.id, refreshLibrary]);
  const verification = owner && showVerification && proof.proven !== owner.address
    ? <WorkflowVerification namespace={owner.namespace} account={owner.address} proof={proof}/> : undefined;

  const [workspaceToolboxMode, setWorkspaceToolboxMode] = useState<ToolboxMode>('top');
  const supply = useSupply();
  const transfer = useRobinhoodTransfer(), solanaTransfer = useSolanaTransfer(), lending = useLending(), jupiter = useJupiter();
  const solanaLiquidity = useSolanaLiquidity(), uniswapLiquidity = useUniswapLiquidity(), routerState = useRouter(), solanaComposition = useSolanaComposition();
  const publicTestnet = usePublicTestnet();
  // BUILD-FLOFI-UNIVERSAL-E2E-001: the runtime that serves this workflow comes from its own actions and networks. A run a store recovered
  // from this browser serves only the visit's untouched draft or exactly its own workflow, never another one (e.g. a Base Sepolia swap
  // opened on /approve after a Solana Mainnet Jupiter run). The order is unchanged: a Solana transfer never reaches the EVM transfer
  // runtime; Aave paths before the isolated position and Solana paths; the Solana composition before the isolated Solana paths.
  const supplyReview = supply.record?.review;
  const runtime = selectOwnerRuntime(state.workflow, { recoveryShell,
    solanaTransfer: { recovered: solanaTransfer.recovered, workflow: solanaTransfer.record?.review.workflow ?? null },
    // RH-DEMO-001: the transfer store has no recovery flag; its persisted run still attaches only to the untouched template.
    transfer: { recovered: Boolean(transfer.record), workflow: transfer.record?.review.workflow ?? null },
    lending: { recovered: lending.recovered, workflow: lending.record?.reviews[0]?.workflow ?? null },
    supply: { recovered: supply.recovered, workflow: supplyReview?.workflow ?? null,
      operation: !supplyReview ? null : supplyReview.withdraw ? 'withdraw' : supplyReview.repay ? 'repay' : supplyReview.borrow ? 'borrow' : 'supply' },
    uniswapLiquidity: { recovered: uniswapLiquidity.recovered, workflow: uniswapLiquidity.record?.workflow ?? null },
    router: { recovered: routerState.recovered, workflow: routerState.record?.workflow ?? null },
    solanaComposition: { recovered: solanaComposition.recovered, workflow: solanaComposition.record?.record.review.workflow ?? null },
    solanaLiquidity: { recovered: solanaLiquidity.recovered, workflow: solanaLiquidity.record?.review.workflow ?? null },
    jupiter: { recovered: jupiter.recovered, workflow: jupiter.record?.review.workflow ?? null },
    publicSwap: { recoveryOnly: publicTestnet.recoveryOnly, workflow: publicTestnet.run?.workflow ?? null,
      continuedApproval: Boolean(publicTestnet.run && !publicTestnet.retired && publicTestnet.run.attempts.at(-1)?.step === 'approval' && publicTestnet.run.attempts.at(-1)?.state === 'CONFIRMED') },
    // The shared owner-wallet Uniswap swap: the testnet pairs and (BUILD-RH-002, BUILD-BASE-001) catalog-network swaps. Base USDC ⇄ WETH joins
    // it only where Base mainnet swaps are enabled and no local fork runtime is available; otherwise it keeps its BUILD-002 paths.
    baseReferenceServed: publicTestnet.catalogAvailable(BASE_MAINNET.chain) && !info?.available });
  const { routerPath, solanaTransferPath, transferPath, lendingPath, withdrawPath, repayPath, borrowPath, supplyPath, uniswapLiquidityPath,
    solanaCompositionPath, solanaLiquidityPath, solanaPath, publicPath } = runtime;
  const [selectedId, select] = useState<string | null>(null);
  const [inspectorExpanded, setInspectorExpanded] = useState(false);
  const selectAction = useCallback((id: string | null) => {
    select(id);
    if (!id) setInspectorExpanded(false);
  }, []);
  const openActionSettings = useCallback((id: string) => {
    select(id);
    setInspectorExpanded(true);
  }, []);
  const { environment, walletEnvironment, result: capability } = useWorkflowCapability();
  const acrossWorkflow = state.workflow.nodes.length === 1 && state.workflow.nodes[0]?.adapterConstraints.adapters[0]?.id === 'across.direct';
  const bridgeSwapWorkflow = (state.workflow.nodes.length === 2 && state.workflow.nodes[0]?.nodeId === 'build009-bridge') || Boolean(bridgeSwap.run);
  const crossChainWorkflow = state.workflow.nodes.some(n => n.actionType === 'asset.liquidity.prepare');
  const bridgeWorkflow = !routerPath && state.workflow.nodes.length === 1 && state.workflow.nodes[0]?.actionType === 'asset.bridge';
  const forkExecution = tab === 'Execute' && Boolean(crossChainWorkflow || (info?.available && prepared) || modeB.info?.available || cow.execution || (liquidity.info?.available && liquidity.prepared) || composition.info?.available || bridge.execution || bridgeSwap.run || across.run);
  const persistedBuild009Recovery = bridgeSwap.recovered &&
    bridgeSwap.run?.format === 'gryloo.build009.mocked.v1' &&
    !['BRIDGE_QUOTED', 'BRIDGE_AUTHORIZED'].includes(bridgeSwap.run.state);
  const recoveryPath = recoveryShell && Boolean(modeA.recoveryOnly || modeB.recoveryOnly || composition.recoveryOnly || liquidity.recoveryOnly ||
    cow.recoveryOnly || bridge.recoveryOnly || persistedBuild009Recovery || across.recovered);
  // The existing CoW loopback runtime is explicitly disabled on deployed environments.
  const localCowIntent = Boolean(cow.info?.enabled && cow.execution);
  const executionSurface = routerPath || solanaTransferPath || transferPath || lendingPath || withdrawPath || repayPath || borrowPath || supplyPath || uniswapLiquidityPath || solanaCompositionPath || solanaLiquidityPath || solanaPath || publicPath || recoveryPath || localCowIntent || (environment !== 'PUBLIC_TESTNET' && environment !== 'MAINNET' &&
    capability.executionSupported && forkExecution);
  // Select the same runtime as the existing Simulate surface; presentation never changes its gates.
  const restoredLocalKind = restoredLocalExecutionKind(state.workflow, recoveryShell ? { composition: composition.recoveryOnly, liquidity: liquidity.recoveryOnly, cow: cow.recoveryOnly } : { composition: false, liquidity: false, cow: false });
  let simulationSource: SimulationSource = runtime.kind === 'router' ? { kind: 'router', state: routerState }
    : runtime.kind === 'solana-transfer' ? { kind: 'solana-transfer', state: solanaTransfer }
    : runtime.kind === 'transfer' ? { kind: 'transfer', state: transfer }
    : runtime.kind === 'lending' ? { kind: 'lending', state: lending }
    : runtime.kind === 'supply' ? { kind: 'supply', state: supply }
    : runtime.kind === 'uniswap-pool' ? { kind: 'uniswap-pool', state: uniswapLiquidity }
    : runtime.kind === 'solana-composition' ? { kind: 'solana-composition', state: solanaComposition }
    : runtime.kind === 'solana-pool' ? { kind: 'solana-pool', state: solanaLiquidity }
    : runtime.kind === 'solana-swap' ? { kind: 'solana-swap', state: jupiter }
    : runtime.kind === 'public' ? { kind: 'public', state: publicTestnet }
    : crossChainWorkflow ? { kind: 'unavailable', state: { error: null, busy: false } }
    : acrossWorkflow || across.run ? { kind: 'across', state: across }
    : bridgeSwapWorkflow ? { kind: 'unavailable', state: bridgeSwap }
    : bridgeWorkflow ? { kind: 'unavailable', state: bridge }
    : restoredLocalKind === 'composition' || state.workflow.nodes.some(n => n.actionType.includes('liquidity')) && state.workflow.nodes.some(n => n.actionType === 'asset.swap.exact-input')
      ? { kind: 'composition', state: composition }
    : restoredLocalKind === 'fork-pool' || state.workflow.nodes.some(n => n.actionType.includes('liquidity')) ? { kind: 'fork-pool', state: liquidity }
    : restoredLocalKind === 'cow' || state.workflow.nodes.some(n => n.adapterConstraints.protocols.includes('cow-protocol'))
      ? { kind: 'unavailable', state: cow }
    : modeB.status?.prepared && !modeB.retired ? { kind: 'delegated-swap', state: modeB }
    : { kind: 'fork-swap', state: modeA };
  const reviewBinding = useReviewAuthorization(simulationSource.kind);
  const [restoredBinding, setRestoredBinding] = useState({ epoch: restorationEpoch, key: null as string | null });
  if (restoredBinding.epoch !== restorationEpoch) setRestoredBinding({ epoch: restorationEpoch, key: reviewBinding.authorization.key });
  if (restorationEpoch > 0 && (restoredBinding.epoch !== restorationEpoch || restoredBinding.key === reviewBinding.authorization.key))
    simulationSource = { ...simulationSource, state: { ...simulationSource.state, retired: true } } as SimulationSource;
  // BUILD-FLOFI-UNIVERSAL-E2E-001: every surface (Canvas Review, Execute, the /approve signing surface) presents and approves only this
  // workflow's own Review; a retired or other-network Review is dropped, never shown beside this workflow.
  const authorization = workflowBoundAuthorization(reviewBinding.authorization, state.workflow, simulationSource);
  const executionProgress = useExecutionLifecycle(simulationSource.kind, reviewBinding.wallet);
  const recordedStart = useExecutionStart(simulationSource.kind, reviewBinding.wallet);
  // BUILD-FIX-UX-001: a final run of another (new or edited) workflow has not started this workflow's execution; its record is unchanged.
  const executionStart = executionProgress.started && !currentExecution(executionProgress) ? { ...recordedStart, started: false } : recordedStart;
  function openSimulationControls() {
    const details = document.querySelector<HTMLDetailsElement>('.simulation-technical');
    if (details) { details.open = true; details.scrollIntoView({ block: 'start' }); details.querySelector<HTMLElement>('summary')?.focus(); }
  }
  const solanaReview = solanaLiquidity.record?.review;
  const simulateAgain = simulationSource.kind === 'router' ? routerState.simulate
    : simulationSource.kind === 'solana-transfer' ? solanaTransfer.simulate
    : simulationSource.kind === 'transfer' ? transfer.simulate
    : simulationSource.kind === 'lending' ? lending.simulate
    : simulationSource.kind === 'supply' ? supply.simulate
    : simulationSource.kind === 'uniswap-pool' ? uniswapLiquidity.simulate
    : simulationSource.kind === 'solana-composition' ? solanaComposition.simulate
    : simulationSource.kind === 'solana-pool' ? () => solanaLiquidity.simulate(solanaReview?.operation ?? 'OPEN', solanaReview?.operation === 'OPEN' ? undefined : solanaReview?.accounts.positionMint, solanaReview?.partBps ?? undefined)
    : simulationSource.kind === 'solana-swap' ? jupiter.simulate
    : simulationSource.kind === 'public' ? publicTestnet.simulate
    : simulationSource.kind === 'fork-swap' ? modeA.simulate
    : simulationSource.kind === 'delegated-swap' ? modeB.prepare
    : simulationSource.kind === 'composition' ? composition.prepare
    : openSimulationControls;
  const embeddedReview = <ReviewAuthorizationDetails workflowName={workflowName} workflow={state.workflow} context={context} source={simulationSource} authorization={authorization} wallet={reviewBinding.wallet} invalidWorkflow={Boolean(reviewError)} backToBuild={() => setTab('Build')}/>;
  const simulationDisabled = authoringIncomplete || approvalGate || simulationSource.kind === 'unavailable' ||
    ('available' in simulationSource.state && simulationSource.state.available === false) ||
    ('info' in simulationSource.state && simulationSource.state.info?.available === false);
  // BUILD-SOLANA-TRANSFER-UX-001: a proposal loaded for one proven wallet is authorized by that same signer only. A different connected
  // account is never substituted: its simulation and Review would bind another owner, so the action waits for the right wallet.
  const signer = reviewBinding.wallet.account;
  const walletConnection = useWalletConnection();
  const walletIssue = approvalWallet && signer && !sameAccount(approvalWallet, signer)
    ? tr('This proposal was loaded for {0}. Switch your wallet to that account to authorize it.', shortAccount(approvalWallet)) : null;
  const requiredSigningChain = !('retired' in simulationSource.state && simulationSource.state.retired) && authorization.chain
    || state.workflow.nodes.find(node => !node.actionType.startsWith('mock-'))?.chainId;
  const networkTarget = walletNetworkTarget(requiredSigningChain);
  const networkAction = signer && requiredSigningChain && networkTarget && reviewBinding.wallet.chain !== requiredSigningChain ? {
    label: tr('Switch to {0}', networkTarget.label), disabled: Boolean(simulationSource.state.busy || approvalGate || walletIssue),
    request: () => void walletConnection.switchNetwork(requiredSigningChain),
  } : undefined;
  const lifecycleState = { workflow: state.workflow, context, source: simulationSource, authorization: authorization,
    wallet: reviewBinding.wallet, execution: executionStart, progress: executionProgress, recovery: executionProgress.recovery,
    invalidWorkflow: Boolean(reviewError || authoringIncomplete || approvalGate || walletIssue || autoPrepare && !approvalWallet) };
  const lifecycleControls = useExecutionControls(lifecycleState);
  // A proposal opened from a chat, MCP client or channel prepares its own fresh, read-only simulation as soon as it is loaded for that signer:
  // once per workflow revision and signer, never during or after a recorded run of this workflow, never retried automatically, and nothing is
  // accepted or signed. BUILD-CHAT-E2E-001: the final run of another workflow (the previous step of a multi-step run) does not count.
  const actionable = state.workflow.nodes.some(node => !node.actionType.startsWith('mock-'));
  const prepareKey = autoPrepare && approvalWallet && !approvalGate && !walletIssue && signer && actionable && !authoringIncomplete && !simulationDisabled && !currentExecution(executionProgress)
    ? `${state.workflow.workflowId}:${state.workflow.revision}:${restorationEpoch}:${signer}:${reviewBinding.wallet.chain}:${connectedWallet.revision}:${jupiter.revision}` : null;
  const preparedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!prepareKey || preparedFor.current === prepareKey || simulationSource.state.busy) return;
    preparedFor.current = prepareKey;
    if (authorization.key && !reviewBinding.wallet.changed && !('retired' in simulationSource.state && simulationSource.state.retired)) return;
    if (surface !== 'signing') setTab('Simulate');
    void simulateAgain();
  // A proposal that arrived while its runtime was busy gets its one preparation when that request settles.
  }, [prepareKey, simulationSource.state.busy]);
  // UX-004: after a final result, start a genuinely clean workflow in Build. Only workflow-scoped state resets (canvas, drafts, proposal,
  // selection, name, Review binding, notices, Copilot conversation); the wallet connection, sign-in session and preferences are untouched.
  const [workflowEpoch, setWorkflowEpoch] = useState(0);
  function startNewWorkflow() {
    createNewWorkflow(); setWorkflowName('Your Workflow'); selectAction(null); setSaveNotice(null); setShowVerification(false); setAutomateCanvas(false);
    setWorkflowEpoch(epoch => epoch + 1); setTab('Build');
  }
  const simulateAction = walletIssue ? <div className="canvas-lifecycle-control"><p role="status">{walletIssue}</p><button type="button" onClick={() => void walletConnection.connect()}>{tr('Use another wallet')}</button></div>
    : networkAction ? <div className="canvas-lifecycle-control"><button type="button" disabled={networkAction.disabled} onClick={networkAction.request}>{networkAction.label}</button>{walletConnection.error && <p role="status">{tr(walletConnection.error)}</p>}</div> : <CanvasLifecycleAction {...lifecycleState} controls={lifecycleControls} workflowName={workflowName}
    simulationDisabled={simulationDisabled || !actionable}
    simulate={() => { setTab('Simulate'); return simulateAgain(); }} onExecute={() => setTab('Execute')}/>;
  if (surface === 'signing') return <div className="app-shell signing-shell" inert={!interactive}><a className="skip-link" href="#workspace">{tr("Skip to workspace")}</a>
    <TopBar compact tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering}/>
    <SigningSurface {...lifecycleState} controls={lifecycleControls} workflowName={workflowName} simulate={simulateAgain} simulationDisabled={simulationDisabled || !actionable}
      gated={approvalGate} walletIssue={walletIssue} networkAction={networkAction} walletRequestError={walletConnection.error} connectWallet={() => void walletConnection.connect()} approvalSlot={approvalSlot} onViewInFloFi={onViewInFloFi}
      startNewWorkflow={navigate ? () => { startNewWorkflow(); navigate('/app'); } : undefined}/>
  </div>;
  if (secondaryRoute) return <div className="app-shell" inert={!interactive}><a className="skip-link" href="#workspace">{tr("Skip to workspace")}</a><TopBar tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering}/>
    <main id="workspace" className="main secondary-workspace" tabIndex={-1} aria-label={tr('{0} workspace', tr(secondaryRoute.label))}><SecondaryProductWorkspace workspace={secondaryRoute.id} workflows={{ ...workflows, loading: library.loading, connected: Boolean(owner), verification: owner && library.error === 'WALLET_SESSION_REQUIRED' ? <WorkflowVerification namespace={owner.namespace} account={owner.address} proof={proof}/> : undefined }}
      automations={{ owner, proof, onPropose: command => { propose(command); setTab('Build'); },
        canvas: automateCanvas ? { workflow: state.workflow, name: workflowName, dismiss: () => setAutomateCanvas(false) } : null }}/>
</main>
  </div>;
  if (tab === 'Dashboard') return <div className="app-shell" inert={!interactive}><a className="skip-link" href="#workspace">{tr("Skip to workspace")}</a><TopBar tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering}/>
    <main id="workspace" className="main" tabIndex={-1} aria-label={tr("Dashboard")}><DashboardWorkspace workflowName={workflowName} progress={executionProgress} recovery={executionProgress.recovery} wallet={reviewBinding.wallet} context={context}
      runId={dashboardRoute?.runId ?? null}
      build={() => setTab('Build')} execute={() => setTab('Execute')} navigate={navigate ?? (() => undefined)}/></main>
  </div>;
  if (authoringIncomplete && tab !== 'Build') return <div className="app-shell" inert={!interactive}><TopBar tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering}/><main className="main"><section className="panel stage-empty"><p>{tr("Configure the action amount in Build first.")}</p><button type="button" onClick={() => setTab('Build')}>{tr("Return to Build")}</button></section></main></div>;
  const stageContent = tab === 'Build' ? <><div className="build-grid"><WorkflowCanvas estimateOwner={solanaSession?.account.address} environment={walletEnvironment} selectedId={selectedId} select={selectAction} openSettings={openActionSettings} workflowName={workflowName} renameWorkflow={setWorkflowName} onAutomate={automationsReady ? () => { setAutomateCanvas(true); navigate?.('/app/automations'); } : undefined} onSave={() => void saveCurrentWorkflow()} onToolboxModeChange={setWorkspaceToolboxMode} primaryAction={simulateAction}/><CopilotPanel key={workflowEpoch} interactive={interactive} owner={owner} proof={proof}/></div>{verification}{saveNotice?.owner === ownerKey && <p role="status">{tr(saveNotice.message)}</p>}{library.busy && <p role="status">{tr('Saving workflow…')}</p>}{library.error && library.error !== 'WALLET_SESSION_REQUIRED' && <p role="alert">{tr(library.error === 'WORKFLOW_VERSION_CONFLICT' ? 'This workflow was updated in another session. Reopen it before saving.' : 'Workflow saving is unavailable. Try again.')}</p>}<ArtifactInspector selectedId={selectedId} select={selectAction} expanded={inspectorExpanded} onExpandedChange={setInspectorExpanded}/>
          {engineering && <EngineeringAuthoring selectedId={selectedId}><ReviewPanel/></EngineeringAuthoring>}</>
        : tab === 'Simulate' && engineering ? routerPath ? <RouterPanel view="simulate"/> : solanaTransferPath ? <SolanaTransferPanel view="simulate"/> : transferPath ? <RobinhoodTransferPanel view="simulate"/> : lendingPath ? <LendingPanel view="simulate"/> : withdrawPath ? <WithdrawPanel view="simulate"/> : repayPath ? <RepayPanel view="simulate"/> : borrowPath ? <BorrowPanel view="simulate"/> : supplyPath ? <SupplyPanel view="simulate"/> : uniswapLiquidityPath ? <UniswapLiquidityPanel view="simulate"/> : solanaCompositionPath ? <SolanaCompositionPanel view="simulate"/> : solanaLiquidityPath ? <SolanaLiquidityPanel view="simulate"/> : solanaPath ? <JupiterPanel view="simulate"/> : publicPath ? <PublicTestnetPanel view="simulate"/> : crossChainWorkflow ? <CrossChainLiquidityPanel view="simulate"/> : acrossWorkflow || across.run ? <AcrossPanel view="simulate"/> : bridgeSwapWorkflow ? <BridgeSwapPanel view="simulate"/> : bridgeWorkflow ? <BridgePanel view="simulate"/> : <SimulatePanel engineeringOnly workflowName={workflowName}><ReviewWorkspace workflowName={workflowName} workflow={state.workflow} context={context} source={simulationSource} authorization={authorization} wallet={reviewBinding.wallet} invalidWorkflow={Boolean(reviewError)} backToBuild={() => setTab('Build')} simulateAgain={simulateAgain} actionSurface="canvas" showTechnicalDetails={false}/><ObservationPanel/><ForkSimulationPanel/><ModeBPanel view="simulate"/><CompositionPanel view="simulate"/><CowPanel view="simulate"/><LiquidityPanel view="simulate"/></SimulatePanel>
        : executionSurface ? routerPath ? <RouterPanel view="execute"/> : solanaTransferPath ? <SolanaTransferPanel view="execute"/> : transferPath ? <RobinhoodTransferPanel view="execute"/> : lendingPath ? <LendingPanel view="execute"/> : withdrawPath ? <WithdrawPanel view="execute"/> : repayPath ? <RepayPanel view="execute"/> : borrowPath ? <BorrowPanel view="execute"/> : supplyPath ? <SupplyPanel view="execute"/> : uniswapLiquidityPath ? <UniswapLiquidityPanel view="execute"/> : solanaCompositionPath ? <SolanaCompositionPanel view="execute"/> : solanaLiquidityPath ? <SolanaLiquidityPanel view="execute"/> : solanaPath ? <JupiterPanel view="execute"/> : publicPath ? <PublicTestnetPanel view="execute"/> : persistedBuild009Recovery ? <BridgeSwapPanel view="execute"/> : across.recovered ? <AcrossPanel view="execute"/> :
          bridge.recoveryOnly ? <BridgePanel view="execute"/> : modeA.recoveryOnly || modeB.recoveryOnly ||
          composition.recoveryOnly || liquidity.recoveryOnly || cow.recoveryOnly ?
            <><ExecutionPanel/><ModeBPanel view="execute"/><CompositionPanel view="execute"/><CowPanel view="execute"/><LiquidityPanel view="execute"/></> :
          crossChainWorkflow ? <CrossChainLiquidityPanel view="execute"/> : across.run ? <AcrossPanel view="execute"/> :
          bridgeSwap.run ? <BridgeSwapPanel view="execute"/> : bridge.execution ? <BridgePanel view="execute"/> :
          <><ExecutionPanel/><ModeBPanel view="execute"/><CompositionPanel view="execute"/><CowPanel view="execute"/><LiquidityPanel view="execute"/></>
        : null;
  return <div className="app-shell" inert={!interactive}><a className="skip-link" href="#workspace">{tr("Skip to workspace")}</a><TopBar tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering}/>
    {approvalSlot && <div className="approval-notice-slot" ref={approvalSlot}/>}
    <AutomationInbox owner={owner} proven={Boolean(owner && proof.proven === owner.address)} open={() => navigate?.('/app/automations')}/>
    <main id="workspace" className={`main workflow-workspace${tab === 'Build' ? ' build-workspace' : ''}`} data-workspace-toolbox={workspaceToolboxMode} tabIndex={-1} aria-label={tr(tab === 'Build' ? 'Workflow workspace' : tab === 'Simulate' ? 'Simulation workspace' : 'Execution workspace')}>
      {tab === 'Execute' ? <ExecuteWorkspace controls={lifecycleControls} primaryAction={simulateAction} workflowName={workflowName} workflow={state.workflow} context={context} source={simulationSource} authorization={authorization} wallet={reviewBinding.wallet} execution={executionStart} progress={executionProgress} recovery={executionProgress.recovery} invalidWorkflow={Boolean(reviewError || authoringIncomplete)} backToBuild={() => setTab('Build')} backToSimulate={() => setTab('Simulate')} startNewWorkflow={startNewWorkflow} technicalDetails={executionStart.started || executionProgress.started || recoveryPath || localCowIntent ? stageContent : undefined}/> : tab === 'Simulate' ?
        <SimulateWorkspace workflowName={workflowName} returnToBuild={() => setTab('Build')} simulationSource={simulationSource} review={embeddedReview} simulateAction={simulateAction}>
          {engineering && <details className="shell-details technical-workspace simulation-technical"><summary>{tr('View technical details')}</summary><ReviewTechnicalDetails authorization={authorization}/>{stageContent}</details>}
        </SimulateWorkspace> : stageContent}
      <MobileBuildNavigation stage={tab === 'Build' ? 'Build' : tab === 'Simulate' ? 'Simulate' : 'Execute'}/>
      {state.error && <div className="error-banner" role="alert"><strong>{tr("Edit not applied")}</strong><span>{tr(tab !== 'Build' ? 'Review the workflow configuration in Build before simulating again.' : state.error)}</span></div>}
    </main>{tab !== 'Execute' && <SummaryBar tab={tab} setTab={setTab} canvasOwnsAction/>}
  </div>;
}
