// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #149: what the Automations History says about one run started from a proposal. It follows the canonical lifecycle
 * (`domain/canonical-execution-status.ts`) over the run's recorded facts, so it names the same moment the Dashboard, chat and MCP name:
 *
 *   simulation      simulated or reviewed only: no wallet request, nothing sent
 *   refusal         the wallet request was declined, cancelled, expired or never submitted: nothing sent
 *   submission      a wallet request is pending, submitted or has a hash awaiting confirmation
 *   confirmation    a transaction is confirmed onchain (an approval alone is said as such: it is not the main action)
 *   reconciliation  only a run whose reconciled evidence FloFi verified reads "Execution reconciled"
 *
 * (The intention — a proposal opened or loaded with no run yet — is the occurrence's own label.) Display only: no automation decision reads it.
 */
import { canonicalRunLifecycle } from '../domain/canonical-execution-status';
import { landedAttempts } from '../domain/landed-attempts';
import type { RunView } from '../automations/views';

const SIMULATED = new Set(['DRAFT', 'QUOTED', 'PREPARED', 'SIMULATED']);
export function automationRunLabel(run: Pick<RunView, 'status' | 'reconciled' | 'errorCode' | 'evidenceBundleHash'> & Partial<Pick<RunView, 'needsObservation' | 'attempts'>>): string {
  // Reconciliation is claimed only with the evidence FloFi verified for this run (the shared approval model's check).
  if (run.reconciled) return 'Execution reconciled';
  const lifecycle = canonicalRunLifecycle({ status: run.status, errorCode: run.errorCode, needsObservation: run.needsObservation === true,
    hasEvidence: run.evidenceBundleHash !== null, ...run.attempts ? { attempts: run.attempts } : {} });
  // An approval that landed is never the main action, and never "nothing was sent" — but an uncertain, divergent or still-submitted state
  // keeps its own (attention) label (BUILD-FLOFI-E2E-RELIABILITY-001 workflow review).
  const landed = landedAttempts(run.attempts);
  if (landed.approvalOnly && ['CONFIRMED_ONCHAIN', 'PARTIALLY_COMPLETED', 'AUTHORIZATION_PENDING'].includes(lifecycle.status)) return landed.label!;
  switch (lifecycle.status) {
    // Attempts that could not be read never prove that nothing was sent (the Dashboard fails closed the same way).
    case 'NOT_STARTED': return run.attempts === null ? 'Status unresolved — no transaction is repeated' : SIMULATED.has(run.status) ? 'Simulated only — nothing was sent' : 'Reviewed only — nothing was sent';
    case 'AUTHORIZATION_PENDING': return 'Wallet request prepared — no submission recorded; open the run to check';
    // Attempts that could not be read cannot rule out an approval or an earlier step that landed (BUILD-FLOFI-E2E-RELIABILITY-001).
    case 'REJECTED': return run.attempts === null ? 'Status unresolved — no transaction is repeated' : 'Refused or not submitted — nothing was sent';
    case 'SUBMITTED': return 'Submitted — awaiting confirmation';
    case 'HASH_KNOWN': return 'Transaction sent — awaiting onchain confirmation';
    case 'CONFIRMED_ONCHAIN': return 'Confirmed onchain — reconciling';
    case 'SETTLEMENT_PENDING': return 'Origin confirmed — settlement pending';
    case 'RECONCILED': case 'RECONCILED_WITH_ATTENTION': return 'Outcome recorded — not yet verified as reconciled';
    case 'PARTIALLY_COMPLETED': return 'Partially completed — earlier actions confirmed';
    case 'REVERTED': return 'Transaction reverted';
    case 'FAILED': return 'Execution failed';
    case 'INCONCLUSIVE': return 'Status unresolved — no transaction is repeated';
    case 'INTERVENTION_REQUIRED': return 'Needs your review — open the run';
  }
}
/** Every label the History can show for a run (the PT catalog covers each). */
export const AUTOMATION_RUN_LABELS = Object.freeze(['Execution reconciled', 'Simulated only — nothing was sent', 'Reviewed only — nothing was sent',
  'Wallet request prepared — no submission recorded; open the run to check', 'Refused or not submitted — nothing was sent', 'Submitted — awaiting confirmation',
  'Transaction sent — awaiting onchain confirmation', 'Confirmed onchain — reconciling', 'Origin confirmed — settlement pending',
  'Outcome recorded — not yet verified as reconciled', 'Partially completed — earlier actions confirmed', 'Transaction reverted', 'Execution failed',
  'Status unresolved — no transaction is repeated', 'Needs your review — open the run']);
