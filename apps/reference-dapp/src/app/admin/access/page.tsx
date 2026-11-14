// SPDX-License-Identifier: AGPL-3.0-only
import { adminPage } from '../../../admin/page-context';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';
import { Section, Status, TechnicalDetails } from '../../../components/admin/admin-ui';

type Search = Promise<Record<string, string | string[] | undefined>>;
/** Plain-language names for audit event kinds; the exact kind is always shown beside them. Unknown kinds show only their code. */
const EVENTS: Record<string, string> = {
  ADMIN_SIGN_IN: 'Sign-in', ADMIN_SIGN_OUT: 'Sign-out', ADMIN_PRINCIPAL_GRANTED: 'Access granted', ADMIN_PRINCIPAL_REVOKED: 'Access revoked',
  ADMIN_COPILOT_SETTINGS_SAVED: 'AI settings saved', ADMIN_COPILOT_SETTINGS_ROLLED_BACK: 'AI settings restored', ADMIN_COPILOT_SETTINGS_RESET: 'AI settings reset to defaults',
  ADMIN_COPILOT_PROBE: 'AI model tested', ADMIN_COPILOT_MODELS_REFRESHED: 'AI model list refreshed', ADMIN_FLIGHT_VIEWED: 'Subscriber list viewed',
  ADMIN_FLIGHT_EXPORTED: 'Subscribers exported', ADMIN_SESSIONS_REVOKED: 'Sessions revoked', ADMIN_LEARNING_CANDIDATE_ADDED: 'Glossary candidate added',
  ADMIN_LEARNING_EVALUATED: 'Glossary evaluated', ADMIN_LEARNING_PUBLISHED: 'Glossary published', ADMIN_LEARNING_ROLLED_BACK: 'Glossary restored',
  ADMIN_LEARNING_DISABLED: 'Glossary disabled', ADMIN_LEARNING_STARTER_LOADED: 'Starter glossary loaded', ADMIN_LEARNING_RETENTION: 'Learning retention applied',
  ADMIN_LEARNING_AUTOMATIC_PURGED: 'Automatic learning purged',
};
const OUTCOMES = [{ id: 'ALL', label: 'All events' }, { id: 'REFUSED', label: 'Refused' }, { id: 'FAILED', label: 'Failed' }] as const;

/** BUILD-ADMIN-001: who is signed in and the append-only admin audit trail (closed codes and opaque ids only). */
export default async function AdminAccessPage({ searchParams }: { searchParams: Search }) {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const { context } = page, search = await searchParams;
  const outcome = OUTCOMES.find(entry => entry.id === search.outcome)?.id ?? 'ALL';
  const events = await page.store.recentAudit(100).catch(() => null), shown = events?.filter(event => outcome === 'ALL' || event.outcome === outcome) ?? null;
  const operator = context.principal.role === 'OPERATOR';
  return <AdminShell active="access" context={context} title="Access & audit"
    description="Who is signed in, what each role can do, and every administrative action. Access is granted only with the operator command-line tool, never from this console.">
    <Section id="admin-session-heading" title="Your session">
      <div className="admin-table-wrap"><table className="admin-table"><tbody>
        <tr><th scope="row">Role</th><td><Status tone={operator ? 'info' : 'neutral'}>{context.principal.role}</Status>{' '}
          {operator ? 'Operator — can read everything and change AI settings, AI learning and campaign exports.' : 'Viewer — read only; cannot change settings or export subscriber data.'}</td></tr>
        <tr><th scope="row">Wallet</th><td><code>{context.principal.account}</code>{context.principal.label ? ` · ${context.principal.label}` : ''}</td></tr>
        <tr><th scope="row">Session expires</th><td>{context.expiresAt.toISOString().replace('T', ' ').slice(0, 16)} UTC</td></tr>
      </tbody></table></div>
      <TechnicalDetails><p>Principal <code>{context.principal.principalId}</code>. Grants and revocations: <code>backend/admin-cli.ts</code> (requires database access).
        The role is read from the database on every request; nothing about authority is stored in the browser.</p></TechnicalDetails>
    </Section>
    <Section id="admin-audit-heading" title="Audit trail" description="Latest 100 events, append-only. Nothing here can be edited or deleted."
      actions={<nav className="admin-segmented" aria-label="Audit outcome">{OUTCOMES.map(entry => <a key={entry.id} href={entry.id === 'ALL' ? '/admin/access' : `/admin/access?outcome=${entry.id}`}
        aria-current={outcome === entry.id ? 'true' : undefined}>{entry.label}</a>)}</nav>}>
      {shown === null ? <p className="admin-alert" data-tone="warn">The audit trail could not be read.</p>
        : shown.length === 0 ? <p className="admin-empty">{outcome === 'ALL' ? 'No administrative events yet.' : 'No events with this outcome among the latest 100.'}</p>
        : <div className="admin-table-wrap"><table className="admin-table">
          <thead><tr><th>When (UTC)</th><th>Event</th><th>Outcome</th><th>Actor</th><th>Code</th><th>Target</th></tr></thead>
          <tbody>{shown.map(event => <tr key={event.eventId}>
            <td className="admin-mono">{event.at.replace('T', ' ').slice(0, 19)}</td>
            <td>{EVENTS[event.kind] ? <>{EVENTS[event.kind]}<br/><code className="admin-hint">{event.kind}</code></> : <code>{event.kind}</code>}</td>
            <td><Status tone={event.outcome === 'OK' ? 'ok' : event.outcome === 'REFUSED' ? 'warn' : 'bad'}>{event.outcome}</Status></td>
            <td><code>{event.actor}</code></td>
            <td>{event.code ? <code>{event.code}</code> : '—'}</td><td>{event.target ? <code>{event.target}</code> : '—'}</td>
          </tr>)}</tbody>
        </table></div>}
    </Section>
  </AdminShell>;
}
