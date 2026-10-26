// SPDX-License-Identifier: AGPL-3.0-only
import { ROBINHOOD_NETWORK, featuredStockSymbols } from './asset-catalogs';
import { createBaseSepoliaReviewContext, validateWorkflowDraft, type ReviewContext } from '@defi-workflow-engine/reference-linter';
import { validateSavedWorkflow } from './saved-workflow';
import {isLendingComposition,workflowDependencyOrder,type SemanticWorkflow} from '@defi-workflow-engine/workflow-contracts';
import { isBoundComposition } from '@defi-workflow-engine/action-registry';
import type { Command } from './commands';
import { directions, type Direction } from './swap-authoring';
import { universalBridgeDetails, defaultUniversalInputAsset, universalKeyOfCanvasLabel } from './universal-bridge-authoring';
import { universalCanvasNetworks } from './canvas-action-setup';
import { routerDetails } from './router-authoring';
import type { UniswapLiquidityInput } from './uniswap-liquidity-authoring';
import { defaultPoolRange, validCryptoSelection, canSelectCryptoAssets, cryptoInputOf, type CryptoSelection, type CryptoSelections } from './crypto-action-picker';
import { actionReviewValue } from './canvas-action-setup';
import { canvasPosition, type CanvasLayout } from './canvas-layout';
import { editorReducer, initialEditor, templateEditor, type EditorState } from './editor';
import { freeze, type Workflow } from './initial-workflow';
import { canEditCanvasAmount, canvasAmountCommand, amountCommandTarget, bridgeSetupNetworks, CANVAS_BRIDGE_NETWORK_OPTIONS, type CanvasActionSetup, type CanvasAmountInputs, type CanvasBridgeNetworks, type CanvasBridgeNetworkInputs, type CanvasRecipientInputs } from './canvas-action-setup';
import { transferDetails } from './robinhood-transfer-authoring';
import { checkRecipient, recipientPolicy } from './recipient-address';
import { DEFAULT_SLIPPAGE } from './slippage-policy';

type Snapshot = { readonly workflow: Workflow; readonly layout: CanvasLayout; readonly actionSetup: CanvasActionSetup | null; readonly amountInputs: CanvasAmountInputs; readonly bridgeNetworkInputs: CanvasBridgeNetworkInputs; readonly cryptoSelections: CryptoSelections; readonly recipientInputs: CanvasRecipientInputs };
export type EditorHistory = { readonly editor: EditorState; readonly layout: CanvasLayout;
  readonly actionSetup: CanvasActionSetup | null; readonly amountInputs: CanvasAmountInputs; readonly setupSerial: number;
  readonly bridgeNetworkInputs: CanvasBridgeNetworkInputs;
  readonly cryptoSelections: CryptoSelections;
  /** UX-001: edited "To" text of authored Send cards; it rides with that card's amount draft and is committed only on Apply. */
  readonly recipientInputs: CanvasRecipientInputs;
  readonly past: readonly Snapshot[]; readonly future: readonly Snapshot[] };
