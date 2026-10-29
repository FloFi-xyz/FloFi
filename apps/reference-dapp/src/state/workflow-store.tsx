// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { routerDetails } from '../domain/router-authoring';
import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState, useMemo, type Dispatch, type ReactNode } from 'react';
import { BaseObservationError, createReviewContext, lintWorkflow, reviewContextForChain, type ReviewContext, type ReviewResult } from '@defi-workflow-engine/reference-linter';
import { editorReducer, type EditorState } from '../domain/editor';
import { editorHistoryReducer, initialEditorHistory } from '../domain/editor-history';
import { readCanvasLayout, saveCanvasLayout, type CanvasLayout } from '../domain/canvas-layout';
import { describeProposal } from '../domain/proposal';
import { activeNetworkScope, introducedTestNetworks, testNetworkMessage } from '../domain/network-scope';
import { chainReducer, checkChainAccess, initialChainState, type ChainState } from '../domain/artifact-chain';
import { generateMockedChain, generationEligibility, type Eligibility } from '../domain/mock-artifacts';
import type { Command } from '../domain/commands';
import type { Direction } from '../domain/swap-authoring';
import type { UniswapLiquidityInput } from '../domain/uniswap-liquidity-authoring';
import type {SemanticWorkflow} from '@defi-workflow-engine/workflow-contracts';
import { amountCommandTarget, canvasAmountCommand, canvasAmountMessage, canvasAuthoringIncomplete, type CanvasActionSetup, type CanvasAmountInputs, type CanvasBridgeNetworks, type CanvasBridgeNetworkInputs, type CanvasRecipientInputs } from '../domain/canvas-action-setup';
import { readBaseQuote } from '../app/observation-action';
import { browserFailureMessage, initialObservationState, observationReducer, receiveObservation, type ObservationState } from '../domain/base-observation';
import { actionReviewValue } from '../domain/canvas-action-setup';
import { createCryptoActionNode, type CryptoActionInput, type CryptoSelection, type CryptoSelections } from '../domain/crypto-action-picker';
import { boundAmount, boundProjection, stepNodeKey, validCompletions, workflowSequence, type CompletedStep, type SequenceStep, type WorkflowSequence } from '../domain/workflow-sequence';

