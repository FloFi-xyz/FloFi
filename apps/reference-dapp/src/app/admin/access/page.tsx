// SPDX-License-Identifier: AGPL-3.0-only
import { adminPage } from '../../../admin/page-context';
import { AdminShell, AdminUnavailable } from '../../../components/admin/admin-shell';

/** BUILD-ADMIN-001: who is signed in and the append-only admin audit trail (closed codes and opaque ids only). */
export default async function AdminAccessPage() {
  const page = await adminPage();
  if (!page.ok) return <AdminUnavailable code={page.code}/>;
  const { context } = page;
  const events = await page.store.recentAudit(100).catch(() => null);
  return <AdminShell active="access" context={context} title="Access & audit"
    description="Administrator grants are created and revoked only with the operator CLI (backend/admin-cli.ts). The console cannot grant access.">
    <section className="admin-card" aria-labelledby="admin-session-heading">
      <header><h2 id="admin-session-heading">Your session</h2></header>
      <div className="admin-table-wrap"><table className="admin-table"><tbody>
        <tr><th scope="row">Principal</th><td><code>{context.principal.principalId}</code>{context.principal.label ? ` · ${context.principal.label}` : ''}</td></tr>
        <tr><th scope="row">Wallet</th><td><code>{context.principal.account}</code></td></tr>
        <tr><th scope="row">Role</th><td>{context.principal.role === 'OPERATOR' ? 'Operator — read everything and change AI settings' : 'Viewer — read only'}</td></tr>
        <tr><th scope="row">Session expires</th><td>{context.expiresAt.toISOString().replace('T', ' ').slice(0, 16)} UTC</td></tr>
      </tbody></table></div>
    </section>
    <section className="admin-card" aria-labelledby="admin-audit-heading">
      <header><h2 id="admin-audit-heading">Audit trail</h2><p>Latest 100 events · append-only</p></header>
      {events === null ? <p className="admin-alert" data-tone="warn">The audit trail could not be read.</p>
        : events.length === 0 ? <p className="admin-empty">No administrative events yet.</p>
        : <div className="admin-table-wrap"><table className="admin-table">
          <thead><tr><th>When (UTC)</th><th>Actor</th><th>Event</th><th>Outcome</th><th>Code</th><th>Target</th></tr></thead>
          <tbody>{events.map(event => <tr key={event.eventId}>
            <td className="admin-mono">{event.at.replace('T', ' ').slice(0, 19)}</td><td><code>{event.actor}</code></td><td>{event.kind}</td>
            <td><span className="admin-badge" data-tone={event.outcome === 'OK' ? 'ok' : event.outcome === 'REFUSED' ? 'warn' : 'bad'}>{event.outcome}</span></td>
            <td>{event.code ? <code>{event.code}</code> : '—'}</td><td>{event.target ? <code>{event.target}</code> : '—'}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  </AdminShell>;
}
