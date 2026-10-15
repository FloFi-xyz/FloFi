// SPDX-License-Identifier: AGPL-3.0-only
import { adminPermits } from '../../../admin/guard';
import { CONTRIBUTOR_THRESHOLD, learningAdminView, LEARNING_WINDOW_DAYS, type Rate } from '../../../admin/learning-view';
import { adminPage } from '../../../admin/page-context';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { CandidateActions, KnowledgeControls, OperatorTools } from '../../../components/admin/learning-console';

const REASON: Record<string, string> = { OFF: 'off (FLOFI_LEARNING not enabled)', SESSION_ONLY: 'in-conversation adaptation only (FLOFI_LEARNING=session)', INVALID: 'misconfigured',
  SECRET_MISSING: 'FLOFI_LEARNING_SECRET missing',
  SECRET_INVALID: 'FLOFI_LEARNING_SECRET too short', SECRET_REUSED: 'FLOFI_LEARNING_SECRET reuses another secret' };
const pct = (r: Rate) => r.rate === null ? '—' : `${Math.round(r.rate * 1000) / 10}%`;
const AUTOMATIC: Record<string, string> = { OFF: 'Off — nothing observed is stored (FLOFI_LEARNING_AUTOMATIC unset)', CONSENT: 'Consent — only identities that turned it on',
  LEGITIMATE_INTEREST: 'Legitimate interest — every verified identity that did not object' };
const counts = (record: Readonly<Record<string, number>>) => Object.entries(record).sort((a, b) => b[1] - a[1]).map(([code, n]) => `${code} ${n}`).join(' · ') || '—';
function Kpi({ label, value, note, tone }: { label: string; value: string; note?: string | undefined; tone?: string | undefined }) {
  return <div className="admin-kpi" data-tone={tone}><span>{label}</span><strong>{value}</strong>{note ? <small>{note}</small> : null}</div>;
}

/**
 * BUILD-CHAT-LEARNING-001: AI Learning — aggregates of private memory and feedback, review of global glossary candidates, publication gated by the
 * deterministic evaluation, version and evaluation history, rollback and disable. No private memory term, message or identity is shown.
 */
