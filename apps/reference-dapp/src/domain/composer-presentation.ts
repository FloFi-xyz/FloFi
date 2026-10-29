// SPDX-License-Identifier: AGPL-3.0-only
import type { ReviewContext, ReviewResult } from '@defi-workflow-engine/reference-linter';
import { liquidityDetails } from '@defi-workflow-engine/reference-linter';
import { workflowDependencyOrder } from '@defi-workflow-engine/workflow-contracts';
import type { Workflow } from './initial-workflow';
import type { Command } from './commands';
import { shellChainLabel } from './product-shell';
import { swapDetails, formatHumanAmount } from './swap-authoring';
import { supplyDetails, borrowDetails, repayDetails, withdrawDetails } from './supply-authoring';
import { lendingDetails, lendingCanvasEdges } from './lending-authoring';
import { bridgeDetails } from './bridge-authoring';
import { routerDetails } from './router-authoring';
import { universalBridgeDetails } from './universal-bridge-authoring';
import { solanaSwapDetails, solanaSwapLabels } from './jupiter-authoring';
import { solanaLiquidityDetails } from './solana-liquidity-authoring';
import { uniswapLiquidityDetails } from './uniswap-liquidity-authoring';
import { robinhoodLiquidityDetails } from './robinhood-liquidity-authoring';
import { transferDetails } from './robinhood-transfer-authoring';
import { catalogSwapDetails } from './catalog-swap-authoring';

