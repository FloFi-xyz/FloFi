// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { simulationUnavailableReason } from '../domain/simulation-unavailable';
import { refreshBridgeAfterApproval } from '../domain/bridge-review-recovery';
import { flightWalletAccess } from '../app/flight-wallet-action';
import { flightRefusal } from '../domain/flight-refusal';
import { selectOwnerRuntime, type OwnerRuntimeSignals } from '../domain/runtime-selection';
import { DELIVERY_READABLE, deliveredByRecord, SEQUENCE_RUNTIMES, sequenceOrder, stepAssets } from '../domain/workflow-sequence';
import { ownerByRecord } from '../domain/sequence-restore';
import { shortAddress } from '../accounts/account-model';
import { presentSequence, sequenceFundingMessage, sequenceUnservedMessage, sequenceUnsupportedMessage } from '../domain/sequence-presentation';
import { composerActions, composerSummary } from '../domain/composer-presentation';
import { setupSummary } from '../domain/canvas-action-setup';
import { shellChainLabel } from '../domain/product-shell';
import type { PendingEdit } from '../state/flofi-conversation';
import { BASE_MAINNET } from '@defi-workflow-engine/action-registry';
import { useLocale } from '../i18n/locale';

import { WithdrawPanel } from './withdraw-panel';
import { RobinhoodTransferPanel } from './robinhood-transfer-panel';
import { SolanaTransferPanel } from './solana-transfer-panel';
import { useSolanaTransfer } from '../state/solana-transfer-store';
import { useRobinhoodTransfer } from '../state/robinhood-transfer-store';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ToolboxMode } from '../domain/canvas-layout';
import { CowPanel } from './cow-panel';
import { useCow } from '../state/cow-store';
import { ModeBProvider, useModeB } from '../state/mode-b-store';
import { CompositionProvider, useComposition } from '../state/composition-store';
import { CompositionPanel } from './composition-panel';
import { useModeA } from '../state/mode-a-store';
import { FlightBoarding, useFlightDraft } from '../flight/app-boarding';
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
import { ActionSettingsPopover } from './artifact-inspector';
import { CopilotPanel } from './copilot-panel';
import { useFlofiConversation } from '../state/flofi-conversation';
import { MobileBuildNavigation } from './mobile-build-navigation';
import { ExecutionPanel } from './execution-panel';
import { ModeBPanel } from './mode-b-panel';
import { ExecuteWorkspace } from './execute-workspace';
import { EditorRunAction } from './editor-run-action';
import { EditorWorkflowRunPanel, useEditorWorkflowRun } from './editor-workflow-run';
import { projectCanvasAction } from '../domain/canvas-lifecycle';
import { editorRunReadiness } from '../domain/editor-run';
import { useExecutionLifecycle } from '../state/execution-lifecycle';
import { useExecutionStart } from '../state/execution-start';
import { restoredLocalExecutionKind } from '../domain/execution-recovery';
import { currentExecution, isFinalExecutionResult } from '../domain/execution-result';
import { executionContinuation } from '../domain/conversation-lifecycle';
import { ReviewAuthorizationDetails } from './review-workspace';
import { workflowBoundAuthorization } from '../domain/review-presentation';
import { useReviewAuthorization } from '../state/review-authorization';
import { useWalletConnection, walletNetworkTarget } from '../state/wallet-connection';
import { SummaryBar } from './summary-bar';
import type { SimulationSource } from '../domain/simulation-presentation';
import { SimulateWorkspace } from './simulate-workspace';
import { ReviewSummaryPanel } from './review-summary-panel';
import { networkQuestionPending } from '../domain/approved-ux';
import { projectSimulation, simulationStatusPresentation } from '../domain/simulation-presentation';
import { SigningSurface } from './signing-surface';
import { TopBar, type ProductSection } from './top-bar';
import { WorkflowCanvas } from './workflow-canvas';
import { PoolPriceRangeProvider } from './pool-price-range';
import { CanvasCardInputsProvider } from './canvas-card-inputs';
import { authoringEnvironment, useWorkflowCapability } from '../state/capability-store';
import { activeNetworkScope, workflowAllowed } from '../domain/network-scope';
import { usePublicTestnet } from '../state/public-testnet-store';
import { PublicTestnetPanel } from './public-testnet-panel';