type Pending = { valid: boolean; command: Command; diff: readonly string[]; review: ReviewResult | null; authoringId?: string; authoringAmount?: string };
type Store = { restorationEpoch: number; state: EditorState; dispatch: Dispatch<Command>; context: ReviewContext;
  cryptoSelections: CryptoSelections; editCryptoSelection(id: string, selection: CryptoSelection, beneficiary?: string): void;
  reviewCryptoPool(id: string, input: CryptoActionInput): string | null;
  actionSetup: CanvasActionSetup | null; amountInputs: CanvasAmountInputs; authoringIncomplete: boolean;
  bridgeNetworkInputs: CanvasBridgeNetworkInputs; editBridgeNetworks(id: string, patch: Partial<CanvasBridgeNetworks>): void;
  startActionSetup(action: CanvasActionSetup['action'], position: { x: number; y: number }, beneficiary?: string): string;
  /** BUILD-RH-002: the Stocks card, a Robinhood Chain catalog swap (USDG → Stock Token). */
  startStocksSetup(position: { x: number; y: number }): string;
  editCanvasAmount(id: string, amount: string): void; cancelCanvasAmount(id: string): void;
  /** UX-001: the Send card's "To" draft; Apply commits it to the transfer's canonical `recipient`. */
  recipientInputs: CanvasRecipientInputs; editCanvasRecipient(id: string, recipient: string): void;
  editPoolSetup(id: string, input: UniswapLiquidityInput): void;
  editSwapSetupDirection(id: string, direction: Direction): void;
  reviewCanvasAmount(id: string, poolInput?: UniswapLiquidityInput): string | null; removeActionSetup(): void;
  /**
   * BUILD-FIX-UX-001: apply the card's amount draft (with its draft token/network selection) to the editable workflow at once — the same
   * command and validation as `reviewCanvasAmount`, without a proposal step. Editing the draft is not authorization: the new revision
   * retires any simulation and Review, and execution still needs a fresh simulation, Strategy Manifest acceptance and wallet signature.
   * Returns the validation message, or null once applied.
   */
  commitCanvasAmount(id: string): string | null;
  restoreLendingCanvas(workflow:SemanticWorkflow):void; restoreSolanaCompositionCanvas(workflow: SemanticWorkflow): void; restoreWorkflow(workflow: SemanticWorkflow): void; adoptDraftIdentity(workflowId: string): void;
  /**
   * BUILD-FLOFI-PRODUCT-UX-001: a run persisted in this browser that may put its workflow back on the untouched Canvas is being read. Until it
   * settles the Canvas shows a neutral surface, never the empty "Start your workflow" state it would replace a moment later.
   */
  canvasRestoring: boolean; trackCanvasRestoration<T>(read: Promise<T>): Promise<T>;
  /** UX-004: start a genuinely clean workflow (fresh draft identity; prior Review/proposal retired). Wallet and session are untouched. */
  createNewWorkflow(): void;
  /** UX-004: true once the owner created a new workflow in this visit; a persisted run is recovered only into the visit's initial draft. */
  newWorkflow: boolean;
  canvasLayout: CanvasLayout; canUndo: boolean; canRedo: boolean; undo(): void; redo(): void;
  moveCanvasNodes(positions: Readonly<Record<string, { x: number; y: number }>>): void;
  addCanvasCommand(command: Command, position: { x: number; y: number }): void;
  duplicateCanvasNodes(nodeIds: readonly string[]): void;
  pending: Pending | null; propose(command: Command): void; applyProposal(): void; dismissProposal(): void;
  /**
   * BUILD-FLOFI-CONVERSATIONAL-001: commits one validated authoring command that the owner asked for in the FloFi chat, with no proposal step:
   * the same editor reducer, base-revision guard, test-network refusal and undoable history entry as `applyProposal`. Authoring only — the new
   * revision retires every quote, simulation and Review; execution still needs a fresh simulation, Review and the owner's wallet signature.
   * `expected` is the workflow the commit produces, so the caller can tell from the stored workflow whether it landed.
   */
  commitChatCommand(command: Command): ChatCommit;
  /** Undoes a chat commit only while it is still the latest history entry (the workflow is exactly `expected`); otherwise nothing changes. */
  undoChatCommit(commit: { readonly before: Workflow; readonly expected: Workflow }): boolean;
  /** The position operation an applied position-management proposal prepared for the Simulate panel (never simulated, reviewed or signed here). */
  stagedPosition: StagedPosition | null;
  review: ReviewResult | null; reviewError: string | null;
  /**
   * BUILD-FLOFI-CHAT-E2E-FIX-002: a workflow of several independent owner-wallet actions runs as an ordered sequence of one-action steps
   * (`domain/workflow-sequence.ts`). `runtimeWorkflow` is what every owner-wallet runtime simulates, reviews, authorizes and reconciles: the
   * current step alone (a funded step bound to what its producer delivered), or the canonical workflow itself when it is not a sequence.
   * The Canvas and chat always edit the canonical `state.workflow`.
   */
  runtimeWorkflow: Workflow; sequence: SequenceView | null;
  /** Records that the sequence's current step reconciled (from its own durable record); the next step becomes the runtime workflow. */
  completeSequenceStep(index: number, completion: { readonly received: string | null; readonly runKey: string | null }): void;
  chain: ChainState; eligibility: Eligibility; generateArtifacts(): void; refreshArtifacts(): void; accessCheck(): void };
/** The sequence as the shell, chat and Review present it. `cursor` is the step its runtime serves now; `finished` once every step reconciled. */
export type SequenceView = { readonly steps: WorkflowSequence['steps']; readonly cursor: number; readonly current: SequenceStep; readonly completed: readonly CompletedStep[];
  /** The amount a funded current step spends (native units), or null when it spends its authored amount. */ readonly bound: string | null;
  /** Why the current funded step cannot use its producer's delivery: nothing provable was delivered, or its card refused the bound amount. */
  readonly fundingIssue: 'DELIVERY_NOT_PROVEN' | 'NOTHING_DELIVERED' | 'BOUND_REFUSED' | null; readonly finished: boolean };
export type StagedPosition = { readonly positionMint: string; readonly operation: 'DECREASE_PARTIAL' | 'EXIT'; readonly partBps: number | null; readonly serial: number };
type Workflow = EditorState['workflow'];
export type ChatCommit = { readonly ok: true; readonly before: Workflow; readonly expected: Workflow } | { readonly ok: false; readonly error: string };
const Context = createContext<Store | null>(null);
const testNetworksIntroduced = (before: Parameters<typeof introducedTestNetworks>[0], after: Parameters<typeof introducedTestNetworks>[1]) =>
  introducedTestNetworks(before, after, activeNetworkScope());

