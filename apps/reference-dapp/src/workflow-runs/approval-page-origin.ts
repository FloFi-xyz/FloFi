// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-PRODUCT-RELIABILITY-REVENUE-001 (KAN-25 §8.2): the channel of a single flow created on an approval page, decided when the run is
 * created — independently of whether its owner shares status with the requester (which decides only what the requester may SEE, and still
 * drives `HandoffStore.bindRuns`).
 *
 * An execution proposed through ChatGPT/Claude MCP, Telegram, the Developer API or an automation and signed on FloFi's approval page is created by
 * that page's `simulate`/`prepare` server action. The approval is resolved here, server side, from trusted facts only:
 *   - the page: the proxy's authoritative path (`/approve` or `/mcp/approve`), carried by FloFi's own server (`execution-origins.ts` context);
 *   - the claimant: a wallet this request proved (HttpOnly sign-in cookies, read by FloFi's server) that is also the run's own durable owner and the
 *     wallet that claimed the approval;
 *   - the proposal: the run's own stored record, whose reviewed workflow hashes EXACTLY (canonically) to the approval's workflow hash, on the
 *     approval's single flow, while the approval is live (claimed and within its claim window, or applied) and claimed no later than now.
 * Exactly one requester channel must result: approvals of different channels that all match (the same wallet holding two proposals of the same
 * workflow) record nothing here (Unknown until a binding or the audited backfill decides). Read-only; the caller writes the origin (first record
 * wins) and never lets this fail or delay the financial call beyond its bounded write.
 */
import type { Queryable } from '@defi-workflow-engine/cloud-runtime';
import type { Workflow } from '../domain/initial-workflow.ts';
import { semanticWorkflowHash } from '../engine/strategy-engine.ts';
import { originOfRequester, type ExecutionOrigin, type OriginWallet } from './execution-origins.ts';

/** The workflow a flow record reviewed, wherever the flow keeps it (review, workflow, or the first of several reviews). */
export function reviewedWorkflows(record: unknown): unknown[] {
  const r = record && typeof record === 'object' ? record as { review?: { workflow?: unknown }; workflow?: unknown; reviews?: { workflow?: unknown }[] } : {};
  return [r.review?.workflow, r.workflow, Array.isArray(r.reviews) ? r.reviews[0]?.workflow : undefined].filter(w => w && typeof w === 'object');
}
const hashesOf = (record: unknown) => [...new Set(reviewedWorkflows(record).flatMap(w => { try { return [semanticWorkflowHash(w as Workflow)]; } catch { return []; } }))];
const normalized = (namespace: OriginWallet['namespace'], address: string) => namespace === 'eip155' ? address.toLowerCase() : address;

export type ApprovalPageRun = {
  readonly flow: string; readonly runId: string;
  /** The wallets this request proved (never a client-supplied address). */
  readonly wallets: readonly OriginWallet[];
  /** The run's durable owner (`execution_runs.owner_account`, else its record's owner), and its stored record. */
  readonly owner: string | null; readonly record: unknown; readonly now: Date };

/** The origin of an approval-page run, or null when no single live approval of this claimant proposed exactly this workflow. */
export async function approvalPageOrigin(db: Queryable, tenantId: string, run: ApprovalPageRun): Promise<ExecutionOrigin | null> {
  if (!run.owner || !run.wallets.length) return null;
  const owner = run.owner.startsWith('0x') ? run.owner.toLowerCase() : run.owner;
  const claimant = run.wallets.find(w => normalized(w.namespace, w.address) === owner);
  if (!claimant) return null;
  const hashes = hashesOf(run.record);
  if (!hashes.length) return null;
  const { rows } = await db.query<{ requester_kind: string; client_id: string }>(`SELECT requester_kind, client_id FROM mcp_handoffs
    WHERE tenant_id = $1 AND claimed_namespace = $2 AND (CASE WHEN $2 = 'eip155' THEN lower(claimed_address) ELSE claimed_address END) = $3
      AND plan->>'kind' IN ('SINGLE_FLOW', 'COMPOSITE_FLOW') AND plan->>'flow' = $4 AND workflow_hash = ANY($5::text[])
      AND (status = 'APPLIED' OR (status = 'CLAIMED' AND claim_expires_at > $6)) AND ended_at IS NULL AND claimed_at <= $6
    ORDER BY claimed_at DESC LIMIT 8`, [tenantId, claimant.namespace, owner, run.flow, hashes, run.now]);
  const origins = new Set(rows.map(row => originOfRequester(row.requester_kind, row.client_id)));
  return origins.size === 1 ? [...origins][0]! : null;
}
