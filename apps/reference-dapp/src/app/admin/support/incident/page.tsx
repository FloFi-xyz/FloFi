// SPDX-License-Identifier: AGPL-3.0-only
import { adminPermits } from '../../../../admin/guard';
import { adminPage } from '../../../../admin/page-context';
import { CATEGORY_LABELS, explainCode, type CodeExplanation } from '../../../../admin/support/codes';
import { EVIDENCE_LABELS, incidentStatus, isIncidentId, NOTE_KIND_LABELS, STATUS_LABELS, type Note } from '../../../../admin/support/diagnostics';
import { FEATURE_LABELS, INCIDENT_LIFECYCLE_LABELS, SEVERITY_LABELS, type Incident } from '../../../../admin/support/incidents';
import { RESOLUTION_LABELS } from '../../../../admin/support/lifecycle';
import { ELIGIBILITY_LABELS, RECOVERY_ACTIONS } from '../../../../admin/support/registry';
import { incidentDetail, notesByIncident, type IncidentDetail } from '../../../../admin/support/view';
import { nonceConflictView, type RunCheckContext } from '../../../../admin/support/nonce-conflict-view';
import { AdminShell, AdminUnavailable } from '../../../../components/admin/admin-shell';
import { Section, Status, TechnicalDetails, type Tone } from '../../../../components/admin/admin-ui';
import { NoteForm, RecoveryPanel } from '../../../../components/admin/support-console';

type Search = Promise<Record<string, string | string[] | undefined>>;
const when = (iso: string | null) => iso ? iso.replace('T', ' ').slice(0, 19) + ' UTC' : '—';
const GLYPH: Record<string, string> = { OBSERVED: '✓', INFERRED: '≈', UNKNOWN: '?', UNAVAILABLE: '–', NOT_REACHED: '○' };
const SUBMITTED: Record<Incident['submitted'], string> = { YES: 'Yes — a transaction was submitted', NO: 'No — nothing was submitted', UNKNOWN: 'Unknown — it may have been broadcast',
  NOT_APPLICABLE: 'Not applicable' };
const FUNDS: Record<Incident['funds'], string> = { NONE: 'No', POSSIBLE: 'Possibly — treat as involving real funds', TEST_ONLY: 'Only test-network or mocked funds',
  UNKNOWN: 'Unknown' };
const ENVIRONMENT: Record<string, string> = { MAINNET: 'Mainnet', TESTNET: 'Testnet / Devnet', MOCKED: 'Mocked (local)' };
const DEPLOYMENT: Record<CodeExplanation['deployment'], string> = { NO: 'No', CONFIG: 'A deployment configuration change', CODE: 'Yes — a code fix', UNKNOWN: 'Unknown' };
const VERIFICATION_LABELS: Record<string, string> = { PENDING_VERIFICATION: 'Pending verification', RESOLVED: 'Task completed', STOPPED_AGAIN: 'Stopped again',
  INCONCLUSIVE: 'Inconclusive' };
const ELIGIBILITY_TONE: Record<string, Tone> = { RECOVERABLE_NOW: 'ok', REQUIRES_CONFIRMATION: 'info', WAITING_EXTERNAL: 'neutral', USER_ACTION: 'info', ENGINEERING: 'bad',
  INVESTIGATION: 'warn', NONE: 'neutral' };

const LIFECYCLE_TONE: Record<Incident['lifecycle'], Tone> = { ACTIVE: 'warn', UNDER_INVESTIGATION: 'info', HISTORICAL: 'neutral', VERIFIED_RESOLVED: 'ok', FINAL: 'neutral' };
const STOPPED_STATUS: Record<string, string> = { UNRESOLVED: 'Unresolved', RETRYING: 'Queued again — not finished', RESOLVED: 'Resolved', NOT_REQUIRED: 'No longer needed — not verified' };

