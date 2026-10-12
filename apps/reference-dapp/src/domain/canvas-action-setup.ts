// SPDX-License-Identifier: AGPL-3.0-only
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import type { Workflow } from './initial-workflow';
import type { Command } from './commands';
import { createUniswapLiquidityNode, type UniswapLiquidityInput } from './uniswap-liquidity-authoring';
import { canvasAddCommand } from './canvas-authoring';
import { swapDetails, inputSymbol, directionLabel, SWAP_DEFAULT_SLIPPAGE_BPS, type Direction } from './swap-authoring';
import { ROBINHOOD_NETWORK } from './asset-catalogs';
import { networkIdentity } from './network-registry';
import { createRouterNode, routerDetails, routerInputForNetworks, routerInputOf, routerTokensOf, ROUTER_NETWORK_OPTIONS, type RouterBridgeInput } from './router-authoring';
import { createBridgeNode, bridgeDetails } from './bridge-authoring';
import { shellChainLabel } from './product-shell';
import { editorReducer, type EditorState } from './editor';
import { createAuthoredSupply, createAuthoredBorrow, createAuthoredRepay, createAuthoredWithdraw, supplyDetails, borrowDetails, repayDetails, withdrawDetails } from './supply-authoring';
import { lendingDetails, lendingNodeInput } from './lending-authoring';
import { createAuthoredTransfer, transferDetails } from './robinhood-transfer-authoring';
import { singleAmountProposalTarget } from './composer-presentation';
import { createCryptoActionNode, cryptoInputOf, cryptoProfile, canSelectCryptoAssets, defaultPoolRange, type CryptoSelection, type CryptoSelections, type CryptoActionInput } from './crypto-action-picker';
import { checkRecipient } from './recipient-address';

/** Required-field authoring only, never an executable node or alternate workflow. */
/** `cryptoRecipient` (UX-001): the Send card's typed "To" text, committed only as the transfer's canonical `recipient` on Apply. */
export type CanvasActionSetup = { readonly id: string; readonly amount: string; readonly cryptoSelection?: CryptoSelection; readonly cryptoBeneficiary?: string; readonly cryptoRecipient?: string } &
  ({ readonly action: 'pool'; readonly input: UniswapLiquidityInput } |
  /** `stocks`: the Stocks card (BUILD-RH-002): a Robinhood Chain catalog swap that buys a Stock Token with USDG. */
  { readonly action: 'swap'; readonly direction?: Direction; readonly stocks?: true } | { readonly action: 'bridge'; readonly networks?: CanvasBridgeNetworks } | { readonly action: 'withdraw' | 'transfer' } | { readonly action: 'supply' | 'borrow' | 'repay'; readonly beneficiary: string });