/** Display projections only. No editable values, validation rules or execution states live here. */
export function composerActions(workflow: Workflow) {
  return workflowDependencyOrder(workflow.nodes).filter(node => !node.actionType.startsWith('mock-'));
}
/** Identify the card for an existing Supply edit without changing proposal acceptance. */
export function supplyProposalTarget(workflow: Workflow, command: Command): string | null {
  if (command.type === 'SET_SUPPLY') return workflow.nodes.find(node => node.nodeId === command.nodeId && node.actionType === 'supply')?.nodeId ?? null;
  const lending = command.type === 'AUTHOR_LENDING' ? lendingDetails(workflow) : null;
  if (command.type === 'AUTHOR_LENDING' && lending && command.input.borrow === lending.borrow
    && command.input.slippage === lending.slippage && command.input.owner === lending.owner) return 'lending-supply';
  return null;
}
/** Match single-amount card proposals while retaining the original commands and linkage. */
export function singleAmountProposalTarget(workflow: Workflow, command: Command, preferredId?: string): string | null {
  const composition = command.type === 'AUTHOR_LENDING' ? lendingDetails(workflow) : null;
  if (preferredId === 'lending-borrow' && command.type === 'AUTHOR_LENDING' && composition
    && command.input.supply === composition.supply && command.input.slippage === composition.slippage
    && command.input.owner === composition.owner) return 'lending-borrow';
  const supply = supplyProposalTarget(workflow, command);
  if (supply) return supply;
  if (command.type === 'SET_BORROW' || command.type === 'SET_REPAY' || command.type === 'SET_WITHDRAW') {
    const action = command.type === 'SET_BORROW' ? 'borrow' : command.type === 'SET_REPAY' ? 'repay' : 'withdraw';
    return workflow.nodes.find(node => node.nodeId === command.nodeId && node.actionType === action)?.nodeId ?? null;
  }
  const lending = command.type === 'AUTHOR_LENDING' ? lendingDetails(workflow) : null;
  return command.type === 'AUTHOR_LENDING' && lending && command.input.supply === lending.supply
    && command.input.slippage === lending.slippage && command.input.owner === lending.owner ? 'lending-borrow' : null;
}
const actionLabels: Record<string, string> = {
  'asset.swap.exact-input': 'Swap', 'asset.bridge': 'Bridge',
  'asset.liquidity.concentrated': 'Pool / Liquidity', 'asset.liquidity.uniswap-v3': 'Pool / Liquidity',
  'asset.liquidity.prepare': 'Prepare liquidity', 'asset.transfer': 'Send',
  supply: 'Supply', borrow: 'Borrow', repay: 'Repay', withdraw: 'Withdraw',
};
const providerLabels: Record<string, string> = {
  'aave-v3': 'Aave V3', uniswap: 'Uniswap', 'uniswap-v3': 'Uniswap V3', weth9: 'WETH9',
  'lifi.rest': 'LI.FI', lifi: 'LI.FI', 'across.direct': 'Across',
  'flofi.router': 'Cross-chain Router', 'flofi.router.universal': 'Universal Router', 'cow-protocol': 'CoW Protocol',
  'solana.system-transfer': 'System Program', 'solana.spl-transfer': 'SPL Token',
  'evm.native-transfer': 'Wallet send', 'evm.token-transfer': 'Token transfer',
};
export function composerSummary(workflow: Workflow, node: Workflow['nodes'][number], context: ReviewContext) {
  // BUILD-RH-002: a catalog swap reads its assets from the network catalog; buying a Stock Token with USDG is the Stocks card.
  const catalogSwap = catalogSwapDetails(node);
  const action = catalogSwap?.stockPurchase ? 'Stocks' : actionLabels[node.actionType] ?? 'Action';
  const lending = lendingDetails(workflow);
  const swap = swapDetails(node, context), solana = solanaSwapDetails(node);
  const router = routerDetails(node), bridge = bridgeDetails(node), universal = universalBridgeDetails(node);
  const uni = uniswapLiquidityDetails(node), orca = solanaLiquidityDetails(node), rhPool = robinhoodLiquidityDetails(node);
  const position = liquidityDetails(node, context);
  const supply = lending ? null : supplyDetails(node as Parameters<typeof supplyDetails>[0]);
  const borrow = lending ? null : borrowDetails(node as Parameters<typeof borrowDetails>[0]);
  const repay = lending ? null : repayDetails(node as Parameters<typeof repayDetails>[0]);
  const withdraw = lending ? null : withdrawDetails(node as Parameters<typeof withdrawDetails>[0]);
  const transfer = transferDetails(node as Parameters<typeof transferDetails>[0]);
  const money = supply ?? borrow ?? repay ?? withdraw;
  const providers = node.adapterConstraints.adapters.map(adapter => adapter.id);
  const protocols = node.adapterConstraints.protocols;
  const provider = solana ? solanaSwapLabels(solana.network).provider : uni?.provider ?? orca?.provider ?? rhPool?.provider ??
    [...new Set((providers.length ? providers : protocols).map(id => providerLabels[id] ?? id))].join(' / ');
  const destination = node.inputs.find(input => input.name === 'asset-out');
  const destinationChain = destination?.kind === 'ASSET' ? destination.value.chainId : null;
  const chain = universal ? `${universal.sourceLabel} → ${universal.destinationLabel}` : router ? `${router.source} → ${router.destination}` : destinationChain && destinationChain !== node.chainId
    ? `${shellChainLabel(node.chainId)} → ${shellChainLabel(destinationChain)}` : shellChainLabel(node.chainId);
  const linked = node.inputs.some(input => input.kind === 'OUTPUT_REFERENCE');
  const amount = lending ? `${node.actionType === 'supply' ? lending.supply : lending.borrow} USDC` : money ? `${money.amount} ${money.asset}` :
    transfer ? `${transfer.amount} ${transfer.asset}` : universal ? `${universal.amount} ${universal.inputSymbol}` : router ? `${router.amount} ${router.token}` : bridge ? `${bridge.amount} USDC` :
    solana ? `${solana.amount} ${solana.from}` : swap ? `${swap.amount} ${swap.from}` : catalogSwap ? `${catalogSwap.amount} ${catalogSwap.from}` :
    uni ? `${uni.maxUsdc} USDC + ${uni.maxWeth} WETH` : rhPool ? `${rhPool.amountA} ${rhPool.tokenA} + ${rhPool.amountB} ${rhPool.tokenB}` : orca ? orcaAmount(orca) :
    position ? `${formatHumanAmount(position.amountWeth, 'WETH', context)} WETH + ${formatHumanAmount(position.amountUsdc, 'USDC', context)} USDC` :
    linked ? 'Amount from linked step' : 'Amount not available';
  const detail = solana ? `${solana.from} → ${solana.to}` : swap ? `${swap.from} → ${swap.to}` : catalogSwap ? `${catalogSwap.from} → ${catalogSwap.to}` :
    lending && node.actionType === 'asset.swap.exact-input' ? 'Borrowed USDC → WETH' :
    uni ? 'USDC / WETH' : rhPool ? `${rhPool.tokenA} / ${rhPool.tokenB}` : orca ? `SOL / ${orca.tokenB}` : position ? 'WETH / USDC' : undefined;
  // The router pair names both assets (BUILD-RH-002: USDC → USDG into Robinhood Chain); legacy bridge readers describe USDC on both ends.
  const bridgePair = universal ? `${universal.inputSymbol} → ${universal.outputSymbol}` : router ? `${router.token} → ${router.destinationToken}` : bridge ? 'USDC → USDC' : undefined;
  const liquidityValues = uni ? [{ amount: uni.maxUsdc, token: 'USDC' }, { amount: uni.maxWeth, token: 'WETH' }]
    : rhPool ? [{ amount: rhPool.amountA, token: rhPool.tokenA }, { amount: rhPool.amountB, token: rhPool.tokenB }]
    : orca ? [{ amount: orca.maxSol, token: 'SOL' }, { amount: orca.maxDevUsdc, token: orca.tokenB }]
    : position ? [{ amount: formatHumanAmount(position.amountWeth, 'WETH', context), token: 'WETH' }, { amount: formatHumanAmount(position.amountUsdc, 'USDC', context), token: 'USDC' }] : undefined;
  return { action, provider, chain, amount, detail, bridgePair, linked, ...(liquidityValues ? { liquidityValues } : {}),
    risk: node.actionType === 'borrow' ? 'Variable debt' : node.actionType === 'withdraw' ? 'Collateral change' : undefined };
}

