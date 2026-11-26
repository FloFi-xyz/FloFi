// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { simulationUnavailableReason } from '../domain/simulation-unavailable';
import { refreshBridgeAfterApproval } from '../domain/bridge-review-recovery';
import { uniswapPositionRefreshInPlace, uniswapRefreshInPlace } from '../domain/uniswap-liquidity-continuation';
import { positionPreparationRefusal } from '../domain/liquidity-position-summary';
import { orcaPositionRequestOf, orcaPositionRequestOfMarker, workflowPositionManagement, type LiquidityPositionChoice } from '../domain/liquidity-positions';
import type { LiquidityPositionPoolInput } from '../domain/commands';
import { flightWalletAccess } from '../app/flight-wallet-action';
import { FLIGHT_REFUSAL_HREF, flightRefusal } from '../domain/flight-refusal';
import { selectOwnerRuntime, type OwnerRuntimeSignals } from '../domain/runtime-selection';
import { compositionWorkflow, deliveredByRun, DELIVERY_READABLE, deliveredByRecord, localExecutionHolds, SEQUENCE_RUNTIMES, SINGLE_CARD_RUNTIMES, singleCardFallsBack, sequenceOrder, stepAssets } from '../domain/workflow-sequence';
import { universalBridgeDetails } from '../domain/universal-bridge-authoring';
import { routerDetails } from '../domain/router-authoring';
import { ownerByRecord } from '../domain/sequence-restore';
import { shortAddress } from '../accounts/account-model';
import { presentSequence, sequenceFundingMessage, sequenceUnservedMessage, sequenceUnsupportedMessage } from '../domain/sequence-presentation';
import { composerActions, composerSummary } from '../domain/composer-presentation';
import { actionReviewValue, setupSummary } from '../domain/canvas-action-setup';
import { shellChainLabel } from '../domain/product-shell';
import type { PendingEdit } from '../state/flofi-conversation';
import { BASE_MAINNET } from '@defi-workflow-engine/action-registry';
import { translate, useLocale } from '../i18n/locale';
import { destinationHoldsPreparation, destinationIssueMessage, DESTINATION_ISSUE, destinationWalletPhrase, type DestinationSurface } from '../domain/destination-wallet';
import { retryAccountWallets } from '../state/destination-wallets';

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
import { useWorkflow, type StagedPosition } from '../state/workflow-store';
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
import { ExecuteWorkspace, executeActionPlacement } from './execute-workspace';
import { EditorRunAction } from './editor-run-action';
import { EditorWorkflowRunPanel, EditorWorkflowRunPrimaryAction, EditorWorkflowSimulateAction, useEditorWorkflowRun } from './editor-workflow-run';
import { EditorChromeProvider, EditorStageHead } from './editor-chrome';
import { GroupedSimulationPanel } from './simulation-context-panel';
import { OperationSummary, WorkflowTechnicalFacts } from './operation-summary';
import type { FooterStatus } from '../domain/approved-ux';
import type { CanvasAction } from '../domain/canvas-lifecycle';
import { ownerBoundSwapReview, swapProfile } from '../domain/public-testnet-swap';
import { projectCanvasAction } from '../domain/canvas-lifecycle';
import { editorRunReadiness } from '../domain/editor-run';
import { useExecutionLifecycle } from '../state/execution-lifecycle';
import { useExecutionStart } from '../state/execution-start';
import { restoredLocalExecutionKind } from '../domain/execution-recovery';
import { currentExecution, isFinalExecutionResult } from '../domain/execution-result';
import { executionContinuation } from '../domain/conversation-lifecycle';
import { runReconciled, workflowProgressView } from '../domain/workflow-progress';
import { shellCanvasExecution } from '../domain/canvas-execution';
import type { SequenceContinuation } from './workflow-progress-panel';
import { ReviewAuthorizationDetails } from './review-workspace';
import { workflowBoundAuthorization } from '../domain/review-presentation';
import { useReviewAuthorization } from '../state/review-authorization';
import { useWalletConnection, walletNetworkTarget } from '../state/wallet-connection';
import { usesFloFiWallet } from '../wallet/flofi-wallet-channel';
import { floFiWalletBridgeIssue } from '../domain/flofi-wallet-bridge';
import { SummaryBar } from './summary-bar';
import type { SimulationSource } from '../domain/simulation-presentation';
import { SimulateWorkspace } from './simulate-workspace';
import { ReviewSummaryPanel } from './review-summary-panel';
import { SimulationSummary } from './simulation-summary';
import { networkQuestionPending, flightRefusalPlacement, flightSignerFor, recordNeedsAttention } from '../domain/approved-ux';
import { projectSimulation, simulationAmount, simulationError, simulationStatusPresentation } from '../domain/simulation-presentation';
import { SigningSurface } from './signing-surface';
import { TopBar, type ProductSection } from './top-bar';
import { WorkflowCanvas } from './workflow-canvas';
import { PoolPriceRangeProvider } from './pool-price-range';
import { CanvasCardInputsProvider } from './canvas-card-inputs';
import { authoringEnvironment, useWorkflowCapability } from '../state/capability-store';
import { activeNetworkScope, workflowAllowed } from '../domain/network-scope';
import { usePublicTestnet } from '../state/public-testnet-store';
import { PublicTestnetPanel } from './public-testnet-panel';