export type CanvasBridgeNetworks = Pick<RouterBridgeInput, 'source' | 'destination'>;
export type CanvasBridgeNetworkInputs = Readonly<Record<string, CanvasBridgeNetworks>>;
/** UX-001: an authored Send card's edited "To" text (like an amount draft); Apply commits it to that node's canonical `recipient`. */
export type CanvasRecipientInputs = Readonly<Record<string, string>>;
export const CANVAS_BRIDGE_NETWORK_OPTIONS = {
  source: Object.values(ROUTER_NETWORK_OPTIONS).map(option => option.source),
  destination: Object.values(ROUTER_NETWORK_OPTIONS).map(option => option.destination),
} as const;
/** "USDC → USDC", or (BUILD-RH-002) "USDC → USDG" into Robinhood Chain; an unsupported chain pair keeps the neutral USDC wording. */
export function bridgePairLabel(networks: CanvasBridgeNetworks): string {
  const tokens = routerTokensOf(networks);
  return tokens ? `${tokens.token} → ${tokens.destinationToken}` : 'USDC → USDC';
}
export function bridgeSetupNetworks(setup: Extract<CanvasActionSetup, { action: 'bridge' }>): CanvasBridgeNetworks {
  return setup.networks ?? { source: ROUTER_NETWORK_OPTIONS.testnet.source, destination: ROUTER_NETWORK_OPTIONS.testnet.destination };
}
export function canvasAmountReviewValue(amount: string | undefined, networks?: CanvasBridgeNetworks) {
  return networks && amount !== undefined ? JSON.stringify([amount, networks.source, networks.destination]) : amount;
}
export function setupReviewValue(setup: CanvasActionSetup) { return setup.action === 'pool' ? JSON.stringify(setup.input) : setup.action === 'swap' && setup.direction ? JSON.stringify([setup.amount, setup.direction]) : setup.action === 'bridge' ? canvasAmountReviewValue(setup.amount, setup.networks)! : setup.amount; }
export function cryptoSetupInput(setup: CanvasActionSetup): CryptoActionInput {
  if (!setup.cryptoSelection) throw new Error('ACTION_SELECTION_REQUIRED');
  return { selection: setup.cryptoSelection, amount: setup.action === 'pool' ? setup.input.maxUsdc : setup.amount,
    slippage: setup.action === 'pool' ? setup.input.slippage : setup.action === 'swap' ? String(SWAP_DEFAULT_SLIPPAGE_BPS) : '50', ...(setup.cryptoBeneficiary ? { beneficiary: setup.cryptoBeneficiary } : 'beneficiary' in setup ? { beneficiary: setup.beneficiary } : {}),
    ...(setup.cryptoSelection.action === 'transfer' && setup.cryptoRecipient !== undefined ? { recipient: setup.cryptoRecipient } : {}),
    ...(setup.action === 'pool' ? { secondAmount: setup.input.maxWeth, rangeUnit: setup.input.rangeUnit, lower: setup.input.lower, upper: setup.input.upper } : {}) };
}
export function actionReviewValue(setup: CanvasActionSetup | null, id: string, amount: string | undefined, bridge?: CanvasBridgeNetworks, selection?: CryptoSelection, recipient?: string) {
  if (setup?.id === id) return setup.cryptoSelection ? JSON.stringify(cryptoSetupInput(setup)) : setupReviewValue(setup);
  const value = selection ? JSON.stringify([amount, selection]) : canvasAmountReviewValue(amount, bridge);
  // A reviewed proposal is current only for the exact typed destination too.
  return recipient === undefined || value === undefined ? value : JSON.stringify([value, recipient]);
}
/** UX-001: the canonical recipient an edited "To" text authors on `network`; an empty or malformed destination never reaches a command. */
function recipientEdit(network: string, text: string | undefined): { recipient?: string } {
  if (text === undefined) return {};
  const check = checkRecipient(network, text);
  if (!check.ok) throw new Error(check.code);
  return { recipient: check.recipient };
}
export type CanvasAmountInputs = Readonly<Record<string, string>>;

export function amountCommandTarget(command: Command, workflow?: Workflow, preferredId?: string) {
  if (command.type === 'SET_CRYPTO_ACTION') return { id: command.nodeId, amount: command.input.amount };
  if (command.type === 'SET_SWAP_AMOUNT') return { id: command.nodeId, amount: command.amount };
  if (command.type === 'SET_ROUTER_BRIDGE' || command.type === 'SET_BRIDGE') return { id: command.nodeId, amount: command.input.amount };
  if (command.type === 'SET_SUPPLY' || command.type === 'SET_BORROW' || command.type === 'SET_REPAY' || command.type === 'SET_WITHDRAW' || command.type === 'SET_RH_TRANSFER') return { id: command.nodeId, amount: command.input.amount };
  if (command.type === 'AUTHOR_LENDING' && workflow) {
    const id = singleAmountProposalTarget(workflow, command, preferredId);
    if (id) return { id, amount: id === 'lending-supply' ? command.input.supply : command.input.borrow };
  }
  return null;
}