export function WorkflowProvider({ children, initialContext, initialWorkflowId = 'workflow-local' }: { children: ReactNode; initialContext: unknown; initialWorkflowId?: string }) {
  const [history, dispatchHistory] = useReducer(editorHistoryReducer, undefined, () => {
    const history = initialEditorHistory();
    return { ...history, editor: { ...history.editor, workflow: { ...history.editor.workflow, workflowId: initialWorkflowId } } };
  });
  const state = history.editor;
  const editorRef = useRef(state); editorRef.current = state;
  const historyRef = useRef(history); historyRef.current = history;
  const [restorationEpoch, setRestorationEpoch] = useState(0);
  const [newWorkflow, setNewWorkflow] = useState(false);
  const [pendingRestorations, setPendingRestorations] = useState(0);
  const trackCanvasRestoration = useCallback(<T,>(read: Promise<T>): Promise<T> => {
    setPendingRestorations(count => count + 1);
    return read.finally(() => setPendingRestorations(count => count - 1));
  }, []);
  const authoringIncomplete = canvasAuthoringIncomplete(history.actionSetup, history.amountInputs);
  const incompleteRef = useRef(authoringIncomplete);
  incompleteRef.current = authoringIncomplete;
  // A public testnet swap's own chain selects the trusted context (Base Sepolia or Ethereum Sepolia); anything else keeps the initial one.
  const context = useMemo(() => {
    const swapChain = state.workflow.nodes.find(n => n.actionType === 'asset.swap.exact-input' && (n.chainId === 'eip155:84532' || n.chainId === 'eip155:11155111'))?.chainId;
    return swapChain ? reviewContextForChain(swapChain, createReviewContext(initialContext)) : createReviewContext(initialContext);
  }, [state.workflow, initialContext]);
  const dispatch = useCallback((command: Command) => {
    dispatchHistory({ type: 'COMMAND', command, context });
  }, [context]);
  const restoreLendingCanvas=useCallback((workflow:SemanticWorkflow)=>dispatchHistory({type:'RESTORE_LENDING_CANVAS',workflow}),[]);
  const restoreSolanaCompositionCanvas = useCallback((workflow: SemanticWorkflow) => dispatchHistory({ type: 'RESTORE_SOLANA_COMPOSITION_CANVAS', workflow }), []);
  const addCanvasCommand = useCallback((command: Command, position: { x: number; y: number }) => {
    const preview = editorReducer(editorRef.current, command, context);
    if (!preview.error && testNetworksIntroduced(editorRef.current.workflow, preview.workflow).length) return;
    dispatchHistory({ type: 'COMMAND', command, position, context });
  }, [context]);
  const [layoutLoaded, setLayoutLoaded] = useState(false);
  const initialWorkflow = useRef(state.workflow);
  useEffect(() => { dispatchHistory({ type: 'LOAD_LAYOUT', layout: readCanvasLayout(initialWorkflow.current) }); setLayoutLoaded(true); }, []);
  useEffect(() => { if (layoutLoaded) saveCanvasLayout(state.workflow.workflowId, history.layout); }, [layoutLoaded, state.workflow.workflowId, history.layout]);
  const moveCanvasNodes = useCallback((positions: Readonly<Record<string, { x: number; y: number }>>) =>
    dispatchHistory({ type: 'MOVE', positions }), []);
  const duplicateCanvasNodes = useCallback((nodeIds: readonly string[]) =>
    dispatchHistory({ type: 'DUPLICATE', nodeIds, context }), [context]);
  const undo = useCallback(() => dispatchHistory({ type: 'UNDO' }), []);
  const redo = useCallback(() => dispatchHistory({ type: 'REDO' }), []);
  const [pending, setPending] = useState<Pending | null>(null);
  const [stagedPosition, setStagedPosition] = useState<StagedPosition | null>(null);
  useEffect(() => {
    // History/restoration can change a reviewed field without invoking its input handler.
    setPending(current => {
      if (!current?.authoringId) return current;
      const amount = actionReviewValue(history.actionSetup, current.authoringId, history.amountInputs[current.authoringId], history.bridgeNetworkInputs[current.authoringId], history.cryptoSelections[current.authoringId], history.recipientInputs[current.authoringId]);
      return amount === current.authoringAmount && current.command.baseRevision === state.workflow.revision ? current : null;
    });
  }, [history.actionSetup, history.amountInputs, history.bridgeNetworkInputs, history.cryptoSelections, history.recipientInputs, state.workflow.revision]);
  const [chain, dispatchChain] = useReducer(chainReducer, undefined, initialChainState);
  const workflowRef = useRef(state.workflow);
  const chainRef = useRef(chain);
  const generationRef = useRef(0);
  workflowRef.current = state.workflow;
  chainRef.current = chain;
  // BUILD-FLOFI-CHAT-E2E-FIX-002: several independent owner-wallet actions form a sequence; each step must lint alone (its runtime's own rule).
  const sequence = useMemo(() => state.workflow.nodes.length ? workflowSequence(state.workflow, workflow => lintWorkflow(workflow, context)) : null, [state.workflow, context]);
  const reviewState = useMemo(() => {
    // BUILD-FLOFI-PRODUCT-UX-001: the empty draft has no canonical form yet (the IR needs a node), so there is nothing to review and nothing invalid.
    if (!state.workflow.nodes.length) return { review: null, reviewError: null };
    try { return { review: lintWorkflow(state.workflow, context), reviewError: null }; }
    catch (cause) {
      if (sequence) {
        const findings = sequence.steps.flatMap(step => lintWorkflow(step.projection, context).findings);
        return { review: Object.freeze({ revision: state.workflow.revision, findings: Object.freeze(findings), executable: false, enforcement: 'NOT_ENFORCED' }) as ReviewResult, reviewError: null };
      }
      return { review: null, reviewError: cause instanceof Error ? cause.message : 'INVALID_WORKFLOW' };
    }
  }, [state.workflow, context, sequence]);
  // Executed steps of this workflow's sequence (this visit). Only steps that still describe the workflow count; any other change starts over.
  const [sequenceRun, setSequenceRun] = useState<{ readonly workflowId: string; readonly completed: readonly CompletedStep[] }>({ workflowId: '', completed: [] });
  const completed = sequenceRun.workflowId === state.workflow.workflowId ? validCompletions(sequence, state.workflow, sequenceRun.completed) : [];
  const cursor = sequence ? Math.min(completed.length, sequence.steps.length - 1) : 0, currentStep = sequence?.steps[cursor] ?? null;
  const finished = Boolean(sequence && completed.length >= sequence.steps.length);
  const bound = currentStep ? boundAmount(currentStep, completed) : null;
  const producerDelivery = currentStep?.fundedBy !== null && currentStep?.fundedBy !== undefined ? completed[currentStep.fundedBy]?.received ?? null : null;
  const boundWorkflow = useMemo(() => currentStep ? boundProjection(currentStep, bound, context) : null, [currentStep, bound, context]);
  const runtimeWorkflow = sequence && currentStep ? boundWorkflow ?? currentStep.projection : state.workflow;
  const sequenceView: SequenceView | null = sequence && currentStep ? { steps: sequence.steps, cursor, current: currentStep, completed, bound, finished,
    fundingIssue: finished || currentStep.fundedBy === null ? null : producerDelivery === null ? 'DELIVERY_NOT_PROVEN' : producerDelivery === '0' ? 'NOTHING_DELIVERED'
      : boundWorkflow === null ? 'BOUND_REFUSED' : null } : null;
  const sequenceRef = useRef({ sequence, completed, workflow: state.workflow }); sequenceRef.current = { sequence, completed, workflow: state.workflow };
  const completeSequenceStep = useCallback((index: number, completion: { readonly received: string | null; readonly runKey: string | null }) => {
    const { sequence, completed, workflow } = sequenceRef.current, step = sequence?.steps[index], node = step && workflow.nodes.find(item => item.nodeId === step.nodeId);
    if (!step || !node || index !== completed.length) return;
    setSequenceRun({ workflowId: workflow.workflowId, completed: [...completed, { nodeId: step.nodeId, node: stepNodeKey(node), received: completion.received, runKey: completion.runKey }] });
  }, []);
  const eligibility: Eligibility = useMemo(() => authoringIncomplete ? { eligible: false, reason: 'Configure the amount in Build before simulating.' }
    : generationEligibility(state.workflow, context), [state.workflow, context, authoringIncomplete]);

  // An accepted semantic edit replaces the immutable IR object and invalidates the chain.
  useEffect(() => { dispatchChain({ type: 'REVISION_ACCEPTED', workflow: state.workflow }); }, [state.workflow]);
  const accessCheck = useCallback(() => {
    dispatchChain({ type: 'ACCESS_CHECK', workflow: workflowRef.current, wallNowMs: Date.now(), monotonicNowMs: performance.now() });
  }, []);
  // Background tabs throttle timers, so expiry is re-checked whenever the tab resumes.
  useEffect(() => {
    document.addEventListener('visibilitychange', accessCheck);
    window.addEventListener('focus', accessCheck);
    window.addEventListener('pageshow', accessCheck);
    return () => {
      document.removeEventListener('visibilitychange', accessCheck);
      window.removeEventListener('focus', accessCheck);
      window.removeEventListener('pageshow', accessCheck);
    };
  }, [accessCheck]);
  // The timer only triggers a re-check; it is never the check itself.
  useEffect(() => {
    if (!chain.record || chain.retired) return;
    const timer = setTimeout(accessCheck, Math.max(0, chain.record.expiresAtMs - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [chain.record, chain.retired, accessCheck]);

  function propose(command: Command, authoring?: { authoringId: string; authoringAmount: string }) {
    const preview = editorReducer(state, command, context);
    // BUILD-FLOFI-MAINNET-PRODUCT-001: in the public product no proposal (chat, Copilot, Canvas) may put a step on a test network. The owner is
    // told why; nothing is moved to a mainnet on their behalf.
    const introduced = preview.error ? [] : testNetworksIntroduced(state.workflow, preview.workflow);
    if (introduced.length) {
      setPending({ valid: false, command, diff: [testNetworkMessage(introduced)], review: null, ...authoring ?? {} });
      return;
    }
    const diff = describeProposal(state, preview, command, context);
    let review: ReviewResult | null = null;
    if (!preview.error) {
      try { review = lintWorkflow(preview.workflow, context); } catch { /* Invalid draft is already rejected by reducer. */ }
    }
    const target = amountCommandTarget(command, state.workflow);
    const networks = target ? history.bridgeNetworkInputs[target.id] : undefined;
    const networkMatches = !networks || (command.type === 'SET_ROUTER_BRIDGE' && command.input.source === networks.source && command.input.destination === networks.destination);
    if (target && command.type === 'SET_CRYPTO_ACTION' && history.amountInputs[target.id] === undefined) dispatchHistory({ type: 'EDIT_CANVAS_AMOUNT', id: target.id, amount: target.amount, context });
    const amountEdit = target && (history.amountInputs[target.id] === target.amount || command.type === 'SET_CRYPTO_ACTION' && history.amountInputs[target.id] === undefined) ? { authoringId: target.id, authoringAmount: actionReviewValue(null, target.id, target.amount, networks, history.cryptoSelections[target.id], history.recipientInputs[target.id])! } : undefined;
    setPending({ valid: !preview.error && networkMatches, command, diff, review, ...(authoring ?? amountEdit) });
  }
  function applyProposal() {
    if (!pending || !pending.valid) return;
    const preview = editorReducer(state, pending.command, context);
    if (!preview.error && testNetworksIntroduced(state.workflow, preview.workflow).length) return;
    dispatchHistory({ type: 'COMMAND', command: pending.command, context,
      ...(pending.authoringId ? { authoringId: pending.authoringId, authoringAmount: pending.authoringAmount! } : {}) });
    const command = pending.command;
    if (command.type === 'MANAGE_SOLANA_POSITION') setStagedPosition(current => ({ positionMint: command.positionMint, operation: command.operation, partBps: command.partBps,
      serial: (current?.serial ?? 0) + 1 }));
    else setStagedPosition(null);
    setPending(null);
  }
  const commitChatCommand = useCallback((command: Command): ChatCommit => {
    const current = editorRef.current;
    if (command.source !== 'CHAT') return { ok: false, error: 'CHAT_COMMAND_REQUIRED' };
    const preview = editorReducer(current, command, context);
    if (preview.error) return { ok: false, error: preview.error };
    if (preview.workflow === current.workflow && command.type !== 'MANAGE_SOLANA_POSITION') return { ok: false, error: 'NO_CHANGE' };
    const introduced = testNetworksIntroduced(current.workflow, preview.workflow);
    if (introduced.length) return { ok: false, error: testNetworkMessage(introduced) };
    dispatchHistory({ type: 'COMMAND', command, context });
    setPending(null);
    if (command.type === 'MANAGE_SOLANA_POSITION') setStagedPosition(staged => ({ positionMint: command.positionMint, operation: command.operation, partBps: command.partBps,
      serial: (staged?.serial ?? 0) + 1 }));
    else setStagedPosition(null);
    return { ok: true, before: current.workflow, expected: preview.workflow };
  }, [context]);
  const undoChatCommit = useCallback((commit: { readonly before: Workflow; readonly expected: Workflow }) => {
    const latest = historyRef.current, previous = latest.past.at(-1);
    if (latest.editor.workflow !== commit.expected || previous?.workflow !== commit.before) return false;
    dispatchHistory({ type: 'UNDO' });
    return true;
  }, []);
  function startActionSetup(action: CanvasActionSetup['action'], position: { x: number; y: number }, beneficiary?: string) {
    if (history.actionSetup) return history.actionSetup.id;
    dispatchHistory({ type: 'START_ACTION_SETUP', action, position, ...(beneficiary ? { beneficiary } : {}) });
    return `action-setup-${history.setupSerial + 1}`;
  }
  function startStocksSetup(position: { x: number; y: number }) {
    if (history.actionSetup) return history.actionSetup.id;
    dispatchHistory({ type: 'START_STOCKS_SETUP', position });
    return `action-setup-${history.setupSerial + 1}`;
  }
  function editCanvasAmount(id: string, amount: string) {
    dispatchHistory({ type: 'EDIT_CANVAS_AMOUNT', id, amount, context });
    setPending(current => current?.authoringId === id ? null : current);
  }
  function editPoolSetup(id: string, input: UniswapLiquidityInput) {
    dispatchHistory({ type: 'EDIT_POOL_SETUP', id, input });
    setPending(current => current?.authoringId === id ? null : current);
  }
  function editSwapSetupDirection(id: string, direction: Direction) {
    dispatchHistory({ type: 'EDIT_SWAP_SETUP_DIRECTION', id, direction });
    setPending(current => current?.authoringId === id ? null : current);
  }
  function editCryptoSelection(id: string, selection: CryptoSelection, beneficiary?: string) {
    dispatchHistory({ type: 'EDIT_CRYPTO_SELECTION', id, selection, context, ...(beneficiary ? { beneficiary } : {}) });
    setPending(current => current?.authoringId === id || (current && 'nodeId' in current.command && current.command.nodeId === id) ? null : current);
  }
  function editBridgeNetworks(id: string, patch: Partial<CanvasBridgeNetworks>) {
    dispatchHistory({ type: 'EDIT_BRIDGE_NETWORKS', id, patch, context });
    setPending(current => current?.authoringId === id || (current?.command.type === 'SET_ROUTER_BRIDGE' && current.command.nodeId === id) ? null : current);
  }
  function cancelCanvasAmount(id: string) { dispatchHistory({ type: 'CANCEL_CANVAS_AMOUNT', id }); setPending(current => current?.authoringId === id ? null : current); }
  function editCanvasRecipient(id: string, recipient: string) {
    dispatchHistory({ type: 'EDIT_CANVAS_RECIPIENT', id, recipient, context });
    setPending(current => current?.authoringId === id ? null : current);
  }
  function reviewCryptoPool(id: string, input: CryptoActionInput) {
    try {
      createCryptoActionNode('node-preview', input);
      const setup = history.actionSetup?.id === id && history.actionSetup.action === 'pool' ? { ...history.actionSetup, input: {
        network: 'Base Sepolia' as const, maxUsdc: input.amount, maxWeth: input.secondAmount ?? '0', rangeUnit: input.rangeUnit ?? 'TICK', lower: input.lower!, upper: input.upper!, slippage: input.slippage,
      } } : null;
      if (setup) dispatchHistory({ type: 'EDIT_POOL_SETUP', id, input: setup.input });
      const command: Command = setup ? canvasAmountCommand(state, setup, history.amountInputs, id, context, history.bridgeNetworkInputs, history.cryptoSelections) : { type: 'SET_CRYPTO_ACTION', nodeId: id, input, source: 'CANVAS', baseRevision: state.workflow.revision };
      const amount = actionReviewValue(setup, id, input.amount, undefined, history.cryptoSelections[id]);
      propose(command, { authoringId: id, authoringAmount: amount! });
      return null;
    } catch (cause) { return canvasAmountMessage(cause, input.selection.network); }
  }
  function removeActionSetup() { dispatchHistory({ type: 'REMOVE_ACTION_SETUP' }); setPending(current => current?.authoringId === history.actionSetup?.id ? null : current); }
  function reviewCanvasAmount(id: string, poolInput?: UniswapLiquidityInput) {
    try {
      const setup = poolInput && history.actionSetup?.id === id && history.actionSetup.action === 'pool'
        ? { ...history.actionSetup, input: poolInput } : history.actionSetup;
      const command = canvasAmountCommand(state, setup, history.amountInputs, id, context, history.bridgeNetworkInputs, history.cryptoSelections, history.recipientInputs);
      if (poolInput && setup?.action === 'pool') dispatchHistory({ type: 'EDIT_POOL_SETUP', id, input: poolInput });
      const amount = actionReviewValue(setup, id, history.amountInputs[id], history.bridgeNetworkInputs[id], history.cryptoSelections[id], history.recipientInputs[id])!;
      propose(command, { authoringId: id, authoringAmount: amount });
      return null;
    } catch (cause) { return canvasAmountMessage(cause, (history.cryptoSelections[id] ?? history.actionSetup?.cryptoSelection)?.network); }
  }
  function commitCanvasAmount(id: string) {
    try {
      const command = canvasAmountCommand(state, history.actionSetup, history.amountInputs, id, context, history.bridgeNetworkInputs, history.cryptoSelections, history.recipientInputs);
      const amount = actionReviewValue(history.actionSetup, id, history.amountInputs[id], history.bridgeNetworkInputs[id], history.cryptoSelections[id], history.recipientInputs[id]);
      if (amount === undefined) return null;
      // Changing an existing Router adapter needs a visible proposal; ordinary amount edits retain direct Enter-to-apply behavior.
      if (command.type === 'SET_UNIVERSAL_BRIDGE' && state.workflow.nodes.some(node => node.nodeId === command.nodeId && routerDetails(node))) return reviewCanvasAmount(id);
      // The history guard re-checks that the draft is still exactly this one, so a repeated commit of the same draft is a no-op.
      dispatchHistory({ type: 'COMMAND', command, context, authoringId: id, authoringAmount: amount });
      setPending(current => current?.authoringId === id ? null : current);
      return null;
    } catch (cause) { return canvasAmountMessage(cause, (history.cryptoSelections[id] ?? history.actionSetup?.cryptoSelection)?.network); }
  }
  const generateArtifacts = useCallback(() => {
    const workflow = workflowRef.current;
    if (incompleteRef.current || chainRef.current.pending || !generationEligibility(workflow, context).eligible) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    const nowMs = Date.now(), monotonicStartMs = performance.now();
    dispatchChain({ type: 'GENERATE_STARTED', workflow, generation });
    generateMockedChain(workflow, context, { nowMs, generation }).then(({ chain: artifacts, review }) => {
      dispatchChain({ type: 'GENERATE_SUCCEEDED', currentWorkflow: workflowRef.current, record: {
        chain: artifacts, review, sourceWorkflow: workflow, generation,
        observedAtMs: nowMs, expiresAtMs: Date.parse(review.expiresAt), monotonicStartMs,
      } });
    }, (cause: unknown) => {
      dispatchChain({ type: 'GENERATE_FAILED', generation, code: cause instanceof Error ? cause.message : 'GENERATION_FAILED' });
    });
  }, [context]);
  const refreshArtifacts = useCallback(() => {
    // Refresh is a use of the chain: it is refused unless the guard passes now.
    if (!checkChainAccess(chainRef.current, workflowRef.current, Date.now(), performance.now()).ok) { accessCheck(); return; }
    generateArtifacts();
  }, [accessCheck, generateArtifacts]);
  return <Context.Provider value={{ restorationEpoch, state, dispatch, context, restoreLendingCanvas, restoreSolanaCompositionCanvas, adoptDraftIdentity: workflowId => dispatchHistory({ type: 'ADOPT_DRAFT_IDENTITY', workflowId }), restoreWorkflow: workflow => { setRestorationEpoch(n => n + 1); setPending(null); dispatchHistory({ type: 'RESTORE_WORKFLOW', workflow }); },
    canvasRestoring: pendingRestorations > 0, trackCanvasRestoration,
    createNewWorkflow: () => { setRestorationEpoch(n => n + 1); setNewWorkflow(true); setPending(null); setStagedPosition(null); dispatchHistory({ type: 'NEW_WORKFLOW', workflowId: `workflow-${crypto.randomUUID()}` }); }, newWorkflow, canvasLayout: history.layout, canUndo: history.past.length > 0,
    actionSetup: history.actionSetup, amountInputs: history.amountInputs, authoringIncomplete,
    bridgeNetworkInputs: history.bridgeNetworkInputs, editBridgeNetworks, cryptoSelections: history.cryptoSelections, editCryptoSelection, reviewCryptoPool,
    startActionSetup, startStocksSetup, editCanvasAmount, editPoolSetup, editSwapSetupDirection, cancelCanvasAmount, reviewCanvasAmount, commitCanvasAmount, removeActionSetup,
    recipientInputs: history.recipientInputs, editCanvasRecipient,
    canRedo: history.future.length > 0, undo, redo, moveCanvasNodes, addCanvasCommand, duplicateCanvasNodes,
    pending, propose, applyProposal, dismissProposal: () => setPending(null), commitChatCommand, undoChatCommit, stagedPosition, ...reviewState, runtimeWorkflow, sequence: sequenceView, completeSequenceStep,
    chain, eligibility, generateArtifacts, refreshArtifacts, accessCheck }}>
    <BaseObservationProvider>{children}</BaseObservationProvider>
  </Context.Provider>;
}

type Observations = { observations: ObservationState; readQuote(nodeId: string): void; accessCheck(): void };
const ObservationContext = createContext<Observations | null>(null);

/**
 * Read-only Base observations live in their own context. They are never part
 * of the workflow state, never feed an edit and never reach authorization.
 */
function BaseObservationProvider({ children }: { children: ReactNode }) {
  const { state, context, authoringIncomplete } = useWorkflow();
  const incompleteRef = useRef(authoringIncomplete); incompleteRef.current = authoringIncomplete;
  const [observations, dispatchObservation] = useReducer(observationReducer, undefined, initialObservationState);
  const workflowRef = useRef(state.workflow);
  const observationsRef = useRef(observations);
  const tokenRef = useRef(0);
  workflowRef.current = state.workflow;
  observationsRef.current = observations;
  useEffect(() => { dispatchObservation({ type: 'REVISION_ACCEPTED', workflow: state.workflow }); }, [state.workflow]);
  const accessCheck = useCallback(() => {
    dispatchObservation({ type: 'ACCESS_CHECK', workflow: workflowRef.current, wallNowMs: Date.now(), monotonicNowMs: performance.now() });
  }, []);
  useEffect(() => {
    document.addEventListener('visibilitychange', accessCheck);
    window.addEventListener('focus', accessCheck);
    window.addEventListener('pageshow', accessCheck);
    return () => {
      document.removeEventListener('visibilitychange', accessCheck);
      window.removeEventListener('focus', accessCheck);
      window.removeEventListener('pageshow', accessCheck);
    };
  }, [accessCheck]);
  // The timer only triggers a re-check at the earliest expiry; it is never the check itself.
  useEffect(() => {
    const expiries = Object.values(observations).flatMap(entry => entry.status === 'CURRENT' ? [entry.record.expiresAtMs] : []);
    if (expiries.length === 0) return;
    const timer = setTimeout(accessCheck, Math.max(0, Math.min(...expiries) - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [observations, accessCheck]);
  const readQuote = useCallback((nodeId: string) => {
    if (incompleteRef.current) return;
    if (observationsRef.current[nodeId]?.status === 'READING') return;
    const workflow = workflowRef.current;
    tokenRef.current += 1;
    const token = tokenRef.current;
    dispatchObservation({ type: 'READ_STARTED', nodeId, token, workflow });
    readBaseQuote({ workflow, nodeId }).then(async (result) => {
      if (!result.ok) {
        dispatchObservation({ type: 'READ_FAILED', nodeId, token, code: result.code, message: result.message });
        return;
      }
      try {
        const record = await receiveObservation(result, { nodeId, sourceWorkflow: workflow, currentWorkflow: workflowRef.current,
          wallNowMs: Date.now(), monotonicNowMs: performance.now() }, context);
        dispatchObservation({ type: 'READ_SUCCEEDED', nodeId, token, record, currentWorkflow: workflowRef.current });
        accessCheck();
      } catch (cause) {
        const code = cause instanceof BaseObservationError ? cause.code : 'INTERNAL_ERROR';
        dispatchObservation({ type: 'READ_FAILED', nodeId, token, code, message: browserFailureMessage(code) });
      }
    }, () => {
      dispatchObservation({ type: 'READ_FAILED', nodeId, token, code: 'INTERNAL_ERROR', message: browserFailureMessage('INTERNAL_ERROR') });
    });
  }, [context, accessCheck]);
  return <ObservationContext.Provider value={{ observations, readQuote, accessCheck }}>{children}</ObservationContext.Provider>;
}
export function useBaseObservations() {
  const value = useContext(ObservationContext);
  if (!value) throw new Error('BaseObservationProvider is required');
  return value;
}
export function useWorkflow() {
  const value = useContext(Context);
  if (!value) throw new Error('WorkflowProvider is required');
  return value;
}