function Summary({ incident }: { incident: Incident }) {
  return <Section id="support-incident-summary" title="Summary" tone={incident.severity === 'HIGH' ? 'bad' : incident.severity === 'MEDIUM' ? 'warn' : undefined}
    description={incident.summary}>
    <dl className="admin-dl">
      <dt>Incident lifecycle</dt><dd><Status tone={LIFECYCLE_TONE[incident.lifecycle]}>{INCIDENT_LIFECYCLE_LABELS[incident.lifecycle]}</Status>
        {incident.attention ? <div className="admin-diff" style={{ marginTop: 4 }}>{incident.attention.explanation}</div> : null}
        {incident.attention?.flagged ? <div className="admin-diff">The original attention flag is kept as recorded.</div> : null}</dd>
      <dt>Recovery</dt><dd><Status tone={ELIGIBILITY_TONE[incident.eligibility] ?? 'neutral'}>{ELIGIBILITY_LABELS[incident.eligibility]}</Status></dd>
      <dt>Recommended next step</dt><dd>{incident.recommended}</dd>
      <dt>Severity</dt><dd>{SEVERITY_LABELS[incident.severity]}</dd>
      <dt>Category</dt><dd>{CATEGORY_LABELS[incident.category]} · {FEATURE_LABELS[incident.feature]}</dd>
      {incident.environment || incident.provenance ? <><dt>Environment</dt><dd>{incident.environment ? ENVIRONMENT[incident.environment] : <>Unrecognised provenance <code>{incident.provenance}</code></>}
        {incident.networks.length ? ` · ${incident.networks.join(', ')}` : ''}</dd></> : null}
      <dt>Transaction outcome</dt><dd>{incident.outcome}{incident.outcomeKnown ? '' : ' (not established)'}</dd>
      <dt>Submitted</dt><dd>{SUBMITTED[incident.submitted]}</dd>
      <dt>Could funds be involved</dt><dd>{FUNDS[incident.funds]}</dd>
      <dt>Last recorded</dt><dd>{when(incident.at)}</dd>
    </dl>
    {incident.attention?.stopped.length ? <div className="admin-table-wrap" style={{ marginTop: 12 }}><table className="admin-table" aria-label="Stopped background tasks">
      <thead><tr><th>Task</th><th>Times stopped</th><th>Last stop (UTC)</th><th>Last reason</th><th>Now</th></tr></thead>
      <tbody>{incident.attention.stopped.map(s => <tr key={s.kind}><td><code>{s.kind}</code></td><td className="num">{s.count}</td><td className="admin-mono">{when(s.lastStoppedAt)}</td>
        <td>{s.code ? <code>{s.code}</code> : '—'}</td><td>{STOPPED_STATUS[s.status]}{s.basis ? <span className="admin-diff"> — {RESOLUTION_LABELS[s.basis]}</span> : null}</td></tr>)}</tbody>
    </table></div> : null}
    {incident.guided ? <p style={{ marginTop: 10 }}><a className="admin-button" data-variant="primary" href={incident.guided.href}>{incident.guided.name}</a>
      <span className="admin-diff"> {incident.guided.description}</span></p> : null}
  </Section>;
}

function Explanations({ codes }: { codes: readonly string[] }) {
  const explained = codes.map(explainCode).filter((x): x is CodeExplanation => x !== null);
  if (!explained.length) return null;
  return <Section id="support-explanation" title="What the error means" description="Explanations come from the code alone; what happened to this execution is in the timeline.">
    {explained.map(e => <div key={e.code} className="admin-scope" style={{ marginBottom: 10 }}>
      <header><h3>{e.label}</h3>{e.known ? null : <Status tone="warn">Not in the catalog</Status>}</header>
      <p>{e.meaning}</p>
      <dl className="admin-dl">
        <dt>Likely cause</dt><dd>{e.likelyCause ?? 'Not established by the code itself.'}</dd>
        <dt>User action</dt><dd>{e.userAction ?? 'None the user can take for this code.'}</dd>
        <dt>Deployment needed</dt><dd>{DEPLOYMENT[e.deployment]}</dd>
      </dl>
      <TechnicalDetails><p>Code <code>{e.code}</code> · category {CATEGORY_LABELS[e.category]} · remedy {e.remedy}</p></TechnicalDetails>
    </div>)}
  </Section>;
}

