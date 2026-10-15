// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkflowView } from '../../admin/analytics/view';
import { ANALYTICS_ROW_LIMIT } from '../../admin/analytics/workflows';
import { fmt } from './charts';

const when = (date: Date) => `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/**
 * BUILD-ADMIN-001: what the figures of one analytics view leave out, said next to them (Overview and Workflows). Every gap the view can
 * detect is listed: a truncated range, records not indexed or unreadable, unrecognized actions, unclassified statuses, unknown provenance
 * and delegated executions (separate records). Nothing is estimated to fill a gap.
 */
export function DataNotes({ view }: { view: Extract<WorkflowView, { ok: true }> }) {
  const a = view.analytics, notes: string[] = [];
  if (a.coverage.truncated && a.coverage.coveredFrom) notes.push(`This range holds ${fmt(a.coverage.runsInRange)} runs, more than one view reads ` +
    `(${fmt(ANALYTICS_ROW_LIMIT)}): every figure below covers only executions started from ${when(a.coverage.coveredFrom)} on. Narrow the range to see the rest.`);
  if (view.indexingCode) notes.push('Action and network facts could not be refreshed now; the figures use what is already indexed.');
  if (view.indexing?.pending) notes.push(`${fmt(view.indexing.pending)} started runs in this range are not indexed yet, so their actions and networks are missing below. ` +
    'They are indexed in small batches on each visit; `admin-cli index` completes it at once.');
  if (a.compositionsWithoutRecord) notes.push(`${fmt(a.compositionsWithoutRecord)} composition executions are not indexed yet: until they are, their step runs ` +
    'cannot be recognized and may be counted as separate executions.');
  const missing = a.networks.withoutRecordCodes.filter(code => code.code !== 'NOT_INDEXED');
  if (missing.length) notes.push(`${fmt(missing.reduce((n, c) => n + c.count, 0))} executions have no readable canonical record (${missing.map(c => c.code).join(', ')}): ` +
    'they are counted as executions, never assigned a network.');
  if (a.skippedActions) notes.push(`${fmt(a.skippedActions)} actions of executed workflows name no recognizable action type or network in their record: ` +
    'they are missing from the network distribution.');
  if (a.unclassified.length) notes.push(`Unclassified statuses (shown as their own bucket, never as success): ${a.unclassified
    .map(u => `${u.flow}/${u.status} ×${u.count}`).join(', ')}.`);
  if (a.unknownProvenance) notes.push(`${fmt(a.unknownProvenance)} runs carry an unknown provenance and are excluded from every environment.`);
  if (view.delegatedInRange === null) notes.push('Delegated (automation) executions could not be counted; they are never part of these figures.');
  else if (view.delegatedInRange) notes.push(`${fmt(view.delegatedInRange)} delegated (automation) executions were created in this range. They are separate records ` +
    '(no environment flag) and are not included in these figures or the network distribution: see Automations.');
  return notes.length ? <div className="admin-note" role="note">{notes.map(note => <p key={note}>{note}</p>)}</div> : null;
}
