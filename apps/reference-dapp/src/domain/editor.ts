import {createAuthoredLending} from './lending-authoring';
// SPDX-License-Identifier: AGPL-3.0-only
import { createBaseSepoliaReviewContext, createEthereumSepoliaReviewContext, reviewContextForChain, validateWorkflowDraft, type ReviewContext } from '@defi-workflow-engine/reference-linter';
import { commandIsValid, type Command } from './commands';
import { freeze, initialWorkflow, templateWorkflow, type Workflow } from './initial-workflow';
import { createMockNode } from './mock-actions';
import { createSwapNode, parseHumanAmount, parseSlippage, swapDetails, SWAP_ACTION } from './swap-authoring';
import { createLiquidityNode, LIQUIDITY_ACTION } from './liquidity-authoring';
import { createCompositionWorkflow } from './composition-authoring';
import { BRIDGE_ACTION } from '@defi-workflow-engine/workflow-contracts';
import { createBridgeNode } from './bridge-authoring';
import { createBridgeSwapWorkflow } from './bridge-swap-authoring';
import { createAcrossWorkflow } from './across-authoring';
import { createCrossChainLiquidityWorkflow } from './cross-chain-liquidity';
import { canDeleteCanvasEdge, planCanvasRemoval, type CanvasRemoval } from './canvas-keyboard';
import { bindCompositionConsumer, compositionBindingFor, unbindCompositionConsumer } from '@defi-workflow-engine/action-registry';
import { readConcentratedLiquiditySource } from '@defi-workflow-engine/workflow-contracts';

import { createAuthoredSupply, createAuthoredBorrow, createAuthoredRepay, createAuthoredWithdraw } from './supply-authoring';
import { createAuthoredTransfer } from './robinhood-transfer-authoring';
import { createSolanaSwapNode, solanaSwapDetails } from './jupiter-authoring';
import { createSolanaLiquidityNode, solanaLiquidityDetails } from './solana-liquidity-authoring';
import { createUniswapLiquidityNode, uniswapLiquidityDetails } from './uniswap-liquidity-authoring';
import { createRouterNode, routerDetails } from './router-authoring';
import { createUniversalBridgeFromInput, universalBridgeDetails } from './universal-bridge-authoring';
import { createCryptoActionNode, canSelectCryptoAssets, cryptoSelectionOf, cryptoReviewContext } from './crypto-action-picker';

export interface EditorState { readonly workflow: Workflow; readonly error: string | null }
export const initialEditor = (): EditorState => ({ workflow: initialWorkflow(), error: null });
/** Engineering fixture editor that starts with the protected mock template at `node-001` (not the product empty canvas). */
export const templateEditor = (): EditorState => ({ workflow: templateWorkflow(), error: null });