function Notes({ notes, incidentId, csrf, canWrite }: { notes: readonly Note[]; incidentId: string; csrf: string; canWrite: boolean }) {
  return <Section id="support-notes" title="Notes" description={`Status: ${STATUS_LABELS[incidentStatus(notes)]}. Notes are audited and never replace the execution’s own evidence.`}>
    {notes.length ? <ul className="admin-note-list">{notes.map(note => <li key={note.eventId}><strong>{NOTE_KIND_LABELS[note.kind]}</strong>
      <span className="admin-diff"> · {when(note.at)} · <code>{note.actor.slice(0, 12)}…</code></span><div>{note.text ?? <span className="admin-diff">Text removed under the retention policy or an approved erasure request; the note record is kept.</span>}</div>
      {note.textState === 'LEGACY' ? <div className="admin-diff">Written before the separate text store: kept in the audit record, not removable by retention.</div> : null}</li>)}</ul>
      : <p className="admin-empty">No notes yet.</p>}
    <div style={{ marginTop: 12 }}><NoteForm csrf={csrf} incidentId={incidentId} canWrite={canWrite}/></div>
  </Section>;
}

/** BUILD-FLOFI-RECONCILIATION-PRIVACY-UX-001: the worker's read-only nonce-conflict investigations. Never "resolved": the outcome is the run's. */
function NonceConflicts({ rows, context }: { rows: Extract<IncidentDetail, { type: 'run' }>['nonceConflicts']; context: RunCheckContext }) {
  if (rows === null) return <Section id="support-nonce-conflict" title="Nonce-conflict investigation"><p className="admin-alert" data-tone="warn">
    The investigation record could not be read right now. This says nothing about the execution’s outcome.</p></Section>;
  if (!rows.length) return null;
  return <Section id="support-nonce-conflict" title="Nonce-conflict investigation" tone="warn"
    description="Read-only forensic checks by the worker. They never sign, submit or change the execution, and never decide its outcome.">
    {rows.map(row => nonceConflictView(row, context)).map(v => <div key={v.attemptId} className="admin-scope" style={{ marginBottom: 10 }} data-testid="nonce-conflict">
      <header><h3>{v.classification}</h3><Status tone={v.escalatedAt ? 'bad' : 'warn'}>{v.status}</Status></header>
      <p>{v.meaning}</p>
      <dl className="admin-dl">
        <dt>Network · step · reserved nonce</dt><dd>{v.network} · {v.step} · <code>{v.nonce}</code></dd>
        <dt>Transaction outcome</dt><dd>{v.outcome}</dd>
        <dt>Consuming transaction</dt><dd>{v.conflictingTransaction ? <><code>{v.conflictingTransaction.hash}</code>
          {v.conflictingTransaction.proven ? ` — verified final on chain (block ${v.conflictingTransaction.block})` : ' — recorded by the flow, not yet verified final'}
          {v.conflictingTransaction.explorer ? <> · <a href={v.conflictingTransaction.explorer} rel="noreferrer noopener" target="_blank">explorer (a link, not evidence)</a></> : null}</>
          : 'Not recorded'}</dd>
        <dt>Evidence source</dt><dd>{v.evidenceSource}</dd>
        <dt>Related FloFi workflow</dt><dd>{v.relatedWorkflows.length ? v.relatedWorkflows.map(w => <div key={w.runId}>
          <a href={`/admin/support/incident?id=${encodeURIComponent(`run:${w.runId}`)}`}><code>{w.runId}</code></a> ({w.flow}) — {w.basis}</div>)
          : 'None established by exact transaction hash.'}</dd>
        <dt>Execution structure</dt><dd>{v.structure}</dd>
        <dt>Reviewed effect</dt><dd>{v.effect}</dd>
        <dt>Same call, another nonce</dt><dd>{v.alternate}</dd>
        <dt>Later steps of this execution</dt><dd>{v.laterAttempts}</dd>
        <dt>Proof completeness</dt><dd>{v.proofComplete ? 'Every check available for this step ran on final data (still not a proof of the outcome)' : 'Incomplete'}</dd>
        <dt>Last independent on-chain verification</dt><dd>{when(v.lastVerifiedAt)}{v.lastCheckCode ? <> · last check: <code>{v.lastCheckCode}</code></> : null}</dd>
        <dt>Checks</dt><dd>{v.investigations} since {when(v.firstObservedAt)} · unchanged for {v.stableObservations}{v.escalatedAt ? ` · escalated ${when(v.escalatedAt)}` : ''}</dd>
        <dt>Why the outcome remains unknown</dt><dd><ul style={{ margin: 0, paddingLeft: 18 }}>{v.whyUnknown.map(reason => <li key={reason}>{reason}</li>)}</ul></dd>
        <dt>Safe next action</dt><dd>{v.nextAction}</dd>
      </dl>
      <TechnicalDetails summary="Field-by-field comparison with the reviewed call">
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Field</th><th>Consuming transaction vs reviewed call</th></tr></thead>
          <tbody>{v.comparison.map(c => <tr key={c.field}><td>{c.field}</td><td>{c.value}</td></tr>)}</tbody></table></div>
      </TechnicalDetails>
    </div>)}
  </Section>;
}