/** Existing lint findings distinguish authoring problems from later quote/simulation gates. */
export function composerNodeState(review: ReviewResult | null, nodeId: string) {
  const findings = review?.findings.filter(finding => finding.nodeId === nodeId) ?? [];
  const authoring = findings.filter(finding => finding.field !== 'expectedOutputs' && !/SIMULATION_REQUIRED$/.test(finding.code));
  const block = authoring.find(finding => finding.severity === 'BLOCK');
  const warning = authoring.find(finding => finding.severity === 'WARNING');
  return { findings, status: block ? 'Needs attention' : warning ? 'Warning' : review ? 'Configured' : 'Draft',
    tone: block ? 'invalid' : warning ? 'warning' : 'neutral',
    message: (block ?? warning)?.message,
    next: findings.some(finding => finding.field === 'expectedOutputs' || /SIMULATION_REQUIRED$/.test(finding.code)) ? 'Simulation / review required' : undefined };
}

/** Only actual resource edges and dependencies; adjacent independent actions are never connected. */
export function composerConnections(workflow: Workflow) {
  const lending = lendingCanvasEdges(workflow);
  if (lending) return lending;
  const visible = new Set(composerActions(workflow).map(node => node.nodeId));
  const pairs = new Map<string, { id: string; source: string; target: string; label: string }>();
  for (const node of workflow.nodes) for (const source of node.dependencies) {
    if (visible.has(source) && visible.has(node.nodeId)) {
      const id = `${source}-${node.nodeId}`;
      pairs.set(id, { id, source, target: node.nodeId, label: 'After previous step' });
    }
  }
  for (const edge of workflow.resourceEdges) {
    if (!visible.has(edge.fromNodeId) || !visible.has(edge.toNodeId)) continue;
    const id = `${edge.fromNodeId}-${edge.toNodeId}`;
    const label = edge.outputId === 'swap-input' ? 'Swap input' : edge.outputId === 'liquidity-usdc' ? 'Liquidity USDC' :
      edge.outputId === 'liquidity-weth' ? 'Liquidity WETH' : edge.inputName === 'weth-from-swap' ? 'WETH output' : 'Linked output';
    const previous = pairs.get(id);
    pairs.set(id, { id, source: edge.fromNodeId, target: edge.toNodeId,
      label: previous && previous.label !== 'After previous step' ? `${previous.label} · ${label}` : label });
  }
  return [...pairs.values()];
}

/** A bound position names where the swapped token comes from: the swap's reconciled output, capped by the owner's maximum. */
function orcaAmount(orca: NonNullable<ReturnType<typeof solanaLiquidityDetails>>): string {
  const fromSwap = (cap: string, symbol: string) => orca.source!.fullOutput ? `all ${symbol} from the swap` : `up to ${cap} ${symbol} from the swap`;
  if (!orca.source) return `${orca.maxSol} SOL + ${orca.maxDevUsdc} ${orca.tokenB}`;
  return orca.source.token === 1 ? `${orca.maxSol} SOL + ${fromSwap(orca.maxDevUsdc, 'devUSDC')}` : `${fromSwap(orca.maxSol, 'SOL')} + ${orca.maxDevUsdc} devUSDC`;
}
