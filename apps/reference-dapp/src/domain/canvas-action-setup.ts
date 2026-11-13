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
import { checkDestinationAddress } from './destination-wallet';
import { UNIVERSAL_NETWORKS, type UniversalNetworkKey } from '@defi-workflow-engine/workflow-contracts';
import { DEFAULT_SLIPPAGE } from './slippage-policy';
import { createUniversalBridgeFromInput, universalBridgeDetails, universalCanvasInput, universalCanvasPair, universalInputOf, resolveUniversalAsset, universalKeyOfCanvasLabel, UNIVERSAL_CANVAS_LABEL } from './universal-bridge-authoring';

/** Required-field authoring only, never an executable node or alternate workflow. */
/** `cryptoRecipient` (UX-001): the Send card's typed "To" text, committed only as the transfer's canonical `recipient` on Apply. */
export type CanvasActionSetup = { readonly id: string; readonly amount: string; readonly cryptoSelection?: CryptoSelection; readonly cryptoBeneficiary?: string; readonly cryptoRecipient?: string } &
  ({ readonly action: 'pool'; readonly input: UniswapLiquidityInput } |
  /** `stocks`: the Stocks card (BUILD-RH-002): a Robinhood Chain catalog swap that buys a Stock Token with USDG. */
  { readonly action: 'swap'; readonly direction?: Direction; readonly stocks?: true } | { readonly action: 'bridge'; readonly networks?: CanvasBridgeNetworks } | { readonly action: 'withdraw' | 'transfer' } | { readonly action: 'supply' | 'borrow' | 'repay'; readonly beneficiary: string });
/**
 * Bridge drafts keep each network's asset reference independently. Assets outside certified fixed routes require a reviewed Universal Router proposal.
 */
