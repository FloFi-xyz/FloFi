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
import { channelCopy, shorten } from './copy.ts';
import type { ChannelReply } from './types.ts';

type Progress = NonNullable<Awaited<ReturnType<typeof channelApprovalProgress>>>['progress'];
const text = (value: string): ChannelReply => ({ text: shorten(value), choices: [], link: null });
const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;
export const ENDED = new Set(['EXPIRED', 'SUPERSEDED', 'REVOKED', 'STALE']);

/** The reply to STATUS for this conversation's most recent proposal. */
export function statusReplies(language: ChannelLanguage, found: { readonly handoff: HandoffRecord; readonly progress: Progress } | null): ChannelReply[] {
  const m = channelCopy(language);
  if (!found) return [text(m.noApproval)];
  const { progress } = found, lines = [m.approval(progress.status, hhmm(progress.expiresAt))];
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
export function plannedNotifications(language: ChannelLanguage, handoff: HandoffRecord, progress: Progress): { readonly due: readonly PlannedNotification[]; readonly done: boolean } {
  const m = channelCopy(language), due: PlannedNotification[] = [];
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