/** One pure reducer for both views. View selection and layout never enter the IR. */
export function editorReducer(state: EditorState, command: Command, context?: ReviewContext): EditorState {
  const reject = (error: string): EditorState => ({ workflow: state.workflow, error });
  if (!commandIsValid(command)) return reject('INVALID_COMMAND');
  const current = state.workflow;
  if (command.baseRevision !== current.revision) return reject('BASE_REVISION_CONFLICT: review a fresh proposal.');
  if (current.revision === Number.MAX_SAFE_INTEGER) return reject('REVISION_OVERFLOW');
  if (command.type === 'ADD_CRYPTO_ACTION' || command.type === 'SET_CRYPTO_ACTION') {
    if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
    try {
      const old = command.type === 'SET_CRYPTO_ACTION' ? current.nodes.find(node => node.nodeId === command.nodeId) : null;
      if (command.type === 'SET_CRYPTO_ACTION' && (!old || !canSelectCryptoAssets(old, current) || cryptoSelectionOf(old)?.action !== command.input.selection.action)) return reject('ACTION_SELECTION_LOCKED');
      const id = old?.nodeId ?? `node-${String(current.revision + 2).padStart(3, '0')}`;
      let replacement = createCryptoActionNode(id, command.input);
      if (old?.chainId === replacement.chainId && old.actionType === replacement.actionType) {
        // Keep existing provider constraints and legacy minimums when editing the same deployment.
        replacement = { ...replacement, adapterConstraints: old.adapterConstraints as typeof replacement.adapterConstraints };
        if (replacement.actionType === LIQUIDITY_ACTION) replacement = { ...replacement, inputs: replacement.inputs.map(input => ['amount0-min', 'amount1-min'].includes(input.name) ? old.inputs.find(previous => previous.name === input.name) as typeof input : input) };
      }
      if (old) replacement = { ...replacement, dependencies: [...old.dependencies] };
      if (old && JSON.stringify(old) === JSON.stringify(replacement)) return { workflow: current, error: null };
      const workflow = { ...current, revision: current.revision + 1, nodes: old ? current.nodes.map(node => node.nodeId === id ? replacement : node) : [...current.nodes, replacement] };
      validateWorkflowDraft(workflow, cryptoReviewContext(command.input.selection.network));
      return { workflow: freeze(workflow), error: null };
    } catch (cause) { return reject(cause instanceof Error ? cause.message : 'ACTION_SELECTION_INVALID'); }
  }
  if(command.type==='AUTHOR_LENDING'){try{const workflow=createAuthoredLending(current.workflowId,current.revision+1,command.input);validateWorkflowDraft(workflow,createBaseSepoliaReviewContext());return{workflow:freeze(workflow),error:null};}catch(cause){return reject(cause instanceof Error?cause.message:'LENDING_INPUT_INVALID');}}
  if (command.type === 'ADD_RH_TRANSFER' || command.type === 'SET_RH_TRANSFER') {
    const editing = command.type === 'SET_RH_TRANSFER';
    try {
      if (editing && !current.nodes.some(n => n.nodeId === command.nodeId && n.actionType === 'asset.transfer')) return reject('UNKNOWN_TRANSFER_NODE');
      const id = editing ? command.nodeId : `node-${String(current.revision + 2).padStart(3, '0')}`;
      let replacement = createAuthoredTransfer(id, command.input);
      if (editing) replacement = { ...replacement, dependencies: [...current.nodes.find(n => n.nodeId === id)!.dependencies] };
      if (editing && JSON.stringify(replacement) === JSON.stringify(current.nodes.find(n => n.nodeId === id))) return { workflow: current, error: null };
      const workflow = { ...current, revision: current.revision + 1, nodes: !editing ? [...current.nodes, replacement] : current.nodes.map(n => n.nodeId === id ? replacement : n) };
      if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
      validateWorkflowDraft(workflow, context); return { workflow: freeze(workflow), error: null };
    } catch (cause) { return reject(cause instanceof Error ? cause.message : 'TRANSFER_INPUT_INVALID'); }
  }
  if (command.type === 'ADD_WITHDRAW' || command.type === 'SET_WITHDRAW' || command.type === 'ADD_REPAY' || command.type === 'SET_REPAY' || command.type === 'ADD_SUPPLY' || command.type === 'SET_SUPPLY' || command.type === 'ADD_BORROW' || command.type === 'SET_BORROW') {
    const withdrawing=command.type==='ADD_WITHDRAW'||command.type==='SET_WITHDRAW';
    const repaying=command.type==='ADD_REPAY'||command.type==='SET_REPAY';
    const borrowing=command.type==='ADD_BORROW'||command.type==='SET_BORROW';
    const editing=command.type==='SET_WITHDRAW'||command.type==='SET_REPAY'||command.type==='SET_SUPPLY'||command.type==='SET_BORROW';
    try {
      if (editing && !current.nodes.some(n => n.nodeId === command.nodeId && n.actionType === (withdrawing?'withdraw':repaying?'repay':borrowing?'borrow':'supply'))) return reject('UNKNOWN_SUPPLY_NODE');
      const id = editing ? command.nodeId : `node-${String(current.revision + 2).padStart(3, '0')}`;
      let replacement = withdrawing ? createAuthoredWithdraw(id,command.input) : (repaying?createAuthoredRepay:borrowing?createAuthoredBorrow:createAuthoredSupply)(id, command.input);
      if (editing) replacement = { ...replacement, dependencies: [...current.nodes.find(n => n.nodeId === id)!.dependencies] };
      if (editing && JSON.stringify(replacement) === JSON.stringify(current.nodes.find(n => n.nodeId === id))) return {workflow:current,error:null};
      const workflow = { ...current, revision: current.revision + 1, nodes: !editing ? [...current.nodes,replacement] : current.nodes.map(n => n.nodeId === id ? replacement : n) };
      if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
      validateWorkflowDraft(workflow, context); return {workflow:freeze(workflow),error:null};
    } catch (cause) { return reject(cause instanceof Error ? cause.message : 'SUPPLY_INPUT_INVALID'); }
  }
  if (command.type === 'ADD_SOLANA_SWAP' || command.type === 'SET_SOLANA_SWAP') {
    try {
      if (command.type === 'SET_SOLANA_SWAP' && !current.nodes.some(n => n.nodeId === command.nodeId && solanaSwapDetails(n))) return reject('UNKNOWN_SOLANA_SWAP_NODE');
      const id = command.type === 'SET_SOLANA_SWAP' ? command.nodeId : `node-${String(current.revision + 2).padStart(3, '0')}`;
      let replacement = createSolanaSwapNode(id, command.input);
      if (command.type === 'SET_SOLANA_SWAP') replacement = { ...replacement, dependencies: [...current.nodes.find(n => n.nodeId === id)!.dependencies] };
      if (command.type === 'SET_SOLANA_SWAP' && JSON.stringify(replacement) === JSON.stringify(current.nodes.find(n => n.nodeId === id))) return { workflow: current, error: null };
      let workflow: Workflow = { ...current, revision: current.revision + 1, nodes: command.type === 'ADD_SOLANA_SWAP' ? [...current.nodes, replacement] : current.nodes.map(n => n.nodeId === id ? replacement : n) };
      if (command.type === 'SET_SOLANA_SWAP') workflow = rebindConsumers(workflow, replacement);
      if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
      validateWorkflowDraft(workflow, context); return { workflow: freeze(workflow), error: null };
    } catch (cause) { return reject(cause instanceof Error ? cause.message : 'SOLANA_SWAP_INPUT_INVALID'); }
  }
  if (command.type === 'ADD_SOLANA_LIQUIDITY' || command.type === 'SET_SOLANA_LIQUIDITY') {
    try {
      if (command.type === 'SET_SOLANA_LIQUIDITY' && !current.nodes.some(n => n.nodeId === command.nodeId && solanaLiquidityDetails(n))) return reject('UNKNOWN_SOLANA_LIQUIDITY_NODE');
      const id = command.type === 'SET_SOLANA_LIQUIDITY' ? command.nodeId : `node-${String(current.revision + 2).padStart(3, '0')}`;
      let replacement = createSolanaLiquidityNode(id, command.input);
      if (command.type === 'SET_SOLANA_LIQUIDITY') {
        const old = current.nodes.find(n => n.nodeId === id)!, source = readConcentratedLiquiditySource(old as never).source, producer = current.nodes.find(n => n.nodeId === source?.nodeId);
        // A bound position stays bound to its swap output; its token side follows the swap, never the edit.
        replacement = source && producer ? bindCompositionConsumer(replacement, producer) : { ...replacement, dependencies: [...old.dependencies] };
      }
      if (command.type === 'SET_SOLANA_LIQUIDITY' && JSON.stringify(replacement) === JSON.stringify(current.nodes.find(n => n.nodeId === id))) return { workflow: current, error: null };
      const workflow = { ...current, revision: current.revision + 1, nodes: command.type === 'ADD_SOLANA_LIQUIDITY' ? [...current.nodes, replacement] : current.nodes.map(n => n.nodeId === id ? replacement : n) };
      if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
      validateWorkflowDraft(workflow, context); return { workflow: freeze(workflow), error: null };
    } catch (cause) { return reject(cause instanceof Error ? cause.message : 'SOLANA_LIQUIDITY_INPUT_INVALID'); }
  }
  if (command.type === 'ADD_SOLANA_COMPOSITION') {
    // Exactly the Canvas path, one reducer step at a time: add the swap (unless it exists), add the position, then link them; the link must bind.
    const step = (from: EditorState, next: Record<string, unknown>) => editorReducer(from, { ...next, source: command.source, baseRevision: from.workflow.revision } as Command, context);
    let next: EditorState = { workflow: current, error: null }, producer = command.from;
    if (command.swap) { next = step(next, { type: 'ADD_SOLANA_SWAP', input: command.swap }); producer = next.workflow.nodes.at(-1)!.nodeId; }
    else if (current.nodes.some(node => boundTo(node, command.from!))) return reject('COMPOSITION_PRODUCER_ALREADY_BOUND');
    if (next.error) return reject(next.error);
    next = step(next, { type: 'ADD_SOLANA_LIQUIDITY', input: command.liquidity });
    if (next.error) return reject(next.error);
    const consumer = next.workflow.nodes.at(-1)!.nodeId;
    next = step(next, { type: 'CONNECT', from: producer, to: consumer });
    if (next.error) return reject(next.error);
    if (!boundTo(next.workflow.nodes.find(node => node.nodeId === consumer)!, producer!)) return reject('COMPOSITION_UNSUPPORTED');
    return next;
  }
  if (command.type === 'MANAGE_SOLANA_POSITION') {
    // The Orca runtime manages a position from a workflow whose only financial step is that position: the existing position step keeps its id and is
    // set to the position's verified range (unlinked); other Solana Devnet swap or position steps are removed. Any other step blocks the proposal.
    if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
    const financial = current.nodes.filter(node => !node.actionType.startsWith('mock-'));
    if (financial.some(node => !solanaLiquidityDetails(node) && solanaSwapDetails(node)?.network !== 'Solana Devnet')) return reject('POSITION_WORKFLOW_HAS_OTHER_STEPS');
    try {
      const keep = financial.find(node => solanaLiquidityDetails(node));
      const id = keep?.nodeId ?? `node-${String(current.revision + 2).padStart(3, '0')}`;
      const position = createSolanaLiquidityNode(id, command.input);
      const removed = new Set(financial.map(node => node.nodeId).filter(nodeId => nodeId !== id));
      const nodes = [...current.nodes.filter(node => !removed.has(node.nodeId) && node.nodeId !== id).map(node => ({ ...node, dependencies: node.dependencies.filter(dep => !removed.has(dep)) })), position];
      const resourceEdges = current.resourceEdges.filter(edge => !removed.has(edge.fromNodeId) && !removed.has(edge.toNodeId) && edge.toNodeId !== id);
      if (JSON.stringify(nodes) === JSON.stringify(current.nodes) && JSON.stringify(resourceEdges) === JSON.stringify(current.resourceEdges)) return { workflow: current, error: null };
      const workflow = { ...current, revision: current.revision + 1, nodes, resourceEdges };
      validateWorkflowDraft(workflow, context); return { workflow: freeze(workflow), error: null };
    } catch (cause) { return reject(cause instanceof Error ? cause.message : 'SOLANA_LIQUIDITY_INPUT_INVALID'); }
  }
  if (command.type === 'ADD_UNISWAP_LIQUIDITY' || command.type === 'SET_UNISWAP_LIQUIDITY') {
    try {
      if (command.type === 'SET_UNISWAP_LIQUIDITY' && !current.nodes.some(n => n.nodeId === command.nodeId && uniswapLiquidityDetails(n))) return reject('UNKNOWN_UNISWAP_LIQUIDITY_NODE');
      const id = command.type === 'SET_UNISWAP_LIQUIDITY' ? command.nodeId : `node-${String(current.revision + 2).padStart(3, '0')}`;
      let replacement = createUniswapLiquidityNode(id, command.input);
      if (command.type === 'SET_UNISWAP_LIQUIDITY') replacement = { ...replacement, dependencies: [...current.nodes.find(n => n.nodeId === id)!.dependencies] };
      if (command.type === 'SET_UNISWAP_LIQUIDITY' && JSON.stringify(replacement) === JSON.stringify(current.nodes.find(n => n.nodeId === id))) return { workflow: current, error: null };
      const workflow = { ...current, revision: current.revision + 1, nodes: command.type === 'ADD_UNISWAP_LIQUIDITY' ? [...current.nodes, replacement] : current.nodes.map(n => n.nodeId === id ? replacement : n) };
      if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
      validateWorkflowDraft(workflow, context); return { workflow: freeze(workflow), error: null };
    } catch (cause) { return reject(cause instanceof Error ? cause.message : 'UNISWAP_LIQUIDITY_INPUT_INVALID'); }
  }
  if (command.type === 'AUTHOR_CROSS_CHAIN_LIQUIDITY') {
    if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
    try { const workflow = createCrossChainLiquidityWorkflow(current.workflowId, current.revision + 1, command.input);
      validateWorkflowDraft(workflow, context); return { workflow: freeze(workflow), error: null };
    } catch (cause) { return reject(cause instanceof Error ? cause.message : 'CROSS_CHAIN_LIQUIDITY_INVALID'); }
  }
  if (command.type === 'AUTHOR_ACROSS') {
    if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
    try { const workflow = createAcrossWorkflow(current.workflowId, current.revision + 1, command.input);
      validateWorkflowDraft(workflow, context); return { workflow: freeze(workflow), error: null };
    } catch (cause) { return reject(cause instanceof Error ? cause.message : 'ACROSS_WORKFLOW_INVALID'); }
  }
  if (command.type === 'AUTHOR_BRIDGE_SWAP') {
    if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
    try { const workflow = createBridgeSwapWorkflow(current.workflowId, current.revision + 1, command.input);
      validateWorkflowDraft(workflow, context); return { workflow: freeze(workflow), error: null };
    } catch (cause) { return reject(cause instanceof Error ? cause.message : 'BRIDGE_SWAP_INVALID'); }
  }
  if (command.type === 'ADD_ROUTER_BRIDGE' || command.type === 'SET_ROUTER_BRIDGE') {
    if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
    try {
      if (command.type === 'SET_ROUTER_BRIDGE' && !current.nodes.some(node => node.nodeId === command.nodeId && routerDetails(node))) return reject('UNKNOWN_ROUTER_NODE');
      const id = command.type === 'SET_ROUTER_BRIDGE' ? command.nodeId : `node-${String(current.revision + 2).padStart(3, '0')}`;
      let replacement = createRouterNode(id, command.input);
      if (command.type === 'SET_ROUTER_BRIDGE') replacement = { ...replacement, dependencies: [...current.nodes.find(n => n.nodeId === id)!.dependencies] };
      if (command.type === 'SET_ROUTER_BRIDGE' && JSON.stringify(replacement) === JSON.stringify(current.nodes.find(n => n.nodeId === id))) return { workflow: current, error: null };
      const workflow = { ...current, revision: current.revision + 1, nodes: command.type.startsWith('SET_') ? current.nodes.map(n => n.nodeId === id ? { ...replacement, dependencies: [...n.dependencies] } : n) : [...current.nodes.filter(n => !n.actionType.startsWith('mock-')), replacement] };
      validateWorkflowDraft(workflow, context);
      return { workflow: freeze(workflow), error: null };
    } catch (cause) { return reject(cause instanceof Error ? cause.message : 'ROUTER_INPUT_INVALID'); }
  }
  if (command.type === 'ADD_UNIVERSAL_BRIDGE' || command.type === 'SET_UNIVERSAL_BRIDGE') {
    if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
    try {
      if (command.type === 'SET_UNIVERSAL_BRIDGE' && !current.nodes.some(node => node.nodeId === command.nodeId && (universalBridgeDetails(node) || routerDetails(node)))) return reject('UNKNOWN_UNIVERSAL_BRIDGE_NODE');
      const id = command.type === 'SET_UNIVERSAL_BRIDGE' ? command.nodeId : `node-${String(current.revision + 2).padStart(3, '0')}`;
      const replacement = createUniversalBridgeFromInput(id, command.input);
      if (command.type === 'SET_UNIVERSAL_BRIDGE' && JSON.stringify({ ...replacement, dependencies: [] }) === JSON.stringify({ ...current.nodes.find(n => n.nodeId === id), dependencies: [] }))
        return { workflow: current, error: null };
      // The universal bridge is an isolated publicly executable capability: it replaces authoring templates, and on SET keeps the node's links.
      const workflow = { ...current, revision: current.revision + 1, nodes: command.type === 'SET_UNIVERSAL_BRIDGE'
        ? current.nodes.map(n => n.nodeId === id ? { ...replacement, dependencies: [...n.dependencies] } : n) : [...current.nodes.filter(n => !n.actionType.startsWith('mock-')), replacement] };
      validateWorkflowDraft(workflow, context);
      return { workflow: freeze(workflow), error: null };
    } catch (cause) { return reject(cause instanceof Error ? cause.message : 'UNIVERSAL_BRIDGE_INPUT_INVALID'); }
  }
  if (command.type === 'ADD_BRIDGE' || command.type === 'SET_BRIDGE') {
    if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
    try {
      if (command.type === 'SET_BRIDGE' && !current.nodes.some(node => node.nodeId === command.nodeId && node.actionType === BRIDGE_ACTION)) return reject('UNKNOWN_BRIDGE_NODE');
      const id = command.type === 'SET_BRIDGE' ? command.nodeId : `node-${String(current.revision + 2).padStart(3, '0')}`;
      const replacement = createBridgeNode(id, command.input);
      const workflow = { ...current, revision: current.revision + 1, nodes: command.type.startsWith('SET_') ? current.nodes.map(n => n.nodeId === id ? { ...replacement, dependencies: [...n.dependencies] } : n) : [...current.nodes.filter(n => !n.actionType.startsWith('mock-')), replacement] };
      validateWorkflowDraft(workflow, context);
      return { workflow: freeze(workflow), error: null };
    } catch (cause) { return reject(cause instanceof Error ? cause.message : 'INVALID_BRIDGE_INPUT'); }
  }
  if (command.type === 'AUTHOR_COMPOSITION') {
    if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
    try {
      const workflow = createCompositionWorkflow(current.workflowId, current.revision + 1, command.safe, command.input, context);
      validateWorkflowDraft(workflow, context);
      return { workflow: freeze(workflow), error: null };
    } catch (cause) { return reject(cause instanceof Error ? cause.message : 'INVALID_COMPOSITION'); }
  }
  let nodes = [...current.nodes];
  let resourceEdges = [...current.resourceEdges];
  if (command.type === 'REMOVE_MANY' || command.type === 'REMOVE') {
    // BUILD-SOLANA-MAINNET-001 (requirement D): any action can be deleted (canvas-keyboard.ts `planCanvasRemoval`). Deleting the last action
    // leaves the empty draft (BUILD-FLOFI-PRODUCT-UX-001: no node at all) and no card; nothing replaces the deleted one.
    const selected = command.type === 'REMOVE' ? [command.nodeId] : command.nodeIds;
    const plan = resolveCanvasRemoval(current, selected, context);
    if (!plan || selected.some(id => !plan.removed.includes(id))) return reject('UNKNOWN_NODE');
    ({ nodes, resourceEdges } = applyCanvasRemoval(current, plan));
  } else if (command.type === 'ADD' || command.type === 'ADD_SWAP' || command.type === 'ADD_TESTNET_SWAP' || command.type === 'ADD_ETHEREUM_SEPOLIA_SWAP' || command.type === 'ADD_COW_SWAP' || command.type === 'ADD_LIQUIDITY') {
    if (nodes.length >= 1024) return reject('NODE_LIMIT');
    const id = `node-${String(current.revision + 2).padStart(3, '0')}`;
    if (nodes.some(node => node.nodeId === id)) return reject('DUPLICATE_NODE');
    if (command.type === 'ADD') nodes.push(createMockNode(id, command.kind));
    else {
      if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
      if (command.type === 'ADD_LIQUIDITY') {
        if (nodes.some(n => n.actionType === LIQUIDITY_ACTION)) return reject('ONE_LIQUIDITY_POSITION_ONLY');
        try { nodes.push(createLiquidityNode(id, command.input, context)); }
        catch (cause) { return reject(cause instanceof Error ? cause.message : 'INVALID_LIQUIDITY_INPUT'); }
      } else {
        // A swap is built from its own command's network. A Base (mainnet) swap never inherits a testnet context.
        const swapContext = command.type === 'ADD_TESTNET_SWAP' ? createBaseSepoliaReviewContext() : command.type === 'ADD_ETHEREUM_SEPOLIA_SWAP' ? createEthereumSepoliaReviewContext() : context;
        if ((command.type === 'ADD_SWAP' || command.type === 'ADD_COW_SWAP') && swapContext.assets.USDC.asset.chainId === 'eip155:11155111') return reject('SWAP_NETWORK_MISMATCH');
        try { nodes.push(createSwapNode(id, command.direction, command.amount, command.slippage, swapContext, command.type === 'ADD_COW_SWAP' ? 'cow' : 'uniswap')); }
        catch (cause) { return reject(cause instanceof Error ? cause.message : 'INVALID_SWAP_INPUT'); }
      }
    }
  } else if (command.type === 'CONNECT') {
    if (command.from === command.to || !nodes.some(n => n.nodeId === command.from)
        || !nodes.some(n => n.nodeId === command.to)) return reject('INVALID_CONNECTION');
    const target = nodes.find(n => n.nodeId === command.to)!;
    if (nodes.find(n => n.nodeId === command.from)!.actionType.startsWith('mock-') !== target.actionType.startsWith('mock-')) return reject('ISOLATED_ACTION_EDGE_UNSUPPORTED');
    if (target.dependencies.includes(command.from)) return { workflow: current, error: null };
    const ancestors = (id: string, seen = new Set<string>()): boolean => {
      if (id === command.to) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return nodes.find(n => n.nodeId === id)!.dependencies.some(parent => ancestors(parent, seen));
    };
    if (ancestors(command.from)) return reject('CYCLIC_CONNECTION');
    const producer = nodes.find(n => n.nodeId === command.from)!;
    const mockLink = producer.actionType.startsWith('mock-') && target.actionType.startsWith('mock-');
    if (mockLink && target.inputs.some(input => input.name === 'source')) return reject('INPUT_ALREADY_CONNECTED');
    // A registered composition pair links typed: the position's maximum for the swapped token becomes min(cap, the swap's
    // actual reconciled output). Any other link stays an ordering dependency, as before.
    const composition = !mockLink && !target.dependencies.length && !target.inputs.some(input => input.kind === 'OUTPUT_REFERENCE') ? compositionBindingFor(producer, target) : null;
    const bound = composition ? bindCompositionConsumer(target, producer) : null;
    nodes = nodes.map(n => n.nodeId === command.to ? bound ?? { ...n, dependencies: [...n.dependencies, command.from],
      inputs: mockLink ? [...n.inputs, { name: 'source' as const, kind: 'OUTPUT_REFERENCE' as const,
        value: { nodeId: command.from, outputId: 'result' } }] : n.inputs,
    } : n);
    if (mockLink) resourceEdges.push({ fromNodeId: command.from, outputId: 'result', toNodeId: command.to, inputName: 'source' });
    if (bound && composition) resourceEdges.push({ fromNodeId: command.from, outputId: composition.binding.producer.outputId, toNodeId: command.to, inputName: bound.inputs.at(-1)!.name });
  } else if (command.type === 'DISCONNECT') {
    if (!current.nodes.some(node => node.nodeId === command.to && node.dependencies.includes(command.from))) return reject('UNKNOWN_CONNECTION');
    if (!canDeleteCanvasEdge(current, command.from, command.to)) return reject('PROTECTED_CONNECTION: this connection is required by the workflow.');
    resourceEdges = resourceEdges.filter(edge => !(edge.fromNodeId === command.from && edge.toNodeId === command.to));
    nodes = nodes.map(node => node.nodeId === command.to && boundTo(node, command.from) ? unbindCompositionConsumer(node) : node.nodeId === command.to ? { ...node,
      dependencies: node.dependencies.filter(id => id !== command.from),
      inputs: node.inputs.filter(input => !(input.name === 'source' && input.kind === 'OUTPUT_REFERENCE'
        && input.value.nodeId === command.from)),
    } : node);
  } else {
    const node = nodes.find(n => n.nodeId === command.nodeId);
    if (!node) return reject('UNKNOWN_NODE');
    if (['supply','borrow','repay','withdraw','asset.transfer'].includes(node.actionType)) { return reject('SUPPLY_REVIEWED_EDIT_REQUIRED');
    } else if (node.actionType === LIQUIDITY_ACTION) {
      if (command.type !== 'SET_LIQUIDITY' || !context) return reject('INVALID_LIQUIDITY_COMMAND');
      try {
        const replacement = { ...createLiquidityNode(node.nodeId, command.input, context), dependencies: [...node.dependencies] };
        if (JSON.stringify(replacement) === JSON.stringify(node)) return { workflow: current, error: null };
        nodes = nodes.map(n => n.nodeId === node.nodeId ? replacement : n);
      } catch (cause) { return reject(cause instanceof Error ? cause.message : 'INVALID_LIQUIDITY_INPUT'); }
    } else if (node.actionType === SWAP_ACTION) {
      if (!context) return reject('REVIEW_CONTEXT_REQUIRED');
      const details = swapDetails(node, context);
      const parameter = node.inputs.find(p => p.name === 'amount-in');
      if (!details || parameter?.kind !== 'QUANTITY') return reject('INVALID_SWAP_NODE');
      const locked = node.lockedParameters.some(p => p.name === 'amount-in');
      if (command.type === 'LOCK') {
        if (locked === command.locked) return { workflow: current, error: null };
        nodes = nodes.map(n => n.nodeId === node.nodeId ? { ...n,
          lockedParameters: command.locked ? [parameter] : [],
          editableBounds: command.locked ? [] : [{ parameterName: 'amount-in', asset: { ...parameter.value.asset }, minimumAmount: '1', maximumAmount: context.assets[details.from].maximumAmountUnits }],
        } : n);
      } else if (command.type === 'SET_SWAP_AMOUNT') {
        if (locked) return reject('LOCKED_PARAMETER: unlock on canvas before editing.');
        let amount: string;
        try { amount = parseHumanAmount(command.amount, details.from, context); }
        catch (cause) { return reject(cause instanceof Error ? cause.message : 'INVALID_AMOUNT'); }
        if (amount === details.units) return { workflow: current, error: null };
        nodes = nodes.map(n => n.nodeId === node.nodeId ? { ...n,
          inputs: n.inputs.map(p => p.name === 'amount-in' ? { ...parameter, value: { ...parameter.value, amount } } : p),
          userConstraints: n.userConstraints.map(c => c.kind === 'MAXIMUM_INPUT' ? { ...c, quantity: { ...c.quantity, amount } } : c),
        } : n);
      } else if (command.type === 'SET_SLIPPAGE') {
        let bps: number;
        try { bps = parseSlippage(command.slippage); }
        catch (cause) { return reject(cause instanceof Error ? cause.message : 'INVALID_SLIPPAGE'); }
        if (details.slippage === bps) return { workflow: current, error: null };
        if (node.userConstraints.filter(c => c.kind === 'MAXIMUM_SLIPPAGE_BPS').length !== 1) return reject('SLIPPAGE_REQUIRED_ONCE');
        nodes = nodes.map(n => n.nodeId === node.nodeId ? { ...n,
          userConstraints: n.userConstraints.map(c => c.kind === 'MAXIMUM_SLIPPAGE_BPS' ? { ...c, maximumBps: bps } : c),
        } : n);
      } else return reject('INVALID_SWAP_COMMAND');
    } else {
      const parameter = node.inputs.find(input => input.name === 'amount');
      if (!parameter || parameter.kind !== 'QUANTITY') return reject('UNKNOWN_PARAMETER');
      const locked = node.lockedParameters.some(input => input.name === 'amount');
      if (command.type === 'LOCK') {
        if (locked === command.locked) return { workflow: current, error: null };
        nodes = nodes.map(n => n.nodeId === node.nodeId ? { ...n, lockedParameters: command.locked ? [parameter] : [] } : n);
      } else if (command.type === 'SET_AMOUNT') {
        if (locked) return reject('LOCKED_PARAMETER: unlock on canvas before editing.');
        if (BigInt(command.amount) > (1n << 256n) - 1n) return reject('AMOUNT_OUT_OF_RANGE');
        if (command.amount === parameter.value.amount) return { workflow: current, error: null };
        nodes = nodes.map(n => n.nodeId === node.nodeId ? { ...n, inputs: n.inputs.map(input => input.name === 'amount'
          ? { ...parameter, value: { ...parameter.value, amount: command.amount } } : input) } : n);
      } else return reject('INVALID_MOCK_COMMAND');
    }
  }
  const candidate = { ...current, revision: current.revision + 1, nodes, resourceEdges };
  // BUILD-FLOFI-PRODUCT-UX-001: deleting the last action leaves the empty draft (no node), which has nothing to validate.
  if (!candidate.nodes.length) return { workflow: freeze(candidate), error: null };
  if (context) {
    // A public testnet swap is validated against its own chain's trusted assets (Base Sepolia or Ethereum Sepolia).
    const swapChain = candidate.nodes.find(n => n.actionType === SWAP_ACTION && (n.chainId === 'eip155:84532' || n.chainId === 'eip155:11155111'))?.chainId;
    try { validateWorkflowDraft(candidate, swapChain ? reviewContextForChain(swapChain, context) : context); }
    catch (cause) { return reject(cause instanceof Error ? cause.message : 'INVALID_WORKFLOW'); }
  } else if (nodes.some(n => [SWAP_ACTION, LIQUIDITY_ACTION].includes(n.actionType))) return reject('REVIEW_CONTEXT_REQUIRED');
  return { workflow: freeze(candidate), error: null };
}