import type { SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import {useLending} from '../state/lending-store';
import {LendingPanel} from './lending-panel';
import { useSupply } from '../state/supply-store';
import { RepayPanel } from './repay-panel';
import { BorrowPanel } from './borrow-panel';
import { SupplyPanel } from './supply-panel';
import { EstimateOwnersContext } from '../state/estimate-owners';
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
import { UniversalBridgePanel } from './universal-bridge-panel';
import { useUniversalRouter } from '../state/universal-router-store';
import { DashboardWorkspace } from './dashboard/dashboard-workspace';
import { PortfolioWidget } from './dashboard/portfolio-widget';
import { dashboardRoute as resolveDashboardRoute } from '../lib/dashboard/routes';
import { secondaryWorkspaceRoute } from '../domain/secondary-workspaces';
import { SecondaryProductWorkspace } from './secondary-product-workspace';
import { AutomationInbox } from './automations-workspace';
import { automationsAvailability } from '../app/automation-action';

import { useSavedWorkflows } from '../state/saved-workflows';
import { useExecutionEnvironment } from '../state/capability-store';
import { useBuild009Wallet } from '../state/build009-wallet-store';
import { defaultProofChain, useWalletProof } from './wallet-proof';
import { WorkflowVerification } from './saved-workflows';
import { BuildEntry } from './build-entry';
import { BUILD_ENTRY, buildEntryFresh, buildEntryLanding } from '../domain/build-entry';
import { editorOverview, EMPTY_EDITOR_OVERVIEW } from '../domain/editor-overview';
import { EditorOverviewPanel, focusCanvasStep } from './editor-overview-panel';
import { EditorStepper } from './editor-stepper';

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
  const { t: tr, language } = useLocale();
  // Server HTML is visible before handlers and initial canvas preferences are ready.
  const [interactive, setInteractive] = useState(false);
  useEffect(() => { setInteractive(true); }, []);
  const { state, context, reviewError, authoringIncomplete, restoreWorkflow, restorationEpoch, propose, createNewWorkflow, newWorkflow, runtimeWorkflow, sequence, sequenceRestore, completeSequenceStep,
    recordExecutedAction, executedActions, amountInputs, actionSetup, commitCanvasAmount, cancelCanvasAmount, removeActionSetup, pending: proposal, canvasRestoring,
    review: workflowReview, cryptoSelections = {}, bridgeNetworkInputs = {}, recipientInputs = {} } = useWorkflow();
  // BUILD-FLOFI-CHAT-E2E-FIX-002: every runtime path below serves `runtimeWorkflow` — the canonical workflow, or the current step of a sequence of
  // independent owner-wallet actions (Swap → Bridge). The Canvas, chat and saving keep the canonical `state.workflow`.
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
  // BUILD0-UX-001: a fresh visit of the public workspace opens on Build 0 (the intent entry); every other surface keeps Build (Build 1).
  // `entryAuto` stays true only while the owner has not chosen a section, so a restored workflow or recovered run may still move past it.
  const entryLanding = buildEntryLanding({ pathname, engineering, approval: Boolean(approvalSlot || autoPrepare), surface });
  const [section, setSection] = useState<ProductSection>(() => entryLanding ? BUILD_ENTRY : 'Build');
  const [entryAuto, setEntryAuto] = useState(entryLanding);
  const [entryDraft, setEntryDraft] = useState('');
  // BUILD-FLOFI-FLIGHT-001: the request typed on /board arrives once as an editable draft in the Build entry (never sent on its own).
  useFlightDraft(entryLanding ? setEntryDraft : null);
  const dashboardRoute = resolveDashboardRoute(pathname);
  const secondaryRoute = secondaryWorkspaceRoute(pathname);
  const tab = dashboardRoute ? 'Dashboard' : section;
  const setTab = useCallback((section: ProductSection) => {
    if ((authoringIncomplete || approvalGate) && (section === 'Simulate' || section === 'Execute')) return;
    setEntryAuto(false);
    if (navigate && section === 'Dashboard') { navigate('/app/dashboard'); return; }
    setSection(section);
    if (navigate && (dashboardRoute || secondaryRoute)) navigate('/app');
  }, [authoringIncomplete, approvalGate, navigate, dashboardRoute, secondaryRoute]);
  const [workflowName, setWorkflowName] = useState('Your Workflow');
  const connectedWallet = useBuild009Wallet();
  const walletIdentity = useExecutionEnvironment();
  const solanaSession = useJupiter().session;
  // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: the Simulate canvas quotes with the connected addresses (display only).
  const estimateOwners = useMemo(() => ({ evm: connectedWallet.account, solana: solanaSession?.account.address ?? null }), [connectedWallet.account, solanaSession]);
  const owner = walletIdentity.walletKind === 'solana'
    ? solanaSession ? { namespace: 'solana' as const, address: solanaSession.account.address } : null
    : connectedWallet.account ? { namespace: 'eip155' as const, address: connectedWallet.account } : null;
  const proof = useWalletProof(owner?.namespace ?? null, solanaSession?.chain ?? defaultProofChain());
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
    // BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the server decides who owns the library (a wallet proven here or held by the signed-in FloFi account);
    // a wallet proof is asked for only when it refused this wallet.
    const saved = await library.save(state.workflow as SemanticWorkflow, workflowName, code => { if (code === 'WALLET_SESSION_REQUIRED') setShowVerification(true); });
    if (saved) setSaveNotice({ owner: ownerKey, message: 'Workflow saved.' });
  }
  async function reopenWorkflow(id: string) {
    const document = await library.open(id);
    if (!document) return;
    restoreWorkflow(document.workflow); setWorkflowName(document.name ?? 'Your Workflow');
    setSaveNotice({ owner: ownerKey, message: 'Workflow restored. Simulate again before reviewing.' });
    setTab('Build');
  }
  const workflows = { list: library.list, busy: library.busy, error: library.error, changeHistory: library.changeHistory,
    open: (id: string) => { void reopenWorkflow(id); }, refresh: () => { void proof.refresh(); library.refresh(); } };
  useEffect(() => { if (secondaryRoute?.id === 'workflows') refreshLibrary(); }, [secondaryRoute?.id, refreshLibrary]);
  const verification = owner && showVerification && proof.proven !== owner.address
    ? <WorkflowVerification namespace={owner.namespace} account={owner.address} proof={proof}/> : undefined;

  const [workspaceToolboxMode, setWorkspaceToolboxMode] = useState<ToolboxMode>('top');
  const supply = useSupply();
  const transfer = useRobinhoodTransfer(), solanaTransfer = useSolanaTransfer(), lending = useLending(), jupiter = useJupiter();
  const solanaLiquidity = useSolanaLiquidity(), uniswapLiquidity = useUniswapLiquidity(), routerState = useRouter(), solanaComposition = useSolanaComposition();
  const universal = useUniversalRouter();
  const publicTestnet = usePublicTestnet();
  // BUILD-FLOFI-UNIVERSAL-E2E-001: the runtime that serves this workflow comes from its own actions and networks. A run a store recovered
  // from this browser serves only the visit's untouched draft or exactly its own workflow, never another one (e.g. a Base Sepolia swap
  // opened on /approve after a Solana Mainnet Jupiter run). The order is unchanged: a Solana transfer never reaches the EVM transfer
  // runtime; Aave paths before the isolated position and Solana paths; the Solana composition before the isolated Solana paths.
  const supplyReview = supply.record?.review;
  const runtimeSignals: OwnerRuntimeSignals = { recoveryShell,
    solanaTransfer: { recovered: solanaTransfer.recovered, workflow: solanaTransfer.record?.review.workflow ?? null },
    // RH-DEMO-001: the transfer store has no recovery flag; its persisted run still attaches only to the untouched template.
    transfer: { recovered: Boolean(transfer.record), workflow: transfer.record?.review.workflow ?? null },
    lending: { recovered: lending.recovered, workflow: lending.record?.reviews[0]?.workflow ?? null },
    supply: { recovered: supply.recovered, workflow: supplyReview?.workflow ?? null,
      operation: !supplyReview ? null : supplyReview.withdraw ? 'withdraw' : supplyReview.repay ? 'repay' : supplyReview.borrow ? 'borrow' : 'supply' },
    uniswapLiquidity: { recovered: uniswapLiquidity.recovered, workflow: uniswapLiquidity.record?.workflow ?? null },
    router: { recovered: routerState.recovered, workflow: routerState.record?.workflow ?? null },
    universal: { recovered: universal.recovered, workflow: universal.record?.workflow ?? null },
    solanaComposition: { recovered: solanaComposition.recovered, workflow: solanaComposition.record?.record.review.workflow ?? null },
    solanaLiquidity: { recovered: solanaLiquidity.recovered, workflow: solanaLiquidity.record?.review.workflow ?? null },
    jupiter: { recovered: jupiter.recovered, workflow: jupiter.record?.review.workflow ?? null },
    publicSwap: { recoveryOnly: publicTestnet.recoveryOnly, workflow: publicTestnet.run?.workflow ?? null,
      continuedApproval: Boolean(publicTestnet.run && !publicTestnet.retired && publicTestnet.run.attempts.at(-1)?.step === 'approval' && publicTestnet.run.attempts.at(-1)?.state === 'CONFIRMED') },
    // The shared owner-wallet Uniswap swap: the testnet pairs and (BUILD-RH-002, BUILD-BASE-001) catalog-network swaps. Base USDC ⇄ WETH joins
    // it only where Base mainnet swaps are enabled and no local fork runtime is available; otherwise it keeps its BUILD-002 paths.
    baseReferenceServed: publicTestnet.catalogAvailable(BASE_MAINNET.chain) && !info?.available };
  const runtime = selectOwnerRuntime(runtimeWorkflow, runtimeSignals);
  // Every step of a sequence must have an owner-wallet runtime FloFi can run on its own before the first one is simulated: a step that cannot
  // run is named (action, network, why) and nothing is simulated, so a workflow is never left half executed by design.
  const freshSignals: OwnerRuntimeSignals = { ...runtimeSignals, recoveryShell: false };
  const sequenceKinds = sequence ? sequence.steps.map(step => selectOwnerRuntime(step.projection, freshSignals).kind) : [];
  const unsupportedStep = sequence ? sequence.steps.find((_, index) => !SEQUENCE_RUNTIMES.includes(sequenceKinds[index] ?? '')) ?? null : null;
  // A step whose runtime this deployment does not serve (its provider is off here) is named before anything runs, never discovered after step 1.
  // Until a runtime's availability has answered it is unknown, never "not available": the chat waits for it (`runtimeChecking`).
  const stepKnown = (kind: string | null) => kind === 'public' ? publicTestnet.availabilityKnown : kind === 'universal' ? universal.availabilityKnown
    : kind === 'router' ? routerState.availabilityKnown : true;
  const stepServed = (kind: string | null, chain: string) => !stepKnown(kind) || (kind === 'public' ? publicTestnet.chainAvailable(chain) : kind === 'universal' ? universal.available
    : kind === 'router' ? routerState.available : true);
  const unservedStep = sequence && !unsupportedStep ? sequence.steps.find((step, index) => index >= sequence.cursor && !stepServed(sequenceKinds[index] ?? null, step.chainId)) ?? null : null;
  const runtimeChecking = sequence ? sequence.steps.some((_, index) => index >= sequence.cursor && !stepKnown(sequenceKinds[index] ?? null)) : !stepKnown(runtime.kind);
  // BUILD AAVE-V3-EXPANSION-001: after a refresh, a step whose earlier run is still being re-proven (or whose record could not be read) is never
  // offered as new; and a step that spends an earlier step's delivery continues only with the wallet that received it (its record's owner).
  const fundingOwner = sequence && !sequence.finished ? sequence.current.funding.map(funding => sequence.completed[funding.fundedBy]?.owner).find(Boolean) ?? null : null;
  const continuingWallet = fundingOwner?.startsWith('0x') ? connectedWallet.account?.toLowerCase() ?? null : solanaSession?.account.address ?? null;
  const sequenceIssue = !sequence ? null : sequenceRestore ? sequenceRestore.status === 'CHECKING'
      ? tr('Checking which steps of this workflow already ran before continuing. Nothing can be simulated or signed until this finishes.')
      : tr('Step {0} may already have run: FloFi could not read its execution record to confirm it. It is not offered again until it is confirmed.', sequenceRestore.step)
    : fundingOwner && continuingWallet && continuingWallet !== fundingOwner
      ? tr('Step {0} spends what an earlier step delivered to wallet {1}. Connect that wallet to continue; nothing was simulated or sent.', sequence.cursor + 1, shortAddress(fundingOwner))
    : unsupportedStep ? sequenceUnsupportedMessage(state.workflow, context, unsupportedStep, language === 'PT' ? 'PT' : 'EN')
    : unservedStep ? sequenceUnservedMessage(state.workflow, context, unservedStep, language === 'PT' ? 'PT' : 'EN')
    : sequenceFundingMessage(sequence, language === 'PT' ? 'PT' : 'EN');
  const { universalPath, routerPath, solanaTransferPath, transferPath, lendingPath, withdrawPath, repayPath, borrowPath, supplyPath, uniswapLiquidityPath,
    solanaCompositionPath, solanaLiquidityPath, solanaPath, publicPath } = runtime;
  const [selectedId, select] = useState<string | null>(null);
  // BUILD-FLOFI-CONVERSATIONAL-001: the bottom Advanced Settings inspector is gone. A card's own settings control opens that card's parameters in a
  // popover anchored to it (the same validated forms and commands); the chat edits the same canonical steps.
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const selectAction = useCallback((id: string | null) => {
    select(id);
    setSettingsId(current => current === id ? current : null);
  }, []);
  const closeActionSettings = useCallback(() => setSettingsId(null), []);
  const openActionSettings = useCallback((id: string) => {
    select(id);
    setSettingsId(current => current === id ? null : id);
  }, []);
  const { environment, walletEnvironment, result: capability } = useWorkflowCapability();
  const acrossWorkflow = runtimeWorkflow.nodes.length === 1 && runtimeWorkflow.nodes[0]?.adapterConstraints.adapters[0]?.id === 'across.direct';
  const bridgeSwapWorkflow = (runtimeWorkflow.nodes.length === 2 && runtimeWorkflow.nodes[0]?.nodeId === 'build009-bridge') || Boolean(bridgeSwap.run);
  const crossChainWorkflow = runtimeWorkflow.nodes.some(n => n.actionType === 'asset.liquidity.prepare');
  const bridgeWorkflow = !routerPath && !universalPath && runtimeWorkflow.nodes.length === 1 && runtimeWorkflow.nodes[0]?.actionType === 'asset.bridge';
  const forkExecution = tab === 'Execute' && Boolean(crossChainWorkflow || (info?.available && prepared) || modeB.info?.available || cow.execution || (liquidity.info?.available && liquidity.prepared) || composition.info?.available || bridge.execution || bridgeSwap.run || across.run);
  const persistedBuild009Recovery = bridgeSwap.recovered &&
    bridgeSwap.run?.format === 'gryloo.build009.mocked.v1' &&
    !['BRIDGE_QUOTED', 'BRIDGE_AUTHORIZED'].includes(bridgeSwap.run.state);
  const recoveryPath = recoveryShell && Boolean(modeA.recoveryOnly || modeB.recoveryOnly || composition.recoveryOnly || liquidity.recoveryOnly ||
    cow.recoveryOnly || bridge.recoveryOnly || persistedBuild009Recovery || across.recovered);
  // The existing CoW loopback runtime is explicitly disabled on deployed environments.
  const localCowIntent = Boolean(cow.info?.enabled && cow.execution);
  const executionSurface = universalPath || routerPath || solanaTransferPath || transferPath || lendingPath || withdrawPath || repayPath || borrowPath || supplyPath || uniswapLiquidityPath || solanaCompositionPath || solanaLiquidityPath || solanaPath || publicPath || recoveryPath || localCowIntent || (environment !== 'PUBLIC_TESTNET' && environment !== 'MAINNET' &&
    capability.executionSupported && forkExecution);
  // Select the same runtime as the existing Simulate surface; presentation never changes its gates.
  const restoredLocalKind = restoredLocalExecutionKind(runtimeWorkflow, recoveryShell ? { composition: composition.recoveryOnly, liquidity: liquidity.recoveryOnly, cow: cow.recoveryOnly } : { composition: false, liquidity: false, cow: false });
  let simulationSource: SimulationSource = sequenceIssue ? { kind: 'unavailable', state: { error: null, busy: false } }
    : runtime.kind === 'universal' ? { kind: 'universal', state: universal } : runtime.kind === 'router' ? { kind: 'router', state: routerState }
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
    : restoredLocalKind === 'composition' || runtimeWorkflow.nodes.some(n => n.actionType.includes('liquidity')) && runtimeWorkflow.nodes.some(n => n.actionType === 'asset.swap.exact-input')
      ? { kind: 'composition', state: composition }
    : restoredLocalKind === 'fork-pool' || runtimeWorkflow.nodes.some(n => n.actionType.includes('liquidity')) ? { kind: 'fork-pool', state: liquidity }
    : restoredLocalKind === 'cow' || runtimeWorkflow.nodes.some(n => n.adapterConstraints.protocols.includes('cow-protocol'))
      ? { kind: 'unavailable', state: cow }
    : modeB.status?.prepared && !modeB.retired ? { kind: 'delegated-swap', state: modeB }
    : { kind: 'fork-swap', state: modeA };
  const reviewBinding = useReviewAuthorization(simulationSource.kind);
  // P0 (owner test 2026-11-12): the Flight decision for the signing wallet, read before each simulation (`flightWalletAccess`). A refusal is shown
  // as this simulation's own classified blocker ("Wallet not linked to your FloFi account"), never as a failed simulation; it applies only while
  // the same wallet is connected, and nothing was quoted, simulated or sent for it.
  // It never masks a run's own state: with an execution started or live, a previous record, a recovery or a retired Review, those keep their
  // own words (a Flight sentence there would read as if nothing had been sent).
  // The wallet checked is the signer of the step being simulated, by its chain family (a mixed EVM/Solana workflow's EVM step is signed by the EVM
  // wallet even when the whole workflow's wallet kind is Solana) — the owner that step's flow call names.
  const stepChain = runtimeWorkflow.nodes[0]?.chainId ?? null;
  const flightSigner = stepChain?.startsWith('solana:') ? solanaSession?.account.address ?? null : stepChain ? connectedWallet.account ?? null : reviewBinding.wallet.account;
  const [flightBlock, setFlightBlock] = useState<{ readonly owner: string; readonly code: string } | null>(null);
  const executionProgress = useExecutionLifecycle(simulationSource.kind, reviewBinding.wallet);
  const recordedStart = useExecutionStart(simulationSource.kind, reviewBinding.wallet);
  // BUILD-FIX-UX-001: a final run of another (new or edited) workflow has not started this workflow's execution; its record is unchanged.
  const executionStart = executionProgress.started && !currentExecution(executionProgress) ? { ...recordedStart, started: false } : recordedStart;
  const sourceState = simulationSource.state as { readonly record?: unknown; readonly run?: unknown; readonly recoveryOnly?: boolean; readonly retired?: boolean; readonly busy?: boolean };
  const flightHere = Boolean(flightBlock && flightSigner && flightBlock.owner.toLowerCase() === flightSigner.toLowerCase());
  const runOwnState = Boolean(sourceState.record || sourceState.run || sourceState.recoveryOnly || sourceState.retired || executionStart.started || currentExecution(executionProgress));
  if (flightHere && !sourceState.busy && !runOwnState)
    simulationSource = { ...simulationSource, state: { ...simulationSource.state, error: flightBlock!.code } } as SimulationSource;
  // Where the run keeps its own words, the refusal is still said — never swallowed — as a notice that keeps what was already sent tracked.
  const flightNotice = flightHere && runOwnState ? flightRefusal(flightBlock!.code) : null;
  const [restoredBinding, setRestoredBinding] = useState({ epoch: restorationEpoch, key: null as string | null });
  if (restoredBinding.epoch !== restorationEpoch) setRestoredBinding({ epoch: restorationEpoch, key: reviewBinding.authorization.key });
  if (restorationEpoch > 0 && (restoredBinding.epoch !== restorationEpoch || restoredBinding.key === reviewBinding.authorization.key))
    simulationSource = { ...simulationSource, state: { ...simulationSource.state, retired: true } } as SimulationSource;
  // BUILD-FLOFI-UNIVERSAL-E2E-001: every surface (Canvas Review, Execute, the /approve signing surface) presents and approves only this
  // workflow's own Review; a retired or other-network Review is dropped, never shown beside this workflow.
  const authorization = workflowBoundAuthorization(reviewBinding.authorization, runtimeWorkflow, simulationSource);
  // BUILD-FLOFI-CHAT-E2E-FIX-002: a sequence step hands over to the next one only when its own run is final and every action of it is confirmed
  // (the runtime's reconciled record), and — when a later step spends its output — once that record proves the delivered amount. Nothing is
  // submitted here; the next step still needs its own fresh simulation, Review, confirmations and wallet signature.
  const liveStep = currentExecution(executionProgress);
  const stepRecord: unknown = simulationSource.kind === 'public' ? publicTestnet.run : simulationSource.kind === 'universal' ? universal.record
    : simulationSource.kind === 'router' ? routerState.record : simulationSource.kind === 'solana-swap' ? jupiter.record
    : simulationSource.kind === 'supply' ? supply.record : null;
  const stepDone = Boolean(sequence && !sequence.finished && !sequenceIssue && liveStep && liveStep.matchesWorkflow !== false && liveStep.state === 'complete' && isFinalExecutionResult(liveStep));
  const stepDelivered = stepDone && sequence ? deliveredByRecord(simulationSource.kind, stepRecord, sequence.current.output) : null;
  const awaitingDelivery = stepDone && Boolean(sequence?.steps.some(step => step.funding.some(f => f.fundedBy === sequence.cursor))) && DELIVERY_READABLE.includes(simulationSource.kind) && stepDelivered === null;
  const stepRunKey = liveStep?.runKey ?? null;
  const stepOwner = stepDone || (!sequence && liveStep?.state === 'complete') ? ownerByRecord(simulationSource.kind, stepRecord) : null;
  useEffect(() => {
    if (!sequence || !stepDone || awaitingDelivery) return;
    completeSequenceStep(sequence.cursor, { received: stepDelivered, runKey: stepRunKey, kind: simulationSource.kind, owner: stepOwner });
  }, [sequence?.cursor, stepDone, awaitingDelivery, stepDelivered, stepRunKey, completeSequenceStep, simulationSource.kind, stepOwner]);
  // BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: a one-action workflow whose own run is final and reconciled (same rule as a sequence step) is kept as
  // an executed first step, so the owner can keep building it: an action added afterwards is its own next step, never a repeat of this one.
  const soleAction = !sequence ? sequenceOrder(state.workflow) : [];
  const actionDone = Boolean(!sequence && soleAction.length === 1 && SEQUENCE_RUNTIMES.includes(simulationSource.kind) && liveStep && liveStep.matchesWorkflow !== false &&
    liveStep.state === 'complete' && isFinalExecutionResult(liveStep));
  const actionDelivered = actionDone ? deliveredByRecord(simulationSource.kind, stepRecord, stepAssets(soleAction[0]!).output) : null;
  useEffect(() => {
    if (actionDone) recordExecutedAction({ received: actionDelivered, runKey: stepRunKey, kind: simulationSource.kind, owner: stepOwner });
  }, [actionDone, actionDelivered, stepRunKey, recordExecutedAction, simulationSource.kind, stepOwner]);
  const sequencePresentation = sequence ? { ...presentSequence(state.workflow, context, sequence), issue: sequenceIssue, awaitingDelivery } : null;
  // Every runtime surface names the step it serves, so a step's simulation or Review never reads as the whole workflow's.
  // BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: the Editor runs a sequence in the confirm-each-step mode; the note names that mode explicitly
  // (authorizing a whole workflow once is the delegated mode of a workflow run, never claimed here).
  const sequenceNote = sequencePresentation ? sequencePresentation.finished ? tr('All {0} steps of this workflow are completed and reconciled.', sequencePresentation.total)
    : tr('Confirm each step · Step {0} of {1}: {2}. Each step is simulated, reviewed and confirmed in your wallet on its own, in order; this result covers this step only.', sequencePresentation.current, sequencePresentation.total,
      tr(sequencePresentation.steps[sequencePresentation.current - 1]?.action ?? 'Action')) : null;
  function openSimulationControls() {
    const details = document.querySelector<HTMLDetailsElement>('.simulation-technical');
    if (details) { details.open = true; details.scrollIntoView({ block: 'start' }); details.querySelector<HTMLElement>('summary')?.focus(); }
  }
  const solanaReview = solanaLiquidity.record?.review;
  const simulateRuntime = simulationSource.kind === 'universal' ? () => refreshBridgeAfterApproval(universal.record, runtimeWorkflow, universal.retired) ? universal.refresh() : universal.simulate()
    : simulationSource.kind === 'router' ? () => refreshBridgeAfterApproval(routerState.record, runtimeWorkflow, routerState.retired) ? routerState.refresh() : routerState.simulate()
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
  const embeddedReview = <ReviewAuthorizationDetails workflowName={workflowName} workflow={runtimeWorkflow} context={context} source={simulationSource} authorization={authorization} wallet={reviewBinding.wallet} invalidWorkflow={Boolean(reviewError)} backToBuild={() => setTab('Build')}/>;
  // BUILD-FLOFI-MAINNET-PRODUCT-001: a test-network workflow (saved or handed off before FloFi became Mainnet-only) is never simulated, reviewed or
  // signed in the public product; the Canvas offers the owner's explicit rebuild on its mainnet instead.
  const testNetworkWorkflow = !workflowAllowed(state.workflow, activeNetworkScope());
  const simulationDisabled = authoringIncomplete || approvalGate || testNetworkWorkflow || simulationSource.kind === 'unavailable' ||
    ('available' in simulationSource.state && simulationSource.state.available === false) ||
    ('info' in simulationSource.state && simulationSource.state.info?.available === false);
  // BUILD-SOLANA-TRANSFER-UX-001: a proposal loaded for one proven wallet is authorized by that same signer only. A different connected
  // account is never substituted: its simulation and Review would bind another owner, so the action waits for the right wallet.
  const signer = reviewBinding.wallet.account;
  // P0: Flight first, for the same wallet the API binds; the runtime simulates only when that wallet may act (a refusal is a value, not a throw).
  const simulateAgain = async (): Promise<void> => {
    if (flightSigner) {
      const access = await flightWalletAccess(flightSigner).catch(() => null);
      if (access && !access.ok) { setFlightBlock({ owner: flightSigner, code: access.code }); return; }
    }
    setFlightBlock(null);
    await simulateRuntime();
  };
  const walletConnection = useWalletConnection();
  const walletIssue = approvalWallet && signer && !sameAccount(approvalWallet, signer)
    ? tr('This proposal was loaded for {0}. Switch your wallet to that account to authorize it.', shortAccount(approvalWallet)) : null;
  const requiredSigningChain = !('retired' in simulationSource.state && simulationSource.state.retired) && authorization.chain
    || runtimeWorkflow.nodes.find(node => !node.actionType.startsWith('mock-'))?.chainId;
  const networkTarget = walletNetworkTarget(requiredSigningChain);
  const networkAction = signer && requiredSigningChain && networkTarget && reviewBinding.wallet.chain !== requiredSigningChain ? {
    label: tr('Switch to {0}', networkTarget.label), network: networkTarget.label, disabled: Boolean(simulationSource.state.busy || approvalGate || walletIssue),
    request: () => void walletConnection.switchNetwork(requiredSigningChain),
  } : undefined;
  const lifecycleState = { workflow: runtimeWorkflow, context, source: simulationSource, authorization: authorization,
    wallet: reviewBinding.wallet, execution: executionStart, progress: executionProgress, recovery: executionProgress.recovery,
    invalidWorkflow: Boolean(reviewError || authoringIncomplete || approvalGate || testNetworkWorkflow || walletIssue || autoPrepare && !approvalWallet) };
  const lifecycleControls = useExecutionControls(lifecycleState);
  // BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: "Run workflow" — a multi-step Canvas workflow that has not started here, valid and simulated at its
  // current revision, starts the shared workflow run on /approve (the server re-reads and re-gates it). The revision whose simulation last made it
  // ready is kept so an edit after the simulation says so; an open proposal on /approve and the signing surface never offer it.
  const canvasAction = projectCanvasAction(lifecycleControls.current, lifecycleControls);
  const runSimulated = Boolean(sequence) && (canvasAction.kind === 'approve' || canvasAction.kind === 'execute');
  const [runSimulation, setRunSimulation] = useState<{ readonly workflowId: string; readonly revision: number } | null>(null);
  useEffect(() => { if (runSimulated) setRunSimulation({ workflowId: state.workflow.workflowId, revision: state.workflow.revision }); },
    [runSimulated, state.workflow.workflowId, state.workflow.revision]);
  const editorRun = editorRunReadiness({
    sequence: sequence && !approvalSlot && !autoPrepare && surface === 'workspace' ? { steps: sequence.steps.length, cursor: sequence.cursor, completed: sequence.completed.length,
      finished: sequence.finished } : null,
    restoring: Boolean(sequenceRestore), started: Boolean(currentExecution(executionProgress)) || executionProgress.started || executionStart.started,
    invalid: Boolean(lifecycleState.invalidWorkflow || state.error), issue: sequenceIssue, lifecycle: canvasAction.kind, busy: Boolean(simulationSource.state.busy),
    revision: state.workflow.revision, simulatedRevision: runSimulation?.workflowId === state.workflow.workflowId ? runSimulation.revision : null });
  // P0 workflow execution: a multi-step Canvas workflow runs as ONE workflow run, reviewed once and authorized with the lowest-friction mechanism
  // the owner's wallet really supports (an EIP-5792 atomic batch where it reports one), in place. The per-step sequence stays only as the explicit
  // fallback when the whole-workflow Review says a step needs its own flow (and why), or when this deployment does not offer it.
  const localSequenceStarted = Boolean(currentExecution(executionProgress)) || executionProgress.started || executionStart.started
    || Boolean(sequence && (sequence.cursor > 0 || sequence.completed.length > 0));
  const workflowRunHere = useEditorWorkflowRun({ workflow: state.workflow, evmAccount: connectedWallet.account,
    enabled: Boolean(sequence) && !approvalSlot && !autoPrepare && surface === 'workspace' && !sequenceRestore && !localSequenceStarted });
  // The whole-workflow path is primary until its Review shows this workflow must run step by step (it cannot be grouped, the RPC cannot simulate
  // it, or the path cannot run here); a safety refusal keeps it primary, so the workflow is fixed before anything runs (a started run always is).
  const groupedPrimary = workflowRunHere.available && (workflowRunHere.started || !workflowRunHere.stepByStep);
  // P0 workflow execution (production 2026-11-08, OWNER_STATE_CHANGED_REVIEW_REQUIRED after the USDC approval): on an owner-bound network
  // (Arbitrum One, Ethereum) a swap's Review binds the exact approval transaction, so once THIS run's own approval reconciled the swap needs its own
  // fresh, read-only Review. FloFi prepares it at once — exactly as the chat already does — instead of sending the owner back to "Simulate"; the
  // Canvas action then reads "Authorize in wallet" for the swap (one click, the wallet's own confirmation). Nothing is signed or sent by it.
  const continuation = executionContinuation({ progress: executionProgress });
  const ownerBoundContinuation = Boolean(continuation?.approval && simulationSource.kind === 'public'
    && (simulationSource.state as { run?: { quote?: { ownerReview?: unknown } } | null }).run?.quote?.ownerReview);
  const requotedContinuation = useRef<string | null>(null);
  useEffect(() => {
    if (!continuation || !ownerBoundContinuation || requotedContinuation.current === continuation.key) return;
    // "Continue to swap" under the approval's Review can never start an owner-bound swap (its begin is refused): the fresh Review comes first.
    if (!['continue', 'simulate'].includes(canvasAction.kind) || canvasAction.disabled || simulationSource.state.busy) return;
    requotedContinuation.current = continuation.key;
    void simulateAgain();
  }, [continuation?.key, ownerBoundContinuation, canvasAction.kind, canvasAction.disabled, simulationSource.state.busy]);
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
  // BUILD-FLOFI-PRODUCT-UX-001: informational Beta Mainnet notice only; it gates nothing. Omitted from the compact signing surface.
  const betaNotice = <><p className="beta-notice" role="note">{tr("FloFi Beta Mainnet — Real funds are enabled. Review every transaction before signing.")}</p>
    {/* BUILD-FLOFI-FLIGHT-001: after "Board now" on /board, a ready Review asks the server for the person's boarding pass. */}
    <FlightBoarding readyKey={authorization.ready ? authorization.key : null} workflowId={state.workflow.workflowId}/></>;
  const simulationReason = sequenceIssue ?? (simulationDisabled || !actionable || lifecycleState.invalidWorkflow ? simulationUnavailableReason({ incomplete: Boolean(authoringIncomplete || reviewError || !actionable),
    unsupported: testNetworkWorkflow || simulationSource.kind === 'unavailable', walletRequired: !signer || Boolean(approvalGate || autoPrepare && !approvalWallet),
    providerUnavailable: 'available' in simulationSource.state && simulationSource.state.available === false || 'info' in simulationSource.state && simulationSource.state.info?.available === false,
    error: simulationSource.state.error, staleQuote: lifecycleControls.view.expiresAt !== null && Date.now() >= lifecycleControls.view.expiresAt }) : null);
  const groupedAction = <div className="canvas-lifecycle-control editor-run-control">
    <p className="canvas-sequence-note" role="note">{tr(workflowRunHere.started ? 'This workflow runs as one workflow run: follow it in Execute.'
      : 'All {0} steps are reviewed together and authorized at once where your wallet can batch them.', String(sequence?.steps.length ?? 0))}</p>
    <button type="button" className="primary" data-lifecycle-action="workflow-run"
      disabled={(!workflowRunHere.started && Boolean(authoringIncomplete)) || ['reviewing', 'authorizing', 'proving', 'wallet', 'confirming'].includes(workflowRunHere.phase)}
      onClick={() => { setTab('Execute'); if (workflowRunHere.canReview && !workflowRunHere.review) void workflowRunHere.startReview(); }}>
      {tr(workflowRunHere.started || workflowRunHere.following ? 'Open workflow progress' : workflowRunHere.review ? 'Open the workflow review' : 'Review whole workflow')}</button>
  </div>;
  const simulateAction = groupedPrimary ? groupedAction : sequenceRestore ? <div className="canvas-lifecycle-control sequence-restore-control">
      <p role="status">{sequenceIssue}</p>
      {sequenceRestore.status === 'UNVERIFIED' && <>
        <button type="button" onClick={sequenceRestore.retry}>{tr('Check again')}</button>
        <p className="sequence-restore-warning">{tr('Only if your wallet history shows that step {0} did not run:', sequenceRestore.step)}</p>
        <button type="button" className="secondary" onClick={sequenceRestore.discard}>{tr('Forget this record and offer step {0} again', sequenceRestore.step)}</button>
      </>}
    </div>
    : walletIssue ? <div className="canvas-lifecycle-control"><p role="status">{walletIssue}</p><button type="button" onClick={() => void walletConnection.connect()}>{tr('Use another wallet')}</button></div>
    : networkAction ? <div className="canvas-lifecycle-control"><button type="button" disabled={networkAction.disabled} onClick={networkAction.request}>{networkAction.label}</button>{walletConnection.error && <p role="status">{tr(walletConnection.error)}</p>}</div> : <CanvasLifecycleAction {...lifecycleState} controls={lifecycleControls} workflowName={workflowName}
    simulationDisabled={simulationDisabled || !actionable} simulationReason={simulationReason} sequenceNote={sequenceNote}
    simulate={() => { setTab('Simulate'); return simulateAgain(); }} onExecute={() => setTab('Execute')}/>;
  // BUILD-FLOFI-CONVERSATIONAL-001: the chat lives here, above the stage switch, so Build, Simulate and Execute share one conversation. It reaches
  // the same lifecycle the Canvas CTA uses (this Simulate, these controls); on /approve it keeps its earlier proposal-only behaviour.
  // BUILD-FLOFI-CHAT-E2E-FIX-002: amounts typed on Canvas cards and never applied block every simulation. The chat names each one (step, action,
  // typed value) and applies or discards it only on the owner's explicit answer, through the same card actions the Canvas uses.
  const orderedActions = composerActions(state.workflow);
  const pendingEdits: PendingEdit[] = [
    ...actionSetup ? [{ nodeId: actionSetup.id, step: orderedActions.length + 1, action: setupSummary(actionSetup, context).action, value: setupSummary(actionSetup, context).amount }] : [],
    ...Object.entries(amountInputs).filter(([id]) => id !== actionSetup?.id).map(([id, value]) => {
      const index = orderedActions.findIndex(node => node.nodeId === id), node = orderedActions[index];
      const card = node ? composerSummary(state.workflow, node, context) : null, symbol = card?.amount.split(' ').slice(1).join(' ');
      return { nodeId: id, step: index + 1, action: card?.action ?? 'Action', value: `${value}${symbol ? ` ${symbol}` : ''}` };
    })];
  const resolveEdit = (nodeId: string, apply: boolean): string | null => {
    if (!pendingEdits.some(edit => edit.nodeId === nodeId)) return 'This edit is no longer pending.';
    if (apply) return commitCanvasAmount(nodeId);
    if (actionSetup?.id === nodeId) removeActionSetup(); else cancelCanvasAmount(nodeId);
    return null;
  };
  // P0 approved UX (board 07): the blocker the chat explains on "explain / why? / não entendi" — the same projection the blocker panel shows.
  const blockerView = (() => {
    // The whole-workflow Review's own native-fee shortfall (prepared before any run exists): its numbers, for the same owner.
    const runRefusal = workflowRunHere.review?.refusal;
    if (runRefusal?.evidence && !workflowRunHere.run && !workflowRunHere.started && !workflowRunHere.unloaded) return { title: 'Not enough ETH for the network fee', message: 'Your wallet does not hold enough of the network\'s native token for this request.',
      owner: workflowRunHere.review!.owner, feeShortfall: runRefusal.evidence };
    if (simulationSource.state.busy) return null;
    const view = projectSimulation(runtimeWorkflow, context, simulationSource);
    if (view.status !== 'blocked') return null;
    const presented = simulationStatusPresentation(view, Boolean(reviewError), false);
    return { title: presented.label, message: simulationReason ?? presented.message, owner: reviewBinding.wallet.account, feeShortfall: null };
  })();
  const conversation = useFlofiConversation({ owner, epoch: workflowEpoch, direct: !approvalSlot && !autoPrepare && surface === 'workspace',
    interfaceLanguage: language === 'PT' ? 'PT' : 'EN',
    // The chat reviews, confirms and follows the workflow its runtime serves (a sequence's current step); it edits the canonical workflow itself.
    bridge: { workflow: runtimeWorkflow, context, source: simulationSource, authorization, wallet: reviewBinding.wallet, progress: executionProgress,
      invalidWorkflow: lifecycleState.invalidWorkflow, simulate: simulateAgain, controls: lifecycleControls, networkAction, sequence: sequencePresentation,
      pendingEdits, resolveEdit, runtimeChecking, walletNetwork: reviewBinding.wallet.chain ? shellChainLabel(reviewBinding.wallet.chain) : null, networkError: walletConnection.error,
      simulationBlocked: walletIssue ?? (groupedPrimary ? workflowRunHere.started ? 'This workflow runs as one workflow run: follow it in Execute.'
        : 'This workflow runs as one workflow run: open Execute and choose Review whole workflow, then Authorize workflow.'
        : simulationDisabled || !actionable || lifecycleState.invalidWorkflow ? simulationReason ?? 'Simulation is not available for this workflow.' : null),
      connectWallet: () => void walletConnection.connect(), startNewWorkflow, executedActions, continuable: Boolean(sequence?.finished) || actionDone, blocker: blockerView } });
  // BUILD-FLOFI-CHAT-E2E-FIX-002: the public chat-first workspace presents the Review and progress in the chat; Simulate and Execute show the canvas
  // beside it, with their summaries in an optional details surface (approval surfaces and the engineering workspace keep their side panels).
  const chatFirst = conversation.direct && !engineering;
  // BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): one live summary of the real workflow (steps and their status, networks, state, what needs
  // attention) for the Canvas header, the FloFi panel and the footer. "Show step" selects the card and brings it into view; nothing is edited.
  // Computed for the Editor's Canvas only (no other surface shows it); a refused edit or a failed review is always surfaced as such.
  const overviewShown = tab === 'Build' && surface === 'workspace';
  const overview = useMemo(() => overviewShown ? editorOverview(state.workflow, context, workflowReview,
    { setup: actionSetup ? { id: actionSetup.id, action: setupSummary(actionSetup, context).action } : null, amountInputs, cryptoSelections, bridgeNetworkInputs, recipientInputs },
    Boolean(state.error || reviewError)) : EMPTY_EDITOR_OVERVIEW,
  [overviewShown, state.workflow, state.error, reviewError, context, workflowReview, actionSetup, amountInputs, cryptoSelections, bridgeNetworkInputs, recipientInputs]);
  const showStep = (nodeId: string) => { selectAction(nodeId); focusCanvasStep(nodeId); };
  const chat = <CopilotPanel conversation={conversation} interactive={interactive} owner={owner} proof={proof}
    overview={tab === 'Build' && chatFirst ? <EditorOverviewPanel overview={overview} showStep={showStep}/> : undefined}/>;
  // BUILD0-UX-001: a workflow restored or reopened, a run recovered from this browser, a live execution, a proposal or an unfinished Canvas card
  // is never held behind the entry the visit landed on: once the persisted-run read settles, the shell opens Build 1 (the stages keep their own
  // records and gates). A request the owner is typing in Build 0 is never discarded: the entry stays, naming the workflow it would add to.
  const entryFresh = buildEntryFresh({ workflow: state.workflow, restorationEpoch, authoringIncomplete, executionSurface: Boolean(executionSurface),
    execution: Boolean(currentExecution(executionProgress)) || executionProgress.started || executionStart.started, proposal: Boolean(proposal) });
  const leaveEntry = tab === BUILD_ENTRY && entryAuto && !entryFresh && !canvasRestoring && !entryDraft.trim() && !conversation.busy;
  useEffect(() => { if (leaveEntry) { setEntryAuto(false); setSection('Build'); } }, [leaveEntry]);
  const entry = chatFirst;
  if (surface === 'signing') return <div className="app-shell signing-shell" inert={!interactive}><a className="skip-link" href="#workspace">{tr("Skip to workspace")}</a>
    <TopBar compact tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering}/>
    <SigningSurface {...lifecycleState} controls={lifecycleControls} workflowName={workflowName} simulate={simulateAgain} simulationDisabled={simulationDisabled || !actionable}
      gated={approvalGate} walletIssue={walletIssue} networkAction={networkAction} walletRequestError={walletConnection.error} connectWallet={() => void walletConnection.connect()} approvalSlot={approvalSlot} onViewInFloFi={onViewInFloFi}
      startNewWorkflow={navigate ? () => { startNewWorkflow(); navigate('/app'); } : undefined}/>
  </div>;
  if (secondaryRoute) return <div className="app-shell" inert={!interactive}><a className="skip-link" href="#workspace">{tr("Skip to workspace")}</a><TopBar tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering} entry={entry}/>{betaNotice}
    <main id="workspace" className="main secondary-workspace" tabIndex={-1} aria-label={tr('{0} workspace', tr(secondaryRoute.label))}><SecondaryProductWorkspace workspace={secondaryRoute.id} workflows={{ ...workflows, loading: library.loading, connected: Boolean(owner), verification: owner && library.error === 'WALLET_SESSION_REQUIRED' ? <WorkflowVerification namespace={owner.namespace} account={owner.address} proof={proof}/> : undefined,
      // BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the execution history moved here from the Dashboard (same records, same server-checked actions).
      records: secondaryRoute.id === 'workflows' && owner ? <DashboardWorkspace mode="records" workflowName={workflowName} progress={executionProgress} recovery={executionProgress.recovery}
        wallet={{ ...reviewBinding.wallet, account: owner.address }} context={context} runId={null} build={() => setTab('Build')} execute={() => setTab('Execute')} navigate={navigate ?? (() => undefined)}
        openWorkflow={{ names: new Map(library.list?.items.map(item => [item.workflowId, item.name] as const) ?? []), open: id => { void reopenWorkflow(id); } }} signInPrompt={library.error === 'WALLET_SESSION_REQUIRED'}/> : undefined }}
      automations={{ owner, proof, openChat: () => setTab(BUILD_ENTRY), onPropose: command => { propose(command); setTab('Build'); },
        canvas: automateCanvas ? { workflow: state.workflow, name: workflowName, dismiss: () => setAutomateCanvas(false) } : null }}/>