import { UNIVERSAL_NETWORKS, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
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
import { UniswapPositionProvider, useUniswapPosition, useUniswapPositionExecutionLifecycle } from '../state/uniswap-position-store';
import { RouterPanel } from './router-panel';
import { useRouter } from '../state/router-store';
import { UniversalBridgePanel } from './universal-bridge-panel';
import { useUniversalRouter } from '../state/universal-router-store';
import { DashboardWorkspace } from './dashboard/dashboard-workspace';
import { PortfolioWidget } from './dashboard/portfolio-widget';
import { DefiPositions } from './dashboard/defi-positions';
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
import { isPristineDraft } from '../domain/initial-workflow';
import { editorPersistencePath } from '../domain/editor-persistence';
import { editorStageReasons } from '../domain/editor-stages';
import { useProductBootstrap } from '../state/product-bootstrap';

/** `approvalSlot`/`approvalGate` (BUILD-FLOFI-UX-UI-002, `/approve` only): where the proposal's notice renders, and whether Simulate and
 * Execute stay closed until the proposal is loaded for the proven wallet.
 * BUILD-SOLANA-TRANSFER-UX-001 (`/approve` only): `surface: 'signing'` presents the same orchestration as the minimal signing surface instead of
 * the Canvas; `approvalWallet` is the proven wallet the proposal was loaded for (only that signer may authorize it); `autoPrepare` runs the
 * proposal's fresh read-only simulation once it is loaded for that signer; `onViewInFloFi` switches to the Canvas presentation. */
type ProductNavigation = { engineering?: boolean; pathname?: string | null; navigate?: (path: string) => void;
  approvalSlot?: ((element: HTMLDivElement | null) => void) | undefined; approvalGate?: boolean;
  surface?: 'workspace' | 'signing'; approvalWallet?: string | null; autoPrepare?: boolean; onViewInFloFi?: (() => void) | undefined };
export function AppShell(props: ProductNavigation = {}) { return <ModeBProvider><CompositionProvider><CanvasCardInputsProvider><PoolPriceRangeProvider><UniswapPositionProvider><AppShellContent {...props}/></UniswapPositionProvider></PoolPriceRangeProvider></CanvasCardInputsProvider></CompositionProvider></ModeBProvider>; }

/**
 * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: what "Simulate" runs for a staged position operation. An Orca mainnet choice simulates exactly its own
 * operation on its own position (`orcaPositionRequestOf`), the Devnet engineering command its staged operation; without a staged choice the
 * previous Review's operation is simulated again (OPEN when there is none). A staged withdrawal or collection is never simulated as OPEN.
 */
/** The previous Orca run's operation, only while that run still belongs to exactly the current workflow (never a retired record's). */
export function solanaPoolPrevious(review: { operation: string; accounts: { positionMint: string }; partBps: number | null } | null | undefined, retired: boolean):
  { operation: string; positionMint: string; partBps: number | null } | null {
  return review && !retired ? { operation: review.operation, positionMint: review.accounts.positionMint, partBps: review.partBps } : null;
}
export function solanaPoolSimulation(staged: StagedPosition | null, previous: { operation: string; positionMint: string; partBps: number | null } | null | undefined,
  workflow?: { readonly nodes: readonly unknown[] } | null):
  { operation: 'OPEN' | 'DECREASE_PARTIAL' | 'EXIT' | 'COLLECT'; positionMint: string | undefined; partBps: number | undefined } {
  const orca = staged && (!staged.choice || staged.choice.position.protocol === 'ORCA') ? staged : null;
  if (orca?.choice) { const request = orcaPositionRequestOf(orca.choice); return { operation: request.operation, positionMint: request.positionMint, partBps: request.partBps }; }
  if (orca) return { operation: orca.operation, positionMint: orca.positionId, partBps: orca.partBps ?? undefined };
  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 (F1): with no staged choice, the canonical node's management marker decides: never OPEN for a position workflow.
  const marked = workflowPositionManagement(workflow);
  if (marked?.protocol === 'ORCA') {
    const request = orcaPositionRequestOfMarker(marked.management);
    if (!request) throw new Error('ORCA_POSITION_REQUEST_MISMATCH');
    return { operation: request.operation, positionMint: request.positionMint, partBps: request.partBps ?? undefined };
  }
  const operation = (previous?.operation ?? 'OPEN') as 'OPEN' | 'DECREASE_PARTIAL' | 'EXIT' | 'COLLECT';
  return { operation, positionMint: operation === 'OPEN' ? undefined : previous?.positionMint, partBps: previous?.partBps ?? undefined };
}

const sameAccount = (a: string, b: string) => a === b || /^0x/i.test(a) && a.toLowerCase() === b.toLowerCase();
const shortAccount = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
/**
 * BUILD-FLOFI-STUDIO-UNIVERSAL-002: third-party Studio metadata an independent FloFi operator certified and published, shown in the Editor only
 * (never on the Chat landing or an approval surface). It is reference information: no action, network or authoring option comes from it.
 */
function PublishedStudioMetadata() {
  const { language } = useLocale();
  const { publishedIntegrations } = useProductBootstrap();
  if (!publishedIntegrations?.length) return null;
  const pt = language === 'PT';
  const kind = (value: string) => value === 'vault' ? (pt ? 'Cofre' : 'Vault') : (pt ? 'Rede' : 'Network');
  return <details className="shell-details studio-discovery">
    <summary>{pt ? `Integrações de terceiros no FloFi Studio (${publishedIntegrations.length})` : `Third-party integrations in FloFi Studio (${publishedIntegrations.length})`}</summary>
    <p>{pt ? 'Publicadas por desenvolvedores e revisadas pela FloFi como informação de referência. Ainda não podem ser usadas em ações.'
      : 'Published by developers and reviewed by FloFi as reference information. They cannot be used in actions yet.'}</p>
    <ul>{publishedIntegrations.slice(0, 20).map(item => <li key={`${item.projectId}/${item.slug}/${item.version}`}>
      <strong>{item.name}</strong> · {kind(item.kind)} · <code>{item.chainRef}</code>
    </li>)}</ul>
  </details>;
}
function AppShellContent({ engineering = false, pathname, navigate, approvalSlot, approvalGate = false, surface = 'workspace', approvalWallet = null, autoPrepare = false, onViewInFloFi }: ProductNavigation) {
  const { t: tr, language } = useLocale();
  const { conversationScope = null } = useProductBootstrap();
  // Server HTML is visible before handlers and initial canvas preferences are ready.
  const [interactive, setInteractive] = useState(false);
  useEffect(() => { setInteractive(true); }, []);
  const { state, context, reviewError, authoringIncomplete, restoreWorkflow, restorationEpoch, propose, createNewWorkflow, newWorkflow, runtimeWorkflow, sequence, sequenceRestore, completeSequenceStep,
    recordExecutedAction, executedActions, amountInputs, actionSetup, commitCanvasAmount, cancelCanvasAmount, removeActionSetup, pending: proposal, canvasRestoring,
    review: workflowReview, cryptoSelections = {}, bridgeNetworkInputs = {}, recipientInputs = {}, stagedPosition = null, clearStagedPosition, stageLiquidityPosition } = useWorkflow();
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
  // Derive the default from the current route until the owner picks a section or a workflow is restored.
  const entryLanding = buildEntryLanding({ pathname, engineering, approval: Boolean(approvalSlot || autoPrepare), surface });
  const [section, setSection] = useState<ProductSection | null>(null);
  const [entryDraft, setEntryDraft] = useState('');
  // BUILD-FLOFI-FLIGHT-001: the request typed on /board arrives once as an editable draft in the Build entry (never sent on its own).
  useFlightDraft(entryLanding ? setEntryDraft : null);
  const dashboardRoute = resolveDashboardRoute(pathname);
  const secondaryRoute = secondaryWorkspaceRoute(pathname);
  const tab = dashboardRoute ? 'Dashboard' : section ?? (entryLanding ? BUILD_ENTRY : 'Build');
  const setTab = useCallback((section: ProductSection) => {
    if ((authoringIncomplete || approvalGate) && (section === 'Simulate' || section === 'Execute')) return;
    if (navigate && section === 'Dashboard') { navigate('/app/dashboard'); return; }
    setSection(section);
    if (navigate && (dashboardRoute || secondaryRoute)) navigate('/app');
  }, [authoringIncomplete, approvalGate, navigate, dashboardRoute, secondaryRoute]);
  const [workflowName, setWorkflowName] = useState('Your Workflow');
  const connectedWallet = useBuild009Wallet();
  const walletIdentity = useExecutionEnvironment();
  const jupiterWallet = useJupiter();
  const solanaSession = jupiterWallet.session;
  // BUILD-FLOFI-WALLET-UX-EXECUTION-FIX-001: the Simulate canvas quotes with the connected addresses (display only).
  const estimateOwners = useMemo(() => ({ evm: connectedWallet.account, solana: solanaSession?.account.address ?? null }), [connectedWallet.account, solanaSession]);
  const owner = walletIdentity.walletKind === 'solana'
    ? solanaSession ? { namespace: 'solana' as const, address: solanaSession.account.address } : null
    : connectedWallet.account ? { namespace: 'eip155' as const, address: connectedWallet.account } : null;
  const walletRestoring = !owner && (connectedWallet.restoring || jupiterWallet.restoring);
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
  // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a staged Uniswap position operation (or that store's own run of this workflow) is served by the position store.
  const uniswapPosition = useUniswapPosition();
  // A staged position belongs to its verified owner: another connected wallet clears it (nothing was simulated or signed for it).
  const stagedOwner = stagedPosition?.choice?.position.owner ?? null, stagedOrca = stagedPosition?.choice?.position.protocol === 'ORCA';
  const stagedSigner = stagedOrca ? solanaSession?.account.address ?? null : connectedWallet.account?.toLowerCase() ?? null;
  useEffect(() => { if (stagedOwner && stagedSigner && stagedSigner !== stagedOwner) clearStagedPosition?.(); }, [stagedOwner, stagedSigner, clearStagedPosition]);
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
  // P0 hotfix (locale contract): the sequence's reason in a given language (each value an explicit `{0}` parameter), so the FloFi chat can keep
  // its messages in the CURRENT interface language; the screen shows it in the language it has now.
  const sequenceIssueIn = (shown: 'EN' | 'PT'): string | null => !sequence ? null : sequenceRestore ? sequenceRestore.status === 'CHECKING'
      ? translate(shown, 'Checking which steps of this workflow already ran before continuing. Nothing can be simulated or signed until this finishes.')
      : translate(shown, 'Step {0} may already have run: FloFi could not read its execution record to confirm it. It is not offered again until it is confirmed.', sequenceRestore.step)
    : fundingOwner && continuingWallet && continuingWallet !== fundingOwner
      ? translate(shown, 'Step {0} spends what an earlier step delivered to wallet {1}. Connect that wallet to continue; nothing was simulated or sent.', sequence.cursor + 1, shortAddress(fundingOwner))
    : unsupportedStep ? sequenceUnsupportedMessage(state.workflow, context, unsupportedStep, shown)
    : unservedStep ? sequenceUnservedMessage(state.workflow, context, unservedStep, shown)
    : sequenceFundingMessage(sequence, shown);
  const sequenceIssue = sequenceIssueIn(language === 'PT' ? 'PT' : 'EN');
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
    : runtime.kind === 'uniswap-pool' ? { kind: 'uniswap-pool', state: uniswapPosition.engaged ? uniswapPosition : uniswapLiquidity }
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
  const authoredStepChain = runtimeWorkflow.nodes.find(node => !node.actionType.startsWith('mock-'))?.chainId ?? null;
  const reviewBinding = useReviewAuthorization(simulationSource.kind, authoredStepChain);
  const stepChain = authoredStepChain ?? reviewBinding.authorization.chain;
  // P0 (owner test 2026-11-12): the Flight decision for the signing wallet, read before each simulation (`flightWalletAccess`). A refusal is shown
  // as this simulation's own classified blocker ("Wallet not linked to your FloFi account"), never as a failed simulation; it applies only while
  // the same wallet is connected, and nothing was quoted, simulated or sent for it.
  // It never masks a run's own state: with an execution started or live, a previous record, a recovery or a retired Review, those keep their
  // own words (a Flight sentence there would read as if nothing had been sent).
  // The wallet checked is the signer of the step being simulated, by its chain family (a mixed EVM/Solana workflow's EVM step is signed by the EVM
  // wallet even when the whole workflow's wallet kind is Solana) — the owner that step's flow call names.
  const flightSigner = flightSignerFor(stepChain, { evm: connectedWallet.account ?? null, solana: solanaSession?.account.address ?? null, fallback: reviewBinding.wallet.account });
  const [flightBlock, setFlightBlock] = useState<{ readonly owner: string; readonly code: string; readonly workflowId: string } | null>(null);
  // The position store's run has its own lifecycle projection (the same projections the shared hook applies to the mint run).
  const positionServed = simulationSource.kind === 'uniswap-pool' && uniswapPosition.engaged;
  const sharedProgress = useExecutionLifecycle(simulationSource.kind, reviewBinding.wallet), positionProgress = useUniswapPositionExecutionLifecycle(reviewBinding.wallet);
  const executionProgress = positionServed ? positionProgress : sharedProgress;
  const recordedStart = useExecutionStart(simulationSource.kind, reviewBinding.wallet);
  // BUILD-FIX-UX-001: a final run of another (new or edited) workflow has not started this workflow's execution; its record is unchanged.
  const executionStart = executionProgress.started && !currentExecution(executionProgress) ? { ...recordedStart, started: false } : recordedStart;
  const sourceState = simulationSource.state as { readonly record?: unknown; readonly run?: unknown; readonly recoveryOnly?: boolean; readonly retired?: boolean; readonly busy?: boolean };
  const flightHere = Boolean(flightBlock && flightSigner && flightBlock.owner.toLowerCase() === flightSigner.toLowerCase() && flightBlock.workflowId === state.workflow.workflowId);
  // Only evidence that something ran, may have run, or a record that needs attention keeps the run's own words. A simulation-only record or run
  // (nothing sent) is replaced by the refusal: the previous simulation is never presented as this request's result.
  const flightPlacement = flightRefusalPlacement({ applies: flightHere, busy: Boolean(sourceState.busy), recoveryOnly: Boolean(sourceState.recoveryOnly),
    recordAttention: recordNeedsAttention(sourceState.record), executionStarted: executionStart.started || Boolean(currentExecution(executionProgress)) });
  if (flightPlacement === 'SOURCE') simulationSource = { ...simulationSource, state: { ...simulationSource.state, error: flightBlock!.code } } as SimulationSource;
  // While Flight is being asked the simulation is already under way for the owner: the lifecycle control shows "Simulating workflow…" (locked),
  // so a second click can never start a second simulation (e2e: workflow-ux-execution held server actions).
  const [preflighting, setPreflighting] = useState(false);
  const preflight = useRef(false);
  if (preflighting && !simulationSource.state.busy) simulationSource = { ...simulationSource, state: { ...simulationSource.state, busy: true } } as SimulationSource;
  // Where the run keeps its own words, the refusal is still said — never swallowed — as a notice that keeps what was already sent tracked.
  const flightNotice = flightPlacement === 'NOTICE' ? flightRefusal(flightBlock!.code) : null;
  const [restoredBinding, setRestoredBinding] = useState({ epoch: restorationEpoch, key: null as string | null });
  if (restoredBinding.epoch !== restorationEpoch) setRestoredBinding({ epoch: restorationEpoch, key: reviewBinding.authorization.key });
  if (restorationEpoch > 0 && (restoredBinding.epoch !== restorationEpoch || restoredBinding.key === reviewBinding.authorization.key))
    simulationSource = { ...simulationSource, state: { ...simulationSource.state, retired: true } } as SimulationSource;
  // BUILD-FLOFI-UNIVERSAL-E2E-001: every surface (Canvas Review, Execute, the /approve signing surface) presents and approves only this
  // workflow's own Review; a retired or other-network Review is dropped, never shown beside this workflow.
  const authorization = workflowBoundAuthorization(reviewBinding.authorization, runtimeWorkflow, simulationSource);
  // BUILD-FLOFI-CHAT-E2E-FIX-002: a sequence step hands over to the next one only when its own run is final and every step of it is
  // reconciled (its step evidence: the runtime read the outcome from the chain; a confirmed receipt alone is not enough), and — when a later step spends its output — once that record proves the delivered amount. Nothing is
  // submitted here; the next step still needs its own fresh simulation, Review, confirmations and wallet signature.
  const liveStep = currentExecution(executionProgress);
  const stepRecord: unknown = simulationSource.kind === 'public' ? publicTestnet.run : simulationSource.kind === 'universal' ? universal.record
    : simulationSource.kind === 'router' ? routerState.record : simulationSource.kind === 'solana-swap' ? jupiter.record
    : simulationSource.kind === 'supply' ? supply.record : null;
  const stepDone = Boolean(sequence && !sequence.finished && !sequenceIssue && liveStep && liveStep.matchesWorkflow !== false && runReconciled(liveStep));
  const stepDelivered = stepDone && sequence ? deliveredByRecord(simulationSource.kind, stepRecord, sequence.current.output) : null;
  const awaitingDelivery = stepDone && Boolean(sequence?.steps.some(step => step.funding.some(f => f.fundedBy === sequence.cursor))) && DELIVERY_READABLE.includes(simulationSource.kind) && stepDelivered === null;
  const stepRunKey = liveStep?.runKey ?? null;
  const stepOwner = stepDone || (!sequence && liveStep?.state === 'complete') ? ownerByRecord(simulationSource.kind, stepRecord) : null;
  // P0 hotfix (execution continuity): the step this visit's own run completed hands over to the next one, which continues in place (below).
  const handedOver = useRef<string | null>(null);
  useEffect(() => {
    if (!sequence || !stepDone || awaitingDelivery) return;
    handedOver.current = `${state.workflow.workflowId}:${sequence.cursor + 1}`;
    completeSequenceStep(sequence.cursor, { received: stepDelivered, runKey: stepRunKey, kind: simulationSource.kind, owner: stepOwner });
  }, [sequence?.cursor, stepDone, awaitingDelivery, stepDelivered, stepRunKey, completeSequenceStep, simulationSource.kind, stepOwner]);
  // BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: a one-action workflow whose own run is final and reconciled (same rule as a sequence step) is kept as
  // an executed first step, so the owner can keep building it: an action added afterwards is its own next step, never a repeat of this one.
  const soleAction = !sequence ? sequenceOrder(state.workflow) : [];
  const actionDone = Boolean(!sequence && soleAction.length === 1 && SEQUENCE_RUNTIMES.includes(simulationSource.kind) && liveStep && liveStep.matchesWorkflow !== false &&
    runReconciled(liveStep));
  const actionDelivered = actionDone ? deliveredByRecord(simulationSource.kind, stepRecord, stepAssets(soleAction[0]!).output) : null;
  useEffect(() => {
    if (actionDone) recordExecutedAction({ received: actionDelivered, runKey: stepRunKey, kind: simulationSource.kind, owner: stepOwner });
  }, [actionDone, actionDelivered, stepRunKey, recordExecutedAction, simulationSource.kind, stepOwner]);
  const sequencePresentation = sequence ? { ...presentSequence(state.workflow, context, sequence), issue: sequenceIssue, awaitingDelivery } : null;
  // Every runtime surface names the step it serves, so a step's simulation or Review never reads as the whole workflow's.
  // BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: the Editor runs a sequence in the confirm-each-step mode; the note names that mode explicitly
  // (authorizing a whole workflow once is the delegated mode of a workflow run, never claimed here).
  // BUILD-FLOFI-BETA-REGRESSION-FIX-001 (FIX-09): a funded bridge's route can only be quoted after the funding step reconciles (the provider
  // answers for the real delivered amount), so that limitation is stated truthfully BEFORE the owner authorizes the funding step.
  // FIX-09 review (flofi-bridge): a funded certified Router bridge has the same quote-after-delivery limitation as a universal one.
  const dependentBridgeAhead = Boolean(sequence && !sequence.finished && sequence.steps.some((step, index) => {
    if (index <= sequence.cursor || !step.funding.some(f => f.fundedBy === sequence.cursor)) return false;
    const node = state.workflow.nodes.find(entry => entry.nodeId === step.nodeId);
    return Boolean(node && (universalBridgeDetails(node) || routerDetails(node)));
  }));
  const sequenceNote = sequencePresentation ? sequencePresentation.finished ? tr('All {0} steps of this workflow are completed and reconciled.', sequencePresentation.total)
    : tr('Confirm each step · Step {0} of {1}: {2}. Each step is simulated, reviewed and confirmed in your wallet on its own, in order; this result covers this step only.', sequencePresentation.current, sequencePresentation.total,
      tr(sequencePresentation.steps[sequencePresentation.current - 1]?.action ?? 'Action'))
      + (dependentBridgeAhead ? ' ' + tr('A later bridge step is quoted by its provider only after this step delivers, so its route for the exact delivered amount cannot be guaranteed yet; providers can refuse very small amounts. A completed step is never repeated.') : '') : null;
  function openSimulationControls() {
    const details = document.querySelector<HTMLDetailsElement>('.simulation-technical');
    if (details) { details.open = true; details.scrollIntoView({ block: 'start' }); details.querySelector<HTMLElement>('summary')?.focus(); }
  }
  const solanaReview = solanaLiquidity.record?.review;
  // BUILD-P0-MAINNET-EXECUTION-RELIABILITY (review): a run at its 16-attempt limit is never refreshed in place again (begin would refuse it); a fresh run starts.
  const reuseUniversalRun = () => refreshBridgeAfterApproval(universal.record, runtimeWorkflow, universal.retired && !universal.destinationRetired)
    && (universal.record?.attempts.length ?? 0) < 16;
  const simulateRuntime = simulationSource.kind === 'universal' ? () => reuseUniversalRun() ? universal.refresh() : universal.simulate()
    : simulationSource.kind === 'router' ? () => refreshBridgeAfterApproval(routerState.record, runtimeWorkflow, routerState.retired) ? routerState.refresh() : routerState.simulate()
    : simulationSource.kind === 'solana-transfer' ? solanaTransfer.simulate
    : simulationSource.kind === 'transfer' ? transfer.simulate
    : simulationSource.kind === 'lending' ? lending.simulate
    : simulationSource.kind === 'supply' ? supply.simulate
    // EXEC-01: "Simulate again" of a started liquidity run (an approval landed, nothing pending) refreshes that same run in place: the
    // confirmed approval is kept and only the remaining requests are reviewed again. A run with nothing landed starts a new simulation.
    // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: a staged Uniswap position operation simulates exactly that operation (`uniswapPositionRequestOf`); the
    // Editor's "Refresh review" (C2) and "Simulate again" refresh the SAME run in place while nothing of it was sent and the owner is connected.
    : positionServed ? () => uniswapPositionRefreshInPlace(uniswapPosition.record, uniswapPosition.retired, connectedWallet.account)
      ? uniswapPosition.refresh() : uniswapPosition.simulate()
    : simulationSource.kind === 'uniswap-pool' ? () => uniswapRefreshInPlace(uniswapLiquidity.record, uniswapLiquidity.retired) ? uniswapLiquidity.refresh() : uniswapLiquidity.simulate()
    : simulationSource.kind === 'solana-composition' ? solanaComposition.simulate
    : simulationSource.kind === 'solana-pool' ? () => {
      // A previous run's operation is simulated again only while that run still belongs to exactly this workflow: a retired record (another
      // workflow, e.g. a new deposit at the same range) never turns a deposit into its withdrawal, collect or exit (flofi-workflow P2).
      const next = solanaPoolSimulation(stagedPosition, solanaPoolPrevious(solanaReview, solanaLiquidity.retired), runtimeWorkflow);
      return solanaLiquidity.simulate(next.operation, next.positionMint, next.partBps);
    }
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
  // BUILD-FLOFI-UNIFIED-WALLET-RESOLUTION-P0-001: a bridge whose receiving wallet is not resolved (none known, several to choose from, or the
  // account's wallets still loading) is not simulated; the Canvas, the Simulate stage and the chat all say which wallet is missing and on which
  // network. The store refuses the same before any sign-in, and the server keeps its own refusal: this gate only adds, it relaxes nothing.
  // A refresh of an existing run (after its approval) keeps the reviewed recipient on the server, so only a NEW simulation waits for it. Read only
  // when a destination issue exists (so the workflow holds its bridge): the check hashes the workflow, which an empty one (a reload) cannot be.
  const universalRefreshes = () => {
    try { return reuseUniversalRun(); }
    catch { return false; }
  };
  // Workflow review: an unavailable (or not yet answered) universal router is said first; the destination is asked only where it can be used.
  // BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001: worded for the surface that shows it (the Editor has the Bridge card; /approve does not).
  // The embedded MCP approval (no "Open Canvas") never points at a Canvas it does not have.
  const destinationSurface: DestinationSurface = surface !== 'signing' ? 'editor' : onViewInFloFi ? 'approve' : 'approve-embedded';
  // The proposal whose automatic preparation /approve holds (see `destinationHoldsPreparation` below): its new reads do not continue by themselves.
  const destinationHeld = useRef<string | null>(null);
  const holdPreparation = () => { if (simulationSource.kind === 'universal') destinationHeld.current = state.workflow.workflowId; };
  const destinationIssueIn = (shown: 'EN' | 'PT', on: DestinationSurface = destinationSurface): string | null => {
    if (!(simulationSource.kind === 'universal' && universal.available && universal.availabilityKnown && universal.destinationIssue && universal.details
      && !universalRefreshes())) return null;
    const ecosystem = UNIVERSAL_NETWORKS[universal.details.destination].ecosystem === 'SOLANA' ? 'Solana' as const : 'EVM' as const;
    return translate(shown, destinationIssueMessage(universal.destinationIssue, on, destinationHeld.current === state.workflow.workflowId), universal.details.destinationLabel, ecosystem,
      translate(shown, destinationWalletPhrase(ecosystem)));
  };
  const destinationBlocked = destinationIssueIn(language === 'PT' ? 'PT' : 'EN');
  const conversationDestinationIssue = destinationIssueIn(language === 'PT' ? 'PT' : 'EN', 'approve-embedded');
  // The account's wallets are still being read for this bridge's destination: the chat says so once and continues by itself when they are.
  const destinationLoading = destinationBlocked && universal.destinationIssue === DESTINATION_ISSUE.LOADING && universal.details
    ? { network: universal.details.destinationLabel, reason: conversationDestinationIssue ?? destinationBlocked } : null;
  // What the owner can do about it where no Bridge card is shown (/approve): connect a wallet of the destination ecosystem (it only reads its
  // public address; nothing is signed) and, after a failed account read, read it again. Choosing or typing an address happens on the Canvas.
  const destinationEcosystemLabel = universal.details ? UNIVERSAL_NETWORKS[universal.details.destination].ecosystem === 'SOLANA' ? 'Solana' as const : 'EVM' as const : null;
  // A wallet connected here is the first one FloFi uses (session tier), so Connect also settles a choice between several wallets.
  const destinationActions = destinationBlocked && destinationEcosystemLabel && universal.destinationIssue !== DESTINATION_ISSUE.LOADING ? {
      // Wallet-execution review: the owner's own Connect or Try again holds the preparation at once (also while a wallet is still restoring),
      // so a destination resolved by it is simulated only when the owner chooses Simulate.
      connect: { label: destinationEcosystemLabel === 'Solana' ? 'Connect a Solana wallet' : 'Connect an EVM wallet',
        run: async () => { holdPreparation(); return destinationEcosystemLabel === 'Solana' ? Boolean(await jupiter.connect('solana:mainnet')) : Boolean(await connectedWallet.connect()); } },
      retry: universal.destinationIssue === DESTINATION_ISSUE.UNAVAILABLE ? () => { holdPreparation(); retryAccountWallets(); } : null, canvas: destinationSurface === 'approve' } : null;
  const simulationDisabled = Boolean(destinationBlocked) || authoringIncomplete || approvalGate || testNetworkWorkflow || simulationSource.kind === 'unavailable' ||
    ('available' in simulationSource.state && simulationSource.state.available === false) ||
    ('info' in simulationSource.state && simulationSource.state.info?.available === false);
  // BUILD-SOLANA-TRANSFER-UX-001: a proposal loaded for one proven wallet is authorized by that same signer only. A different connected
  // account is never substituted: its simulation and Review would bind another owner, so the action waits for the right wallet.
  const signer = reviewBinding.wallet.account;
  const simulationRequest = { workflow: state.workflow, runtime: runtimeWorkflow, signer, kind: simulationSource.kind, incomplete: Boolean(authoringIncomplete) };
  const currentSimulationRequest = useRef(simulationRequest);
  currentSimulationRequest.current = simulationRequest;
  // P0: Flight first, for the same wallet the API binds; the runtime simulates only when that wallet may act (a refusal is a value, not a throw).
  // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (final wallet-execution review): the simulation FloFi starts by itself is non-interactive — the Router
  // and Transfer stores never open the wallet selector or ask for a sign-in then (their inline error instead); every other runtime's simulation is
  // read-only already. Only an explicit `{ quiet: true }` selects it (an event object passed by a click never does).
  const simulateQuietly = simulationSource.kind === 'transfer' ? () => transfer.simulate({ interactive: false })
    : simulationSource.kind === 'router' ? () => refreshBridgeAfterApproval(routerState.record, runtimeWorkflow, routerState.retired) ? routerState.refresh() : routerState.simulate({ interactive: false })
    : simulateRuntime;
  const simulateAgain = async (options?: { readonly quiet?: true }): Promise<void> => {
    if (preflight.current) return; // a click while Flight is being asked starts nothing more
    // P0 hotfix (execution continuity): a finished sequence has no step left to simulate; its last step is never simulated (or offered) again.
    if (sequence?.finished) return;
    preflight.current = true; setPreflighting(true);
    let simulation: Promise<unknown> | undefined;
    try {
      let access: Awaited<ReturnType<typeof flightWalletAccess>> | null = null;
      if (flightSigner) {
        // FIX-09: a Flight check that never answers never leaves the simulation locked on "Simulating workflow…"; the runtime's own
        // authorization checks still protect execution (an unanswered read fails open exactly like a failed one, as before).
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { access = await Promise.race([flightWalletAccess(flightSigner).catch(() => null),
          new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 20_000); })]); }
        finally { clearTimeout(timer); }
      }
      const latest = currentSimulationRequest.current;
      if (latest.incomplete || latest.workflow !== simulationRequest.workflow || latest.runtime !== simulationRequest.runtime ||
        latest.signer !== simulationRequest.signer || latest.kind !== simulationRequest.kind) return;
      if (flightSigner && access && !access.ok) { setFlightBlock({ owner: flightSigner, code: access.code, workflowId: state.workflow.workflowId }); return; }
      setFlightBlock(null);
      // Started before the lock lifts, so the runtime's own busy state takes over in the same update (no enabled gap between the two).
      simulation = Promise.resolve(options?.quiet === true ? simulateQuietly() : simulateRuntime());
    } finally { preflight.current = false; setPreflighting(false); }
    await simulation;
  };
  const walletConnection = useWalletConnection(stepChain);
  const requiredSigningChain = !('retired' in simulationSource.state && simulationSource.state.retired) && authorization.chain
    || runtimeWorkflow.nodes.find(node => !node.actionType.startsWith('mock-'))?.chainId;
  const networkTarget = walletNetworkTarget(requiredSigningChain);
  // The proposal's own account: known before the run path is chosen (the FloFi Wallet check below joins it once it is).
  const accountIssueIn = (shown: 'EN' | 'PT') => approvalWallet && signer && !sameAccount(approvalWallet, signer)
    ? translate(shown, 'This proposal was loaded for {0}. Switch your wallet to that account to authorize it.', shortAccount(approvalWallet)) : null;
  const accountIssue = accountIssueIn(language === 'PT' ? 'PT' : 'EN');
  const canReadAcrossEvmNetworks = networkTarget?.ecosystem === 'evm' && (simulationSource.kind === 'universal' ||
    simulationSource.kind === 'public' && publicTestnet.catalogAvailable(requiredSigningChain ?? ''));
  const networkAction = signer && requiredSigningChain && networkTarget && reviewBinding.wallet.chain !== requiredSigningChain &&
    (!canReadAcrossEvmNetworks || authorization.key && !reviewBinding.wallet.changed) ? {
    label: tr('Switch to {0}', networkTarget.label), labelIn: (shown: 'EN' | 'PT') => translate(shown, 'Switch to {0}', networkTarget.label), network: networkTarget.label, disabled: Boolean(simulationSource.state.busy || approvalGate || accountIssue),
    request: () => void walletConnection.switchNetwork(requiredSigningChain),
  } : undefined;
  const lifecycleState = { workflow: runtimeWorkflow, context, source: simulationSource, authorization: authorization,
    wallet: reviewBinding.wallet, execution: executionStart, progress: executionProgress, recovery: executionProgress.recovery,
    invalidWorkflow: Boolean(reviewError || authoringIncomplete || approvalGate || testNetworkWorkflow || accountIssue || autoPrepare && !approvalWallet) };
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
  // A finished run of another workflow holds back only a step-by-step sequence, never a single card (`localExecutionHolds`).
  const localSequenceStarted = localExecutionHolds({ current: Boolean(currentExecution(executionProgress)), started: executionProgress.started,
    recorded: executionStart.started, sequence: sequence ?? null });
  // BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001: ONE EVM financial card whose action FloFi's user-funded execution groups build (a catalog swap, a
  // certified Router bridge, a transfer, an Aave supply / borrow / repay / withdraw) runs through the SAME whole-workflow path as a multi-step
  // workflow: one Authorize, ONE wallet confirmation (an atomic batch with any exact approval folded in, only where the allowance is short), then
  // automatic reconciliation. Only where the deployment's database accepts one-step runs (the hook's availability); otherwise, and whenever its
  // Review shows the card cannot run as one confirmation, the card keeps its own flow exactly as before.
  const singleCardRun = !sequence && soleAction.length === 1 && SINGLE_CARD_RUNTIMES.includes(runtime.kind ?? '') && soleAction[0]!.chainId.startsWith('eip155:')
    && !compositionWorkflow(state.workflow);
  const workflowRunHere = useEditorWorkflowRun({ workflow: state.workflow, evmAccount: connectedWallet.account, single: singleCardRun,
    enabled: (Boolean(sequence) || singleCardRun) && !approvalSlot && !autoPrepare && surface === 'workspace' && !sequenceRestore && !localSequenceStarted });
  // A single card goes back to its own flow when its Review is not one grouped interaction, refuses the batch, or could not answer at all
  // (`singleCardFallsBack`); a started run of it always stays here.
  const singleCardReview = singleCardRun ? workflowRunHere.review : null;
  const singleCardFallback = singleCardRun && singleCardFallsBack({ ...workflowRunHere, review: singleCardReview });
  // The whole-workflow path is primary until its Review shows this workflow must run step by step (it cannot be grouped, the RPC cannot simulate
  // it, or the path cannot run here); a safety refusal keeps it primary, so the workflow is fixed before anything runs (a started run always is).
  // A run of this workflow (started here, or followed after a reload) always dominates: whatever the deployment's availability answers (an expired
  // account session, before the answer arrives), the workflow is never offered again through its per-step or own-card path.
  const groupedPrimary = workflowRunHere.started || workflowRunHere.available && !workflowRunHere.stepByStep && !singleCardFallback;
  // Incident 9 (`domain/flofi-wallet-bridge.ts`): a bridge on its own flow is never handed to FloFi Wallet, which cannot sign it yet.
  const floFiBridgeIssue = floFiWalletBridgeIssue({ kind: simulationSource.kind, signerIsFloFiWallet: Boolean(signer && usesFloFiWallet(signer)),
    groupedRun: groupedPrimary, executing: Boolean(currentExecution(executionProgress)), ecosystem: networkTarget?.ecosystem,
    laterSteps: sequence && !sequence.finished ? sequence.steps.slice(sequence.cursor + 1).map((step, index) => ({ kind: sequenceKinds[sequence.cursor + 1 + index] ?? null, chainId: step.chainId })) : [] });
  const walletIssueIn = (shown: 'EN' | 'PT') => accountIssueIn(shown) ?? (floFiBridgeIssue ? translate(shown, floFiBridgeIssue) : null);
  const walletIssue = walletIssueIn(language === 'PT' ? 'PT' : 'EN');
  // A single card back on its own flow shows only that flow (its own Review and wording): never the whole-workflow Review or a second primary action
  // beside it (final frontend-ux review). A started run of it always stays shown.
  const groupedShown = workflowRunHere.visible && !singleCardFallback;
  // A single card that falls back to its own flow right after its Review continues there at once (read-only: its own fresh simulation, which never
  // opens the wallet selector or a sign-in: `simulateQuietly`). The owner's Simulate click already asked for it; a flow whose simulation needs a
  // wallet sign-in (the Router without a session, the universal Router) waits for the owner's own click.
  const singleFallbackKey = singleCardFallback && (singleCardReview || workflowRunHere.error) ? `${state.workflow.workflowId}:${state.workflow.revision}` : null;
  const singleFallbackSimulated = useRef<string | null>(null);
  useEffect(() => {
    if (!singleFallbackKey || singleFallbackSimulated.current === singleFallbackKey) return;
    if (walletIssue || networkAction || simulationDisabled || !actionable || lifecycleState.invalidWorkflow) return;
    if (canvasAction.kind !== 'simulate' || canvasAction.disabled || simulationSource.state.busy) return;
    if (simulationSource.kind === 'universal' || !connectedWallet.account) return;
    if (simulationSource.kind === 'router' && routerState.session?.account?.toLowerCase() !== connectedWallet.account.toLowerCase()) return;
    singleFallbackSimulated.current = singleFallbackKey;
    void simulateAgain({ quiet: true });
  }, [singleFallbackKey, walletIssue, Boolean(networkAction), simulationDisabled, lifecycleState.invalidWorkflow, canvasAction.kind, canvasAction.disabled,
    simulationSource.state.busy, simulationSource.kind, routerState.session?.account, connectedWallet.account]);
  // A single card's run that completed and reconciled is kept as this workflow's executed first step (as its own flow's run is), so an action added
  // afterwards is its own next step, never a repeat of this one. Its delivery is what the run reconciled for the card's output asset.
  const groupedSingleRun = singleCardRun || !sequence && soleAction.length === 1 ? workflowRunHere.run : null;
  const groupedSingleDone = Boolean(groupedSingleRun && groupedSingleRun.state === 'COMPLETED' && groupedSingleRun.stepCount === 1
    && groupedSingleRun.steps[0]?.state === 'RECONCILED' && workflowRunHere.authorizedFor?.workflowId === state.workflow.workflowId
    && workflowRunHere.authorizedFor.revision === state.workflow.revision);
  const groupedSingleDelivered = groupedSingleDone ? deliveredByRun(groupedSingleRun!.steps[0]?.outcome?.received ?? [], stepAssets(soleAction[0]!).output) : null;
  useEffect(() => {
    // The wallet that executed it is the run's own (its group's fee payer: the run's bound EVM wallet), never whatever is connected now.
    if (groupedSingleDone && groupedSingleRun) recordExecutedAction({ received: groupedSingleDelivered, runKey: groupedSingleRun.approvalId, kind: 'workflow-run',
      owner: groupedSingleRun.groups[0]?.feePayer?.toLowerCase() ?? null });
  }, [groupedSingleDone, groupedSingleDelivered, groupedSingleRun?.approvalId, recordExecutedAction]);
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
  // P0 hotfix (execution continuity, production 2026-11-12: after the Swap the UI returned to Simulate and the owner had to Review + Execute again).
  // A step-by-step workflow whose earlier step completed (its run final, its delivery proven) and whose next step has not started CONTINUES in the
  // Execute view: the next step's read-only simulation runs at once (only for a handover this visit's own run made; after a reload the owner
  // starts it), and its fresh per-step confirmation is presented inline ("Step 2 of 2", what it spends and receives, one action that accepts that
  // step's own Review and opens its wallet request on the owner's click). The stage never switches to Simulate, and nothing is signed or sent.
  const workflowSurface = !approvalSlot && !autoPrepare && surface === 'workspace';
  const sequenceContinuing = Boolean(workflowSurface && sequence && !sequence.finished && sequence.completed.length > 0 && !liveStep);
  const sequenceFinishedIdle = Boolean(workflowSurface && sequence?.finished && !liveStep);
  // A finished sequence has nothing left to simulate: its simulate control is closed and says why (its last step is never offered again).
  const sequenceDone = Boolean(sequence?.finished);
  const sequenceDoneReason = sequence?.finished ? tr('All {0} steps of this workflow are completed and reconciled.', sequence.steps.length) : null;
  const continueKey = sequenceContinuing && sequence ? `${state.workflow.workflowId}:${sequence.cursor}` : null;
  const autoContinued = useRef<string | null>(null);
  useEffect(() => {
    if (!continueKey || handedOver.current !== continueKey || autoContinued.current === continueKey) return;
    if (!signer || sequenceIssue || sequenceRestore || walletIssue || networkAction || simulationDisabled || !actionable || lifecycleState.invalidWorkflow) return;
    if (canvasAction.kind !== 'simulate' || canvasAction.disabled || simulationSource.state.busy) return;
    // A Router step simulates only for a signed-in wallet session: without one its simulation would open a wallet sign-in request, which only
    // the owner's own click may start (the inline action), never FloFi by itself. The universal Router always may, so it waits for the click too.
    if (simulationSource.kind === 'universal' || simulationSource.kind === 'router' && !routerState.session) return;
    autoContinued.current = continueKey;
    void simulateAgain();
  }, [continueKey, signer, sequenceIssue, Boolean(sequenceRestore), walletIssue, Boolean(networkAction), simulationDisabled, actionable, lifecycleState.invalidWorkflow, canvasAction.kind, canvasAction.disabled, simulationSource.state.busy,
    simulationSource.kind, Boolean(routerState.session)]);
  // One progress truth for the whole workflow (Execute, the FloFi Assistant and the Dashboard read these same numbers). A workflow one runtime
  // serves as a whole already counts its own steps in its run; a step-by-step workflow is counted here, over all of its steps.
  const stepPrepared = Boolean(authorization.key && !simulationSource.state.busy && (canvasAction.kind === 'approve' || canvasAction.kind === 'execute'));
  // P0 hotfix (FIX 2, production 2026-11-13: Swap RECONCILED, Bridge "Not started" with no reason): the next step's refused simulation is shown.
  const stepRefusal = sequenceContinuing && !simulationSource.state.busy && simulationSource.state.error ? simulationError(simulationSource.state.error, simulationSource.kind) : null;
  const workflowProgress = sequence ? workflowProgressView({ sequence: sequencePresentation, live: liveStep, prepared: stepPrepared, refusal: stepRefusal }) : null;
  const continuationSimulation = sequenceContinuing ? projectSimulation(runtimeWorkflow, context, simulationSource).steps[0] ?? null : null;
  const continuationStep = sequence && sequencePresentation ? sequencePresentation.steps[sequence.cursor] ?? null : null;
  const previousStep = sequence && sequence.cursor > 0 && sequencePresentation ? sequencePresentation.steps[sequence.cursor - 1] ?? null : null;
  const executeContinuation: SequenceContinuation | null = sequenceFinishedIdle && sequence && sequencePresentation ? {
    current: sequence.steps.length, total: sequence.steps.length, action: sequencePresentation.steps.at(-1)?.action ?? 'Action', network: sequencePresentation.steps.at(-1)?.network ?? '',
    spends: null, receives: null, previous: null, status: 'COMPLETED', reason: null }
    : sequenceContinuing && sequence && continuationStep ? { current: sequence.cursor + 1, total: sequence.steps.length, action: continuationStep.action, network: continuationStep.network,
      spends: continuationSimulation && continuationSimulation.input !== '—' ? continuationSimulation.input : continuationStep.funding?.bound ?? continuationStep.amount,
      receives: continuationSimulation?.result ?? null,
      previous: previousStep ? { number: previousStep.number, delivered: previousStep.delivered } : null,
      // Workflow review: the destination blocks only a new simulation; a Review that can still be authorized is READY, not "blocked".
      status: simulationSource.state.busy || canvasAction.processing ? 'SIMULATING' : sequenceIssue || sequenceRestore || walletIssue || networkAction
        || destinationBlocked && canvasAction.kind === 'simulate' ? 'BLOCKED'
        : (canvasAction.kind === 'approve' || canvasAction.kind === 'execute') && !canvasAction.disabled ? 'READY' : 'SIMULATE',
      reason: sequenceIssue ?? walletIssue ?? (networkAction ? tr('Switch your wallet to {0} to continue with this step.', networkAction.network) : null)
        ?? (canvasAction.kind === 'simulate' ? destinationBlocked : null)
        ?? (simulationSource.state.error ? simulationError(simulationSource.state.error, simulationSource.kind) : null) } : null;
  // BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001 (security and wallet-execution reviews): a universal bridge whose receiving wallet was missing
  // here is not prepared by itself once it resolves (a connected wallet, Try again, a recovered read): its simulation may ask the source wallet
  // to sign in, so the owner chooses Simulate. A proposal that arrived with its destination already resolved is prepared as before.
  const destinationHold = destinationHoldsPreparation({ kind: simulationSource.kind, held: destinationHeld.current, key: state.workflow.workflowId,
    // MCP review: a session wallet still restoring silently (it will resolve the destination by itself) never holds the preparation either.
    blocked: Boolean(destinationBlocked) && Boolean(approvalWallet) && !approvalGate && universal.destinationIssue !== DESTINATION_ISSUE.LOADING
      && !connectedWallet.restoring && !jupiter.restoring });
  destinationHeld.current = destinationHold.held;
  const preparedAfterDestination = destinationHold.holds;
  const prepareKey = autoPrepare && approvalWallet && !approvalGate && !walletIssue && signer && actionable && !authoringIncomplete && !simulationDisabled && !currentExecution(executionProgress)
    && !preparedAfterDestination
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
  function resetForNewWorkflow() {
    setFlightBlock(null); createNewWorkflow(); setWorkflowName('Your Workflow'); selectAction(null); setSaveNotice(null); setShowVerification(false); setAutomateCanvas(false);
    setWorkflowEpoch(epoch => epoch + 1);
  }
  function startNewWorkflow() { resetForNewWorkflow(); setTab('Build'); }
  /**
   * BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001: the Dashboard's position actions PREPARE the workflow — the owner's choice is committed as
   * MANAGE_LIQUIDITY_POSITION and staged — and open the Editor. Nothing is simulated, reviewed or signed here. A workflow with other steps is
   * never rewritten silently: the owner explicitly starts a new workflow for the position (`fresh`).
   */
  const [queuedPosition, setQueuedPosition] = useState<{ readonly choice: LiquidityPositionChoice; readonly pool: LiquidityPositionPoolInput; readonly from: string } | null>(null);
  function prepareLiquidityPosition(choice: LiquidityPositionChoice, pool: LiquidityPositionPoolInput, fresh = false): string | null {
    if (!stageLiquidityPosition) return 'LIQUIDITY_POSITION_UNAVAILABLE';
    if (fresh) { setQueuedPosition({ choice, pool, from: state.workflow.workflowId }); resetForNewWorkflow(); return null; }
    // BUILD-FLOFI-LIQUIDITY-LIFECYCLE-001 (Editor integration): a workflow being executed or checked is never changed under its run, and one with
    // other steps (a deposit, another position, a swap…) is replaced only after the owner explicitly starts a new workflow for this position.
    const refusal = positionPreparationRefusal(state.workflow, choice, editingPaused);
    if (refusal) return refusal;
    const result = stageLiquidityPosition(choice, pool);
    if (!result.ok) return result.error;
    setTab('Build');
    return null;
  }
  useEffect(() => {
    if (!queuedPosition || state.workflow.workflowId === queuedPosition.from || !stageLiquidityPosition) return;
    setQueuedPosition(null);
    if (stageLiquidityPosition(queuedPosition.choice, queuedPosition.pool).ok) setTab('Build');
  }, [queuedPosition, state.workflow.workflowId]);
  /**
   * BUILD-P0-MAINNET-EXECUTION-RELIABILITY (Incident F): the sidebar's and the Dashboard's "New workflow". The same clean start as "Create new
   * workflow" (new identity; Canvas, selection, proposal, Review binding and Copilot conversation reset; wallet connection and sign-in kept),
   * opening on Chat with an empty request. It cancels nothing: a run already submitted keeps being observed and stays in the Dashboard/History.
   */
  function startNewChatWorkflow() {
    // Already a clean workspace (untouched Canvas, no run on it, no proposal, nothing the owner said — the conversation always opens with FloFi's
    // own introduction): nothing to reset — repeated clicks never mint
    // identities, and a request the owner is still typing in Chat stays.
    if (!canvasRestoring && isPristineDraft(state.workflow) && !currentExecution(executionProgress) && !executionProgress.started && !proposal && !conversation.messages.some(message => message.role === 'you')) { setTab(BUILD_ENTRY); return; }
    resetForNewWorkflow(); setTab(BUILD_ENTRY); setEntryDraft('');
  }
  // BUILD-FLOFI-PRODUCT-UX-001: informational Beta Mainnet notice only; it gates nothing. Omitted from the compact signing surface.
  const betaNotice = <><p className="beta-notice" role="note">{tr("FloFi Beta Mainnet — Real funds are enabled. Review every transaction before signing.")}</p>
    {/* BUILD-FLOFI-FLIGHT-001: after "Board now" on /board, a ready Review asks the server for the person's boarding pass. */}
    <FlightBoarding readyKey={authorization.ready ? authorization.key : null} workflowId={state.workflow.workflowId}/></>;
  const unavailableReason = simulationDisabled || !actionable || lifecycleState.invalidWorkflow ? simulationUnavailableReason({ incomplete: Boolean(authoringIncomplete || reviewError || !actionable),
    unsupported: testNetworkWorkflow || simulationSource.kind === 'unavailable', walletRequired: !signer || Boolean(approvalGate || autoPrepare && !approvalWallet),
    providerUnavailable: 'available' in simulationSource.state && simulationSource.state.available === false || 'info' in simulationSource.state && simulationSource.state.info?.available === false,
    availabilityChecking: 'availabilityKnown' in simulationSource.state && simulationSource.state.availabilityKnown === false,
    error: simulationSource.state.error, staleQuote: lifecycleControls.view.expiresAt !== null && Date.now() >= lifecycleControls.view.expiresAt }) : null;
  const simulationReason = sequenceIssue ?? destinationBlocked ?? unavailableReason;
  /** The same reason in a given language (the chat's messages follow the interface language; `unavailableReason` is a catalog key). */
  const simulationReasonIn = (shown: 'EN' | 'PT') => sequenceIssueIn(shown) ?? destinationIssueIn(shown) ?? (unavailableReason ? translate(shown, unavailableReason) : null);
  // BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio, A2/B2): the whole-workflow Review is this workflow's simulation (read-only: every step together, nothing
  // signed or sent). "Simulate workflow" on Create opens Simulate and runs it there (the same `startReview`), where the owner reads the result
  // before "Review operation" opens Execute; no authorization language on Create. A started run keeps "Open workflow progress" (Execute).
  const groupedReviewExpired = Boolean(workflowRunHere.review?.validUntil && Date.parse(workflowRunHere.review.validUntil) <= Date.now());
  const groupedRunOpen = Boolean(workflowRunHere.started);
  const stepSwap = simulationSource.kind === 'public' ? swapProfile(stepChain) : null;
  const stepNeedsWallet = !engineering && sequence && !signer && networkTarget && actionable && !simulationDisabled && !sequenceDone && !currentExecution(executionProgress)
    && (simulationSource.kind !== 'public' || authorization.key || stepSwap && ownerBoundSwapReview(stepSwap));
  // Execute keeps the wallet prerequisite in the same action slot as Simulate, Refresh and Authorize.
  const stepWalletAction = (inExecute: boolean) => stepNeedsWallet ? <div className="canvas-lifecycle-control">
    <button type="button" data-lifecycle-action="connect-wallet" className={inExecute ? 'primary' : 'secondary'} onClick={() => void walletConnection.connect()}>
      {tr(networkTarget.ecosystem === 'solana' ? 'Connect a Solana wallet' : 'Connect an EVM wallet')}</button>
    {walletConnection.notice && <p role="status">{tr(...walletConnection.notice)}</p>}
  </div> : null;
  const executeWalletAction = canvasAction.kind === 'simulate' && !simulationSource.state.busy ? stepWalletAction(true) : null;
  const groupedAction = <div className="canvas-lifecycle-control editor-run-control">
    {/* A single card shows no workflow-run note (final frontend-ux review): its one action is followed like the card's own flow. */}
    {workflowRunHere.started && !singleCardRun && <p className="canvas-sequence-note" role="note">{tr('This workflow runs as one workflow run: follow it in Execute.')}</p>}
    <button type="button" className="primary" data-lifecycle-action="workflow-run"
      disabled={(!groupedRunOpen && Boolean(authoringIncomplete)) || ['reviewing', 'authorizing', 'proving', 'wallet', 'confirming'].includes(workflowRunHere.phase)}
      onClick={() => {
        if (groupedRunOpen) { setTab('Execute'); return; }
        setTab('Simulate');
        if (workflowRunHere.canReview && (!workflowRunHere.review || groupedReviewExpired)) void workflowRunHere.startReview();
      }}>
      {tr(groupedRunOpen ? 'Open workflow progress' : workflowRunHere.phase === 'reviewing' ? 'Simulating workflow…' : 'Simulate workflow')}</button>
    {!groupedRunOpen && authoringIncomplete && <p role="status">{tr('Configure the action amount on the Canvas first')}</p>}
  </div>;
  const simulateActionFor = (note: string | null, options: { readonly stay?: boolean; readonly inExecute?: boolean; readonly labelFor?: (action: CanvasAction) => string } = {}) => groupedPrimary ? groupedAction : sequenceRestore ? <div className="canvas-lifecycle-control sequence-restore-control">
      <p role="status">{sequenceIssue}</p>
      {sequenceRestore.status === 'UNVERIFIED' && <>
        <button type="button" onClick={sequenceRestore.retry}>{tr('Check again')}</button>
        <p className="sequence-restore-warning">{tr('Only if your wallet history shows that step {0} did not run:', sequenceRestore.step)}</p>
        <button type="button" className="secondary" onClick={sequenceRestore.discard}>{tr('Forget this record and offer step {0} again', sequenceRestore.step)}</button>
      </>}
    </div>
    : walletIssue ? <div className="canvas-lifecycle-control"><p role="status">{walletIssue}</p><button type="button" onClick={() => void walletConnection.connect()}>{tr('Use another wallet')}</button></div>
    : networkAction ? <div className="canvas-lifecycle-control"><button type="button" className="primary canvas-network-switch" disabled={networkAction.disabled} onClick={networkAction.request}>{networkAction.label}</button>{walletConnection.notice && <p role="status">{tr(...walletConnection.notice)}</p>}</div>
    : options.inExecute && executeWalletAction ? executeWalletAction : <>
      <CanvasLifecycleAction {...lifecycleState} controls={lifecycleControls} workflowName={workflowName}
        simulationDisabled={simulationDisabled || !actionable || sequenceDone} simulationReason={sequenceDoneReason ?? simulationReason} sequenceNote={note}
        simulate={() => { if (!options.stay) setTab('Simulate'); return simulateAgain(); }} onExecute={() => setTab('Execute')} labelFor={options.labelFor}/>
      {!options.inExecute && stepWalletAction(false)}
    </>;
  const simulateAction = simulateActionFor(sequenceNote);
  // P0 hotfix (execution continuity): in Execute, a step-by-step workflow (its run, or its next step) and an owner-bound swap's approval → swap
  // continuation continue in place: a fresh simulation asked for here stays in Execute (never the Simulate stage), and a finished workflow
  // offers only "Create new workflow" (never a simulation of its last step again).
  const inlineExecute = sequenceContinuing || Boolean(liveStep && (sequence || ownerBoundContinuation));
  const executeAction = sequenceFinishedIdle ? <button type="button" className="primary execute-new-workflow" onClick={startNewWorkflow}>{tr('Create new workflow')}</button>
    : inlineExecute && !sequenceRestore && !walletIssue && !networkAction ? executeWalletAction ??
      <CanvasLifecycleAction {...lifecycleState} controls={lifecycleControls} workflowName={workflowName}
        simulationDisabled={simulationDisabled || !actionable || sequenceDone} simulationReason={sequenceDoneReason ?? simulationReason} sequenceNote={sequenceContinuing ? null : sequenceNote}
        simulate={() => simulateAgain()} onExecute={() => setTab('Execute')}/>
    : simulateActionFor(sequenceNote, { inExecute: true });
  // BUILD-FLOFI-CONVERSATIONAL-001: the chat lives here, above the stage switch, so Build, Simulate and Execute share one conversation. It reaches
  // the same lifecycle the Canvas CTA uses (this Simulate, these controls); on /approve it keeps its earlier proposal-only behaviour.
  // BUILD-FLOFI-CHAT-E2E-FIX-002: amounts typed on Canvas cards and never applied block every simulation. The chat names each one (step, action,
  // typed value) and applies or discards it only on the owner's explicit answer, through the same card actions the Canvas uses.
  const orderedActions = composerActions(state.workflow);
  const pendingEdits: PendingEdit[] = [
    ...actionSetup ? [{ nodeId: actionSetup.id, step: orderedActions.length + 1, action: setupSummary(actionSetup, context).action,
      value: setupSummary(actionSetup, context).amount, draft: actionReviewValue(actionSetup, actionSetup.id, undefined) }] : [],
    ...Object.entries(amountInputs).filter(([id]) => id !== actionSetup?.id).map(([id, value]) => {
      const index = orderedActions.findIndex(node => node.nodeId === id), node = orderedActions[index];
      const card = node ? composerSummary(state.workflow, node, context) : null;
      const selection = cryptoSelections[id], symbol = selection?.from ?? card?.amount.split(' ').slice(1).join(' ');
      return { nodeId: id, step: index + 1, action: card?.action ?? 'Action', value: `${value}${symbol ? ` ${symbol}` : ''}`,
        draft: actionReviewValue(null, id, value, bridgeNetworkInputs[id], selection, recipientInputs[id]) };
    })];
  const resolveEdit = (nodeId: string, apply: boolean): string | null => {
    if (!pendingEdits.some(edit => edit.nodeId === nodeId)) return 'This edit is no longer pending.';
    if (apply) return commitCanvasAmount(nodeId);
    if (actionSetup?.id === nodeId) removeActionSetup(); else cancelCanvasAmount(nodeId);
    return null;
  };
  // Any sign that part of this workflow ran or may have run: a live or started execution, a sequence step done or restored, a whole-workflow run,
  // or actions already executed. The footer and the chat's blocker explanation then never say "Nothing was sent".
  const workflowStarted = Boolean(currentExecution(executionProgress)) || executionProgress.started || executionStart.started || localSequenceStarted
    || Boolean(sequenceRestore) || Boolean(sequence && (sequence.completed.length > 0 || sequence.finished)) || Boolean(workflowRunHere.run || workflowRunHere.started)
    || executedActions.executed > 0;
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
    return { title: presented.label, message: simulationReason ?? presented.message, owner: reviewBinding.wallet.account, feeShortfall: null, started: workflowStarted,
      messageIn: (shown: 'EN' | 'PT') => simulationReasonIn(shown) ?? translate(shown, presented.message) };
  })();
  const liveExecution = currentExecution(executionProgress);
  // BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the execution the Canvas cards show, from the records this shell already follows — the whole-workflow
  // run this tab authorized for this exact workflow revision, else the step-by-step sequence, else the current runtime's lifecycle. No request is
  // made for it; a record of another workflow or revision colors nothing (`domain/canvas-execution.ts`). Kept by value, so the cards re-render only
  // when a step's state changes.
  const ownWorkflowRun = workflowRunHere.started ? workflowRunHere.run : null;
  const canvasExecutionShown = shellCanvasExecution(state.workflow, { run: ownWorkflowRun, order: ownWorkflowRun ? sequenceOrder(state.workflow) : [],
    authorizedFor: workflowRunHere.authorizedFor, unrecorded: workflowRunHere.unrecorded, sequence, live: liveExecution });
  // Execution UX regression fixes: a single card's reconciled whole-workflow run shows the amount the run proved delivered on the card, in place of
  // the estimate from before execution (the per-card flows carry it from their own evidence, `lifecycleNodeExecution`).
  const singleNode = soleAction.length === 1 ? soleAction[0]! : null, singleOutput = singleNode ? stepAssets(singleNode).output : null;
  const singleReceived = groupedSingleDelivered && singleOutput ? simulationAmount(groupedSingleDelivered, singleOutput.decimals) : null;
  const singleShown = singleNode ? canvasExecutionShown?.nodes[singleNode.nodeId] : undefined;
  const canvasExecutionNow = canvasExecutionShown && singleNode && singleShown && singleReceived && singleShown.visual === 'done' && canvasExecutionShown.key.startsWith('run:')
    ? { ...canvasExecutionShown, nodes: { ...canvasExecutionShown.nodes, [singleNode.nodeId]: { ...singleShown,
      received: { amount: singleReceived, unit: null, label: stepAssets(singleNode).ownerReceives ? 'You received' as const : 'Delivered' as const } } } } : canvasExecutionShown;
  const canvasExecutionKey = canvasExecutionNow ? JSON.stringify(canvasExecutionNow) : null;
  const canvasExecution = useMemo(() => canvasExecutionNow, [canvasExecutionKey]);
  // Locked while the wallet is being asked (every prompting phase, the first Authorize included) or while this workflow's own run is open and
  // moving (PENDING / RUNNING / ATTENTION) or HALTED and still resumable (Resume runs the reviewed workflow, so the Canvas must not drift from it),
  // read from the run itself — never a phase left behind once it ended. A final run never locks it. The
  // chat's edits follow the same lock (`editingPaused` on the conversation bridge).
  const runOpen = Boolean(workflowRunHere.run && (['PENDING', 'RUNNING', 'ATTENTION'].includes(workflowRunHere.run.state)
    || workflowRunHere.run.state === 'HALTED' && workflowRunHere.run.resumable === true));
  // Final workflow review: this workflow's own run, stored in this browser but not loaded yet (before its first status read, or until the owner signs in
  // again), also locks it: an edit then could never be reconciled with what the run executed. "Forget this workflow in this browser" releases it.
  const runUnloaded = workflowRunHere.started && workflowRunHere.unloaded;
  const editingPaused = Boolean(['authorizing', 'proving', 'wallet', 'confirming', 'confirm-update'].includes(workflowRunHere.phase) || runOpen
    || runUnloaded || liveExecution && !isFinalExecutionResult(liveExecution));
  // BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (EXEC-02): while editing is paused, the Canvas header states the execution's own status (from the same
  // authoritative lifecycle Execute and the Assistant read), never the authoring state that invites a new simulation.
  const canvasRunStatus = !editingPaused ? null : liveExecution && !isFinalExecutionResult(liveExecution) ? liveExecution.label
    : ['authorizing', 'proving', 'wallet', 'confirming', 'confirm-update'].includes(workflowRunHere.phase) ? 'Waiting for your authorization'
    : workflowRunHere.run && ['ATTENTION', 'HALTED'].includes(workflowRunHere.run.state) ? 'Execution needs attention'
    // Before its first status read answers: loading; once a read could not load it (e.g. the sign-in expired): what the run panel offers.
    : runUnloaded ? workflowRunHere.error ? 'Load workflow progress' : 'Loading…' : 'Execution in progress';
  const conversation = useFlofiConversation({ owner, epoch: workflowEpoch, direct: !approvalSlot && !autoPrepare && surface === 'workspace',
    interfaceLanguage: language === 'PT' ? 'PT' : 'EN',
    // HOTFIX-P1-CHAT-RECOVERY: where the Editor keeps its Canvas (/app), this tab also keeps the signed-in account's conversation per workflow.
    persist: editorPersistencePath(pathname), accountScope: conversationScope,
    // The chat reviews, confirms and follows the workflow its runtime serves (a sequence's current step); it edits the canonical workflow itself.
    bridge: { workflow: runtimeWorkflow, context, source: simulationSource, authorization, wallet: reviewBinding.wallet, progress: executionProgress,
      invalidWorkflow: lifecycleState.invalidWorkflow, simulate: simulateAgain, controls: lifecycleControls, networkAction, sequence: sequencePresentation,
      // FIX-07: the same invariant as the auto-continue effect — these runtimes' simulations may open a wallet request, so only the owner starts them.
      manualSimulation: simulationSource.kind === 'universal' || (simulationSource.kind === 'router' && !routerState.session),
      // BUILD-FLOFI-SECURITY-0016-WALLET-RECOVERY-001: the destination's wallets are still being read (the chat waits and resumes by itself).
      destinationLoading,
      destinationWalletAction: destinationActions ? { ...destinationActions.connect, retry: destinationActions.retry } : null,
      pendingEdits, resolveEdit, runtimeChecking, walletNetwork: reviewBinding.wallet.chain ? shellChainLabel(reviewBinding.wallet.chain) : null, networkError: walletConnection.error, networkErrorNotice: walletConnection.notice,
      simulationBlocked: walletIssue ?? (groupedPrimary ? workflowRunHere.started ? 'This workflow runs as one workflow run: follow it in Execute.'
        : 'This workflow runs as one workflow run: choose Simulate workflow, then Continue to authorization and Execute workflow.'
        : simulationDisabled || !actionable || lifecycleState.invalidWorkflow ? conversationDestinationIssue
          ?? simulationReason ?? 'Simulation is not available for this workflow.' : null),
      // P0 hotfix (locale contract): the same reason in either language, so the chat's message follows the interface language.
      simulationBlockedIn: shown => walletIssueIn(shown) ?? (groupedPrimary ? translate(shown, workflowRunHere.started ? 'This workflow runs as one workflow run: follow it in Execute.'
        : 'This workflow runs as one workflow run: choose Simulate workflow, then Continue to authorization and Execute workflow.')
        : simulationDisabled || !actionable || lifecycleState.invalidWorkflow ? destinationIssueIn(shown, 'approve-embedded')
          ?? simulationReasonIn(shown) ?? translate(shown, 'Simulation is not available for this workflow.') : null),
      connectWallet: () => void walletConnection.connect(), startNewWorkflow, executedActions, continuable: Boolean(sequence?.finished) || actionDone || groupedSingleDone, blocker: blockerView, editingPaused,
      workflowProgress } });
  // BUILD-FLOFI-CHAT-E2E-FIX-002: the public chat-first workspace presents the Review and progress in the chat; Simulate and Execute show the canvas
  // beside it, with their summaries in an optional details surface (approval surfaces and the engineering workspace keep their side panels).
  const chatFirst = conversation.direct && !engineering;
  // Board 06: in the chat-first Editor, Execute before anything is authorized shows the whole-workflow Review as the one block beside the cards,
  // with its ONE primary action in the Editor footer (the Review's own Review/Authorize when the whole-workflow path is primary, else the
  // step-by-step path's lifecycle action without its caption). Presentation only: the same handlers, gates and wallet requests as before.
  const reviewBlock = Boolean(chatFirst && tab === 'Execute' && groupedShown && !workflowRunHere.run && !workflowRunHere.started
    && !workflowRunHere.unloaded && (workflowRunHere.review || workflowRunHere.canReview)
    && !liveExecution && !executionProgress.started && !executionStart.started && !(groupedPrimary ? null : executeContinuation));
  // BUILD-FLOFI-BUILDER-UX-002 (owner-approved Editor brief): one live summary of the real workflow (steps and their status, networks, state, what needs
  // attention) for the Canvas header, the FloFi panel and the footer. "Show step" selects the card and brings it into view; nothing is edited.
  // Computed for the Editor's Canvas only (no other surface shows it); a refused edit or a failed review is always surfaced as such.
  const overviewShown = tab === 'Build' && surface === 'workspace';
  const overview = useMemo(() => overviewShown ? editorOverview(state.workflow, context, workflowReview,
    { setup: actionSetup ? { id: actionSetup.id, action: setupSummary(actionSetup, context).action } : null, amountInputs, cryptoSelections, bridgeNetworkInputs, recipientInputs },
    Boolean(state.error || reviewError)) : EMPTY_EDITOR_OVERVIEW,
  [overviewShown, state.workflow, state.error, reviewError, context, workflowReview, actionSetup, amountInputs, cryptoSelections, bridgeNetworkInputs, recipientInputs]);
  // UX-02: the Simulate and Execute headers name the same networks as the Create header (the configured steps' own networks; presentation only).
  const headNetworks = useMemo(() => overviewShown ? overview.networks : editorOverview(state.workflow, context, null).networks, [overviewShown, overview, state.workflow, context]);
  const showStep = (nodeId: string) => { selectAction(nodeId); focusCanvasStep(nodeId); };
  // BUILD-FLOFI-UX-EDITOR-FINOPS-001 (C2): the Review's validity ends at a known time; the Editor re-renders then, so Execute, its footer and the
  // Assistant say "expired" at once (the panels keep their own timers too). Never a request: only this render.
  const reviewUntil = groupedPrimary ? workflowRunHere.review?.validUntil ? Date.parse(workflowRunHere.review.validUntil) : null : lifecycleControls.view.expiresAt;
  const [, setReviewClock] = useState(0);
  useEffect(() => {
    if (reviewUntil === null || !Number.isFinite(reviewUntil) || reviewUntil <= Date.now()) return;
    const timer = window.setTimeout(() => setReviewClock(Date.now()), Math.min(reviewUntil - Date.now() + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(timer);
  }, [reviewUntil]);
  // Section 10 (Assistant): the same conversation on every stage, its composer and one local hint worded for the stage — help building (Create),
  // understanding results, costs and warnings (Simulate), authorization, status and blockers (Execute). Presentation only: nothing is sent,
  // stored or added to the conversation, and the workflow is never changed by it.
  const reviewExpiredHere = tab === 'Execute' && chatFirst && (groupedPrimary ? Boolean(reviewBlock && workflowRunHere.review && groupedReviewExpired)
    : Boolean(authorization.key && !liveExecution && lifecycleControls.view.authorizationLabel === 'Expired'));
  const assistantStage = tab === 'Simulate' ? { placeholder: 'Ask about results and costs', note: null }
    : tab === 'Execute' ? { placeholder: 'Ask about this authorization',
      note: reviewExpiredHere ? 'Your review expired. Refresh the values to continue safely. Your workflow is still saved.' : null }
    : { placeholder: undefined, note: null };
  const chat = <CopilotPanel conversation={conversation} interactive={interactive} owner={owner} proof={proof} reviewInPanel={reviewBlock && groupedPrimary}
    placeholder={assistantStage.placeholder} stageNote={assistantStage.note}
    overview={tab === 'Build' && chatFirst ? <EditorOverviewPanel overview={overview} showStep={showStep}/> : undefined}/>;
  // BUILD0-UX-001: a workflow restored or reopened, a run recovered from this browser, a live execution, a proposal or an unfinished Canvas card
  // is never held behind the entry the visit landed on: once the persisted-run read settles, the shell opens Build 1 (the stages keep their own
  // records and gates). A request the owner is typing in Build 0 is never discarded: the entry stays, naming the workflow it would add to.
  const entryFresh = buildEntryFresh({ workflow: state.workflow, restorationEpoch, authoringIncomplete, executionSurface: Boolean(executionSurface),
    execution: Boolean(currentExecution(executionProgress)) || executionProgress.started || executionStart.started, proposal: Boolean(proposal) });
  const canvasReady = !isPristineDraft(state.workflow) || !canvasRestoring;
  if (tab === BUILD_ENTRY && section === null && !entryFresh && canvasReady && !entryDraft.trim() && !conversation.busy) setSection('Build');
  // Every shell that calls `simulateAgain` (the workspace and the /approve signing surface) states a Flight refusal the run keeps its words over.
  const flightHref = flightNotice ? FLIGHT_REFUSAL_HREF[flightNotice.action] : null;
  const flightNoticeView = flightNotice && <div className="error-banner flight-run-notice" role="alert"><strong>{tr(flightNotice.title)}</strong>
    <span>{tr(flightNotice.message)}{/already sent stays tracked/.test(flightNotice.message) ? null : <> {tr('Anything already sent stays tracked.')}</>}</span>
    {flightHref && <a className="secondary" href={flightHref} {...surface === 'signing' ? { target: '_blank', rel: 'noopener noreferrer' } : {}}>
      {tr(flightNotice.action === 'LINK_WALLET' ? 'Open Credentials' : flightNotice.action === 'SIGN_IN' ? 'Sign in' : 'Open Board')}</a>}</div>;
  const entry = chatFirst;
  if (surface === 'signing') return <div className="app-shell signing-shell" inert={!interactive}><a className="skip-link" href="#workspace">{tr("Skip to workspace")}</a>
    <TopBar compact tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering}/>
    {flightNoticeView}
    <SigningSurface {...lifecycleState} controls={lifecycleControls} workflowName={workflowName} simulate={simulateAgain} simulationDisabled={simulationDisabled || !actionable}
      simulationReason={simulationReason} destinationIssue={destinationBlocked} destinationLoading={Boolean(destinationLoading)} destinationActions={destinationActions}
      gated={approvalGate} walletIssue={walletIssue} networkAction={networkAction} walletRequestError={walletConnection.notice ? tr(...walletConnection.notice) : null} connectWallet={() => void walletConnection.connect()} approvalSlot={approvalSlot} onViewInFloFi={onViewInFloFi}
      startNewWorkflow={navigate ? () => { startNewWorkflow(); navigate('/app'); } : undefined}/>
  </div>;
  if (secondaryRoute) return <div className="app-shell" inert={!interactive}><a className="skip-link" href="#workspace">{tr("Skip to workspace")}</a><TopBar tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering} entry={entry} newWorkflow={startNewChatWorkflow}/>{betaNotice}
    <main id="workspace" className="main secondary-workspace" tabIndex={-1} aria-label={tr('{0} workspace', tr(secondaryRoute.label))}><SecondaryProductWorkspace workspace={secondaryRoute.id} workflows={{ ...workflows, loading: library.loading, connected: Boolean(owner), restoring: walletRestoring, verification: owner && library.error === 'WALLET_SESSION_REQUIRED' ? <WorkflowVerification namespace={owner.namespace} account={owner.address} proof={proof}/> : undefined,
      // BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the execution history moved here from the Dashboard (same records, same server-checked actions).
      records: secondaryRoute.id === 'workflows' && owner ? <DashboardWorkspace mode="records" workflowName={workflowName} progress={executionProgress} recovery={executionProgress.recovery} workflowProgress={workflowProgress}
        wallet={{ ...reviewBinding.wallet, account: owner.address }} context={context} runId={null} build={() => setTab('Build')} execute={() => setTab('Execute')} navigate={navigate ?? (() => undefined)}
        openWorkflow={{ names: new Map(library.list?.items.map(item => [item.workflowId, item.name] as const) ?? []), open: id => { void reopenWorkflow(id); } }} signInPrompt={library.error === 'WALLET_SESSION_REQUIRED'}/> : undefined }}
      automations={{ owner, restoring: walletRestoring, proof, openChat: () => setTab(BUILD_ENTRY), onPropose: command => { propose(command); setTab('Build'); },
        canvas: automateCanvas ? { workflow: state.workflow, name: workflowName, dismiss: () => setAutomateCanvas(false) } : null }}/>
