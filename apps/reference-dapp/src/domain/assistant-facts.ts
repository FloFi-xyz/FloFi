// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (A05): what the FloFi assistant knows about the CURRENT workflow revision's simulation. Every figure comes
 * from FloFi's own projections of the selected runtime's simulation (the same `projectSimulation` / `conversationReview` the Simulate panel and the
 * chat's Review card show) and from the platform fee policy's own principal accounting (`platform-fee/principal.ts`, read only). A retired or
 * expired simulation carries no figure. Web chat only (it reads the runtime projections); the answers are in `assistant-answers.ts`. Pure.
 *
 *   assistantSimulation(view, canonical)   the facts, bound to the workflow revision they were simulated for
 *   platformFeeFacts(workflow, context)    FloFi's 0.80% fee basis of the authored workflow (never charged at this time)
 */
import { SOLANA_MAINNET_TOKENS } from '@defi-workflow-engine/action-registry';
import type { ReviewContext } from '@defi-workflow-engine/reference-linter';
import type { Composition } from '../engine/strategy-engine';
import { singleStepFeeBasis, workflowFeeBasis, type FeeBasis } from '../platform-fee/principal';
import { PLATFORM_FEE_BPS } from '../platform-fee/policy';
import { resolveNetworkAsset } from './asset-catalogs';
import type { AssistantSimulation, PlatformFeeFacts } from './assistant-answers';
import { conversationReview, type LifecycleView } from './conversation-lifecycle';
import type { Workflow } from './initial-workflow';
import { projectSimulation, simulationAmount, SIMULATION_AVAILABILITY_CHECKING } from './simulation-presentation';
import { workflowSteps, type WorkflowStep } from './workflow-steps';

const FEE_RATE = `${(PLATFORM_FEE_BPS / 100).toFixed(2)}%`, NATIVE_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
type Node = Workflow['nodes'][number];
type Part = { readonly action: string; readonly nodes: Node[]; readonly recipient?: string | null; readonly maxAmounts?: Readonly<Record<string, string>>; readonly symbols: readonly string[] };
/**
 * The authored steps as the minimal compositions `workflowFeeBasis` reads (its `strategy.action`, a bridge's `recipient`, a position's `maxAmounts`
 * keys and the step's own canonical nodes). A position-management step and the starting template introduce no principal and are left out;
 * anything else this cannot read stays in as an unknown action, so the basis is UNSUPPORTED (never charged) rather than guessed.
 */
function feeParts(workflow: Workflow, context: ReviewContext): Part[] {
  const steps = workflowSteps(workflow, context), parts: Part[] = [];
  const node = (step: WorkflowStep) => workflow.nodes.find(item => item.nodeId === step.nodeId)!;
  for (const step of steps) {
    const d = step.detail;
    switch (d.type) {
      case 'TEMPLATE': case 'LIQUIDITY_POSITION': break;
      case 'EVM_SWAP': case 'CATALOG_SWAP': parts.push({ action: 'swap', nodes: [node(step)], symbols: [d.from] }); break;
      case 'SOLANA_SWAP': parts.push({ action: 'swap', nodes: [node(step)], symbols: [d.input.from] }); break;
      case 'ROUTER': parts.push({ action: 'bridge', nodes: [node(step)], recipient: d.input.recipient && d.input.recipient !== 'CONNECTED_OWNER' ? d.input.recipient : null, symbols: [d.input.token] }); break;
      case 'UNIVERSAL_BRIDGE': parts.push({ action: 'bridge', nodes: [node(step)], recipient: d.input.recipient || null, symbols: [d.inputSymbol ?? d.input.inputAsset] }); break;
      case 'AAVE': parts.push({ action: d.operation.toLowerCase(), nodes: [node(step)], symbols: [d.input.asset] }); break;
      case 'AAVE_WITHDRAW': parts.push({ action: 'withdraw', nodes: [node(step)], symbols: [d.input.asset] }); break;
      case 'TRANSFER': parts.push({ action: 'transfer', nodes: [node(step)], symbols: [d.input.asset] }); break;
      // A Batch Payment spends its total, the sum its legs pay (the policy charges once on that principal).
      case 'BATCH_PAYMENT': parts.push({ action: 'transfer', nodes: [node(step)], symbols: [d.input.asset] }); break;
      case 'UNISWAP_LIQUIDITY': parts.push({ action: 'add_liquidity', nodes: [node(step)], maxAmounts: { USDC: d.input.maxUsdc, WETH: d.input.maxWeth }, symbols: [] }); break;
      case 'CATALOG_LIQUIDITY': parts.push({ action: 'add_liquidity', nodes: [node(step)], maxAmounts: { [d.input.tokenA]: d.input.amountA, [d.input.tokenB]: d.input.amountB }, symbols: [] }); break;
      case 'ORCA_LIQUIDITY': parts.push({ action: 'add_liquidity', nodes: [node(step)], maxAmounts: { SOL: d.input.maxSol, [d.input.network === 'Solana Devnet' ? 'devUSDC' : 'USDC']: d.input.maxDevUsdc }, symbols: [] }); break;
      case 'LENDING_COMPOSITION': {
        const shared = parts.find(part => part.action === 'lending_composition');
        if (shared) shared.nodes.push(node(step)); else parts.push({ action: 'lending_composition', nodes: [node(step)], symbols: [] });
        break;
      }
      case 'OTHER': parts.push({ action: d.actionType, nodes: [node(step)], symbols: [] }); break;
    }
  }
  return parts;
}
/** FloFi's 0.80% fee basis of the authored workflow, per asset (an estimate before Review: never charged at this time). */
export function platformFeeFacts(workflow: Workflow, context: ReviewContext): PlatformFeeFacts {
  const parts = feeParts(workflow, context);
  if (!parts.length) return { rate: FEE_RATE, status: 'NOT_APPLICABLE', amounts: [], recorded: null };
  // Only the fields `principal.ts` reads: the action, a bridge's recipient, a position's deposit keys and the step's canonical nodes.
  const steps = parts.map(part => ({ ok: true, strategy: { action: part.action, ...part.recipient ? { recipient: part.recipient } : {}, ...part.maxAmounts ? { maxAmounts: part.maxAmounts } : {} },
    workflow: { ...workflow, nodes: part.nodes } }) as unknown as Composition);
  let basis: FeeBasis;
  try { basis = steps.length === 1 ? singleStepFeeBasis(steps[0]!) : workflowFeeBasis({ steps, bindings: [] }); }
  catch { return { rate: FEE_RATE, status: 'UNSUPPORTED', amounts: [], recorded: null }; }
  // The symbol the owner authored for that exact asset (a single-input step), else the network catalog's; never a guess.
  const symbolOf = (line: FeeBasis['lines'][number]): string | null => {
    for (const part of parts) for (const one of part.nodes) {
      const spends = one.userConstraints.filter(item => item.kind === 'MAXIMUM_INPUT') as unknown as { quantity: { asset: { chainId: string; address?: string; nativeId?: string; decimals: number } } }[];
      if (spends.length !== 1 || part.symbols.length !== 1) continue;
      const asset = spends[0]!.quantity.asset, evm = asset.chainId.startsWith('eip155:');
      const address = asset.address ? (evm ? asset.address.toLowerCase() : asset.address) : asset.nativeId === 'ETH' && evm ? NATIVE_ETH : asset.nativeId === 'SOL' && !evm ? SOLANA_MAINNET_TOKENS.SOL.mint : null;
      if (asset.chainId === line.chainId && asset.decimals === line.decimals && address === line.address) return part.symbols[0]!;
    }
    return resolveNetworkAsset(line.chainId, { address: line.address })?.symbol ?? null;
  };
  const amounts = basis.lines.flatMap(line => { const symbol = symbolOf(line), value = symbol ? simulationAmount(line.fee, line.decimals, symbol) : null; return value ? [value] : []; });
  return { rate: FEE_RATE, status: amounts.length || basis.status !== 'FEEABLE' ? basis.status : 'UNSUPPORTED', amounts, recorded: null };
}

const NOT_SIMULATED = 'Run a simulation to see the expected result.';
/**
 * The simulation facts of the workflow revision the chat shows. CURRENT only while the selected runtime's record is bound to exactly this revision
 * and unexpired (the projection's own guard); a record for another revision, wallet or network is CHANGED, an expired one EXPIRED, and neither
 * carries a figure. `canonical` is the whole workflow (a sequence simulates its current step alone; the fee basis covers every step).
 */
export function assistantSimulation(view: LifecycleView, canonical: { readonly workflow: Workflow; readonly context: ReviewContext }, now = Date.now()): AssistantSimulation {
  const fee = platformFeeFacts(canonical.workflow, canonical.context), actionable = workflowSteps(canonical.workflow, canonical.context).some(step => step.kind !== 'TEMPLATE');
  const base = { workflowId: canonical.workflow.workflowId, revision: canonical.workflow.revision, expiresAt: null, steps: [], costs: [], additional: [], ceilings: [], missing: [],
    platformFee: fee, problem: null, actionable };
  if (view.source.state.busy) return { ...base, status: 'RUNNING' };
  const simulation = projectSimulation(view.workflow, view.context, view.source, now);
  if (simulation.message === NOT_SIMULATED || simulation.message === SIMULATION_AVAILABILITY_CHECKING) return { ...base, status: 'NONE' };
  const review = conversationReview(view, now);
  if (review.status === 'expired' || /expired/i.test(simulation.message)) return { ...base, status: 'EXPIRED' };
  if (review.status === 'invalidated' || simulation.status === 'blocked' && /changed/i.test(simulation.message)) return { ...base, status: 'CHANGED' };
  if (simulation.status === 'blocked') return { ...base, status: 'BLOCKED', problem: simulation.message };
  if (!simulation.steps.some(step => step.result !== null || step.minimum !== null)) return { ...base, status: 'NONE' };
  const kinds = workflowSteps(view.workflow, view.context);
  const steps = review.steps.map((step, at) => ({ number: step.number, kind: kinds.find(item => item.nodeId === simulation.steps[at]?.id)?.kind ?? null, action: step.action, input: step.input,
    output: step.result, outputLabel: step.resultLabel, minimum: step.minimum, provider: step.provider }));
  const costs = review.fees.filter(line => line.treatment !== 'COMPONENT' && line.treatment !== 'OBLIGATION').map(line => ({ label: line.label, value: line.value, treatment: line.treatment ?? null }));
  const obligation = review.fees.find(line => line.treatment === 'OBLIGATION')?.value ?? null;
  return { ...base, status: 'CURRENT', expiresAt: review.expiresAt ?? simulation.expiresAt, steps, costs, additional: review.totals.additional, ceilings: review.totals.ceilings,
    missing: review.unknown, platformFee: { ...fee, recorded: obligation } };
}
