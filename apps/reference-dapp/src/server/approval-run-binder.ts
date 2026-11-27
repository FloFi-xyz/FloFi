// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 (KAN-25): an approval's run keeps its origin from the moment it is simulated.
 *
 * A one-step proposal (plan SINGLE_FLOW) from an MCP client, a channel conversation, a developer sandbox or an automation is executed on
 * FloFi's signing page through the ordinary /app flow (`app/cloud-flow.ts` → `server/flow-runtime.ts`). Before this, its run was bound to the
 * approval only lazily (`platform/approvals.ts` sharedRunsRead, when the owner shares status and the requester polls) or by native signing; an
 * unbound run reads, in the Admin, as a direct FloFi Web run (`admin/analytics/channels.ts`). This binder, one of the successful-simulation
 * observers (`server/simulation-observer.ts`), binds the simulated run to every approval it is exactly the run of, with the existing
 * `HandoffStore.bindRuns`:
 *
 *   approval   APPLIED, plan SINGLE_FLOW on the call's flow, created within the last BIND_WINDOW_DAYS (the `mcp_handoffs_expiry` index);
 *   workflow   the simulated workflow (`args[0]`) hashes, server-side with the same `semanticWorkflowHash` the approval uses, to EXACTLY the
 *              approval's workflow hash (an edited workflow is not this proposal);
 *   owner      the owner named by the call (`args[1]`) is the VERIFIED wallet session of this request (HttpOnly cookie, `session-principal.ts`)
 *              of that namespace, and that wallet is the approval's proven claimant — never `args[1]` alone;
 *   run        the run id the server's own simulation result names (`flight/simulation-record.ts` runIdOf), created after the claim.
 *
 * These are the same facts `sharedRunsRead` requires before binding, so a binding here never changes what a requester can see: every read of a
 * bound run still requires the owner's status sharing (`shareStatus`), the claimant wallet and the exact reviewed hash. It is bookkeeping, never
 * authority. It never affects the simulation: it runs after it, beside the Flight observer, and whatever it does (throw, reject, hang) the
 * result is returned unchanged within SIMULATION_OBSERVER_MS. Logging is content-free (fixed codes only: no id, address, hash or flow).
 * The Pix payment flow keeps its own binding contract (`mcp/pix-approval-status.ts`) and is never bound here.
 */
import { createLogger, type Database } from '@defi-workflow-engine/cloud-runtime';
import type { Workflow } from '../domain/initial-workflow';
import { semanticWorkflowHash } from '../engine/strategy-engine';
import { runIdOf } from '../flight/simulation-record.ts';
import { createPgHandoffStore } from '../platform/handoff-store.ts';
import type { SimulationCall } from './simulation-observer.ts';

type Env = Readonly<Record<string, string | undefined>>;
type Namespace = 'eip155' | 'solana';
export type RunBindingOutcome = 'NOT_APPLICABLE' | 'NO_SESSION' | 'NO_MATCH' | 'BOUND' | 'RUN_LIMIT';
export type RunBinderDeps = {
  readonly host: () => Promise<{ readonly db: Database; readonly tenantId: string }>;
  readonly now: Date;
  /** The VERIFIED wallet session of this request for one namespace (server-side), or null. */
  readonly verifiedWallet: (namespace: Namespace) => Promise<string | null>;
};

export const BIND_WINDOW_DAYS = 30;
/** `mcp_handoffs.run_ids` holds at most 16 runs (0005); `bindRuns` leaves a full list unchanged. */
const MAX_BOUND_RUNS = 16;
const NOT_BOUND_HERE = new Set(['pix-payment']);
const DAY = 86_400_000;

