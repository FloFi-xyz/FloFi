// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (completion, §3.2): the platform fee of a direct single-flow execution (an `execution_runs` root run
 * that no workflow run owns: a swap, transfer, bridge, supply or composition executed straight from the app, an approval page or a channel).
 *
 * Same policy, same principal rules and same ledger as a workflow run: the basis is `workflowFeeBasis` over the run's own reviewed canonical
 * workflow (the semantic workflow the flow simulated, reviewed and executed), read from its durable record. Nothing here trusts a client value.
 *   - each financial node is one step, in order; its action is the node's action type (never a label);
 *   - a step whose action has no approved policy (borrow, withdraw, repay, liquidity) is NOT_APPLICABLE; a node this module cannot read (a fiat
 *     payment, an unknown action type) makes the execution UNSUPPORTED: never charged;
 *   - the final principal of an asset never exceeds what the reconciled record proves the owner spent of it, when the record states it.
 * A workflow step's run, a recovery run (its root carries the execution) and a fee settlement transfer are not executions of their own: the
 * ledger query excludes them (`ledger.ts`), so a bridge inside a workflow is charged once, by its parent.
 */
import type { Composition } from '../engine/strategy-engine';
import { assetKey } from '../delegation/steps.ts';
import { amountsFromOwnerRecord } from '../workflow-runs/received-amounts.ts';
import { workflowOf } from '../admin/analytics/actions.ts';
import { platformFeeAmount } from './policy';
import type { AssetClassOf, FeeBasis, FeeLine } from './principal';
import { semanticWorkflowFeeBasis } from './semantic-basis';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export { nodeFeeAction } from './semantic-basis';

/** The reviewed canonical workflow of a single-flow record, or null when the record holds none. */
export function recordSemanticWorkflow(record: unknown): Composition['workflow'] | null {
  if (!object(record)) return null;
  const workflow = workflowOf(record);
  return object(workflow) && Array.isArray(workflow.nodes) && workflow.nodes.length > 0 && typeof workflow.workflowId === 'string'
    ? workflow as unknown as Composition['workflow'] : null;
}

/**
 * The fee basis of one single-flow execution from its durable record. `final`: cap each asset's principal at what the reconciled record proves
 * was spent (Review-time callers pass false: the estimate never exceeds the reviewed maximum input).
 */
export function singleFlowFeeBasis(record: unknown, options: { readonly final: boolean; readonly flow?: string; readonly assetClassOf?: AssetClassOf }): FeeBasis {
  const basis = semanticWorkflowFeeBasis(recordSemanticWorkflow(record), options);
  return options.final && basis.status === 'FEEABLE' ? capBySpent(basis, record) : basis;
}

/** Caps each asset's principal at the reconciled amount the record proves the owner spent (no statement: the reviewed amount stands). */
function capBySpent(basis: FeeBasis, record: unknown): FeeBasis {
  const spent = new Map<string, bigint>();
  for (const fact of amountsFromOwnerRecord(record).spent) {
    if (/^(0|[1-9][0-9]{0,77})$/.test(fact.amount)) spent.set(fact.asset, (spent.get(fact.asset) ?? 0n) + BigInt(fact.amount));
  }
  if (!spent.size) return basis;
  const lines: FeeLine[] = basis.lines.flatMap(line => {
    const proven = spent.get(assetKey({ chain: line.chainId, address: line.address }));
    if (proven === undefined || proven >= BigInt(line.principal)) return [line];
    const fee = platformFeeAmount(proven);
    return fee > 0n ? [{ ...line, principal: proven.toString(), fee: fee.toString() }] : [];
  });
  return lines.length ? { ...basis, lines } : { ...basis, status: 'NOT_APPLICABLE', lines: [], reason: 'PLATFORM_FEE_BELOW_ONE_UNIT' };
}

/** The ledger network environment of a single-flow run from its recorded provenance. */
export function singleFlowEnvironment(provenance: string): 'MAINNET' | 'PUBLIC_TESTNET' | 'MOCKED' | null {
  if (provenance === 'PUBLIC_MAINNET') return 'MAINNET';
  if (provenance === 'PUBLIC_TESTNET' || provenance === 'PUBLIC_DEVNET') return 'PUBLIC_TESTNET';
  return provenance === 'MOCKED' ? 'MOCKED' : null;
}

/**
 * How a single-flow run's projected status settles its ledger row (pure): COMPLETED (charge per the basis), WAIVED (it reached a chain and did not
 * complete: never charged), or null (still open, or it never reached a chain: nothing is recorded). An unknown status records nothing.
 */
export function singleFlowOutcome(status: string, hasEvidence: boolean): 'COMPLETED' | 'WAIVED' | null {
  if ((status === 'RECONCILED' || status === 'COMPLETED') && hasEvidence) return 'COMPLETED';
  if (['REVERTED', 'DIVERGENT', 'FAILED', 'REFUNDED'].includes(status)) return 'WAIVED';
  return null;
}
