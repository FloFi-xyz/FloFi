// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-SINGLE-CARD-ONE-CONFIRMATION-001 (History deletion): before History's Delete of a single-card attempt reaches the API's guarded
 * purge (migration 0033), an attempt that is still open only because the batch the owner's wallet REJECTED was never ended is ended here — and
 * only when the server proves from the chain that the rejected batch was never sent (`workflowRunEndVerifiedDecline` →
 * `user-funded/decline-proof.ts`). Anything else changes nothing: the API then decides (and refuses whatever is not provably unsubmitted).
 * Authority: the run is read only to find its handoff; ending it goes through the same owner proof as the Editor's "End workflow" (this
 * browser's proven wallets must be the run's own). Nothing is prepared, signed or sent.
 */
import { cookies } from 'next/headers';
import { workflowRunEndVerifiedDecline } from '../platform/index';
import { createPgWorkflowRunStore } from '../workflow-runs/pg-store';
import { approvalSurface } from './approval-surface';
import { platformStateHost } from './platform-state-host';
import { currentWalletPrincipals } from './session-principal';

const RUN_ID = /^wfr_[a-z2-7]{26}$/;

/** Ends a still-open single-card attempt whose rejected batch is proven unsent; returns whether it did. Never throws. */
export async function endVerifiedDeclinedAttempt(runId: string): Promise<boolean> {
  if (!RUN_ID.test(runId)) return false;
  try {
    const env = process.env, host = await platformStateHost(env);
    const run = await createPgWorkflowRunStore(host.db, host.tenantId).byId(runId);
    if (!run || run.state !== 'RUNNING' || run.mode !== 'USER_FUNDED' || run.stepCount !== 1 || run.requester.kind !== 'EDITOR_SESSION') return false;
    const jar = await cookies();
    await workflowRunEndVerifiedDecline(await approvalSurface(env, name => jar.get(name)?.value), run.handoffId, await currentWalletPrincipals());
    return true;
  } catch {
    return false;
  }
}