function ownerOf(value: unknown): { readonly namespace: Namespace; readonly address: string } | null {
  if (typeof value !== 'string') return null;
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return { namespace: 'eip155', address: value.toLowerCase() };
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return { namespace: 'solana', address: value };
  return null;
}
function workflowHashOf(value: unknown): string | null {
  const w = value as { readonly workflowId?: unknown; readonly nodes?: unknown } | null;
  if (!w || typeof w !== 'object' || Array.isArray(w) || typeof w.workflowId !== 'string' || !Array.isArray(w.nodes)) return null;
  try { return semanticWorkflowHash(value as Workflow); } catch { return null; }
}
/** The call's facts, or null when it cannot be an approval's run (checked before any cookie or database is read). */
function facts(call: SimulationCall) {
  if ((call.method !== 'simulate' && call.method !== 'prepare') || !/^[a-z][a-z0-9-]{1,63}$/.test(call.flow) || NOT_BOUND_HERE.has(call.flow)) return null;
  const runId = runIdOf(call.method, call.value), owner = ownerOf(call.args[1]), workflowHash = owner && runId ? workflowHashOf(call.args[0]) : null;
  return runId && owner && workflowHash ? { runId, owner, workflowHash } : null;
}

/** Binds the simulated run to the approvals it is exactly the run of. */
export async function bindSimulatedRun(call: SimulationCall, deps: RunBinderDeps): Promise<RunBindingOutcome> {
  const fact = facts(call);
  if (!fact) return 'NOT_APPLICABLE';
  const verified = await deps.verifiedWallet(fact.owner.namespace);
  const proven = fact.owner.namespace === 'eip155' ? verified?.toLowerCase() : verified;
  if (!proven || proven !== fact.owner.address) return 'NO_SESSION';
  const { db, tenantId } = await deps.host();
  const { rows } = await db.query<{ handoff_id: string; bound: number }>(`SELECT handoff_id, cardinality(run_ids)::int AS bound FROM mcp_handoffs
    WHERE tenant_id = $1 AND created_at >= $2 AND created_at <= $3 AND status = 'APPLIED' AND plan->>'kind' = 'SINGLE_FLOW' AND plan->>'flow' = $4
      AND workflow_hash = $5 AND claimed_namespace = $6 AND claimed_address = $7 AND claimed_at <= $3 AND NOT ($8::text = ANY(run_ids))
    ORDER BY created_at DESC LIMIT 4`,
  [tenantId, new Date(deps.now.getTime() - BIND_WINDOW_DAYS * DAY), deps.now, call.flow, fact.workflowHash, fact.owner.namespace, fact.owner.address, fact.runId]);
  if (!rows.length) return 'NO_MATCH';
  const open = rows.filter(row => row.bound < MAX_BOUND_RUNS), store = createPgHandoffStore(db, tenantId);
  for (const row of open) await store.bindRuns(row.handoff_id, [fact.runId]);
  return open.length === rows.length ? 'BOUND' : 'RUN_LIMIT';
}

const report = (outcome: 'bound' | 'run_limit' | 'unavailable' | 'failed') => createLogger({ service: 'flofi-web' }).info('approval.run_binding', { outcome });
/** The observer `app/cloud-flow.ts` registers: this request's verified sessions and the platform state database. Never throws. */
export async function bindApprovalRunOfRequest(call: SimulationCall, env: Env = process.env): Promise<void> {
  if (!facts(call)) return;
  try {
    const [{ currentSolanaSession, currentWalletSession }, { platformStateHost }] = await Promise.all([import('./session-principal.ts'), import('./platform-state-host.ts')]);
    let unavailable = false;
    const outcome = await bindSimulatedRun(call, { now: new Date(),
      host: () => platformStateHost(env).catch(error => { unavailable = true; throw error; }),
      // No readable session (no request scope, no cookie, an invalid seal) is no verified owner: nothing is bound, nothing is logged.
      verifiedWallet: async namespace => (await (namespace === 'solana' ? currentSolanaSession() : currentWalletSession()).catch(() => null))?.account ?? null,
    }).catch(error => { if (unavailable) return 'UNAVAILABLE' as const; throw error; });
    if (outcome === 'BOUND' || outcome === 'RUN_LIMIT' || outcome === 'UNAVAILABLE') report(outcome === 'BOUND' ? 'bound' : outcome === 'RUN_LIMIT' ? 'run_limit' : 'unavailable');
  } catch { report('failed'); }
}