function RunDetail({ detail, csrf, canRecover }: { detail: Extract<IncidentDetail, { type: 'run' }>; csrf: string; canRecover: boolean }) {
  const { run, incident } = detail;
  const actions = (incident?.actions ?? []).map(action => ({ ...action, name: RECOVERY_ACTIONS[action.id].name }));
  return <>
    {actions.length ? <Section id="support-recovery" title="Recovery" description={canRecover ? 'Preview first. The server re-checks everything immediately before running it.'
      : 'Your role can preview but not run recoveries.'}>
      <RecoveryPanel csrf={csrf} runId={run.runId} actions={actions}/>
    </Section> : null}
    <NonceConflicts rows={detail.nonceConflicts} context={{ needsObservation: run.needsObservation,
      reconcile: detail.facts?.latest.reconcile ? { state: detail.facts.latest.reconcile.state, createdAt: detail.facts.latest.reconcile.createdAt } : null }}/>
    <Section id="support-timeline" title="Timeline" description="Observed = recorded fact · Inferred = implied by a later fact · Unknown = cannot be established · Not recorded = this flow keeps no record.">
      <ol className="admin-timeline">{detail.milestones.map(m => <li key={m.key} data-evidence={m.evidence}>
        <span aria-hidden="true">{GLYPH[m.evidence]}</span><strong>{m.label}</strong><span className="admin-badge">{EVIDENCE_LABELS[m.evidence]}</span>
        <small>{m.at ? `${when(m.at)} — ` : ''}{m.detail}</small></li>)}</ol>
    </Section>
    <Section id="support-execution" title="Execution facts">
      <dl className="admin-dl">
        <dt>Execution</dt><dd><code>{run.runId}</code></dd><dt>Workflow</dt><dd><code>{run.workflowId}</code></dd>
        <dt>Flow</dt><dd><code>{run.flow}</code> · {run.provenance}</dd><dt>Status</dt><dd><code>{run.status}</code>{run.errorCode ? <> · <code>{run.errorCode}</code></> : null}</dd>
        <dt>Observation</dt><dd>{run.needsObservation ? 'Still needs observation' : 'Not needed'}{run.attentionRequired ? ' · flagged for attention' : ''}</dd>
        <dt>Evidence</dt><dd>{run.hasEvidence ? detail.facts?.evidenceArchived ? 'Bundle exists and is archived' : 'Bundle exists, not archived' : 'None'}</dd>
        <dt>Created / updated</dt><dd>{when(run.createdAt.toISOString())} / {when(run.updatedAt.toISOString())}</dd>
      </dl>
      <TechnicalDetails summary={`Attempts (${detail.attempts.length}${detail.attemptsTruncated ? '+, first 50 shown' : ''})`}>
        {detail.attempts.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Step</th><th>State</th><th>Transaction</th><th>Reconciled</th><th>Updated</th></tr></thead>
          <tbody>{detail.attempts.map(a => <tr key={a.attemptId}><td>{a.step}</td><td><code>{a.state}</code></td><td>{a.transactionHash ? <code>{a.transactionHash}</code> : '—'}</td>
            <td>{a.reconciled ? 'Yes' : 'No'}</td><td className="admin-mono">{when(a.updatedAt.toISOString())}</td></tr>)}</tbody></table></div> : <p>No attempts recorded.</p>}
      </TechnicalDetails>
      <TechnicalDetails summary={`Background tasks (${detail.tasks.length}${detail.tasksTruncated ? '+, newest 20 shown' : ''})`}>
        {detail.tasks.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Task</th><th>Kind</th><th>State</th><th className="num">Attempts</th><th>Last code</th><th>Created</th><th>Finished</th></tr></thead>
          <tbody>{detail.tasks.map(t => <tr key={t.id}><td><code>{t.id}</code></td><td><code>{t.kind}</code></td><td><code>{t.state}</code></td><td className="num">{t.deliveries}</td>
            <td>{t.lastError ? <code>{t.lastError}</code> : '—'}</td><td className="admin-mono">{when(t.createdAt)}</td><td className="admin-mono">{when(t.completedAt)}</td></tr>)}</tbody></table></div>
          : <p>No background tasks retained (completed tasks are kept 14 days).</p>}
      </TechnicalDetails>
      <TechnicalDetails summary={`Journal (${detail.journal.length}${detail.journalTruncated ? '+' : ''} entries)`}>
        {detail.journal.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>#</th><th>Level</th><th>Entity</th><th>Transition</th><th>Recorded</th></tr></thead>
          <tbody>{detail.journal.map(j => <tr key={j.sequence}><td>{j.sequence}</td><td>{j.level}</td><td><code>{j.entityId}</code></td><td><code>{j.fromState ?? '—'} → {j.toState}</code></td>
            <td className="admin-mono">{when(j.recordedAt.toISOString())}</td></tr>)}</tbody></table></div> : <p>This flow keeps no journal for this execution.</p>}
      </TechnicalDetails>
    </Section>
    {/* BUILD-FLOFI-EXECUTION-UX-RELIABILITY-001 (ADMIN-01): each attempt names THIS execution, why its check stopped again (its stop code and what it
        means: a stable nonce conflict is the designed stop, a temporary condition may pass), and keeps the operator's typed reason apart from what the
        task and the execution record verify. */}
    <Section id="support-run-history" title="Recovery attempts for this execution">
      <p className="admin-diff">Execution <code>{run.runId}</code>. An accepted recovery only re-queues a read-only check under this execution’s identity: it does not
        establish that anything settled. Each result below is read from that task and this execution’s record now.</p>
      {detail.history.length === 0 ? <p className="admin-empty">None in the last 90 days.</p> : <ul className="admin-note-list">{detail.history.map(entry => {
        const stop = entry.verification?.status === 'STOPPED_AGAIN' ? explainCode(entry.verification.code) : null;
        return <li key={entry.eventId}>
        <strong>{entry.action && entry.action in RECOVERY_ACTIONS ? RECOVERY_ACTIONS[entry.action as keyof typeof RECOVERY_ACTIONS].name : entry.action}</strong>
        <span className="admin-diff"> · {when(entry.at)} · <code>{entry.actor.slice(0, 12)}…</code>{entry.operationId ? <> · <code>{entry.operationId}</code></> : null}</span>
        <div>{entry.outcome !== 'OK' ? `Refused: ${entry.code}` : entry.verification ? `${VERIFICATION_LABELS[entry.verification.status]} — ${entry.verification.detail}` : 'Not verifiable'}</div>
        {stop ? <div className="admin-diff">Stop code: <code>{stop.code}</code> · {stop.label} · {stop.remedy === 'TRANSIENT' ? 'temporary condition'
          : stop.code === 'NONCE_CONFLICT_STABLE_OPERATOR_REVIEW' || ['USER', 'CONFIGURATION', 'CODE'].includes(stop.remedy) ? 'not a temporary failure' : 'cause not established'}</div> : null}
        {entry.reason ? <div className="admin-diff">Operator’s reason (as typed; not verified evidence): {entry.reason}</div> : entry.outcome === 'OK' && entry.reasonState === 'REMOVED'
          ? <div className="admin-diff">Reason text removed under the retention policy or an approved erasure request.</div> : null}</li>; })}</ul>}
    </Section>
  </>;
}

