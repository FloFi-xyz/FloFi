// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-ADMIN-SUPPORT-RECOVERY-001: the Support & Recovery controls — Diagnose → check eligibility → preview → confirm → execute →
 * verify. Every call is one CSRF-protected POST to `/admin/api/support`; the server re-checks the role, every precondition and the preview's
 * state fingerprint before doing anything, and audits the attempt. A VIEWER can preview but never execute. "Accepted" is never shown as
 * "resolved": the result always shows the server's verification of the postcondition.
 */
import { useState } from 'react';
import { adminPost } from './admin-client';

type Verification = { status: 'PENDING_VERIFICATION' | 'RESOLVED' | 'STOPPED_AGAIN' | 'INCONCLUSIVE'; detail: string; taskState: string; runStatus: string | null; code: string | null };
type Preview = { preview: { action: string; runId: string; stateToken: string; eligibility: { eligible: true } | { eligible: false; state: string; code: string; reason: string };
  current: { status: string; needsObservation: boolean; attentionRequired: boolean; attentionWouldClear: boolean; lastTask: { id: string; state: string; lastError: string | null; deliveries: number } | null } };
  definition: { name: string; description: string; resource: string; preconditions: string[]; postcondition: string; idempotency: string; fundsInvolved: string; reversible: string;
    risks: string[]; failureOutcomes: string[] };
  canExecute: boolean };
type Result = { operationId: string; replayed: boolean; workItemId: string; attentionCleared: boolean; verification: Verification };

const MESSAGES: Record<string, string> = {
  SUPPORT_PREVIEW_STALE: 'The execution changed since the preview. Preview again to see its current state.',
  SUPPORT_ALREADY_SCHEDULED: 'A check for this execution is already queued or running. Nothing was changed.',
  SUPPORT_NOTHING_TO_RECOVER: 'There is nothing to recover any more. Nothing was changed.',
  SUPPORT_RETRY_LIMIT_REACHED: 'This execution reached its recovery limit. Escalate it to engineering.',
  SUPPORT_STOP_REASON_NOT_RETRYABLE: 'The task stopped for a permanent reason. Escalate it to engineering.',
  SUPPORT_REASON_REQUIRED: 'Give a short reason (3–200 characters, no angle brackets).',
  SUPPORT_CONDITION_NOT_REGISTERED: 'No registered action applies to this condition. Nothing was changed.',
  SUPPORT_SEARCH_INVALID: 'Enter a transaction hash, wallet address, execution, workflow, workflow-run, delegated-execution, incident or task id. Free text is not searched.',
  SUPPORT_SEARCH_WALLET_NOT_PERMITTED: 'Looking up a wallet address needs the OPERATOR role.', SUPPORT_SEARCH_RATE_LIMITED: 'Too many lookups in 10 minutes. Try again shortly.',
  SUPPORT_SEARCH_UNAVAILABLE: 'Search is unavailable right now.',
  SUPPORT_RECOVERY_RATE_LIMITED: 'Too many recoveries in the last 10 minutes. Try again later.',
  SUPPORT_IDEMPOTENCY_KEY_REUSED: 'That request id was already used for another recovery. Preview again.',
  SUPPORT_RUN_NOT_FOUND: 'This execution no longer exists.',
  SUPPORT_NOTE_INVALID: 'Notes are plain text, 3–500 characters, without angle brackets.',
  SUPPORT_NOTE_RATE_LIMITED: 'Too many notes in the last 10 minutes. Try again later.',
  ADMIN_ROLE_INSUFFICIENT: 'Your role is read-only.', ADMIN_CSRF_INVALID: 'Your session token is stale. Reload the page.',
  ADMIN_SESSION_REQUIRED: 'Your admin session ended. Sign in again.',
};
const message = (code: string, reason?: string | null) => reason ?? MESSAGES[code] ?? `Refused (${code}).`;
const VERIFICATION: Record<Verification['status'], { label: string; tone: string; glyph: string }> = {
  PENDING_VERIFICATION: { label: 'Accepted — pending verification', tone: 'info', glyph: '…' }, RESOLVED: { label: 'Verified: task completed', tone: 'ok', glyph: '✓' },
  STOPPED_AGAIN: { label: 'Not resolved: stopped again', tone: 'bad', glyph: '✕' }, INCONCLUSIVE: { label: 'Inconclusive', tone: 'warn', glyph: '!' },
};
const newKey = () => typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