export type CanvasBridgeNetworks = { source: RouterBridgeInput['source'] | 'Solana'; destination: RouterBridgeInput['destination'] | 'Solana'; inputAsset?: string; outputAsset?: string };
const routerNetworks = (networks: CanvasBridgeNetworks): Pick<RouterBridgeInput, 'source' | 'destination'> => {
  if (networks.source === 'Solana' || networks.destination === 'Solana') throw new Error('ROUTER_PAIR_UNSUPPORTED');
  return { source: networks.source, destination: networks.destination };
};
export type CanvasBridgeNetworkInputs = Readonly<Record<string, CanvasBridgeNetworks>>;
/** Reverse both asset identities with their networks. Input amounts remain authored input; estimates are never promoted to inputs. */
export function invertCanvasBridgeNetworks(networks: CanvasBridgeNetworks): CanvasBridgeNetworks | null {
  const tokens = routerTokensOf(networks);
  const pair = universalCanvasPair(networks), defaults = pair ? universalCanvasInput(pair, '1', networks) : null;
  const inputAsset = networks.outputAsset ?? tokens?.destinationToken ?? defaults?.outputAsset;
  const outputAsset = networks.inputAsset ?? tokens?.token ?? defaults?.inputAsset;
  const reversed = { source: networks.destination, destination: networks.source,
    ...inputAsset ? { inputAsset } : {}, ...outputAsset ? { outputAsset } : {} };
  return universalCanvasPair(reversed) || Object.values(ROUTER_NETWORK_OPTIONS).some(o => o.source === reversed.source && o.destination === reversed.destination)
    ? reversed as CanvasBridgeNetworks : null;
}
/** UX-001: an authored Send card's edited "To" text (like an amount draft); Apply commits it to that node's canonical `recipient`. */
export type CanvasRecipientInputs = Readonly<Record<string, string>>;
/** Certified Router endpoints plus Solana (universal Bridge cards only; an authored Router card's picker never lists it). */
export const CANVAS_BRIDGE_NETWORK_OPTIONS = {
  source: [...Object.values(ROUTER_NETWORK_OPTIONS).map(option => option.source), 'Solana' as const],
  destination: [...Object.values(ROUTER_NETWORK_OPTIONS).map(option => option.destination), 'Solana' as const],
} as const;
/** "USDC → USDC", or (BUILD-RH-002) "USDC → USDG" into Robinhood Chain; Solana pairs use the universal stablecoin defaults; anything else stays neutral USDC. */
export function bridgePairLabel(networks: CanvasBridgeNetworks): string {
  // Universal first: `routerNetworks` refuses Solana, and a half-chosen draft must never crash the Canvas.
  if (networks.inputAsset || networks.outputAsset) return `${bridgeAssetLabel(networks.source, networks.inputAsset ?? routerTokensOf(networks)?.token ?? 'USDC')} → ${bridgeAssetLabel(networks.destination, networks.outputAsset ?? routerTokensOf(networks)?.destinationToken ?? 'USDC')}`;
  const universal = universalCanvasPair(networks);
  if (universal) { const input = universalCanvasInput(universal, '1'); return `${input.inputAsset} → ${input.outputAsset}`; }
  const tokens = routerTokensOf(networks);
  return tokens ? `${tokens.token} → ${tokens.destinationToken}` : 'USDC → USDC';
}
/** Display metadata never substitutes for the selected network-bound identity. */
export function bridgeAssetLabel(network: string, reference: string): string {
  try { const { symbol } = resolveUniversalAsset(universalKeyOfCanvasLabel(network)!, reference); return symbol === 'TOKEN' ? reference : symbol; }
  catch { return reference; }
}
export function universalCanvasNetworks(details: NonNullable<ReturnType<typeof universalBridgeDetails>>): CanvasBridgeNetworks {
  const input = universalInputOf(details);
  return { source: UNIVERSAL_CANVAS_LABEL[input.source], destination: UNIVERSAL_CANVAS_LABEL[input.destination], inputAsset: input.inputAsset, outputAsset: input.outputAsset } as CanvasBridgeNetworks;
}
export function bridgeSetupNetworks(setup: Extract<CanvasActionSetup, { action: 'bridge' }>): CanvasBridgeNetworks {
  return setup.networks ?? { source: ROUTER_NETWORK_OPTIONS.testnet.source, destination: ROUTER_NETWORK_OPTIONS.testnet.destination };
}
export function canvasAmountReviewValue(amount: string | undefined, networks?: CanvasBridgeNetworks) {
  return networks && amount !== undefined ? JSON.stringify([amount, networks.source, networks.destination, networks.inputAsset, networks.outputAsset]) : amount;
}
export function setupReviewValue(setup: CanvasActionSetup) { return setup.action === 'pool' ? JSON.stringify(setup.input) : setup.action === 'swap' && setup.direction ? JSON.stringify([setup.amount, setup.direction]) : setup.action === 'bridge' ? canvasAmountReviewValue(setup.amount, setup.networks)! : setup.amount; }
export function cryptoSetupInput(setup: CanvasActionSetup): CryptoActionInput {
  if (!setup.cryptoSelection) throw new Error('ACTION_SELECTION_REQUIRED');
  return { selection: setup.cryptoSelection, amount: setup.action === 'pool' ? setup.input.maxUsdc : setup.amount,
    slippage: setup.action === 'pool' ? setup.input.slippage : setup.action === 'swap' ? String(SWAP_DEFAULT_SLIPPAGE_BPS) : DEFAULT_SLIPPAGE, ...(setup.cryptoBeneficiary ? { beneficiary: setup.cryptoBeneficiary } : 'beneficiary' in setup ? { beneficiary: setup.beneficiary } : {}),
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
  if (command.type === 'SET_ROUTER_BRIDGE' || command.type === 'SET_BRIDGE' || command.type === 'SET_UNIVERSAL_BRIDGE') return { id: command.nodeId, amount: command.input.amount };
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

/** BUILD-FLOFI-SINGLE-AUTH-WORKFLOW-UX-001: the Aave cards whose ordinary amount edit applies on Enter, exactly like Swap and Bridge. */
export const DIRECT_AMOUNT_LENDING_ACTIONS: readonly string[] = Object.freeze(['supply', 'borrow', 'repay', 'withdraw']);
/**
 * P0 workflow execution: the Canvas cards whose amount, reserve/network pick and (for a Send) recipient apply directly — Enter, leaving the card,
 * or a pause after typing — exactly like Swap and Bridge, whether the card was just added from the toolbox or is already a step.
 */
export const DIRECT_EDIT_ACTIONS: readonly string[] = Object.freeze([...DIRECT_AMOUNT_LENDING_ACTIONS, 'asset.transfer']);
/**
 * Whether a Canvas card's edit needs a reviewed proposal instead of applying directly (`commitCanvasAmount`). P0 workflow execution: only an
 * EXTERNAL proposal already waiting for this card (one the chat or a channel proposed) keeps its own Review/Apply — the owner's own typing, a
 * reserve or network picked on the card, and a Send's amount or recipient apply directly. A reserve change cannot re-denominate silently: picking
 * another asset clears the amount (`editor-history` EDIT_CRYPTO_SELECTION), so the owner types the amount in the new asset before it applies.
 * Every direct edit is one COMMAND through the history guard: a new workflow revision, a stale Simulation and Review, nothing signed or sent.
 */
export function amountEditNeedsReview(_actionType: string, edit: { readonly reserveDraft?: boolean; readonly proposalPending: boolean }): boolean {
  return edit.proposalPending;
}
/**
 * P0 workflow execution: a typed amount is applied automatically after a pause only when what the owner sees would not change when it is applied
 * (no leading or trailing zeros, no trailing dot): the field keeps exactly the owner's text and caret. Anything else waits for Enter or leaving
 * the card. Invalid amounts are never applied (the card shows why).
 */
export const CANONICAL_TYPED_AMOUNT = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;

export function canEditCanvasAmount(node: Workflow['nodes'][number], context: ReviewContext, workflow?: Workflow) {
  if (node.lockedParameters.length) return false;
  if (workflow && canSelectCryptoAssets(node, workflow)) return true;
  if (workflow && lendingDetails(workflow) && ['lending-supply', 'lending-borrow'].includes(node.nodeId)) return true;
  return Boolean(supplyDetails(node as Parameters<typeof supplyDetails>[0]) || borrowDetails(node as Parameters<typeof borrowDetails>[0]) || repayDetails(node as Parameters<typeof repayDetails>[0]) || withdrawDetails(node as Parameters<typeof withdrawDetails>[0]) || swapDetails(node, context) || routerDetails(node) ||
    (bridgeDetails(node) && !node.inputs.some(input => input.kind === 'OUTPUT_REFERENCE')) || universalBridgeDetails(node));
}

export function canvasAmountCommand(state: EditorState, setup: CanvasActionSetup | null, inputs: CanvasAmountInputs, id: string, context: ReviewContext, bridgeNetworks: CanvasBridgeNetworkInputs = {}, cryptoSelections: CryptoSelections = {}, recipients: CanvasRecipientInputs = {}) {
  let command: Command;
  /** Set when an amount-only edit is rebuilt from the action's own crypto input: everything but the amount must come back unchanged. */
  let amountOnly: { readonly before: Workflow['nodes'][number]; readonly input: CryptoActionInput } | null = null;
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
    // Preserve certified routes; a different network or asset pair explicitly authors a new Universal Router proposal.
    const universal = setup.action === 'bridge' ? universalCanvasPair(bridgeSetupNetworks(setup)) : null;
    if (universal && setup.action === 'bridge') command = { type: 'ADD_UNIVERSAL_BRIDGE', input: { ...universalCanvasInput(universal, setup.amount, bridgeSetupNetworks(setup)),
      recipient: bridgeDestination(universal.destination, recipients[id], '') }, source: 'CANVAS', baseRevision: state.workflow.revision };
    else if (command.type === 'ADD_ROUTER_BRIDGE' && setup.action === 'bridge') {
      const input = routerInputForNetworks(command.input, routerNetworks(bridgeSetupNetworks(setup))), key = universalKeyOfCanvasLabel(input.destination);
      command = { ...command, input: { ...input, recipient: key ? bridgeDestination(key, recipients[id], input.recipient) : input.recipient } };
    }
    }
  }
  else {
    const node = state.workflow.nodes.find(item => item.nodeId === id);
    if (!node || !canEditCanvasAmount(node, context, state.workflow) || inputs[id] === undefined) throw new Error('Select an editable action.');
    const amount = inputs[id];
    // An amount cleared for a new asset (BUILD AAVE-V3-CARD-CATALOG-FIX-001) asks for an amount, never "cannot be combined".
    if (!amount.trim()) throw new Error('AMOUNT_REQUIRED');
    const base = { nodeId: id, source: 'CANVAS' as const, baseRevision: state.workflow.revision };
    const lending = lendingDetails(state.workflow);
    const router = routerDetails(node), bridge = bridgeDetails(node), supply = lending ? null : supplyDetails(node as Parameters<typeof supplyDetails>[0]), borrow = lending ? null : borrowDetails(node as Parameters<typeof borrowDetails>[0]), repay = repayDetails(node as Parameters<typeof repayDetails>[0]), withdraw = withdrawDetails(node as Parameters<typeof withdrawDetails>[0]);
    const transfer = transferDetails(node as Parameters<typeof transferDetails>[0]);
    // P0 catalog reliability (2026-11-07, Arbitrum WETH → USDC 0.0012): an amount-only edit of a catalog or Solana action (no pair or network change
    // on the card) used to fall through to the legacy SET_SWAP_AMOUNT, which only knows the Base reference pair, and failed with INVALID_SWAP_NODE
    // ("cannot be combined"). Such an action is edited through its own crypto input: same pair, network and slippage, the new amount only.
    const own = cryptoInputOf(node);
    const legacyAmountOnly = !transfer && !(lending && (id === 'lending-supply' || id === 'lending-borrow')) && !borrow && !repay && !withdraw && !supply &&
      !router && !universalBridgeDetails(node) && !bridge;
    const selection = cryptoSelections[id] ?? (own && legacyAmountOnly && !swapDetails(node, context) ? own.selection : null);
    const cryptoInput = selection ? own : null;
    if (own && !cryptoSelections[id] && selection) amountOnly = { before: node, input: own };
    command = cryptoInput && selection ? { ...base, type: 'SET_CRYPTO_ACTION', input: { ...cryptoInput, selection, amount,
      ...(cryptoInput.selection.action === 'pool' && cryptoInput.selection.network !== selection.network ? defaultPoolRange(selection.network) : {}),
      ...(cryptoInput.selection.action === 'transfer' ? recipientEdit(selection.network, recipients[id]) : {}) } }
      : transfer ? { ...base, type: 'SET_RH_TRANSFER', input: { ...transfer, amount, ...recipientEdit(transfer.network, recipients[id]) } }
      : lending && (id === 'lending-supply' || id === 'lending-borrow')
      ? { type: 'AUTHOR_LENDING', input: lendingNodeInput(state.workflow, id, amount), source: 'CANVAS', baseRevision: state.workflow.revision }
      : borrow ? { ...base, type: 'SET_BORROW', input: { ...borrow, amount } }
      : repay ? { ...base, type: 'SET_REPAY', input: { ...repay, amount } }
      : withdraw ? { ...base, type: 'SET_WITHDRAW', input: { ...withdraw, amount } }
      : supply ? { ...base, type: 'SET_SUPPLY', input: { ...supply, amount } }
      // BUILD-FLOFI-MAINNET-EXEC-002: a re-pointed Router card keeps its recipient only within the same ecosystem (a 0x address cannot receive on
      // Solana); across ecosystems it delivers to the owner's destination wallet unless one is typed on the card (`bridgeDestination`).
      : router && universalCanvasPair(bridgeNetworks[id] ?? router) ? (() => { const pair = universalCanvasPair(bridgeNetworks[id] ?? router)!;
        return { ...base, type: 'SET_UNIVERSAL_BRIDGE' as const, input: { ...universalCanvasInput(pair, amount, bridgeNetworks[id]),
          recipient: bridgeDestination(pair.destination, recipients[id], sameEcosystem(pair.source, pair.destination) ? router.recipient : ''), slippage: router.slippage } }; })()
      : router ? (() => { const input = routerInputForNetworks({ ...routerInputOf(router), amount }, routerNetworks(bridgeNetworks[id] ?? router)), key = universalKeyOfCanvasLabel(input.destination);
        return { ...base, type: 'SET_ROUTER_BRIDGE' as const, input: { ...input, recipient: key ? bridgeDestination(key, recipients[id], input.recipient) : input.recipient } }; })()
      : universalBridgeDetails(node) ? (() => { const details = universalBridgeDetails(node)!, draft = bridgeNetworks[id];
        const source = draft ? universalKeyOfCanvasLabel(draft.source)! : details.source, destination = draft ? universalKeyOfCanvasLabel(draft.destination)! : details.destination;
        const kept = UNIVERSAL_NETWORKS[destination].ecosystem === UNIVERSAL_NETWORKS[details.destination].ecosystem && sameEcosystem(source, destination) === sameEcosystem(details.source, details.destination) ? details.recipient : '';
        return { ...base, type: 'SET_UNIVERSAL_BRIDGE' as const, input: { ...universalInputOf(details), ...(draft ? { source, destination, inputAsset: draft.inputAsset!, outputAsset: draft.outputAsset! } : {}), amount,
          recipient: bridgeDestination(destination, recipients[id], kept) } }; })()
      : bridge ? { ...base, type: 'SET_BRIDGE', input: { amount, slippageBps: String(bridge.slippageBps) } }
        : { ...base, type: 'SET_SWAP_AMOUNT', amount };
  }
  if (command.type === 'ADD_UNISWAP_LIQUIDITY') createUniswapLiquidityNode('node-preview', command.input);
  // P0 catalog reliability: an edited catalog action's field error (e.g. more decimals than its asset has) is named, not reduced to INVALID_COMMAND.
  if (command.type === 'SET_CRYPTO_ACTION') createCryptoActionNode('node-preview', command.input);
  // Surface the existing constructor's field error before the command guard reduces it to INVALID_COMMAND.
  if (command.type === 'ADD_ROUTER_BRIDGE' || command.type === 'SET_ROUTER_BRIDGE') createRouterNode('node-preview', command.input);
  if (command.type === 'SET_BRIDGE') createBridgeNode('node-preview', command.input);
  if (command.type === 'ADD_UNIVERSAL_BRIDGE' || command.type === 'SET_UNIVERSAL_BRIDGE') createUniversalBridgeFromInput('node-preview', command.input);
  if (command.type === 'SET_SUPPLY' || command.type === 'ADD_SUPPLY') createAuthoredSupply('node-preview', command.input);
  if (command.type === 'SET_BORROW' || command.type === 'ADD_BORROW') createAuthoredBorrow('node-preview', command.input);
  if (command.type === 'SET_REPAY' || command.type === 'ADD_REPAY') createAuthoredRepay('node-preview', command.input);
  if (command.type === 'SET_WITHDRAW' || command.type === 'ADD_WITHDRAW') createAuthoredWithdraw('node-preview', command.input);
  if (command.type === 'SET_RH_TRANSFER' || command.type === 'ADD_RH_TRANSFER') createAuthoredTransfer('node-preview', command.input);
  const preview = editorReducer(state, command, context);
  if (preview.error) throw new Error(preview.error);
  if (amountOnly) {
    // Review guard: an amount-only edit rebuilt from the action's own input must keep its network, adapter, protocols, pair, slippage and range.
    // Anything the input does not carry would be lost on rebuild, so a difference refuses the edit instead of silently changing the action.
    const after = preview.workflow.nodes.find(item => item.nodeId === id), rebuilt = after ? cryptoInputOf(after) : null;
    const settings = (value: CryptoActionInput | null) => value ? JSON.stringify({ ...value, amount: null }) : null;
    // A swap is compared whole: every field but its exact input amount (and the matching MAXIMUM_INPUT cap) must be byte-identical, so asset
    // identities (address, decimals, native id, official id), outputs, capabilities, policies and bounds can never be silently rewritten.
    // A WETH9 wrap/unwrap guarantees exactly its input (1:1), so a minimum equal to the node's own input amount is amount-derived too.
    const swapShape = (node: Workflow['nodes'][number]) => {
      const amountIn = node.inputs.find(input => input.name === 'amount-in' && input.kind === 'QUANTITY') as { value: { amount: string } } | undefined;
      return JSON.stringify({ ...node,
        inputs: node.inputs.map(input => input.name === 'amount-in' && input.kind === 'QUANTITY' ? { ...input, value: { ...input.value, amount: null } } : input),
        userConstraints: node.userConstraints.map(c => c.kind === 'MAXIMUM_INPUT' ? { ...c, quantity: { ...c.quantity, amount: null } } : c),
        expectedOutputs: node.expectedOutputs.map(output => amountIn && output.minimumAmount === amountIn.value.amount ? { ...output, minimumAmount: 'AMOUNT_IN' } : output),
        // The amount's editing ceiling is max(amount, the constructor's constant): amount-derived for a very large amount (review fix).
        editableBounds: node.editableBounds.map(bound => bound.parameterName === 'amount-in' ? { ...bound, maximumAmount: null } : bound) });
    };
    if (after && after.actionType === 'asset.swap.exact-input' && swapShape(after) !== swapShape(amountOnly.before)) throw new Error('ACTION_EDIT_CHANGES_SETTINGS');
    if (!after || after.chainId !== amountOnly.before.chainId || after.actionType !== amountOnly.before.actionType ||
        JSON.stringify(after.adapterConstraints) !== JSON.stringify(amountOnly.before.adapterConstraints) ||
        JSON.stringify(after.userConstraints.filter(c => c.kind !== 'MAXIMUM_INPUT')) !== JSON.stringify(amountOnly.before.userConstraints.filter(c => c.kind !== 'MAXIMUM_INPUT')) ||
        settings(rebuilt) !== settings(amountOnly.input)) throw new Error('ACTION_EDIT_CHANGES_SETTINGS');
  }
  // An unfinished new card must never silently replace already-authored actions on acceptance.
  if (setup?.id === id && state.workflow.nodes.some(node => !node.actionType.startsWith('mock-') &&
    !preview.workflow.nodes.some(candidate => candidate.nodeId === node.nodeId))) throw new Error('ACTION_REQUIRES_SEPARATE_WORKFLOW');
  return command;
}