function Steps({ steps }: { steps: Extract<IncidentDetail, { type: 'workflow-run' | 'delegated' }>['steps'] }) {
  return steps.length ? <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Step</th><th>State</th><th>Flow / chain</th><th>Code</th><th>Updated</th></tr></thead>
    <tbody>{steps.map(s => <tr key={s.index}><td>{s.index + 1}</td><td><code>{s.state}</code></td><td>{s.flow ?? s.chain ?? '—'}</td><td>{s.code ? <code>{s.code}</code> : '—'}</td>
      <td className="admin-mono">{when(s.updatedAt)}</td></tr>)}</tbody></table></div> : <p className="admin-empty">No steps recorded.</p>;
}

/** BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: one incident or resource — explanation, eligibility, safe recovery, evidence timeline and notes. */
export default async function SupportIncidentPage({ searchParams }: { searchParams: Search }) {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const raw = (await searchParams).id, id = typeof raw === 'string' ? raw.trim() : '';
  const shell = (title: string, children: React.ReactNode) => <AdminShell active="support" context={page.context} title={title}
    description="Diagnose → check eligibility → preview → confirm → run → verify. Everything is audited."
    actions={<a className="admin-button" href="/admin/support#support-incidents">All incidents</a>}>{children}</AdminShell>;
  if (!isIncidentId(id)) return shell('Incident', <p className="admin-alert" data-tone="warn">That is not a valid incident or record id.</p>);
  let detail: IncidentDetail, notes: Note[];
  try { [detail, notes] = await Promise.all([incidentDetail(process.env, page.host, page.now, id), notesByIncident(page.host, page.now, [id]).then(map => map.get(id) ?? [])]); }
  catch { return shell('Incident', <p className="admin-alert" data-tone="bad">Diagnostics are unavailable right now (SUPPORT_STORE_UNAVAILABLE).</p>); }
  const canWrite = adminPermits(page.context, 'recover'), csrf = page.context.csrf;
  if (detail.type === 'not-found') return shell('Incident', <>
    <p className="admin-alert" data-tone="warn">No record matches <code>{id}</code>. It may have been resolved, or the identifier is wrong.</p>
    <Notes notes={notes} incidentId={id} csrf={csrf} canWrite={canWrite}/></>);
  const incident = detail.incident;
  return shell(incident?.title ?? 'Diagnostics', <>
    {incident ? <Summary incident={incident}/> : <p className="admin-alert" role="status">Support’s checks found no open condition for <code>{id}</code> right now. That does not
      establish that it is healthy; the diagnostics below are still shown.</p>}
    <Explanations codes={incident?.codes ?? (detail.type === 'run' && detail.run.errorCode ? [detail.run.errorCode] : [])}/>
    {detail.type === 'run' ? <RunDetail detail={detail} csrf={csrf} canRecover={canWrite}/> : null}
    {detail.type === 'work' ? <Section id="support-task" title="Background task">
      <dl className="admin-dl"><dt>Task</dt><dd><code>{detail.task.id}</code> · <code>{detail.task.kind}</code></dd><dt>State</dt><dd><code>{detail.task.state}</code>
        {detail.task.superseded ? ' (a later run of the same task exists)' : ''}</dd>
        <dt>Attempts</dt><dd>{detail.task.deliveries}</dd><dt>Last code</dt><dd>{detail.task.lastError ? <code>{detail.task.lastError}</code> : '—'}</dd>
        <dt>Created / finished</dt><dd>{when(detail.task.createdAt)} / {when(detail.task.completedAt)}</dd>
        {detail.task.runId ? <><dt>Execution</dt><dd><a href={`/admin/support/incident?id=${encodeURIComponent(`run:${detail.task.runId}`)}`}><code>{detail.task.runId}</code></a></dd></> : null}</dl>
      <p className="admin-diff" style={{ marginTop: 8 }}>This kind of task is never retried from the Admin.</p></Section> : null}
    {detail.type === 'workflow-run' ? <Section id="support-wfr" title="Multi-step workflow run">
      <dl className="admin-dl"><dt>Run</dt><dd><code>{detail.row.runId}</code></dd><dt>State</dt><dd><code>{detail.row.state}</code>{detail.row.code ? <> · <code>{detail.row.code}</code></> : null}</dd>
        <dt>Mode</dt><dd>{detail.row.mode ?? '—'} · requested by {detail.row.requesterKind}</dd><dt>Created / updated</dt><dd>{when(detail.row.createdAt)} / {when(detail.row.updatedAt.toISOString())}</dd></dl>
      <Steps steps={detail.steps}/></Section> : null}
    {detail.type === 'delegated' ? <Section id="support-dex" title="Delegated execution">
      <dl className="admin-dl"><dt>Execution</dt><dd><code>{detail.row.executionId}</code></dd><dt>State</dt><dd><code>{detail.row.state}</code>{detail.row.attention ? ' · flagged' : ''}
        {detail.row.code ? <> · <code>{detail.row.code}</code></> : null}</dd><dt>Created / updated</dt><dd>{when(detail.row.createdAt)} / {when(detail.row.updatedAt.toISOString())}</dd></dl>
      <Steps steps={detail.steps}/></Section> : null}
    {detail.type === 'condition' && !incident ? <p className="admin-diff">This platform or AI condition is no longer present.</p> : null}
    <Notes notes={notes} incidentId={id} csrf={csrf} canWrite={canWrite}/>
  </>);
}