</main>
  </div>;
  if (tab === 'Dashboard') return <div className="app-shell" inert={!interactive}><a className="skip-link" href="#workspace">{tr("Skip to workspace")}</a><TopBar tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering} entry={entry} newWorkflow={startNewChatWorkflow}/>{betaNotice}
    <main id="workspace" className="main" tabIndex={-1} aria-label={tr("Dashboard")}><DashboardWorkspace workflowName={workflowName} progress={executionProgress} recovery={executionProgress.recovery} wallet={reviewBinding.wallet} context={context} restoring={walletRestoring}
      workflowProgress={workflowProgress} runId={dashboardRoute?.runId ?? null} portfolio={<PortfolioWidget evm={connectedWallet.account} solana={solanaSession?.account.address ?? null}/>}
      positions={<DefiPositions evm={connectedWallet.account} solana={solanaSession?.account.address ?? null} prepare={prepareLiquidityPosition}/>}
      build={() => setTab('Build')} execute={() => setTab('Execute')} navigate={navigate ?? (() => undefined)} create={entry ? startNewChatWorkflow : undefined}/></main>
  </div>;
  // BUILD0-UX-001: Build 0 has no Canvas, chat panel or summary bar; its request continues in the same conversation, shown in Build 1.
  // BUILD-FLOFI-CHAT-EDITOR-UX-001: Build 0 is presented as Chat and Build 1 as the Editor; this section and its continuation are unchanged.
  if (tab === BUILD_ENTRY) return <div className="app-shell" inert={!interactive}><a className="skip-link" href="#workspace">{tr("Skip to workspace")}</a><TopBar tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering} entry={entry} newWorkflow={startNewChatWorkflow}/>{betaNotice}
    <AutomationInbox owner={owner} proven={Boolean(owner && proof.proven === owner.address)} open={() => navigate?.('/app/automations')}/>
    <main id="workspace" className="main build-entry-workspace" tabIndex={-1} aria-label={tr('Chat')}>
      <p className="editor-restore-status" role="status">{tr('Loading…')}</p>
      <BuildEntry conversation={conversation} workflow={state.workflow} proposal={proposal} actions={orderedActions.length} draft={entryDraft} setDraft={setEntryDraft}
        interactive={interactive} openBuilder={() => setTab('Build')}/>
    </main>
  </div>;
  // P0 approved UX (board 03b): Simulate and Execute close whenever the shell refuses them; same targets and refusals as before.
  const networkQuestion = chatFirst && networkQuestionPending(conversation.messages);
  // BUILD-FLOFI-UX-EDITOR-FINOPS-001 (Caio, section 03): a future stage stays unavailable until its own validation is met, in the public Editor.
  // Simulate needs an action to simulate. Execute needs a simulation or Review of this workflow — valid or expired (an expired Review is shown in
  // Execute) — or any record that something ran, may have run or must be recovered: that evidence always keeps Execute reachable (fail open).
  // Navigation only: every lifecycle action still opens its own stage, and each stage keeps its own simulation, Review, wallet and execution gates.
  const stageSignals = {
    started: workflowStarted, reviewed: Boolean(authorization.key), beyond: ['approve', 'execute', 'continue', 'recover'].includes(canvasAction.kind),
    run: Boolean(workflowRunHere.review || workflowRunHere.run || workflowRunHere.unloaded || workflowRunHere.started),
    sequence: sequenceContinuing || sequenceFinishedIdle || Boolean(sequenceRestore), recovery: recoveryPath, cow: localCowIntent,
    // A recovery projection always exists (a local runtime even names its network as a context issue); only a recovery action — set for a started
    // execution — is evidence of a record to recover.
    live: Boolean(liveExecution), recoveryRecord: Boolean(executionProgress.recovery?.action),
    // A record that keeps its own words (recovery only, or a status that needs attention) is evidence too, whatever its runtime.
    attention: Boolean(sourceState.recoveryOnly) || recordNeedsAttention(sourceState.record) };
  const stageReasons = chatFirst ? editorStageReasons({ actionable, reviewed: stageSignals.reviewed || stageSignals.run, lifecycleBeyondSimulation: stageSignals.beyond,
    executionEvidence: stageSignals.started || stageSignals.sequence || stageSignals.recovery || stageSignals.cow || stageSignals.live || stageSignals.recoveryRecord
      || stageSignals.attention }) : undefined;
  const editorStepper = <EditorStepper tab={tab} setTab={setTab} disabled={Boolean(authoringIncomplete || approvalGate || networkQuestion && !actionable)} incomplete={Boolean(authoringIncomplete)}
    closedReason={networkQuestion && !actionable ? 'Choose the network in the chat first' : null} stageReasons={stageReasons}/>;
  // BUILD-FLOFI-UX-EDITOR-FINOPS-001: the stage indicator lives in the Editor's own header (`editor-chrome.tsx`), never in the global top bar.
  if (authoringIncomplete && tab !== 'Build') return <div className="app-shell" inert={!interactive}><TopBar tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering} entry={entry}
    newWorkflow={startNewChatWorkflow}/>{betaNotice}<main className="main"><EditorChromeProvider value={{ stepper: <EditorStepper tab={tab} setTab={setTab} disabled incomplete/>, networks: headNetworks, rename: setWorkflowName }}>
      <EditorStageHead workflowName={workflowName} steps={orderedActions.length}/></EditorChromeProvider>
    <section className="panel stage-empty"><p>{tr("Configure the action amount on the Canvas first.")}</p><button type="button" onClick={() => setTab('Build')}>{tr("Return to the Canvas")}</button></section></main></div>;
  // P0 approved UX (board 08): while this workflow's execution is live (not final), the Canvas shows "Editing paused during execution" (the shell
  // already refuses edits then; this makes it visible). Read from the execution records, never a timer.
  const stageContent = tab === 'Build' ? <><div className="build-grid"><WorkflowCanvas runActive={editingPaused} runStatus={canvasRunStatus} execution={canvasExecution} estimateOwner={solanaSession?.account.address} environment={authoringEnvironment(walletEnvironment)} selectedId={selectedId} select={selectAction} openSettings={openActionSettings} settingsId={settingsId} workflowName={workflowName} renameWorkflow={setWorkflowName} onNewWorkflow={startNewWorkflow} onAutomate={automationsReady ? () => { setAutomateCanvas(true); navigate?.('/app/automations'); } : undefined} onSave={() => void saveCurrentWorkflow()} onToolboxModeChange={setWorkspaceToolboxMode} overview={overview}/>{chat}</div>{verification}{saveNotice?.owner === ownerKey && <p role="status">{tr(saveNotice.message)}</p>}{library.busy && <p role="status">{tr('Saving workflow…')}</p>}{library.error && library.error !== 'WALLET_SESSION_REQUIRED' && <p role="alert">{tr(library.error === 'WORKFLOW_VERSION_CONFLICT' ? 'This workflow was updated in another session. Reopen it before saving.' : 'Workflow saving is unavailable. Try again.')}</p>}{selectedId && !editingPaused && <ActionSettingsPopover key={selectedId} selectedId={selectedId} select={selectAction} open={settingsId === selectedId} close={closeActionSettings}/>}
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
  // P0 approved UX (board 06/07): the Simulate footer states the validity countdown or the blocker from the same projection the panel shows.
  const footerSimulation = (() => {
    const view = projectSimulation(runtimeWorkflow, context, simulationSource);
    const label = simulationStatusPresentation(view, Boolean(reviewError), simulationSource.state.busy).label;
    return { busy: Boolean(simulationSource.state.busy), status: view.status, label, expiresAt: view.expiresAt, networkQuestion,
      executionStarted: workflowStarted, subject: tab === 'Simulate' && label === 'Pool quote' ? 'quote' as const : 'simulation' as const };
  })();
  // Board 06: on the Review before authorization the footer states the whole-workflow Review's validity (its batch simulation) or that it was
  // refused; the step-by-step path keeps its own simulation's status.
  const runReviewed = workflowRunHere.review;
  const reviewFooter = { busy: workflowRunHere.phase === 'reviewing', status: runReviewed?.refusal ? 'blocked' as const : 'ready' as const,
    label: runReviewed?.refusal?.evidence ? 'Not enough ETH for the network fee' : 'This workflow cannot be authorized yet',
    expiresAt: runReviewed?.validUntil && Number.isFinite(Date.parse(runReviewed.validUntil)) ? Date.parse(runReviewed.validUntil) : null, executionStarted: workflowStarted,
    subject: 'review' as const };
  // BUILD-FLOFI-UX-EDITOR-FINOPS-001 (B2): on Simulate the whole-workflow path's footer states its simulation (the same Review), never authorization.
  const groupedSimulationFooter = { ...reviewFooter, status: runReviewed?.refusal || !runReviewed && workflowRunHere.error ? 'blocked' as const : 'ready' as const,
    label: runReviewed?.refusal?.evidence ? 'Not enough ETH for the network fee' : 'Simulation blocked', subject: 'simulation' as const };
  // C1/C2: on Execute the same lifecycle actions read as the Review the owner authorizes or refreshes. "Execute workflow" (execution UX regression
  // fixes: formerly "Authorize workflow"; the click still opens the reviewed wallet authorization, nothing more) only where that
  // Review covers the whole workflow (one action, nothing running); a step of a confirm-each-step sequence or a request of a run in progress keeps
  // "Authorize in wallet" (the whole workflow is never claimed in those modes). "Simulate again" before anything runs reads "Refresh review".
  const wholeWorkflowReview = !sequence && !liveExecution;
  const executeLabel = (action: CanvasAction) => (action.kind === 'approve' || action.kind === 'execute') ? wholeWorkflowReview ? 'Execute workflow' : action.label
    : action.kind === 'simulate' && action.label === 'Simulate again' && !liveExecution ? 'Refresh review' : action.label;
  const reviewFooterAction = groupedPrimary ? <EditorWorkflowRunPrimaryAction state={workflowRunHere}/> : simulateActionFor(null, { stay: true, inExecute: true, labelFor: executeLabel });
  // B2: Simulate's ONE primary action is inside its panel until the simulation is valid; then the footer's "Review operation" opens Execute (no
  // authorization from Simulate). A wallet, network or restore control the lifecycle needs first stays in the panel too.
  const simulatePanelAction = groupedPrimary ? <EditorWorkflowSimulateAction state={workflowRunHere} disabled={Boolean(authoringIncomplete || networkQuestion && !actionable)}
      reason={authoringIncomplete ? 'Configure the action amount on the Canvas first' : null}/>
    : sequenceRestore || walletIssue || networkAction || canvasAction.kind === 'simulate' || simulationSource.state.busy ? simulateActionFor(null) : null;
  const simulationReady = groupedPrimary ? Boolean(runReviewed && workflowRunHere.grouped && !groupedReviewExpired && workflowRunHere.phase !== 'reviewing')
    : !simulationSource.state.busy && (canvasAction.kind === 'approve' || canvasAction.kind === 'execute');
  const executionUnderway = groupedPrimary ? groupedRunOpen || Boolean(workflowRunHere.run || workflowRunHere.unloaded)
    : Boolean(liveExecution || executionProgress.started || executionStart.started || sequenceContinuing || sequenceFinishedIdle || sequenceRestore);
  // UX-05 (owner guidelines of 21-11-2026): ONE primary action per moment, in the panel the owner reads — "Simulate workflow" before a result,
  // then "Continue to authorization" once it is valid (or "Open workflow progress" for a run already started). It only opens Execute, where the
  // mandatory Review is shown and "Authorize" asks the wallet after an explicit click; the Simulate footer then states the status only.
  const continueToAuthorization = simulationReady || executionUnderway ? <button type="button" className="primary editor-review-operation editor-continue-authorization" data-lifecycle-action="review-operation"
    onClick={() => setTab('Execute')}>{tr(executionUnderway && (groupedPrimary || !simulationReady) ? 'Open workflow progress' : 'Continue to authorization')}<span aria-hidden="true">{' →'}</span></button> : null;
  // C1/C2 (Execute): the one primary action sits in the Editor footer whenever Execute shows the Canvas; a step continuing in place and an
  // execution followed on its timeline keep their own action beside what they describe (never two of them).
  const executeContinuationShown = groupedPrimary ? null : executeContinuation;
  const placement = executeActionPlacement({ live: lifecycleControls.live, canvasExecution, continuation: executeContinuationShown });
  const executeFooterAction = groupedPrimary ? reviewBlock ? reviewFooterAction : null
    : placement !== 'footer' ? null
    : reviewBlock ? reviewFooterAction
    : sequenceFinishedIdle ? <button type="button" className="primary execute-new-workflow" onClick={startNewWorkflow}>{tr('Create new workflow')}</button>
    : inlineExecute && !sequenceRestore && !walletIssue && !networkAction ? executeWalletAction ?? <CanvasLifecycleAction {...lifecycleState} controls={lifecycleControls} workflowName={workflowName}
      simulationDisabled={simulationDisabled || !actionable || sequenceDone} simulationReason={sequenceDoneReason ?? simulationReason} simulate={() => simulateAgain()} onExecute={() => setTab('Execute')} labelFor={executeLabel}/>
    : simulateActionFor(null, { stay: Boolean(authorization.key) || canvasAction.label === 'Simulate again', inExecute: true, labelFor: executeLabel });
  // C1/C2 (step-by-step and single-action path): the Review the owner authorizes, before any execution exists, at the top of the status panel.
  // It is shown whenever a Review of this step can be accepted (also while a run continues, e.g. a Review refreshed in place, and beside the
  // whole-workflow block of a step-by-step workflow), so the Review accepted is always the one on screen.
  const executeReview = chatFirst && !groupedPrimary && authorization.key && !executeContinuationShown
    && (!liveExecution || canvasAction.kind === 'approve' || canvasAction.kind === 'execute')
    ? <ReviewSummaryPanel stage="execute" canvasWorkflow={state.workflow} workflow={runtimeWorkflow} context={context} source={simulationSource} authorization={authorization} wallet={reviewBinding.wallet}
      invalidWorkflow={Boolean(reviewError)} unavailableReason={simulationReason} sequenceNote={sequenceNote}
      technical={lifecycleControls.view.authorizationLabel === 'Expired' ? undefined
        : <SimulationSummary workflow={runtimeWorkflow} context={context} source={simulationSource} invalidWorkflow={Boolean(reviewError)} unavailableReason={simulationReason}/>}/> : null;
  // The Execute footer's status: the live execution's own state (never a timer), else the Review's validity, else the simulation's status.
  const liveTone = (state: string): FooterStatus['tone'] => state === 'complete' ? 'ready' : state === 'active' ? 'neutral' : state === 'uncertain' || state === 'attention' ? 'attention' : 'blocked';
  const executeStatus: FooterStatus | null = liveExecution ? { tone: liveTone(liveExecution.state), text: liveExecution.label }
    : groupedPrimary && !reviewBlock && canvasRunStatus ? { tone: /attention/i.test(canvasRunStatus) ? 'attention' : 'neutral', text: canvasRunStatus } : null;
  const executeSimulation = groupedPrimary ? reviewBlock ? reviewFooter : undefined : liveExecution ? undefined : authorization.key ? { ...footerSimulation, subject: 'review' as const } : footerSimulation;
  // Create never hosts an authorization (no authorization language there): once this step's simulation is valid, or a run is in progress, its one
  // action opens Execute instead; Simulate, its processing state and every prerequisite control stay as before.
  const createNavigation = chatFirst && !groupedPrimary && !simulationSource.state.busy && !sequenceRestore && !walletIssue && !networkAction
    && ['approve', 'execute', 'continue', 'recover'].includes(canvasAction.kind);
  // A step of a confirm-each-step workflow keeps its note beside the action (as on main): a step's result never reads as the whole workflow's.
  const createAction = createNavigation ? <div className="canvas-lifecycle-control">
      {sequenceNote && <p className="canvas-sequence-note" role="note">{sequenceNote}</p>}
      <button type="button" className="primary editor-review-operation" data-lifecycle-action="review-operation" onClick={() => setTab('Execute')}>
        {tr(canvasAction.kind === 'approve' || canvasAction.kind === 'execute' ? 'Review operation' : 'Open workflow progress')}<span aria-hidden="true">{' →'}</span></button></div>
    : simulateActionFor(sequenceNote);
  const footerAction = tab === 'Execute' ? chatFirst ? executeFooterAction : reviewBlock ? reviewFooterAction : undefined
    : tab === 'Build' ? createAction : undefined;
  const footerStatusSource = !chatFirst ? undefined : tab === 'Execute' ? executeSimulation : tab === 'Simulate' && groupedPrimary ? groupedSimulationFooter : footerSimulation;
  return <EstimateOwnersContext.Provider value={estimateOwners}><EditorChromeProvider value={{ stepper: editorStepper, networks: headNetworks, rename: setWorkflowName }}><div className="app-shell" inert={!interactive}><a className="skip-link" href="#workspace">{tr("Skip to workspace")}</a><TopBar tab={tab} setTab={setTab} pathname={pathname ?? null} engineering={engineering} entry={entry} newWorkflow={startNewChatWorkflow}/>{betaNotice}
    {approvalSlot && <div className="approval-notice-slot" ref={approvalSlot}/>}
    {/* Execution UX regression fixes: no previous-workflow banner here. Previous and ongoing executions are in My Workflows (and the Dashboard);
        their records keep being reconciled server-side, and a run of the shown workflow is followed in place. */}
    {flightNoticeView}
    <AutomationInbox owner={owner} proven={Boolean(owner && proof.proven === owner.address)} open={() => navigate?.('/app/automations')}/>
    {/* BUILD-FLOFI-CONVERSATIONAL-001: on Simulate and Execute the same conversation continues beside the stage (complementary to main). */}
    {wrapStage(<main id="workspace" className={`main workflow-workspace${tab === 'Build' ? ' build-workspace' : ''}`} data-workspace-toolbox={tab === 'Build' ? workspaceToolboxMode : undefined} tabIndex={-1} aria-label={tr(tab === 'Build' ? 'Workflow workspace' : tab === 'Simulate' ? 'Simulation workspace' : 'Execution workspace')}>
      {tab === 'Build' && surface === 'workspace' && !approvalSlot && !approvalGate && <PublishedStudioMetadata/>}
      {tab === 'Execute' ? <ExecuteWorkspace detailsOnly={chatFirst} controls={lifecycleControls} groupedRun={groupedPrimary} reviewBlock={reviewBlock} canvasExecution={canvasExecution}
        primaryAction={groupedPrimary ? <button type="button" className="simulation-back" onClick={() => setTab('Build')}>{tr('Back to the Canvas')}</button> : executeAction}
        actionInFooter={chatFirst && !groupedPrimary && placement === 'footer'} review={executeReview}
        workflowProgress={workflowProgress} continuation={executeContinuationShown} workflowName={workflowName} workflow={runtimeWorkflow} context={context} source={simulationSource} authorization={authorization} wallet={reviewBinding.wallet} execution={executionStart} progress={executionProgress} recovery={executionProgress.recovery} invalidWorkflow={Boolean(reviewError || authoringIncomplete)} backToBuild={() => setTab('Build')} backToSimulate={() => setTab('Simulate')} startNewWorkflow={startNewWorkflow} openDashboard={() => setTab('Dashboard')}
        workflowRun={groupedShown ? <EditorWorkflowRunPanel state={workflowRunHere} actionsOutside={reviewBlock && groupedPrimary} summary={<OperationSummary workflow={state.workflow} context={context}/>}
          facts={<WorkflowTechnicalFacts workflow={state.workflow} context={context}/>}/>
          : editorRun.offered ? <EditorRunAction workflow={state.workflow} readiness={editorRun} steps={sequence?.steps.length ?? 0}/> : undefined}
        technicalDetails={engineering && (executionStart.started || executionProgress.started || recoveryPath || localCowIntent) ? stageContent : undefined}/> : tab === 'Simulate' ?
        <SimulateWorkspace detailsOnly={chatFirst} sequenceNote={sequenceNote} workflowName={workflowName} returnToBuild={chatFirst ? undefined : () => setTab('Build')} simulationSource={simulationSource} simulationReason={simulationReason} review={embeddedReview}
          simulateAction={chatFirst ? undefined : simulateAction}
          panelLabel={groupedPrimary ? runReviewed && !groupedReviewExpired && !runReviewed.refusal ? 'Simulation result' : 'Workflow simulation'
            : footerSimulation.subject === 'quote' ? 'Pool quote' : canvasAction.kind === 'approve' || canvasAction.kind === 'execute' ? 'Simulation result' : 'Workflow simulation'}
          renderPanel={chatFirst ? technical => groupedPrimary
            ? <GroupedSimulationPanel state={workflowRunHere} canvasWorkflow={state.workflow} context={context} action={simulatePanelAction} next={continueToAuthorization}/>
            : <ReviewSummaryPanel stage="simulate" action={simulatePanelAction} next={continueToAuthorization} canvasWorkflow={state.workflow} workflow={runtimeWorkflow} context={context} source={simulationSource} authorization={authorization} wallet={reviewBinding.wallet}
            invalidWorkflow={Boolean(reviewError)} unavailableReason={simulationReason} sequenceNote={sequenceNote} technical={technical}/> : undefined}>
          {engineering && <details className="shell-details technical-workspace simulation-technical"><summary>{tr('View technical details')}</summary><ReviewTechnicalDetails authorization={authorization}/>{stageContent}</details>}
        </SimulateWorkspace> : stageContent}
      <MobileBuildNavigation stage={tab === 'Build' ? 'Build' : tab === 'Simulate' ? 'Simulate' : 'Execute'}/>
      {state.error && <div className="error-banner" role="alert"><strong>{tr("Edit not applied")}</strong><span>{tr(tab !== 'Build' ? 'Review the workflow configuration on the Canvas before simulating again.' : state.error)}</span></div>}
    </main>)}{/* BUILD-FLOFI-UX-EDITOR-FINOPS-001: one contextual footer on every stage of the public Editor (step count, the stage's status, ONE primary action). */}
    {(chatFirst || tab !== 'Execute' || reviewBlock) && <SummaryBar tab={tab} setTab={setTab} canvasOwnsAction primaryAction={footerAction ?? undefined} overview={overview} showStep={showStep}
      simulationBlocked={Boolean(walletIssue || simulationDisabled || !actionable || lifecycleState.invalidWorkflow)} simulation={footerStatusSource} networkQuestion={networkQuestion}
      statusOverride={tab === 'Execute' && chatFirst ? executeStatus : null} stageBar={chatFirst && tab === 'Simulate'}
      stageNote={tab === 'Simulate' && chatFirst && !simulationReady && !executionUnderway && (groupedPrimary ? !runReviewed && !workflowRunHere.error
        : footerSimulation.status !== 'blocked' && footerSimulation.expiresAt === null) ? 'After simulating, you can review the details and then execute.' : null}/>}
  </div></EditorChromeProvider></EstimateOwnersContext.Provider>;
}