</main>
  </div>;
  if (tab === 'Dashboard') return <div className="app-shell" inert={!interactive}><a className="skip-link" href="#workspace">{tr("Skip to workspace")}</a><TopBar tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering} entry={entry}/>{betaNotice}
    <main id="workspace" className="main" tabIndex={-1} aria-label={tr("Dashboard")}><DashboardWorkspace workflowName={workflowName} progress={executionProgress} recovery={executionProgress.recovery} wallet={reviewBinding.wallet} context={context}
      runId={dashboardRoute?.runId ?? null} portfolio={<PortfolioWidget evm={connectedWallet.account} solana={solanaSession?.account.address ?? null}/>}
      build={() => setTab('Build')} execute={() => setTab('Execute')} navigate={navigate ?? (() => undefined)} create={entry ? () => setTab(BUILD_ENTRY) : undefined}/></main>
  </div>;
  // BUILD0-UX-001: Build 0 has no Canvas, chat panel or summary bar; its request continues in the same conversation, shown in Build 1.
  // BUILD-FLOFI-CHAT-EDITOR-UX-001: Build 0 is presented as Chat and Build 1 as the Editor; this section and its continuation are unchanged.
  if (tab === BUILD_ENTRY) return <div className="app-shell" inert={!interactive}><a className="skip-link" href="#workspace">{tr("Skip to workspace")}</a><TopBar tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering} entry={entry}/>{betaNotice}
    <AutomationInbox owner={owner} proven={Boolean(owner && proof.proven === owner.address)} open={() => navigate?.('/app/automations')}/>
    <main id="workspace" className="main build-entry-workspace" tabIndex={-1} aria-label={tr('Chat')}>
      <BuildEntry conversation={conversation} workflow={state.workflow} proposal={proposal} actions={orderedActions.length} draft={entryDraft} setDraft={setEntryDraft}
        interactive={interactive} openBuilder={() => setTab('Build')}/>
    </main>
  </div>;
  if (authoringIncomplete && tab !== 'Build') return <div className="app-shell" inert={!interactive}><TopBar tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering} entry={entry}
    center={<EditorStepper tab={tab} setTab={setTab} disabled incomplete/>}/>{betaNotice}<main className="main"><section className="panel stage-empty"><p>{tr("Configure the action amount on the Canvas first.")}</p><button type="button" onClick={() => setTab('Build')}>{tr("Return to the Canvas")}</button></section></main></div>;
  // P0 approved UX (board 08): while this workflow's execution is live (not final), the Canvas shows "Editing paused during execution" (the shell
  // already refuses edits then; this makes it visible). Read from the execution records, never a timer.
  const liveExecution = currentExecution(executionProgress);
  // Locked while the wallet is being asked (every prompting phase, the first Authorize included) or while this workflow's own run is open and
  // moving (PENDING / RUNNING / ATTENTION, read from the run itself — never a phase left behind once it ended). A HALTED or final run, or an
  // earlier workflow being followed, never locks the Canvas.
  const runOpen = Boolean(workflowRunHere.run && !workflowRunHere.following && ['PENDING', 'RUNNING', 'ATTENTION'].includes(workflowRunHere.run.state));
  const editingPaused = Boolean(!workflowRunHere.following && ['authorizing', 'proving', 'wallet', 'confirming', 'confirm-update'].includes(workflowRunHere.phase) || runOpen
    || liveExecution && !isFinalExecutionResult(liveExecution));
  const stageContent = tab === 'Build' ? <><div className="build-grid"><WorkflowCanvas runActive={editingPaused} estimateOwner={solanaSession?.account.address} environment={authoringEnvironment(walletEnvironment)} selectedId={selectedId} select={selectAction} openSettings={openActionSettings} settingsId={settingsId} workflowName={workflowName} renameWorkflow={setWorkflowName} onAutomate={automationsReady ? () => { setAutomateCanvas(true); navigate?.('/app/automations'); } : undefined} onSave={() => void saveCurrentWorkflow()} onToolboxModeChange={setWorkspaceToolboxMode} overview={overview}/>{chat}</div>{verification}{saveNotice?.owner === ownerKey && <p role="status">{tr(saveNotice.message)}</p>}{library.busy && <p role="status">{tr('Saving workflow…')}</p>}{library.error && library.error !== 'WALLET_SESSION_REQUIRED' && <p role="alert">{tr(library.error === 'WORKFLOW_VERSION_CONFLICT' ? 'This workflow was updated in another session. Reopen it before saving.' : 'Workflow saving is unavailable. Try again.')}</p>}{selectedId && !editingPaused && <ActionSettingsPopover key={selectedId} selectedId={selectedId} select={selectAction} open={settingsId === selectedId} close={closeActionSettings}/>}
          {engineering && <EngineeringAuthoring selectedId={selectedId}><ReviewPanel/></EngineeringAuthoring>}</>
        : tab === 'Simulate' && engineering ? universalPath ? <UniversalBridgePanel view="simulate"/> : routerPath ? <RouterPanel view="simulate"/> : solanaTransferPath ? <SolanaTransferPanel view="simulate"/> : transferPath ? <RobinhoodTransferPanel view="simulate"/> : lendingPath ? <LendingPanel view="simulate"/> : withdrawPath ? <WithdrawPanel view="simulate"/> : repayPath ? <RepayPanel view="simulate"/> : borrowPath ? <BorrowPanel view="simulate"/> : supplyPath ? <SupplyPanel view="simulate"/> : uniswapLiquidityPath ? <UniswapLiquidityPanel view="simulate"/> : solanaCompositionPath ? <SolanaCompositionPanel view="simulate"/> : solanaLiquidityPath ? <SolanaLiquidityPanel view="simulate"/> : solanaPath ? <JupiterPanel view="simulate"/> : publicPath ? <PublicTestnetPanel view="simulate"/> : crossChainWorkflow ? <CrossChainLiquidityPanel view="simulate"/> : acrossWorkflow || across.run ? <AcrossPanel view="simulate"/> : bridgeSwapWorkflow ? <BridgeSwapPanel view="simulate"/> : bridgeWorkflow ? <BridgePanel view="simulate"/> : <SimulatePanel engineeringOnly workflowName={workflowName}><ReviewWorkspace workflowName={workflowName} workflow={runtimeWorkflow} context={context} source={simulationSource} authorization={authorization} wallet={reviewBinding.wallet} invalidWorkflow={Boolean(reviewError)} backToBuild={() => setTab('Build')} simulateAgain={simulateAgain} actionSurface="canvas" showTechnicalDetails={false}/><ObservationPanel/><ForkSimulationPanel/><ModeBPanel view="simulate"/><CompositionPanel view="simulate"/><CowPanel view="simulate"/><LiquidityPanel view="simulate"/></SimulatePanel>
        : executionSurface ? universalPath ? <UniversalBridgePanel view="execute"/> : routerPath ? <RouterPanel view="execute"/> : solanaTransferPath ? <SolanaTransferPanel view="execute"/> : transferPath ? <RobinhoodTransferPanel view="execute"/> : lendingPath ? <LendingPanel view="execute"/> : withdrawPath ? <WithdrawPanel view="execute"/> : repayPath ? <RepayPanel view="execute"/> : borrowPath ? <BorrowPanel view="execute"/> : supplyPath ? <SupplyPanel view="execute"/> : uniswapLiquidityPath ? <UniswapLiquidityPanel view="execute"/> : solanaCompositionPath ? <SolanaCompositionPanel view="execute"/> : solanaLiquidityPath ? <SolanaLiquidityPanel view="execute"/> : solanaPath ? <JupiterPanel view="execute"/> : publicPath ? <PublicTestnetPanel view="execute"/> : persistedBuild009Recovery ? <BridgeSwapPanel view="execute"/> : across.recovered ? <AcrossPanel view="execute"/> :
          bridge.recoveryOnly ? <BridgePanel view="execute"/> : modeA.recoveryOnly || modeB.recoveryOnly ||
          composition.recoveryOnly || liquidity.recoveryOnly || cow.recoveryOnly ?
            <><ExecutionPanel/><ModeBPanel view="execute"/><CompositionPanel view="execute"/><CowPanel view="execute"/><LiquidityPanel view="execute"/></> :
          crossChainWorkflow ? <CrossChainLiquidityPanel view="execute"/> : across.run ? <AcrossPanel view="execute"/> :
          bridgeSwap.run ? <BridgeSwapPanel view="execute"/> : bridge.execution ? <BridgePanel view="execute"/> :
          <><ExecutionPanel/><ModeBPanel view="execute"/><CompositionPanel view="execute"/><CowPanel view="execute"/><LiquidityPanel view="execute"/></>
        : null;
  const wrapStage = (stage: ReactNode) => tab === 'Build' ? stage : <div className="stage-with-chat">{stage}{chat}</div>;
  // P0 approved UX (board 03b): the Editor stepper sits in the top bar's center (one band less); same targets and refusals as before.
  const networkQuestion = chatFirst && networkQuestionPending(conversation.messages);
  const editorStepper = <EditorStepper tab={tab} setTab={setTab} disabled={Boolean(authoringIncomplete || approvalGate || networkQuestion && !actionable)} incomplete={Boolean(authoringIncomplete)}
    closedReason={networkQuestion && !actionable ? 'Choose the network in the chat first' : null}/>;
  // P0 approved UX (board 06/07): the Simulate footer states the validity countdown or the blocker from the same projection the panel shows.
  const footerSimulation = (() => {
    const view = projectSimulation(runtimeWorkflow, context, simulationSource);
    const label = simulationStatusPresentation(view, Boolean(reviewError), simulationSource.state.busy).label;
    return { busy: Boolean(simulationSource.state.busy), status: view.status, label, expiresAt: view.expiresAt, networkQuestion,
      // Any sign that part of this workflow ran or may have run: a live or started execution, a sequence step done or restored, a whole-workflow
      // run, or actions already executed. Then the footer never says "Nothing was sent".
      executionStarted: Boolean(currentExecution(executionProgress)) || executionProgress.started || executionStart.started || localSequenceStarted
        || Boolean(sequenceRestore) || Boolean(sequence && (sequence.completed.length > 0 || sequence.finished)) || Boolean(workflowRunHere.run || workflowRunHere.started)
        || executedActions.executed > 0 };
  })();
  return <EstimateOwnersContext.Provider value={estimateOwners}><div className="app-shell" inert={!interactive}><a className="skip-link" href="#workspace">{tr("Skip to workspace")}</a><TopBar tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering} entry={entry} center={editorStepper}/>{betaNotice}
    {approvalSlot && <div className="approval-notice-slot" ref={approvalSlot}/>}
    {/* P0 workflow execution: after a reload, a whole-workflow run this browser started is offered (never followed silently). */}
    {workflowRunHere.earlier && tab !== 'Execute' && <div className="editor-run-earlier-notice" role="status">
      <span>{tr('A workflow you authorized earlier in this browser has not been closed.')}</span>
      <button type="button" className="secondary" onClick={() => { setTab('Execute'); void workflowRunHere.followEarlier(); }}>{tr('Show its progress')}</button></div>}
    {flightNotice && <div className="error-banner flight-run-notice" role="alert"><strong>{tr(flightNotice.title)}</strong>
      <span>{tr(flightNotice.message)}{/already sent stays tracked/.test(flightNotice.message) ? null : <> {tr('Anything already sent stays tracked.')}</>}</span></div>}
    <AutomationInbox owner={owner} proven={Boolean(owner && proof.proven === owner.address)} open={() => navigate?.('/app/automations')}/>
    {/* BUILD-FLOFI-CONVERSATIONAL-001: on Simulate and Execute the same conversation continues beside the stage (complementary to main). */}
    {wrapStage(<main id="workspace" className={`main workflow-workspace${tab === 'Build' ? ' build-workspace' : ''}`} data-workspace-toolbox={tab === 'Build' ? workspaceToolboxMode : undefined} tabIndex={-1} aria-label={tr(tab === 'Build' ? 'Workflow workspace' : tab === 'Simulate' ? 'Simulation workspace' : 'Execution workspace')}>
      {tab === 'Execute' ? <ExecuteWorkspace detailsOnly={chatFirst} controls={lifecycleControls} groupedRun={groupedPrimary}
        primaryAction={groupedPrimary ? <button type="button" className="simulation-back" onClick={() => setTab('Build')}>{tr('Back to the Canvas')}</button> : simulateAction} workflowName={workflowName} workflow={runtimeWorkflow} context={context} source={simulationSource} authorization={authorization} wallet={reviewBinding.wallet} execution={executionStart} progress={executionProgress} recovery={executionProgress.recovery} invalidWorkflow={Boolean(reviewError || authoringIncomplete)} backToBuild={() => setTab('Build')} backToSimulate={() => setTab('Simulate')} startNewWorkflow={startNewWorkflow} openDashboard={() => setTab('Dashboard')}
        workflowRun={workflowRunHere.visible ? <EditorWorkflowRunPanel state={workflowRunHere}/>
          : editorRun.offered ? <EditorRunAction workflow={state.workflow} readiness={editorRun} steps={sequence?.steps.length ?? 0}/> : undefined}
        technicalDetails={engineering && (executionStart.started || executionProgress.started || recoveryPath || localCowIntent) ? stageContent : undefined}/> : tab === 'Simulate' ?
        <SimulateWorkspace detailsOnly={chatFirst} sequenceNote={sequenceNote} workflowName={workflowName} returnToBuild={chatFirst ? undefined : () => setTab('Build')} simulationSource={simulationSource} simulationReason={simulationReason} review={embeddedReview}
          simulateAction={chatFirst ? undefined : simulateAction}
          renderPanel={chatFirst ? technical => <ReviewSummaryPanel workflow={runtimeWorkflow} context={context} source={simulationSource} authorization={authorization} wallet={reviewBinding.wallet}
            invalidWorkflow={Boolean(reviewError)} unavailableReason={simulationReason} sequenceNote={sequenceNote} technical={technical}/> : undefined}>
          {engineering && <details className="shell-details technical-workspace simulation-technical"><summary>{tr('View technical details')}</summary><ReviewTechnicalDetails authorization={authorization}/>{stageContent}</details>}
        </SimulateWorkspace> : stageContent}
      <MobileBuildNavigation stage={tab === 'Build' ? 'Build' : tab === 'Simulate' ? 'Simulate' : 'Execute'}/>
      {state.error && <div className="error-banner" role="alert"><strong>{tr("Edit not applied")}</strong><span>{tr(tab !== 'Build' ? 'Review the workflow configuration on the Canvas before simulating again.' : state.error)}</span></div>}
    </main>)}{/* BUILD-FLOFI-CHAT-EDITOR-UX-001: without Simulate and Execute tabs, the Editor's footer opens those sections, closed whenever setTab refuses them. */}
    {tab !== 'Execute' && <SummaryBar tab={tab} setTab={setTab} canvasOwnsAction primaryAction={tab === 'Build' || tab === 'Simulate' && chatFirst ? simulateAction : undefined} overview={overview} showStep={showStep}
      simulationBlocked={Boolean(walletIssue || simulationDisabled || !actionable || lifecycleState.invalidWorkflow)} simulation={chatFirst ? footerSimulation : undefined} networkQuestion={networkQuestion}/>}
  </div></EstimateOwnersContext.Provider>;
}
