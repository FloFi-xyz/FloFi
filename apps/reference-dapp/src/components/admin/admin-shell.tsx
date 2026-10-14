// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import type { AdminContext } from '../../admin/guard';
import { AdminSignOut } from './admin-sign-out';

/** BUILD-ADMIN-001: the console frame (server component). Navigation is the same for every role; pages enforce permissions themselves. */
export const ADMIN_NAV = [
  { id: 'overview', href: '/admin', label: 'Overview' },
  { id: 'access', href: '/admin/access', label: 'Access & audit' },
] as const;
export type AdminNavId = (typeof ADMIN_NAV)[number]['id'];
const short = (account: string) => `${account.slice(0, 6)}…${account.slice(-4)}`;

export function AdminShell({ active, context, title, description, actions, children }: { active: AdminNavId; context: AdminContext; title: string;
  description?: string; actions?: ReactNode; children: ReactNode }) {
  return <div className="admin-layout">
    <nav className="admin-nav" aria-label="Admin">
      <div className="admin-brand"><img src="/flofi-logo.png" alt=""/><div>FloFi Admin<small>Private console</small></div></div>
      <ul>{ADMIN_NAV.map(item => <li key={item.id}><a href={item.href} aria-current={item.id === active ? 'page' : undefined}>{item.label}</a></li>)}</ul>
      <div className="admin-nav-foot">
        <span><code title={context.principal.account}>{short(context.principal.account)}</code>{' '}
          <span className="admin-badge" data-tone={context.principal.role === 'OPERATOR' ? 'info' : undefined}>{context.principal.role}</span></span>
        <AdminSignOut csrf={context.csrf}/>
      </div>
    </nav>
    <main className="admin-main">
      <header className="admin-header"><div><h1>{title}</h1>{description ? <p>{description}</p> : null}</div>{actions}</header>
      {children}
    </main>
  </div>;
}

const UNAVAILABLE: Record<string, string> = {
  ADMIN_STORE_NOT_CONFIGURED: 'This deployment has no PostgreSQL platform state (DATABASE_URL), so the console cannot authenticate anyone.',
  ADMIN_SCHEMA_NOT_CURRENT: 'The database schema does not match this build. Apply the shipped migrations (including 0012_admin_control_plane) first.',
  ADMIN_STORE_UNAVAILABLE: 'The admin store is unreachable right now.',
};
export function AdminUnavailable({ code }: { code: string }) {
  return <div className="admin-sign-in"><div className="admin-card"><h2>Admin console unavailable</h2>
    <p>{UNAVAILABLE[code] ?? 'The console cannot serve requests right now.'}</p><p className="admin-diff"><code>{code}</code></p></div></div>;
}