export function canvasAuthoringIncomplete(setup: CanvasActionSetup | null, inputs: CanvasAmountInputs) {
  return setup !== null || Object.keys(inputs).length > 0;
}

export function canEditCanvasAmount(node: Workflow['nodes'][number], context: ReviewContext, workflow?: Workflow) {
  if (node.lockedParameters.length) return false;
  if (workflow && canSelectCryptoAssets(node, workflow)) return true;
  if (workflow && lendingDetails(workflow) && ['lending-supply', 'lending-borrow'].includes(node.nodeId)) return true;
  return Boolean(supplyDetails(node as Parameters<typeof supplyDetails>[0]) || borrowDetails(node as Parameters<typeof borrowDetails>[0]) || repayDetails(node as Parameters<typeof repayDetails>[0]) || withdrawDetails(node as Parameters<typeof withdrawDetails>[0]) || swapDetails(node, context) || routerDetails(node) ||
    (bridgeDetails(node) && !node.inputs.some(input => input.kind === 'OUTPUT_REFERENCE')));
}

export function canvasAmountCommand(state: EditorState, setup: CanvasActionSetup | null, inputs: CanvasAmountInputs, id: string, context: ReviewContext, bridgeNetworks: CanvasBridgeNetworkInputs = {}, cryptoSelections: CryptoSelections = {}, recipients: CanvasRecipientInputs = {}) {
  let command: Command;
  if (setup?.id === id) {
    if (setup.cryptoSelection) {
      const input: CryptoActionInput = cryptoSetupInput(setup);
      // A Send to a recipient-capable network requires its typed destination; owner-only networks stay CONNECTED_OWNER.
      if (setup.cryptoSelection.action === 'transfer') {
        const check = checkRecipient(setup.cryptoSelection.network, setup.cryptoRecipient);
        if (!check.ok) throw new Error(check.code);
        delete input.recipient;
        if (check.recipient !== 'CONNECTED_OWNER') input.recipient = check.recipient;
      }
      createCryptoActionNode('node-preview', input);
      command = { type: 'ADD_CRYPTO_ACTION', input, source: 'CANVAS', baseRevision: state.workflow.revision };
    } else {
    command = setup.action === 'pool'
      ? { type: 'ADD_UNISWAP_LIQUIDITY', input: setup.input, source: 'CANVAS', baseRevision: state.workflow.revision }
      : canvasAddCommand(setup.action, state.workflow.revision, 'beneficiary' in setup ? setup.beneficiary : null, setup.amount);
    if (command.type === 'ADD_SWAP' && setup.action === 'swap' && setup.direction) command = { ...command, direction: setup.direction };
    if (command.type === 'ADD_ROUTER_BRIDGE' && setup.action === 'bridge') command = { ...command, input: routerInputForNetworks(command.input, bridgeSetupNetworks(setup)) };
    }
  }
  else {
    const node = state.workflow.nodes.find(item => item.nodeId === id);
    if (!node || !canEditCanvasAmount(node, context, state.workflow) || inputs[id] === undefined) throw new Error('Select an editable action.');
    const amount = inputs[id];
    const base = { nodeId: id, source: 'CANVAS' as const, baseRevision: state.workflow.revision };
    const lending = lendingDetails(state.workflow);
    const router = routerDetails(node), bridge = bridgeDetails(node), supply = lending ? null : supplyDetails(node as Parameters<typeof supplyDetails>[0]), borrow = lending ? null : borrowDetails(node as Parameters<typeof borrowDetails>[0]), repay = repayDetails(node as Parameters<typeof repayDetails>[0]), withdraw = withdrawDetails(node as Parameters<typeof withdrawDetails>[0]);
    const transfer = transferDetails(node as Parameters<typeof transferDetails>[0]);
    const cryptoInput = cryptoSelections[id] ? cryptoInputOf(node) : null;
    command = cryptoInput ? { ...base, type: 'SET_CRYPTO_ACTION', input: { ...cryptoInput, selection: cryptoSelections[id]!, amount,
      ...(cryptoInput.selection.action === 'pool' && cryptoInput.selection.network !== cryptoSelections[id]!.network ? defaultPoolRange(cryptoSelections[id]!.network) : {}),
      ...(cryptoInput.selection.action === 'transfer' ? recipientEdit(cryptoSelections[id]!.network, recipients[id]) : {}) } }
      : transfer ? { ...base, type: 'SET_RH_TRANSFER', input: { ...transfer, amount, ...recipientEdit(transfer.network, recipients[id]) } }
      : lending && (id === 'lending-supply' || id === 'lending-borrow')
      ? { type: 'AUTHOR_LENDING', input: lendingNodeInput(state.workflow, id, amount), source: 'CANVAS', baseRevision: state.workflow.revision }
      : borrow ? { ...base, type: 'SET_BORROW', input: { ...borrow, amount } }
      : repay ? { ...base, type: 'SET_REPAY', input: { ...repay, amount } }
      : withdraw ? { ...base, type: 'SET_WITHDRAW', input: { ...withdraw, amount } }
      : supply ? { ...base, type: 'SET_SUPPLY', input: { ...supply, amount } }
      : router ? { ...base, type: 'SET_ROUTER_BRIDGE', input: routerInputForNetworks({ ...routerInputOf(router), amount }, bridgeNetworks[id] ?? router) }
      : bridge ? { ...base, type: 'SET_BRIDGE', input: { amount, slippageBps: String(bridge.slippageBps) } }
        : { ...base, type: 'SET_SWAP_AMOUNT', amount };
  }
  if (command.type === 'ADD_UNISWAP_LIQUIDITY') createUniswapLiquidityNode('node-preview', command.input);
  // Surface the existing constructor's field error before the command guard reduces it to INVALID_COMMAND.
  if (command.type === 'ADD_ROUTER_BRIDGE' || command.type === 'SET_ROUTER_BRIDGE') createRouterNode('node-preview', command.input);
  if (command.type === 'SET_BRIDGE') createBridgeNode('node-preview', command.input);
  if (command.type === 'SET_SUPPLY' || command.type === 'ADD_SUPPLY') createAuthoredSupply('node-preview', command.input);
  if (command.type === 'SET_BORROW' || command.type === 'ADD_BORROW') createAuthoredBorrow('node-preview', command.input);
  if (command.type === 'SET_REPAY' || command.type === 'ADD_REPAY') createAuthoredRepay('node-preview', command.input);
  if (command.type === 'SET_WITHDRAW' || command.type === 'ADD_WITHDRAW') createAuthoredWithdraw('node-preview', command.input);
  if (command.type === 'SET_RH_TRANSFER' || command.type === 'ADD_RH_TRANSFER') createAuthoredTransfer('node-preview', command.input);
  const preview = editorReducer(state, command, context);
  if (preview.error) throw new Error(preview.error);
  // An unfinished new card must never silently replace already-authored actions on acceptance.
  if (setup?.id === id && state.workflow.nodes.some(node => !node.actionType.startsWith('mock-') &&
    !preview.workflow.nodes.some(candidate => candidate.nodeId === node.nodeId))) throw new Error('ACTION_REQUIRES_SEPARATE_WORKFLOW');
  return command;
}

