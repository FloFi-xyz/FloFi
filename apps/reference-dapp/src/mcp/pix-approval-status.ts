// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #149 (P0): `get_approval_status` / `get_execution_progress` for an approval whose plan executes through the Pix payment flow
 * (`pix-payment`). The shared `sharedRuns` binds a run to a proposal by the hash of the workflow its record reviewed; a Pix run's record
 * reviews a payment node and its Strategy Manifest commitment, not an editor workflow, so it never matched and Pix runs were never listed.
 *
 * A Pix run is listed for an approval only when every fact below holds — never by timing or by owner alone, and nothing is ever written:
 *   requester   the approval is this requester's own (`approvalForRequester`, account isolation, checked by the caller)
 *   approval    APPLIED, its owner shares status, claimed by an EVM wallet (the Pix source wallet) with a claim time; otherwise no run is read
 *   binding     the run id is durably bound to THIS approval (`runIds`, written server-side by FloFi); an unbound Pix run of the same wallet
 *               is not this proposal and is never attributed to it
 *   owner       the run is read AS the claimant wallet (the runtime answers null for anyone else's run), and its summary and durable record
 *               both name that wallet as owner, the record is that run (same id) and it was created after the claim
 * State is the run's own recorded status and its canonical lifecycle (`canonicalRunLifecycle`); `reconciled` and a receipt need the
 * flow's settled evidence (PAYMENT_SETTLED with a bundle hash equal to the record's), never a status label. Nothing here creates, claims,
 * applies or upgrades an approval.
 */
import { canonicalRunLifecycle, type CanonicalLifecycle } from '../domain/canonical-execution-status.ts';
import { approvalStatus, type ApprovalProgress, type HandoffRecord, type RunProgress } from '../platform/index.ts';
import type { McpRuntime } from './runtime.ts';

export const PIX_FLOW = 'pix-payment' as const;
const PIX_RUN_ID = /^pay-[a-f0-9]{32}$/, EVM = /^0x[0-9a-fA-F]{40}$/;
const MAX_RUNS = 8;
export type PixRunProgress = RunProgress & { readonly lifecycle: CanonicalLifecycle; readonly receiptUrl: string | null };
export type PixApprovalProgress = ApprovalProgress & { readonly runs: readonly PixRunProgress[]; readonly runsComplete?: false; readonly runsReadError?: string };

export const isPixApproval = (h: Pick<HandoffRecord, 'plan'>) => h.plan.flow === PIX_FLOW && h.plan.kind !== 'SEQUENTIAL';

type PixRecordFacts = { readonly id: string; readonly state: string; readonly owner: string; readonly evidenceBundleHash: string | null };
/** The few facts of a Pix durable record this view needs, or null when the record is not a well-formed Pix record. */
function pixRecord(value: unknown): PixRecordFacts | null {
  const r = value && typeof value === 'object' ? value as { id?: unknown; state?: unknown; facts?: { owner?: { address?: unknown } }; evidence?: { bundleHash?: unknown } | null } : null;
  const owner = r?.facts?.owner?.address;
  if (!r || typeof r.id !== 'string' || !PIX_RUN_ID.test(r.id) || typeof r.state !== 'string' || typeof owner !== 'string' || !EVM.test(owner)) return null;
  return { id: r.id, state: r.state, owner: owner.toLowerCase(), evidenceBundleHash: typeof r.evidence?.bundleHash === 'string' ? r.evidence.bundleHash : null };
}

/**
 * The status of a Pix approval for its requester. `runsVisible` is false (and no run is read) unless the approval is applied, claimed and
 * shared; `runsComplete: false` with `runsReadError` says a bound run could not be read — its state is then UNKNOWN, never "not started".
 */
export async function pixApprovalProgress(h: HandoffRecord, runtime: McpRuntime, origin: string | null): Promise<PixApprovalProgress> {
  const base = approvalStatus(h);
  const visible = h.status === 'APPLIED' && h.shareStatus && h.claimed !== null && h.claimed.namespace === 'eip155' && EVM.test(h.claimed.address) && h.claimedAt !== null
    && Boolean(runtime.record);
  if (!visible) return { ...base, runs: [], runsVisible: false, workflowRun: null,
    note: h.status === 'APPLIED' && !h.shareStatus ? 'The owner has not shared the status of runs started from this proposal.' : null };
  const owner = h.claimed!.address.toLowerCase(), claimedAt = h.claimedAt!.getTime() - 1_000;
  const bound = [...new Set(h.runIds)].filter(id => PIX_RUN_ID.test(id)).slice(0, MAX_RUNS);
  const runs: PixRunProgress[] = [];
  let readError: string | null = null;
  for (const runId of bound) {
    const run = await runtime.run(runId, owner);
    if (!run.ok) { readError ??= run.code; continue; }
    const summary = run.value;
    // Absent, another wallet's, another flow's or older than the claim: not this approval's run (and indistinguishable on purpose).
    if (!summary || summary.runId !== runId || summary.flow !== PIX_FLOW || summary.ownerAccount?.toLowerCase() !== owner || Date.parse(summary.createdAt) < claimedAt) continue;
    const read = await runtime.record!(PIX_FLOW, runId, owner);
    if (!read.ok) { readError ??= read.code; continue; }
    const record = pixRecord(read.value);
    if (!record || record.id !== runId || record.owner !== owner) continue;
    let evidence: { environment: string; outcome: string; bundleHash: string } | null = null;
    if (summary.hasEvidence) {
      const e = await runtime.evidence(PIX_FLOW, runId, owner);
      if (e.ok && e.value) evidence = { environment: e.value.environment, outcome: e.value.outcome, bundleHash: e.value.bundleHash };
    }
    // Settled only with the flow's own settled evidence, the same bundle in the record, nothing left to observe and no recorded error.
    const reconciled = !summary.needsObservation && summary.errorCode === null && summary.status === 'PAYMENT_SETTLED' && record.state === 'PAYMENT_SETTLED'
      && Boolean(evidence && evidence.outcome === 'PAYMENT_SETTLED' && evidence.environment && evidence.bundleHash && evidence.bundleHash === record.evidenceBundleHash);
    const lifecycle = canonicalRunLifecycle({ ...summary, hasEvidence: reconciled });
    runs.push({ executionId: summary.runId, flow: summary.flow, status: summary.status, lifecycle, reconciled, errorCode: summary.errorCode,
      terminal: !summary.needsObservation && lifecycle.final, evidenceEnvironment: reconciled ? evidence!.environment : null,
      evidenceOutcome: reconciled ? evidence!.outcome : null, evidenceBundleHash: reconciled ? evidence!.bundleHash : null, updatedAt: summary.updatedAt,
      receiptUrl: reconciled && origin ? `${origin}/app/dashboard/runs/${encodeURIComponent(summary.runId)}` : null });
  }
  return { ...base, runs, runsVisible: true, workflowRun: null,
    note: readError ? 'Some runs of this approval could not be read now; their state is UNKNOWN (not "not started"). Read get_approval_status again.'
      : runs.length ? null : 'No Pix payment run is bound to this approval yet.',
    ...readError ? { runsComplete: false as const, runsReadError: readError } : {} };
}