export function RecoveryPanel({ csrf, runId, actions }: { csrf: string; runId: string; actions: { id: string; name: string; eligible: boolean; reason: string | null }[] }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [preview, setPreview] = useState<Preview | null>(null);
  const [confirming, setConfirming] = useState(false), [reason, setReason] = useState(''), [reviewed, setReviewed] = useState(false), [key, setKey] = useState(newKey);
  const [result, setResult] = useState<Result | null>(null);
  async function load(action: string) {
    setBusy(true); setError(null); setResult(null); setConfirming(false); setReviewed(false);
    const answer = await adminPost<Preview>('/admin/api/support', { action: 'preview', recovery: action, runId }, csrf);
    setBusy(false);
    if (!answer.ok) { setError(message(answer.code)); setPreview(null); return; }
    setPreview(answer); setKey(newKey());
  }
  async function run() {
    if (!preview || busy) return;
    setBusy(true); setError(null);
    const answer = await adminPost<Result>('/admin/api/support', { action: 'recover', recovery: preview.preview.action, runId, stateToken: preview.preview.stateToken,
      idempotencyKey: key, reason }, csrf);
    setBusy(false); setConfirming(false);
    if (!answer.ok) { setError(message(answer.code, (answer as { reason?: string | null }).reason)); return; }
    setResult(answer);
  }
  const p = preview?.preview, d = preview?.definition;
  return <div className="admin-form">
    <div className="admin-actions">{actions.map(action => <button key={action.id} type="button" className="admin-button" data-variant={action.eligible ? 'primary' : undefined}
      disabled={busy} onClick={() => load(action.id)}>Preview: {action.name}</button>)}</div>
    <div role="status" aria-live="polite">{error ? <p className="admin-alert" data-tone="bad">{error}</p> : null}</div>
    {p && d ? <section className="admin-scope" aria-label="Recovery preview">
      <header><h3>Preview — {d.name}</h3>
        {p.eligibility.eligible ? <span className="admin-badge" data-tone="ok">✓ Eligible now</span> : <span className="admin-badge" data-tone="warn">! Not eligible</span>}</header>
      {!p.eligibility.eligible ? <p className="admin-alert" data-tone="warn">{p.eligibility.reason} <code>{p.eligibility.code}</code></p> : null}
      <dl className="admin-dl">
        <dt>Target</dt><dd><code>{p.runId}</code> — {d.resource}</dd>
        <dt>Current state</dt><dd>Status <code>{p.current.status}</code> · {p.current.needsObservation ? 'needs observation' : 'no observation needed'}
          {p.current.attentionRequired ? ' · flagged for attention' : ''}{p.current.lastTask ? <> · last task <code>{p.current.lastTask.state}</code>
            {p.current.lastTask.lastError ? <> (<code>{p.current.lastTask.lastError}</code>, {p.current.lastTask.deliveries} attempts)</> : null}</> : ' · no task retained'}</dd>
        <dt>Operation</dt><dd>{d.description}</dd>
        <dt>Expected effect</dt><dd>{d.postcondition}{p.current.attentionRequired ? (p.current.attentionWouldClear ? ' The attention flag will be cleared.'
          : ' The attention flag stays: another stopped task still holds it.') : ''}</dd>
        <dt>Funds</dt><dd>{d.fundsInvolved}</dd>
        <dt>Reversible</dt><dd>{d.reversible}</dd>
        <dt>Risks</dt><dd><ul style={{ margin: 0, paddingLeft: 18 }}>{d.risks.map(item => <li key={item}>{item}</li>)}</ul></dd>
        <dt>If it does not work</dt><dd><ul style={{ margin: 0, paddingLeft: 18 }}>{d.failureOutcomes.map(item => <li key={item}>{item}</li>)}</ul></dd>
      </dl>
      <details className="admin-details"><summary>Preconditions and idempotency</summary><div className="admin-details-body">
        <p><strong>Preconditions (re-checked on the server immediately before execution)</strong></p><ul>{d.preconditions.map(item => <li key={item}>{item}</li>)}</ul>
        <p><strong>Idempotency</strong> — {d.idempotency}</p>
      </div></details>
      {!preview.canExecute ? <p className="admin-diff">Your role is read-only: an OPERATOR can run this recovery.</p>
        : p.eligibility.eligible && !result ? !confirming
          ? <div className="admin-actions"><button type="button" className="admin-button" data-variant="primary" onClick={() => setConfirming(true)}>Continue to confirmation</button></div>
          : <div className="admin-confirm" role="group" aria-label="Confirm recovery">
            <label className="admin-field" htmlFor="support-reason">Reason (recorded in the audit trail)
              <textarea id="support-reason" maxLength={200} value={reason} onChange={event => setReason(event.target.value)} placeholder="e.g. RPC outage resolved; customer ticket 1234"/></label>
            <label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/> I reviewed the target, current state and expected effect above.</label>
            <div className="admin-actions">
              <button type="button" className="admin-button" data-variant="primary" disabled={busy || !reviewed || reason.trim().length < 3} onClick={run}>{busy ? 'Running…' : `Run: ${d.name}`}</button>
              <button type="button" className="admin-button" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
            </div>
          </div> : null}
    </section> : null}
    {result ? <section className="admin-result" data-tone={result.verification.status === 'RESOLVED' ? 'ok' : result.verification.status === 'STOPPED_AGAIN' ? 'bad' : undefined}
      aria-label="Recovery result">
      <strong role="status"><span aria-hidden="true">{VERIFICATION[result.verification.status].glyph}</span> {VERIFICATION[result.verification.status].label}</strong>
      <span>{result.verification.detail}</span>
      <span className="admin-diff">Operation <code>{result.operationId}</code>{result.replayed ? ' (same request already recorded — nothing was repeated)' : ''} · task <code>{result.workItemId}</code>
        {result.attentionCleared ? ' · attention flag cleared' : ''}</span>
      <div className="admin-actions"><a className="admin-button" data-size="sm" href={`/admin/support/incident?id=${encodeURIComponent(`run:${runId}`)}`}>Check the result again</a></div>
    </section> : null}
  </div>;
}