/** `network`: the card's network name, when it has one (BUILD-BASE-001: a catalog network names its own token list). */
export function canvasAmountMessage(cause: unknown, network?: string | null) {
  const code = cause instanceof Error ? cause.message : '';
  if (code === 'TRANSFER_RECIPIENT_REQUIRED') return 'Enter the recipient address.';
  if (code === 'TRANSFER_RECIPIENT_INVALID') return 'Enter a valid recipient address for this network.';
  if (/AMOUNT|PRECISION/.test(code)) return 'Enter a valid amount greater than 0.';
  if (/LOCK|PROTECTED/.test(code)) return 'This amount is protected.';
  if (/STALE/.test(code)) return 'The workflow changed. Review this amount again.';
  if (code === 'ROUTER_PAIR_UNSUPPORTED') return 'Choose matching bridge networks.';
  if (code === 'ASSET_CATALOG_UNAVAILABLE') {
    const catalog = networkIdentity(network);
    return catalog?.catalog && catalog.name !== ROBINHOOD_NETWORK ? `${catalog.name} tokens are unavailable right now. Try again in a moment.`
      : 'Robinhood Stock Tokens are unavailable right now. Try again in a moment.';
  }
  if (code === 'INVALID_ASSET_PAIR') return 'Choose two different assets.';
  return 'This action cannot be combined with the current workflow. Check its settings or use a separate workflow.';
}