export default async function AdminAiLearningPage() {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const view = await learningAdminView(process.env, page.host, page.now), canWrite = adminPermits(page.context, 'write'), csrf = page.context.csrf;
  const activeVersion = view.active?.version ?? 0;
  return <AdminShell active="ai-learning" context={page.context} title="AI Learning"
    description="What the Copilot learns: private meanings saved by verified users (counted, never shown) and FloFi's shared glossary, which only an operator publishes after a passing evaluation.">
    <section className="admin-card" aria-labelledby="learning-status">
      <header><h2 id="learning-status">Learning on this deployment</h2></header>
      <div className="admin-table-wrap"><table className="admin-table"><tbody>
        <tr><th scope="row">Copilot learning (FLOFI_LEARNING)</th><td><span className="admin-badge" data-tone={view.deployment.enabled ? 'ok' : undefined}>
          {view.deployment.enabled ? 'Enabled' : REASON[view.deployment.reason ?? 'OFF'] ?? 'Off'}</span></td></tr>
        <tr><th scope="row">Global glossary served (FLOFI_LEARNING_GLOBAL)</th><td>{view.deployment.global ? 'Yes, the active version below' : 'No (break-glass disabled)'}</td></tr>
        <tr><th scope="row">Persistent automatic learning (FLOFI_LEARNING_AUTOMATIC)</th><td>{AUTOMATIC[view.deployment.automatic]}</td></tr>
        <tr><th scope="row">Active glossary</th><td>{!view.active ? 'None published' : view.active.disabled ? `v${view.active.version}: disabled (no glossary)`
          : view.active.invalid ? <span className="admin-badge" data-tone="bad">v{view.active.version} no longer validates: not served</span>
            : `v${view.active.version}: ${view.active.entries} entries${view.active.restoredFrom ? ` (restored from v${view.active.restoredFrom})` : ''}`}</td></tr>
        <tr><th scope="row">Retention</th><td>feedback {view.retention.eventsDays} d · unused memory {view.retention.memoryDays} d · contributions {view.retention.supportDays} d ·
          subjects without consent {view.retention.unconsentedSubjectDays} d · unlearned evidence {view.retention.evidenceDays} d</td></tr>
      </tbody></table></div>
      {view.storeError ? <p className="admin-alert" data-tone="bad">The learning tables could not be read ({view.storeError}).</p> : null}
    </section>

    <section className="admin-card" aria-labelledby="learning-metrics">
      <header><h2 id="learning-metrics">Last {LEARNING_WINDOW_DAYS} days</h2><p>Content-free events: closed codes and counts, no text, no identity</p></header>
      <div className="admin-kpis">
        <Kpi label="Private memories" value={String(view.memory.entries)} note={`${view.memory.subjects} people (${view.memory.walletSubjects} wallets, ${view.memory.channelSubjects} chat accounts)`}/>
        <Kpi label="Contributors (opted in)" value={String(view.memory.contributors)}/>
        <Kpi label="Copilot turns" value={String(view.turns.total)} note={Object.entries(view.turns.byScope).map(([s, n]) => `${s} ${n}`).join(' · ') || undefined}/>
        <Kpi label="Proposal rate" value={pct(view.turns.proposals)} note={`${view.turns.proposals.count} proposals`}/>
        <Kpi label="Clarification rate" value={pct(view.turns.clarifications)}/>
        <Kpi label="Correction rate" value={pct(view.corrections)} note="revisions per proposal (observed)"/>
        <Kpi label="Refused / failed" value={`${pct(view.turns.refusals)} / ${pct(view.turns.failures)}`} tone={view.repeatedFailures ? 'warn' : undefined}
          note={`${view.repeatedFailures} repeated failures`}/>
      </div>
      <div className="admin-table-wrap"><table className="admin-table"><tbody>
        <tr><th scope="row">Proposals afterwards (observed, not ground truth)</th><td>applied {view.proposals.applied} · dismissed {view.proposals.dismissed} · revised {view.proposals.revised}</td></tr>
        <tr><th scope="row">Glossary suggestions</th><td>confirmed {view.suggestions.confirmed} · another option chosen {view.suggestions.rejected}</td></tr>
        <tr><th scope="row">Learned meanings used</th><td>private {view.usage.memoryUsed} · global {view.usage.knowledgeUsed}</td></tr>
        <tr><th scope="row">Clarifications answered</th><td>{view.clarificationAnswers}</td></tr>
        <tr><th scope="row">Interpreter requests (learning on)</th><td>ok {view.interpreter.ok} · failed {view.interpreter.failed}
          {view.interpreter.failures.length ? ` (${view.interpreter.failures.map(f => `${f.code} ${f.n}`).join(', ')})` : ''}</td></tr>
      </tbody></table></div>
    </section>

    <section className="admin-card" aria-labelledby="learning-invisible">
      <header><h2 id="learning-invisible">Invisible learning (last {LEARNING_WINDOW_DAYS} days)</h2>
        <p>Signals the Copilot classified in natural use; readings FloFi made on its own and what users did with them. Closed codes and counts only.</p></header>
      <div className="admin-kpis">
        <Kpi label="Effectiveness" value={pct(view.automatic.inferred.effectiveness)} note={`${view.automatic.inferred.confirmed} inferred readings applied unchanged`}/>
        <Kpi label="False positives" value={pct(view.automatic.inferred.falsePositives)} tone={view.automatic.inferred.corrected ? 'warn' : undefined}
          note={`${view.automatic.inferred.corrected} of ${view.automatic.inferred.used} inferred readings corrected`}/>
        <Kpi label="Corrections" value={pct(view.automatic.corrections.rate)} note={`chat ${view.automatic.corrections.chat} · canvas ${view.automatic.corrections.canvas} per proposal`}/>
        <Kpi label="Learned meanings" value={String(view.automatic.evidence.learned)} note={`${view.automatic.evidence.stated} stated · ${view.automatic.evidence.rows - view.automatic.evidence.promoted} observed, not used`}/>
      </div>
      <div className="admin-table-wrap"><table className="admin-table"><tbody>
        <tr><th scope="row">Signals adapted</th><td>{counts(view.automatic.adaptations)}</td></tr>
        <tr><th scope="row">Signals ignored (by reason)</th><td>{counts(view.automatic.ignored)}</td></tr>
        <tr><th scope="row">Inferred readings by source</th><td>{Object.entries(view.automatic.inferred.bySource).map(([source, n]) =>
          `${source}: used ${n.used}, applied ${n.confirmed}, corrected ${n.corrected}`).join(' · ') || '—'}</td></tr>
        <tr><th scope="row">Persistent tier (observation → outcome)</th><td>{counts(view.automatic.store)}</td></tr>
        <tr><th scope="row">Identities' choices</th><td>{view.automatic.choices.map(c => `${c.basis} ${c.enabled ? 'on' : 'off'} ${c.n}`).join(' · ') || '—'}
          {' '}· {view.automatic.evidence.subjects} identities with evidence · {view.automatic.evidence.languages} learned starting languages</td></tr>
      </tbody></table></div>
    </section>

    <section className="admin-card" aria-labelledby="learning-candidates">
      <header><h2 id="learning-candidates">Candidates awaiting review</h2>
        <p>Generalized meanings from opted-in users (support = distinct pseudonymous contributors) and operators. Support never publishes anything.
          {view.candidates.belowThreshold ? ` ${view.candidates.belowThreshold} contributed candidates have fewer than ${CONTRIBUTOR_THRESHOLD} contributors and are not listed.` : ''}</p></header>
      {view.candidates.pending.length ? <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th>Term</th><th>Means</th><th>Lang</th><th>Origin</th><th className="num">Support</th><th>Last seen</th><th>Decision</th></tr></thead>
        <tbody>{view.candidates.pending.map(c => <tr key={c.candidateId}><td><code>{c.term}</code></td><td><code>{c.target}</code></td><td>{c.language}</td><td>{c.origin}</td>
          <td className="num">{c.support}</td><td>{c.lastSeenAt.slice(0, 10)}</td><td><CandidateActions csrf={csrf} canWrite={canWrite} candidateId={c.candidateId} state="PENDING"/></td></tr>)}</tbody>
      </table></div> : <p className="admin-diff">No pending candidates.</p>}
    </section>

    <section className="admin-card" aria-labelledby="learning-approved">
      <header><h2 id="learning-approved">Approved (next publication)</h2><p>{view.candidates.approved.length} entries; a retraction removes one from the next version</p></header>
      {view.candidates.approved.length ? <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th>Term</th><th>Means</th><th>Lang</th><th>Decided</th><th>Reason</th><th></th></tr></thead>
        <tbody>{view.candidates.approved.map(c => <tr key={c.candidateId}><td><code>{c.term}</code></td><td><code>{c.target}</code></td><td>{c.language}</td>
          <td>{c.decidedAt?.slice(0, 10)} <code>{c.decidedBy}</code></td><td>{c.reason ?? '—'}</td>
          <td><CandidateActions csrf={csrf} canWrite={canWrite} candidateId={c.candidateId} state="APPROVED"/></td></tr>)}</tbody>
      </table></div> : <p className="admin-diff">Nothing approved yet.</p>}
      <KnowledgeControls csrf={csrf} canWrite={canWrite} activeVersion={activeVersion} approved={view.candidates.approved.length}
        history={view.history.map(row => ({ version: row.version, disabled: row.entries === null }))}/>
    </section>

    <section className="admin-card" aria-labelledby="learning-versions">
      <header><h2 id="learning-versions">Glossary versions</h2><p>Append-only; the latest is active; each published version names its passing evaluation</p></header>
      {view.history.length ? <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th>Version</th><th>Created</th><th>By</th><th>Entries</th><th>Evaluation</th><th>Reason</th></tr></thead>
        <tbody>{view.history.map(row => <tr key={row.version}><td>v{row.version}{row.restoredFrom ? ` ← v${row.restoredFrom}` : ''}</td><td>{row.createdAt.slice(0, 16).replace('T', ' ')}</td>
          <td><code>{row.createdBy}</code></td><td title={row.terms.join('\n')}>{row.entries ?? 'disabled'}</td><td>{row.evaluationId ? `#${row.evaluationId}` : '—'}</td>
          <td>{row.reason ?? '—'}</td></tr>)}</tbody>
      </table></div> : <p className="admin-diff">No version has been published.</p>}
    </section>

    <section className="admin-card" aria-labelledby="learning-evaluations">
      <header><h2 id="learning-evaluations">Evaluations</h2><p>Deterministic, offline: labeled PT-BR/EN corpus, regressions against the active version, generated probes</p></header>
      {view.evaluations.length ? <div className="admin-table-wrap"><table className="admin-table">
        <thead><tr><th>#</th><th>When</th><th>Purpose</th><th>Result</th><th>Entries</th><th>Corpus</th><th>Probes</th><th className="num">Regressions</th><th className="num">Safety</th></tr></thead>
        <tbody>{view.evaluations.map(row => <tr key={row.evaluationId}><td>{row.evaluationId}</td><td>{row.at.slice(0, 16).replace('T', ' ')}</td><td>{row.purpose}</td>
          <td><span className="admin-badge" data-tone={row.passed ? 'ok' : 'bad'}>{row.passed ? 'passed' : 'failed'}</span>
            {row.summary.failures.length ? <div className="admin-diff">{row.summary.failures.map(f => <div key={f}><code>{f}</code></div>)}</div> : null}</td>
          <td>{row.summary.entries ?? '—'}</td><td>{row.summary.cases ?? '—'}</td>
          <td>{row.summary.probes ?? '—'}{row.summary.effective !== null ? ` (${row.summary.effective} effective, ${row.summary.hintOnly} hints)` : ''}</td>
          <td className="num">{row.summary.regressions ?? '—'}</td><td className="num">{row.summary.safetyViolations ?? '—'}</td></tr>)}</tbody>
      </table></div> : <p className="admin-diff">No evaluation yet.</p>}
    </section>

    <section className="admin-card" aria-labelledby="learning-tools">
      <header><h2 id="learning-tools">Operator tools</h2><p>Candidates are validated on entry and still need approval and a passing evaluation</p></header>
      <OperatorTools csrf={csrf} canWrite={canWrite}/>
      {view.candidates.rejected.length ? <details><summary>Rejected and retracted ({view.candidates.rejected.length})</summary>
        <div className="admin-table-wrap"><table className="admin-table"><tbody>{view.candidates.rejected.map(c => <tr key={c.candidateId}><td><code>{c.term}</code></td>
          <td><code>{c.target}</code></td><td>{c.reason ?? '—'}</td><td><CandidateActions csrf={csrf} canWrite={canWrite} candidateId={c.candidateId} state="REJECTED"/></td></tr>)}</tbody>
        </table></div></details> : null}
    </section>
  </AdminShell>;
}