export function NoteForm({ csrf, incidentId, canWrite }: { csrf: string; incidentId: string; canWrite: boolean }) {
  const [kind, setKind] = useState('FINDING'), [text, setText] = useState(''), [busy, setBusy] = useState(false), [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  if (!canWrite) return <p className="admin-diff">Your role is read-only: an OPERATOR can add notes.</p>;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setStatus(null);
    const answer = await adminPost('/admin/api/support', { action: 'note', incidentId, kind, text }, csrf);
    setBusy(false);
    if (!answer.ok) { setStatus({ ok: false, text: message(answer.code) }); return; }
    setText(''); setStatus({ ok: true, text: 'Note added. Reload to see it in the list.' });
  }
  return <form className="admin-form" onSubmit={submit} aria-label="Add a note">
    <div className="admin-form-row">
      <label className="admin-field" htmlFor="support-note-kind">Type<select id="support-note-kind" value={kind} onChange={event => setKind(event.target.value)}>
        <option value="FINDING">Investigation finding</option><option value="DECISION">Recovery decision</option>
        <option value="ESCALATION">Escalation</option><option value="RESOLUTION">Resolution</option></select></label>
    </div>
    <label className="admin-field" htmlFor="support-note-text">Note (plain text, up to 500 characters; no keys, passwords or personal data)
      <textarea id="support-note-text" maxLength={500} value={text} onChange={event => setText(event.target.value)}/></label>
    <div className="admin-actions"><button className="admin-button" type="submit" disabled={busy || text.trim().length < 3}>{busy ? 'Saving…' : 'Add note'}</button></div>
    {status ? <p className="admin-alert" data-tone={status.ok ? 'ok' : 'bad'} role="status">{status.text}</p> : null}
  </form>;
}

type Hit = { type: string; id: string; incidentId: string; label: string; status: string; at: string | null };
type Found = { kind: string; hits: Hit[]; truncated: boolean };
const KIND_LABELS: Record<string, string> = { TRANSACTION_HASH: 'Transaction hash', WALLET: 'Wallet address', WORKFLOW_RUN: 'Multi-step workflow run',
  DELEGATED_EXECUTION: 'Delegated execution', INCIDENT: 'Incident', WORK_ITEM: 'Background task', EXECUTION_OR_WORKFLOW: 'Execution or workflow id' };

/** One audited lookup, sent as a CSRF-protected POST so the identifier never appears in a URL, request log or browser history. */
export function SupportSearch({ csrf }: { csrf: string }) {
  const [q, setQ] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [found, setFound] = useState<Found | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !q.trim()) return;
    setBusy(true); setError(null); setFound(null);
    const answer = await adminPost<Found>('/admin/api/support', { action: 'search', q }, csrf);
    setBusy(false);
    if (!answer.ok) { setError(message(answer.code)); return; }
    setFound(answer);
  }
  return <div className="admin-form">
    <form className="admin-filters" onSubmit={submit} role="search" aria-label="Support lookup">
      <label htmlFor="support-q" style={{ flex: '1 1 320px' }}>Transaction hash, wallet, execution / workflow id, incident or task id
        <input id="support-q" type="search" value={q} onChange={event => setQ(event.target.value)} maxLength={140} autoComplete="off" spellCheck={false}/></label>
      <button className="admin-button" type="submit" disabled={busy || !q.trim()}>{busy ? 'Looking up…' : 'Look up'}</button>
    </form>
    <div role="status" aria-live="polite">
      {error ? <p className="admin-alert" data-tone="warn">{error}</p> : null}
      {found ? <p className="admin-diff">{KIND_LABELS[found.kind] ?? found.kind} · {found.hits.length} match{found.hits.length === 1 ? '' : 'es'}{found.truncated ? ' (first 25 only)' : ''}.
        This lookup was recorded in the audit trail.</p> : null}
    </div>
    {found && found.hits.length === 0 ? <p className="admin-empty">No matching records. This does not establish that the identifier never existed.</p> : null}
    {found && found.hits.length ? <div className="admin-table-wrap"><table className="admin-table" aria-label="Search results">
      <thead><tr><th>Record</th><th>Kind</th><th>Status</th><th>Updated (UTC)</th><th>Details</th></tr></thead>
      <tbody>{found.hits.map(hit => <tr key={`${hit.type}:${hit.id}`}><td><code>{hit.id}</code></td><td>{hit.label}</td><td><code>{hit.status}</code></td>
        <td className="admin-mono">{hit.at ? hit.at.replace('T', ' ').slice(0, 16) : '—'}</td>
        <td><a href={`/admin/support/incident?id=${encodeURIComponent(hit.incidentId)}`}>{hit.type === 'incident' ? 'Open' : 'Diagnose'}</a></td></tr>)}</tbody>
    </table></div> : null}
  </div>;
}