/** Known authoring choices, without manufacturing a temporary canonical action. */
export function setupSummary(setup: CanvasActionSetup, context: ReviewContext) {
  if (setup.action === 'swap' && setup.stocks && setup.cryptoSelection) return { action: 'Stocks', provider: 'Uniswap', chain: setup.cryptoSelection.network,
    amount: `${setup.amount || '0'} ${setup.cryptoSelection.from}`, detail: `${setup.cryptoSelection.from} → ${setup.cryptoSelection.to}`, bridgePair: undefined, linked: false, risk: undefined };
  if (setup.cryptoSelection) {
    const selection = setup.cryptoSelection, profile = cryptoProfile(selection)!;
    return { action: selection.action === 'pool' ? 'Pool / Liquidity' : selection.action === 'transfer' ? 'Send' : selection.action[0]!.toUpperCase() + selection.action.slice(1), provider: profile.provider, chain: selection.network,
      amount: `${setup.action === 'pool' ? setup.input.maxUsdc : setup.amount || '0'} ${selection.from}`,
      ...(setup.action === 'pool' ? { liquidityValues: [{ amount: setup.input.maxUsdc, token: selection.from }, { amount: setup.input.maxWeth, token: selection.to! }] } : {}),
      detail: selection.action === 'swap' ? `${selection.from} → ${selection.to}` : undefined, bridgePair: undefined, linked: false, risk: undefined };
  }
  if (setup.action === 'pool') return { action: 'Pool / Liquidity', provider: 'Uniswap v3', chain: 'Base Sepolia',
    amount: `${setup.input.maxUsdc} USDC + ${setup.input.maxWeth} WETH`,
    liquidityValues: [{ amount: setup.input.maxUsdc, token: 'USDC' }, { amount: setup.input.maxWeth, token: 'WETH' }],
    detail: undefined, bridgePair: undefined, linked: false, risk: undefined };
  return { action: setup.action === 'swap' ? 'Swap' : setup.action === 'bridge' ? 'Bridge' : setup.action === 'transfer' ? 'Send' : setup.action[0]!.toUpperCase() + setup.action.slice(1),
    provider: setup.action === 'swap' ? 'Uniswap' : setup.action === 'bridge' ? 'Router' : 'Aave V3',
    chain: setup.action === 'swap' ? shellChainLabel(context.assets.USDC.asset.chainId) : setup.action === 'bridge' ? `${bridgeSetupNetworks(setup).source} → ${bridgeSetupNetworks(setup).destination}` : 'Base Sepolia',
    amount: `${setup.amount || '0'} ${setup.action === 'swap' ? inputSymbol(setup.direction ?? 'USDC_TO_WETH') : setup.action === 'bridge' ? routerTokensOf(bridgeSetupNetworks(setup))?.token ?? 'USDC' : 'USDC'}`,
    detail: setup.action === 'swap' ? directionLabel(setup.direction ?? 'USDC_TO_WETH') : undefined,
    bridgePair: setup.action === 'bridge' ? bridgePairLabel(bridgeSetupNetworks(setup)) : undefined, linked: false, risk: undefined };
}
