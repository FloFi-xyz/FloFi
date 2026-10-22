// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CHANNELS-001: what a conversation may learn about its own proposals — read from the shared platform, written by FloFi.
 *
 * The approval's state is always visible to the conversation that created it. Runs started from it are visible ONLY while the wallet
 * owner shares them (their explicit choice on /approve, default off for channels), and then only as public facts: the run id is not
 * exposed as a separate fact — its owner-scoped receipt link, status, reconciliation, evidence environment and outcome are shared
 * exactly as FloFi recorded them (MOCKED stays MOCKED). Never the claiming wallet, transaction bytes, calldata or a signature.
 */
import { createHash } from 'node:crypto';
import type { HandoffRecord } from '../../platform/index.ts';
import type { channelApprovalProgress } from './approval.ts';
import type { ChannelLanguage } from './config.ts';
import { channelCopy, shorten, type RunFacts } from './copy.ts';
import type { ChannelReply } from './types.ts';

type Progress = NonNullable<Awaited<ReturnType<typeof channelApprovalProgress>>>['progress'];
const text = (value: string): ChannelReply => ({ text: shorten(value), choices: [], link: null });
const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;
export const ENDED = new Set(['EXPIRED', 'SUPERSEDED', 'REVOKED', 'STALE']);
/** BUILD-CHAT-E2E-001: a run the conversation can still hear about (a halted one may resume). */
export const OPEN_RUN = new Set(['PENDING', 'RUNNING', 'ATTENTION', 'HALTED']);
type WorkflowRunProgress = NonNullable<Progress['workflowRun']>;
const runFacts = (run: WorkflowRunProgress): RunFacts => ({ state: run.state,
  steps: run.steps.map(step => ({ index: step.index, action: step.action, state: step.state, transaction: step.outcome?.submissions[0]?.hash ?? null })) });
/** The non-secret continuation link of a multi-step approval: only the run owner's proven wallet can open it. */
export const continuationUrl = (origin: string, approvalId: string) => `${origin}/approve#${approvalId}`;

/** The reply to STATUS for this conversation's most recent proposal. */
export function statusReplies(language: ChannelLanguage, found: { readonly handoff: HandoffRecord; readonly progress: Progress } | null): ChannelReply[] {
  const m = channelCopy(language);
  if (!found) return [text(m.noApproval)];
  const { progress } = found, lines = [m.approval(progress.status, hhmm(progress.expiresAt))];
  // BUILD-CHAT-E2E-001: a multi-step approval reports its run: step states always, transactions only while the owner shares status.
  if (progress.workflowRun) {
    const run = progress.workflowRun;
    lines.push(m.workflowRun(runFacts(run.stepsVisible ? run : { ...run, steps: run.steps.map(s => ({ ...s, outcome: null })) })));
    if (!run.stepsVisible) lines.push(m.notShared);
    return [text(lines.join('\n'))];
  }
  if (progress.status === 'APPLIED') {
    if (!progress.runsVisible) lines.push(m.notShared);
    else if (!progress.runs.length) lines.push(m.noRuns);
    else lines.push(...progress.runs.map(m.run));
  }
  return [text(lines.join('\n'))];
}

export type PlannedNotification = { readonly key: string; readonly text: string };
/**
 * Notifications due for a handoff's progress, each with a stable key (so a repeated check never sends twice): "loaded in FloFi" once
 * the owner claimed it and shares status, then each recorded lifecycle state once and its terminal outcome once. `done` once nothing more can
 * follow.
 */
export function plannedNotifications(language: ChannelLanguage, handoff: HandoffRecord, progress: Progress, origin?: string):
  { readonly due: readonly PlannedNotification[]; readonly done: boolean } {
  const m = channelCopy(language), due: PlannedNotification[] = [];
  // BUILD-CHAT-E2E-001: a running workflow outlives its approval link's own window, so its run decides (not the link's expiry).
  if (progress.workflowRun) return workflowNotifications(language, handoff, progress.workflowRun, origin);
  if (ENDED.has(progress.status)) return { due, done: true };
  if (!handoff.shareStatus || (progress.status !== 'CLAIMED' && progress.status !== 'APPLIED')) return { due, done: false };
  due.push({ key: `notify:${handoff.handoffId}:loaded`, text: m.loaded });
  for (const run of progress.runs) {
    const id = createHash('sha256').update(run.executionId).digest('hex').slice(0, 16);
    // Preparation creates a run too. Keep its notice distinct so it cannot consume a later authorization/submission notice.
    if (!run.terminal) due.push({ key: `notify:${handoff.handoffId}:run:${id}:state:${run.status.toLowerCase()}`, text: shorten(m.run(run)) });
    else due.push({ key: `notify:${handoff.handoffId}:run:${id}:${run.reconciled ? 'reconciled' : 'ended'}`, text: shorten(m.run(run)) });
  }
  return { due, done: progress.runs.length > 0 && progress.runs.every(r => r.terminal) };
}

/**
 * BUILD-CHAT-E2E-001: notifications of a multi-step workflow's run, while its owner shares status: each step's outcome once (reconciled, failed,
 * uncertain, stopped), "step N is ready for your signature" once per step (with the continuation link), and the run's end once. `done` once the run
 * is over (a halted run may still resume, so it is followed until it ends).
 */
function workflowNotifications(language: ChannelLanguage, handoff: HandoffRecord, run: WorkflowRunProgress, origin?: string) {
  const m = channelCopy(language), due: PlannedNotification[] = [], key = (suffix: string) => `notify:${handoff.handoffId}:wfr:${suffix}`;
  const done = !OPEN_RUN.has(run.state);
  if (!handoff.shareStatus || !run.stepsVisible) return { due, done };
  for (const step of run.steps) if (['RECONCILED', 'FAILED', 'UNCERTAIN', 'BLOCKED'].includes(step.state))
    due.push({ key: key(`step:${step.index}:${step.state.toLowerCase()}`), text: shorten(m.workflowRun(runFacts({ ...run, steps: [step] }))) });
  if (run.nextAction === 'OWNER_SIGNS_STEP' && run.currentStep > 0 && origin)
    due.push({ key: key(`ready:${run.currentStep}`), text: m.stepReady(run.currentStep + 1, continuationUrl(origin, handoff.handoffId)) });
  if (run.state === 'COMPLETED') due.push({ key: key('done'), text: m.runDone });
  else if (run.state === 'HALTED') due.push({ key: key('halted'), text: m.runHalted });
  else if (run.state === 'ATTENTION') due.push({ key: key('attention'), text: m.runAttention });
  else if (done) due.push({ key: key('ended'), text: m.runEnded(run.code ?? run.state) });
  return { due, done };
}