/** The graph after a Canvas removal plan: links into removed steps are dropped and unbound consumers return to their isolated form. */
function applyCanvasRemoval(current: Workflow, plan: CanvasRemoval) {
  const removed = new Set(plan.removed), unbound = new Set(plan.unbound);
  const nodes = current.nodes.filter(node => !removed.has(node.nodeId)).map(node => {
    const own = unbound.has(node.nodeId) ? unbindCompositionConsumer(node) : node;
    return { ...own, dependencies: own.dependencies.filter(id => !removed.has(id)),
      inputs: own.inputs.filter(input => !(input.kind === 'OUTPUT_REFERENCE' && removed.has(input.value.nodeId))) };
  });
  return { nodes, resourceEdges: current.resourceEdges.filter(edge => !removed.has(edge.fromNodeId) && !removed.has(edge.toNodeId)) };
}
/** The steps linked to `ids` by dependencies, output references or resource edges, in either direction (a whole composition). */
function connectedSteps(workflow: Workflow, ids: readonly string[]): Set<string> {
  const links = new Map<string, Set<string>>(workflow.nodes.map(node => [node.nodeId, new Set<string>()]));
  const link = (a: string, b: string) => { links.get(a)?.add(b); links.get(b)?.add(a); };
  for (const node of workflow.nodes) {
    for (const parent of node.dependencies) link(node.nodeId, parent);
    for (const input of node.inputs) if (input.kind === 'OUTPUT_REFERENCE') link(node.nodeId, input.value.nodeId);
  }
  for (const edge of workflow.resourceEdges) link(edge.fromNodeId, edge.toNodeId);
  const found = new Set(ids), queue = [...ids];
  while (queue.length) for (const next of links.get(queue.pop()!) ?? []) if (!found.has(next)) { found.add(next); queue.push(next); }
  return found;
}
/**
 * BUILD-SOLANA-MAINNET-001 (requirement D): what deleting `ids` removes. The plan of `planCanvasRemoval`; when the steps it leaves are not a valid
 * draft — the steps of a fixed composition (Supply → Borrow → Swap, a BUILD-009 bridge → swap, a cross-chain bridge → liquidity) only run
 * together — the deletion removes that whole composition instead of refusing. The Canvas names every additional step it removes; undo restores all.
 */