export type HistoryAction =
  | { readonly type: 'EDIT_CRYPTO_SELECTION'; readonly id: string; readonly selection: CryptoSelection; readonly context: ReviewContext; readonly beneficiary?: string }
  | { readonly type: 'RESTORE_WORKFLOW'; readonly workflow: SemanticWorkflow }
  | { readonly type: 'ADOPT_DRAFT_IDENTITY'; readonly workflowId: string }
  /** UX-004: "Create new workflow": the empty initial draft under a fresh draft identity (no actions, drafts, layout or history). */
  | { readonly type: 'NEW_WORKFLOW'; readonly workflowId: string }
  | { readonly type: 'RESTORE_LENDING_CANVAS'; readonly workflow: SemanticWorkflow }
  /** P0: a recovered Solana Swap → liquidity run that still needs the owner (its position is owed) shows its authorized workflow again. */
  | { readonly type: 'RESTORE_SOLANA_COMPOSITION_CANVAS'; readonly workflow: SemanticWorkflow }
  | { readonly type: 'COMMAND'; readonly command: Command; readonly context: ReviewContext; readonly position?: { x: number; y: number }; readonly authoringId?: string; readonly authoringAmount?: string }
  | { readonly type: 'START_ACTION_SETUP'; readonly action: CanvasActionSetup['action']; readonly position: { x: number; y: number }; readonly beneficiary?: string }
  /** BUILD-RH-002: the Stocks card — a Robinhood Chain catalog swap from USDG into the first featured Stock Token. */
  | { readonly type: 'START_STOCKS_SETUP'; readonly position: { x: number; y: number } }
  | { readonly type: 'EDIT_POOL_SETUP'; readonly id: string; readonly input: UniswapLiquidityInput }
  | { readonly type: 'EDIT_SWAP_SETUP_DIRECTION'; readonly id: string; readonly direction: Direction }
  | { readonly type: 'EDIT_BRIDGE_NETWORKS'; readonly id: string; readonly patch: Partial<CanvasBridgeNetworks>; readonly context: ReviewContext }
  | { readonly type: 'EDIT_CANVAS_AMOUNT'; readonly id: string; readonly amount: string; readonly context: ReviewContext }
  | { readonly type: 'CANCEL_CANVAS_AMOUNT'; readonly id: string }
  | { readonly type: 'EDIT_CANVAS_RECIPIENT'; readonly id: string; readonly recipient: string; readonly context: ReviewContext }
  | { readonly type: 'REMOVE_ACTION_SETUP' }
  | { readonly type: 'MOVE'; readonly positions: Readonly<Record<string, { x: number; y: number }>> }
  | { readonly type: 'DUPLICATE'; readonly nodeIds: readonly string[]; readonly context: ReviewContext }
  | { readonly type: 'LOAD_LAYOUT'; readonly layout: CanvasLayout }
  | { readonly type: 'UNDO' }
  | { readonly type: 'REDO' };

export const initialEditorHistory = (): EditorHistory => ({ editor: initialEditor(), layout: {}, actionSetup: null, amountInputs: {}, bridgeNetworkInputs: {}, cryptoSelections: {}, recipientInputs: {}, setupSerial: 0, past: [], future: [] });
/** Engineering fixture history that starts with the protected mock template at `node-001` (not the product empty canvas). */
export const templateEditorHistory = (): EditorHistory => ({ editor: templateEditor(), layout: {}, actionSetup: null, amountInputs: {}, bridgeNetworkInputs: {}, cryptoSelections: {}, recipientInputs: {}, setupSerial: 0, past: [], future: [] });
const snapshot = (state: EditorHistory): Snapshot => ({ workflow: state.editor.workflow, layout: state.layout, actionSetup: state.actionSetup, amountInputs: state.amountInputs, bridgeNetworkInputs: state.bridgeNetworkInputs, cryptoSelections: state.cryptoSelections, recipientInputs: state.recipientInputs });

export function planCanvasDuplicate(workflow: Workflow, layout: CanvasLayout, nodeIds: readonly string[], context: ReviewContext) {
  const selected = new Set(nodeIds);
  const sources = workflow.nodes.filter(node => selected.has(node.nodeId) &&
    (node.actionType.startsWith('mock-') || (node.actionType === 'asset.swap.exact-input' &&
      !node.dependencies.length && !node.inputs.some(input => input.kind === 'OUTPUT_REFERENCE'))));
  if (!sources.length || workflow.nodes.length + sources.length > 1024 || workflow.revision === Number.MAX_SAFE_INTEGER) return null;
  const next = Math.max(9000000000000000, ...workflow.nodes.flatMap(node => /^node-\d{3,16}$/.test(node.nodeId)
    ? [Number(node.nodeId.slice(5))] : []));
  if (next + sources.length > Number.MAX_SAFE_INTEGER) return null;
  const ids = sources.map((_, index) => `node-${next + index + 1}`);
  const copies = new Map(sources.map((node, index) => [node.nodeId, ids[index]!]));
  const nodes: Workflow['nodes'][number][] = sources.map(node => {
    const inputs: Workflow['nodes'][number]['inputs'][number][] = [];
    for (const input of node.inputs) {
      if (input.kind !== 'OUTPUT_REFERENCE') inputs.push(input);
      else if (copies.has(input.value.nodeId)) inputs.push({ ...input,
        value: { ...input.value, nodeId: copies.get(input.value.nodeId)! } });
    }
    return { ...node, nodeId: copies.get(node.nodeId)!,
      dependencies: node.dependencies.flatMap(id => copies.has(id) ? [copies.get(id)!] : []), inputs };
  });
  const resourceEdges = workflow.resourceEdges.filter(edge => copies.has(edge.fromNodeId) && copies.has(edge.toNodeId))
    .map(edge => ({ ...edge, fromNodeId: copies.get(edge.fromNodeId)!, toNodeId: copies.get(edge.toNodeId)! }));
  const candidate = { ...workflow, revision: workflow.revision + 1,
    nodes: [...workflow.nodes, ...nodes], resourceEdges: [...workflow.resourceEdges, ...resourceEdges] };
  try { validateWorkflowDraft(candidate, context); } catch { return null; }
  const duplicateLayout = { ...layout };
  for (const [index, node] of sources.entries()) {
    const sourcePosition = layout[node.nodeId]?.actionType === node.actionType
      ? layout[node.nodeId]! : { x: 85 + (workflow.nodes.indexOf(node) % 3) * 270,
        y: 90 + Math.floor(workflow.nodes.indexOf(node) / 3) * 190, actionType: node.actionType };
    duplicateLayout[ids[index]!] = { ...sourcePosition, x: sourcePosition.x + 36, y: sourcePosition.y + 36 };
  }
  return { workflow: freeze(candidate), layout: duplicateLayout, ids };
}