/** P0 catalog reliability: what an owner can do when a Canvas edit is refused (the card's Cancel button or Escape, and its Settings button). */
const KEEP_OR_SETTINGS = 'Your workflow was not changed. Press Cancel to keep the current amount, or open the action\u2019s Settings.';
/**
 * `network`: the card's network name, when it has one (BUILD-BASE-001: a catalog network names its own token list). Every message is a catalog key
 * (`i18n/pt-catalog-reliability.ts`); the one carrying a support reference is the `{0}` template, so its code stays visible in every language.
 */
const sameEcosystem = (a: UniversalNetworkKey, b: UniversalNetworkKey) => UNIVERSAL_NETWORKS[a].ecosystem === UNIVERSAL_NETWORKS[b].ecosystem;
/**
 * BUILD-FLOFI-MAINNET-EXEC-002: a bridge's recipient from its card. No typed text keeps `fallback` ('' = the owner's wallet of the destination
 * ecosystem, resolved and bound at Review); an emptied field returns to that automatic destination; anything else must be an address of the
 * destination network (`checkDestinationAddress`), or the edit is refused with its code.
 */
function bridgeDestination(destination: UniversalNetworkKey, typed: string | undefined, fallback: string): string {
  if (typed === undefined) return fallback;
  if (!typed.trim()) return '';
  const check = checkDestinationAddress(destination, typed);
  if (!check.ok) throw new Error(check.code);
  return check.address;
}
export function canvasAmountMessage(cause: unknown, network?: string | null) {
  const raw = cause instanceof Error ? cause.message : '';
  // The Universal Router's own asset/network codes carry a `UNIVERSAL_` prefix; they mean the same as the Canvas codes below.
  const code = raw.startsWith('UNIVERSAL_') ? raw.slice('UNIVERSAL_'.length) : raw;
  if (code === 'TRANSFER_RECIPIENT_REQUIRED') return 'Enter the recipient address.';
  // BUILD-FLOFI-MAINNET-EXEC-002: a bridge's destination wallet typed for its destination network.
  if (raw === 'DESTINATION_REQUIRED') return 'Enter the destination wallet address.';
  if (raw === 'DESTINATION_WRONG_ECOSYSTEM') return 'This address is for another kind of network. Enter an address of the destination network.';
  if (raw === 'DESTINATION_INVALID' || code === 'RECIPIENT_INVALID' || code === 'RECIPIENT_REQUIRED_ACROSS_ECOSYSTEMS') return 'Enter a valid address for the destination network.';
  if (code === 'TRANSFER_RECIPIENT_INVALID') return 'Enter a valid recipient address for this network.';
  if (/AMOUNT|PRECISION/.test(code)) return 'Enter a valid amount greater than 0.';
  if (code === 'ACTION_SELECTION_LOCKED') return 'This step cannot change to another kind of action. Remove it and add the new action instead.';
  if (/LOCK|PROTECTED/.test(code)) return 'This amount is protected.';
  if (/STALE|BASE_REVISION_CONFLICT/.test(code)) return 'The workflow changed. Review this amount again.';
  if (code === 'ACTION_REQUIRES_SEPARATE_WORKFLOW' || code === 'COMPOSITION_UNSUPPORTED' || code === 'ONE_LIQUIDITY_POSITION_ONLY' || code === 'POSITION_WORKFLOW_HAS_OTHER_STEPS')
    return 'This action cannot be combined with the current workflow. Check its settings or use a separate workflow.';
  if (code === 'NODE_LIMIT') return 'This workflow already has the maximum number of steps.';
  if (code === 'ACTION_EDIT_CHANGES_SETTINGS') return 'This amount cannot be applied without changing other settings of the action. ' + KEEP_OR_SETTINGS;
  if (code === 'SWAP_NETWORK_MISMATCH') return 'The swap and its linked step are on different networks. Choose the same network for both.';
  if (code === 'ROUTER_PAIR_UNSUPPORTED' || code === 'SAME_NETWORK') return 'Choose matching bridge networks.';
  if (/^(ASSET_UNKNOWN|ASSET_REFERENCE_AMBIGUOUS|ASSET_ADDRESS_INVALID|ASSET_DECIMALS_MISMATCH|INVALID_ASSET|ACTION_ASSETS_UNSUPPORTED|ASSET_REQUIRED|OUTPUT_ASSET_REQUIRED)$/.test(code))
    return 'This asset is not available for this action on this network. Choose another asset.';
  if (/^(ACTION_NETWORK_UNSUPPORTED|CATALOG_SWAP_NETWORK_UNSUPPORTED)$/.test(code)) return 'This action is not available on this network. Choose another network.';
  if (code === 'SWAP_NATIVE_ASSET_UNSUPPORTED') return 'This swap does not support the native asset on this network. Choose the wrapped asset.';
  if (code === 'INVALID_SLIPPAGE') return 'Enter a valid slippage percentage.';
  if (code === 'LIQUIDITY_RANGE_INVALID') return 'Enter a valid price range: the lower bound must be below the upper bound.';
  if (code === 'ASSET_CATALOG_UNAVAILABLE') {
    const catalog = networkIdentity(network);
    return catalog?.catalog && catalog.name !== ROBINHOOD_NETWORK ? `${catalog.name} tokens are unavailable right now. Try again in a moment.`
      : 'Robinhood Stock Tokens are unavailable right now. Try again in a moment.';
  }
  if (code === 'INVALID_ASSET_PAIR') return 'Choose two different assets.';
  // Any other code is a defect or an unexpected state, not a composition conflict: say so, with the reference support can trace.
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(raw) ? `This change could not be applied (reference ${raw}). ${KEEP_OR_SETTINGS}` : `This change could not be applied. ${KEEP_OR_SETTINGS}`;
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
  const bridge = setup.action === 'bridge' ? bridgeSetupNetworks(setup) : null;
  const universal = bridge ? universalCanvasPair(bridge) : null;
  return { action: setup.action === 'swap' ? 'Swap' : setup.action === 'bridge' ? 'Bridge' : setup.action === 'transfer' ? 'Send' : setup.action[0]!.toUpperCase() + setup.action.slice(1),
    provider: setup.action === 'swap' ? 'Uniswap' : setup.action === 'bridge' ? (universal ? 'Universal Router' : 'Router') : 'Aave V3',
    chain: setup.action === 'swap' ? shellChainLabel(context.assets.USDC.asset.chainId) : bridge ? `${bridge.source} → ${bridge.destination}` : 'Base Sepolia',
    amount: `${setup.amount || '0'} ${setup.action === 'swap' ? inputSymbol(setup.direction ?? 'USDC_TO_WETH') : bridge ? (universal ? bridgeAssetLabel(bridge.source, universalCanvasInput(universal, setup.amount || '0', bridge).inputAsset) : routerTokensOf(bridge)?.token) ?? 'USDC' : 'USDC'}`,
    detail: setup.action === 'swap' ? directionLabel(setup.direction ?? 'USDC_TO_WETH') : undefined,
    bridgePair: bridge ? bridgePairLabel(bridge) : undefined, linked: false, risk: undefined };
}
