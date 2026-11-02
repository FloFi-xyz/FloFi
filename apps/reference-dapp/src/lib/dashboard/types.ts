// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from the FloFi Dashboard delivery. Read models only; never execution state.
import type { ExecutionLifecycle } from '../../domain/execution-lifecycle';

export type DashboardRun = {
  runId: string; workflowId: string; flow: string; status: string; provenance: string;
  ownerAccount: string; errorCode: string | null; needsObservation: boolean;
  attentionRequired: boolean; hasEvidence: boolean; createdAt: string | null; updatedAt: string | null;
  /**
   * Issue #149: the run's recorded attempts when they were read (absent: not read, so the summary alone speaks). An empty list means
   * none are recorded. `attemptsUnavailable`: a read was needed and failed, so "nothing was sent" is never claimed for this run.
   */
  attempts?: readonly DashboardAttempt[]; attemptsUnavailable?: boolean;
};
export type DashboardConnection = 'SIGN_IN_REQUIRED' | 'NOT_CONFIGURED' | 'UNAVAILABLE' | 'CONNECTED';
export type DashboardSnapshot = { connection: DashboardConnection; account: string | null; runs: DashboardRun[]; hasMore: boolean; next?: string | null };
export type DashboardAttempt = { attemptId: string; step: string; state: string; transactionHash: string | null; reconciled: boolean };
export type DashboardEvidence = { bundleHash: string; environment: string; outcome: string; verified: boolean; createdAt: string | null };
export type DashboardRunDetail = {
  run: DashboardRun; attempts: DashboardAttempt[]; evidence: DashboardEvidence[];
  record: unknown; evidenceUnavailable: boolean; recordUnavailable: boolean;
};
export type DashboardDetailResponse = { connection: DashboardConnection | 'NOT_FOUND'; account: string | null; detail: DashboardRunDetail | null };
export type DashboardStatus = 'Completed' | 'Completed with attention' | 'In progress' | 'Needs attention' | 'Partially completed' | 'Failed' | 'Unresolved' | 'Transaction not submitted' | 'Not started';
export type DashboardRunView = {
  run: DashboardRun; title: string; status: DashboardStatus; message: string;
  attention: string[]; networks: string[]; completed: number | null; total: number | null;
  /** Issue #149: what landed onchain, from the recorded attempts (e.g. "Approval confirmed · main action not sent"); null when nothing did or unknown. */
  landed: string | null;
  recovered: boolean; reconciled: boolean; current: boolean; progress: ExecutionLifecycle | null;
};