export function editorHistoryReducer(state: EditorHistory, action: HistoryAction): EditorHistory {
  if (action.type === 'START_ACTION_SETUP') {
    // Configure one new action at a time so the existing canonical sequence never changes on acceptance.
    if (state.actionSetup || !Number.isFinite(action.position.x) || !Number.isFinite(action.position.y) || (['supply', 'borrow', 'repay'].includes(action.action) && !action.beneficiary)) return state;
    const id = `action-setup-${state.setupSerial + 1}`;
    let actionSetup: CanvasActionSetup;
    if (action.action === 'pool') actionSetup = { id, action: 'pool', amount: '0', input: {
      network: 'Base Sepolia', maxUsdc: '0', maxWeth: '0', rangeUnit: 'TICK', lower: '-887270', upper: '887270', slippage: DEFAULT_SLIPPAGE,
    } };
    else if (action.action === 'transfer') actionSetup = { id, action: 'transfer', amount: '0', cryptoSelection: { action: 'transfer', network: 'Robinhood Chain Testnet', from: 'ETH' } };
    else if (action.action === 'supply' || action.action === 'borrow' || action.action === 'repay')
      actionSetup = { id, action: action.action, amount: '0', beneficiary: action.beneficiary! };
    else actionSetup = { id, action: action.action, amount: '0' };
    return { ...state, actionSetup, setupSerial: state.setupSerial + 1,
      layout: { ...state.layout, [id]: { ...action.position, actionType: action.action === 'swap' ? 'asset.swap.exact-input' : action.action === 'bridge' ? 'asset.bridge' : action.action } },
      past: [...state.past, snapshot(state)], future: [] };
  }
  if (action.type === 'START_STOCKS_SETUP') {
    if (state.actionSetup || !Number.isFinite(action.position.x) || !Number.isFinite(action.position.y)) return state;
    const id = `action-setup-${state.setupSerial + 1}`;
    const actionSetup: CanvasActionSetup = { id, action: 'swap', amount: '0', stocks: true,
      cryptoSelection: { action: 'swap', network: ROBINHOOD_NETWORK, from: 'USDG', to: featuredStockSymbols()[0]! } };
    return { ...state, actionSetup, setupSerial: state.setupSerial + 1, layout: { ...state.layout, [id]: { ...action.position, actionType: 'asset.swap.exact-input' } },
      past: [...state.past, snapshot(state)], future: [] };
  }
  if (action.type === 'EDIT_CRYPTO_SELECTION') {
    if (!validCryptoSelection(action.selection)) return state;
    const setup = state.actionSetup?.id === action.id ? state.actionSetup : null;
    const node = state.editor.workflow.nodes.find(node => node.nodeId === action.id);
    if (setup ? setup.action !== action.selection.action : !node || !canSelectCryptoAssets(node, state.editor.workflow) || cryptoInputOf(node)?.selection.action !== action.selection.action) return state;
    const current = setup?.cryptoSelection ?? state.cryptoSelections[action.id];
    if (JSON.stringify(current) === JSON.stringify(action.selection)) return state;
    const changedNetwork = current?.network !== action.selection.network;
    const poolInput = setup?.action === 'pool' && changedNetwork ? { ...setup.input, ...defaultPoolRange(action.selection.network) } : null;
    return { ...state, ...(setup ? { actionSetup: { ...setup, cryptoSelection: action.selection, ...(action.beneficiary ? { cryptoBeneficiary: action.beneficiary } : {}), ...(poolInput ? { input: poolInput } : {}) } as CanvasActionSetup } : {
      cryptoSelections: { ...state.cryptoSelections, [action.id]: action.selection },
      amountInputs: { ...state.amountInputs, [action.id]: state.amountInputs[action.id] ?? cryptoInputOf(node!)!.amount },
    }), past: [...state.past, snapshot(state)], future: [] };
  }
  if (action.type === 'EDIT_BRIDGE_NETWORKS') {
    if (!Object.keys(action.patch).length || Object.keys(action.patch).some(key => !['source', 'destination', 'inputAsset', 'outputAsset'].includes(key)) ||
      (action.patch.source !== undefined && !CANVAS_BRIDGE_NETWORK_OPTIONS.source.includes(action.patch.source)) ||
      (action.patch.destination !== undefined && !CANVAS_BRIDGE_NETWORK_OPTIONS.destination.includes(action.patch.destination))) return state;
    const setup = state.actionSetup?.id === action.id && state.actionSetup.action === 'bridge' ? state.actionSetup : null;
    const node = state.editor.workflow.nodes.find(node => node.nodeId === action.id), router = node ? routerDetails(node) : null, universal = node ? universalBridgeDetails(node) : null;
    if (!setup && (!node || (!router && !universal) || !canEditCanvasAmount(node, action.context, state.editor.workflow))) return state;
    const current: CanvasBridgeNetworks = setup ? bridgeSetupNetworks(setup) : state.bridgeNetworkInputs[action.id] ?? (universal ? universalCanvasNetworks(universal) : router!);
    const networks: CanvasBridgeNetworks = { source: current.source, destination: current.destination, ...current.inputAsset ? { inputAsset: current.inputAsset } : {}, ...current.outputAsset ? { outputAsset: current.outputAsset } : {}, ...action.patch };
    // Changing one network resets only that side's asset to its network default. Never carry an address to another chain.
    if (current.inputAsset && networks.source !== current.source && universalKeyOfCanvasLabel(networks.source)) networks.inputAsset = defaultUniversalInputAsset(universalKeyOfCanvasLabel(networks.source)!);
    if (current.outputAsset && networks.destination !== current.destination && universalKeyOfCanvasLabel(networks.destination)) networks.outputAsset = defaultUniversalInputAsset(universalKeyOfCanvasLabel(networks.destination)!);
    if (networks.source === current.source && networks.destination === current.destination && networks.inputAsset === current.inputAsset && networks.outputAsset === current.outputAsset) return state;
    return { ...state, ...(setup ? { actionSetup: { ...setup, networks } } : {
      bridgeNetworkInputs: { ...state.bridgeNetworkInputs, [action.id]: networks },
      amountInputs: { ...state.amountInputs, [action.id]: state.amountInputs[action.id] ?? (router ?? universal)!.amount },
    }), past: [...state.past, snapshot(state)], future: [] };
  }
  if (action.type === 'EDIT_SWAP_SETUP_DIRECTION') {
    if (state.actionSetup?.id !== action.id || state.actionSetup.action !== 'swap' || !directions.includes(action.direction) || (state.actionSetup.direction ?? 'USDC_TO_WETH') === action.direction) return state;
    return { ...state, actionSetup: { ...state.actionSetup, direction: action.direction }, past: [...state.past, snapshot(state)], future: [] };
  }
  if (action.type === 'EDIT_POOL_SETUP') {
    if (state.actionSetup?.id !== action.id || state.actionSetup.action !== 'pool') return state;
    return { ...state, actionSetup: { ...state.actionSetup, input: action.input }, future: [] };
  }
  if (action.type === 'EDIT_CANVAS_AMOUNT') {
    if (state.actionSetup?.id === action.id) return { ...state, actionSetup: { ...state.actionSetup, amount: action.amount }, future: [] };
    const node = state.editor.workflow.nodes.find(item => item.nodeId === action.id);
    if (!node || !canEditCanvasAmount(node, action.context, state.editor.workflow)) return state;
    return { ...state, amountInputs: { ...state.amountInputs, [action.id]: action.amount },
      past: state.amountInputs[action.id] === undefined ? [...state.past, snapshot(state)] : state.past, future: [] };
  }
  if (action.type === 'CANCEL_CANVAS_AMOUNT') {
    const amountInputs = { ...state.amountInputs }; delete amountInputs[action.id];
    const bridgeNetworkInputs = { ...state.bridgeNetworkInputs }; delete bridgeNetworkInputs[action.id];
    const cryptoSelections = { ...state.cryptoSelections }; delete cryptoSelections[action.id];
    const recipientInputs = { ...state.recipientInputs }; delete recipientInputs[action.id];
    return { ...state, amountInputs, bridgeNetworkInputs, cryptoSelections, recipientInputs, future: [] };
  }
  // UX-001: the Send card's "To" text. It edits only a draft (the setup's, or an authored card's beside its amount draft) on a network whose
  // transfer profile accepts recipients; the canonical `recipient` changes only when the reviewed proposal is applied.
  if (action.type === 'EDIT_CANVAS_RECIPIENT') {
    if (typeof action.recipient !== 'string' || action.recipient.length > 128) return state;
    const setup = state.actionSetup?.id === action.id ? state.actionSetup : null;
    if (setup) return setup.cryptoSelection?.action === 'transfer' && recipientPolicy(setup.cryptoSelection.network).kind === 'ADDRESS' && setup.cryptoRecipient !== action.recipient
      ? { ...state, actionSetup: { ...setup, cryptoRecipient: action.recipient }, future: [] } : state;
    const node = state.editor.workflow.nodes.find(item => item.nodeId === action.id);
    const transfer = node ? transferDetails(node as Parameters<typeof transferDetails>[0]) : null;
    if (!node || !transfer || !canEditCanvasAmount(node, action.context, state.editor.workflow) ||
      recipientPolicy(state.cryptoSelections[action.id]?.network ?? transfer.network).kind !== 'ADDRESS' || state.recipientInputs[action.id] === action.recipient) return state;
    return { ...state, recipientInputs: { ...state.recipientInputs, [action.id]: action.recipient },
      amountInputs: { ...state.amountInputs, [action.id]: state.amountInputs[action.id] ?? transfer.amount },
      past: state.amountInputs[action.id] === undefined ? [...state.past, snapshot(state)] : state.past, future: [] };
  }
  if (action.type === 'REMOVE_ACTION_SETUP') {
    if (!state.actionSetup) return state;
    const layout = { ...state.layout }; delete layout[state.actionSetup.id];
    return { ...state, actionSetup: null, layout, past: [...state.past, snapshot(state)], future: [] };
  }
  // An external proposal is composed on the initial draft. Only an untouched draft (revision 0) takes that draft's identity, so the
  // applied proposal hashes exactly to the proposal; any authored draft keeps its own identity and stays a mismatch.
  if (action.type === 'ADOPT_DRAFT_IDENTITY') {
    const workflow = state.editor.workflow;
    if (workflow.revision !== 0 || workflow.workflowId === action.workflowId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(action.workflowId)) return state;
    return { ...state, editor: { ...state.editor, workflow: freeze({ ...structuredClone(workflow), workflowId: action.workflowId }) } };
  }
  if (action.type === 'NEW_WORKFLOW') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(action.workflowId)) return state;
    const fresh = initialEditorHistory();
    return { ...fresh, editor: { ...fresh.editor, workflow: freeze({ ...structuredClone(fresh.editor.workflow), workflowId: action.workflowId }) } };
  }
  if (action.type === 'RESTORE_WORKFLOW') {
    try {
      const workflow = validateSavedWorkflow(action.workflow);
      return { ...initialEditorHistory(), editor: { workflow: freeze(structuredClone(workflow)), error: null } };
    } catch { return state; }
  }
  if(action.type==='RESTORE_SOLANA_COMPOSITION_CANVAS') {
    // Same rule as the lending restore: only the untouched initial Canvas, the exact IR/revision of a validated durable run, no authority.
    if(state.actionSetup||Object.keys(state.amountInputs).length||state.editor.workflow.revision!==0||state.past.length||!state.editor.workflow.nodes.every(n=>n.actionType.startsWith('mock-')))return state;
    try {
      const workflow=validateWorkflowDraft(action.workflow,createBaseSepoliaReviewContext());
      if(!isBoundComposition(workflow))return state;
      return {...state,editor:{workflow:freeze(workflow),error:null},layout:{},past:[],future:[]};
    } catch {return state;}
  }
  if(action.type==='RESTORE_LENDING_CANVAS') {
    // Restore only the untouched initial Canvas from a validated durable run.
    // Preserve its exact IR/revision; this creates no Review or execution authority.
    if(state.actionSetup||Object.keys(state.amountInputs).length||state.editor.workflow.revision!==0||state.past.length||!state.editor.workflow.nodes.every(n=>n.actionType.startsWith('mock-')))return state;
    try {
      const workflow=validateWorkflowDraft(action.workflow,createBaseSepoliaReviewContext());
      if(!isLendingComposition(workflow))return state;
      return {...state,editor:{workflow:freeze(workflow),error:null},layout:{},past:[],future:[]};
    } catch {return state;}
  }
  if (action.type === 'LOAD_LAYOUT') return { ...state, layout: action.layout };
  if (action.type === 'DUPLICATE') {
    if (state.actionSetup || Object.keys(state.amountInputs).length) return state;
    const result = planCanvasDuplicate(state.editor.workflow, state.layout, action.nodeIds, action.context);
    return result ? { ...state, editor: { workflow: result.workflow, error: null }, layout: result.layout,
      past: [...state.past, snapshot(state)], future: [] } : state;
  }
  if (action.type === 'UNDO' || action.type === 'REDO') {
    const source = action.type === 'UNDO' ? state.past : state.future;
    const target = source.at(-1);
    if (!target) return state;
    const current = snapshot(state);
    // A restored semantic edit is a fresh revision, so old review and execution artifacts cannot become current again.
    const semantic = target.workflow.nodes !== current.workflow.nodes
      || target.workflow.resourceEdges !== current.workflow.resourceEdges;
    if (semantic && current.workflow.revision === Number.MAX_SAFE_INTEGER) return state;
    const workflow = semantic ? freeze({ ...target.workflow, revision: current.workflow.revision + 1 }) : current.workflow;
    return { ...state, editor: { workflow, error: null }, layout: target.layout, actionSetup: target.actionSetup, amountInputs: target.amountInputs, bridgeNetworkInputs: target.bridgeNetworkInputs, cryptoSelections: target.cryptoSelections, recipientInputs: target.recipientInputs,
      past: action.type === 'UNDO' ? state.past.slice(0, -1) : [...state.past, current],
      future: action.type === 'REDO' ? state.future.slice(0, -1) : [...state.future, current] };
  }
  if (action.type === 'MOVE') {
    const layout = { ...state.layout };
    let changed = false;
    for (const [id, position] of Object.entries(action.positions)) {
      const node = state.editor.workflow.nodes.find(item => item.nodeId === id) ?? (state.actionSetup?.id === id
        ? { actionType: state.actionSetup.action === 'swap' ? 'asset.swap.exact-input' : state.actionSetup.action === 'bridge' ? 'asset.bridge' : state.actionSetup.action } : undefined);
      if (!node || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
      const before = layout[id];
      if (before?.x === position.x && before?.y === position.y) continue;
      layout[id] = { ...position, actionType: node.actionType };
      changed = true;
    }
    return changed ? { ...state, layout, past: [...state.past, snapshot(state)], future: [] } : state;
  }
  if (action.authoringId) {
    const amount = actionReviewValue(state.actionSetup, action.authoringId, state.amountInputs[action.authoringId], state.bridgeNetworkInputs[action.authoringId], state.cryptoSelections[action.authoringId], state.recipientInputs[action.authoringId]);
    if (amount === undefined || amount !== action.authoringAmount) return state;
    if (state.actionSetup?.id === action.authoringId) {
      try {
        if (JSON.stringify(canvasAmountCommand(state.editor, state.actionSetup, state.amountInputs, action.authoringId, action.context, state.bridgeNetworkInputs, state.cryptoSelections, state.recipientInputs)) !== JSON.stringify(action.command)) return state;
      } catch { return state; }
    } else {
      const target = amountCommandTarget(action.command, state.editor.workflow, action.authoringId);
      if (target?.id !== action.authoringId || target.amount !== state.amountInputs[action.authoringId]) return state;
      const selection = state.cryptoSelections[action.authoringId];
      if (selection && (action.command.type !== 'SET_CRYPTO_ACTION' || JSON.stringify(action.command.input.selection) !== JSON.stringify(selection))) return state;
      const networks = state.bridgeNetworkInputs[action.authoringId];
      if (networks && (action.command.type !== 'SET_ROUTER_BRIDGE' || action.command.input.source !== networks.source || action.command.input.destination !== networks.destination)) return state;
      // UX-001: an applied Send carries exactly the typed destination, validated for its network.
      const typed = state.recipientInputs[action.authoringId];
      if (typed !== undefined) {
        if (action.command.type !== 'SET_RH_TRANSFER' && !(action.command.type === 'SET_CRYPTO_ACTION' && action.command.input.selection.action === 'transfer')) return state;
        const check = checkRecipient(action.command.type === 'SET_RH_TRANSFER' ? action.command.input.network : action.command.input.selection.network, typed);
        if (!check.ok || (action.command.input.recipient ?? 'CONNECTED_OWNER') !== check.recipient) return state;
      }
    }
  }
  const editor = editorReducer(state.editor, action.command, action.context);
  if (editor.error) return { ...state, editor };
  const amountInputs = { ...state.amountInputs };
  const bridgeNetworkInputs = { ...state.bridgeNetworkInputs };
  const cryptoSelections = { ...state.cryptoSelections };
  const recipientInputs = { ...state.recipientInputs };
  if (action.authoringId) delete cryptoSelections[action.authoringId];
  if (action.authoringId) delete recipientInputs[action.authoringId];
  if (action.authoringId) delete amountInputs[action.authoringId];
  if (action.authoringId) delete bridgeNetworkInputs[action.authoringId];
  for (const id of Object.keys(amountInputs)) {
    const node = editor.workflow.nodes.find(node => node.nodeId === id);
    if (!node || !canEditCanvasAmount(node, action.context, state.editor.workflow)) delete amountInputs[id];
  }
  for (const id of Object.keys(bridgeNetworkInputs)) {
    if (amountInputs[id] === undefined || !editor.workflow.nodes.some(node => node.nodeId === id && routerDetails(node))) delete bridgeNetworkInputs[id];
  }
  for (const id of Object.keys(cryptoSelections)) {
    const node = editor.workflow.nodes.find(node => node.nodeId === id);
    if (!node || !canSelectCryptoAssets(node, editor.workflow)) delete cryptoSelections[id];
  }
  for (const id of Object.keys(recipientInputs)) {
    const node = editor.workflow.nodes.find(node => node.nodeId === id);
    if (amountInputs[id] === undefined || !node || !transferDetails(node as Parameters<typeof transferDetails>[0])) delete recipientInputs[id];
  }
  const actionSetup = state.actionSetup?.id === action.authoringId ? null : state.actionSetup;
  if (editor.workflow === state.editor.workflow && actionSetup === state.actionSetup && Object.keys(amountInputs).length === Object.keys(state.amountInputs).length) return { ...state, editor };
  let layout = { ...state.layout };
  workflowDependencyOrder(state.editor.workflow.nodes).filter(n => !n.actionType.startsWith('mock-')).forEach((node, index) => {
    if (!layout[node.nodeId]) layout[node.nodeId] = { ...(isLendingComposition(state.editor.workflow) ? { x: 180, y: 35 + index * 230 } : canvasPosition({}, node, index)), actionType: node.actionType };
  });
  const position = action.position ?? (state.actionSetup && state.actionSetup.id === action.authoringId ? state.layout[state.actionSetup.id] : undefined);
  if (position) {
    const added = editor.workflow.nodes.find(node => !state.editor.workflow.nodes.some(previous => previous.nodeId === node.nodeId));
    if (added) layout = { ...layout, [added.nodeId]: { ...position, actionType: added.actionType } };
  }
  if (state.actionSetup && !actionSetup) { const nextLayout = { ...layout }; delete nextLayout[state.actionSetup.id]; layout = nextLayout; }
  return { ...state, editor, layout, actionSetup, amountInputs, bridgeNetworkInputs, cryptoSelections, recipientInputs, past: [...state.past, snapshot(state)], future: [] };
}