export function resolveCanvasRemoval(current: Workflow, ids: readonly string[], context?: ReviewContext): CanvasRemoval | null {
  const first = planCanvasRemoval(current, ids);
  if (!first || !context) return first;
  const valid = (plan: CanvasRemoval) => {
    const candidate = { ...current, revision: current.revision + 1, ...applyCanvasRemoval(current, plan) };
    if (!candidate.nodes.length) return true;
    const swapChain = candidate.nodes.find(n => n.actionType === SWAP_ACTION && (n.chainId === 'eip155:84532' || n.chainId === 'eip155:11155111'))?.chainId;
    try { validateWorkflowDraft(candidate, swapChain ? reviewContextForChain(swapChain, context) : context); return true; } catch { return false; }
  };
  if (valid(first)) return first;
  const whole = connectedSteps(current, first.removed);
  const removed = current.nodes.filter(node => whole.has(node.nodeId)).map(node => node.nodeId);
  return { removed, cascaded: removed.filter(id => !ids.includes(id)), unbound: [] };
}
/** A position bound to `producer`'s output (composition-bindings.ts). */
function boundTo(node: Workflow['nodes'][number], producer: string): boolean {
  try { return readConcentratedLiquiditySource(node as never).source?.nodeId === producer; } catch { return false; }
}
/** After a swap edit, each position bound to it is re-bound to the swap's (possibly changed) output token, or left as an ordering link. */
function rebindConsumers(workflow: Workflow, producer: Workflow['nodes'][number]): Workflow {
  let resourceEdges = [...workflow.resourceEdges];
  const nodes = workflow.nodes.map(node => {
    if (!boundTo(node, producer.nodeId)) return node;
    resourceEdges = resourceEdges.filter(edge => !(edge.fromNodeId === producer.nodeId && edge.toNodeId === node.nodeId));
    const isolated = unbindCompositionConsumer(node), match = compositionBindingFor(producer, isolated);
    if (!match) return { ...isolated, dependencies: [producer.nodeId] };
    const bound = bindCompositionConsumer(isolated, producer);
    resourceEdges.push({ fromNodeId: producer.nodeId, outputId: match.binding.producer.outputId, toNodeId: node.nodeId, inputName: bound.inputs.at(-1)!.name });
    return bound;
  });
  return { ...workflow, nodes, resourceEdges };
}
