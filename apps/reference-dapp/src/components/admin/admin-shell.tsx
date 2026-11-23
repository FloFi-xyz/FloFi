// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import type { AdminContext } from '../../admin/guard';
import { requestLanguage } from '../../server/request-language';
import { AdminBrand } from './admin-brand';
import { AdminSignOut } from './admin-sign-out';
import { finopsCopy } from './finops-copy';

/**
 * BUILD-ADMIN-001: the console frame (server component). Navigation is the same for every role; pages enforce permissions themselves.
 *
 * BUILD-ADMIN-AI-PROVIDERS-001 (Admin UX): navigation is grouped by what an operator is trying to do — see how FloFi is doing, run its
 * operations, manage the AI Copilot, manage the campaign, and control access — instead of by implementation area. Every route, its URL
 * and its link name are unchanged. The current page shows its group, a plain-language purpose and its page-level actions; on a phone the
 * navigation becomes a scrollable strip so no page scrolls sideways.
 */
export const ADMIN_NAV_GROUPS = [
  { id: 'monitor', label: 'Monitor', items: [
    { id: 'overview', href: '/admin', label: 'Overview', hint: 'Activity and outcomes at a glance' },
    { id: 'health', href: '/admin/health', label: 'System Health', hint: 'Services, queues and incidents' },
  ] },
  { id: 'finance', label: 'Finance', items: [
    { id: 'finops', href: '/admin/finops', label: 'FinOps & Unit Economics', hint: 'Infrastructure costs and unit economics' },
  ] },
  { id: 'operations', label: 'Operations', items: [
    { id: 'support', href: '/admin/support', label: 'Support & Recovery', hint: 'Incidents, diagnostics and safe recovery' },
    { id: 'workflows', href: '/admin/workflows', label: 'Workflows', hint: 'Executions and what needs attention' },
    { id: 'automations', href: '/admin/automations', label: 'Automations', hint: 'Rules, proposals and delegated runs' },
    { id: 'studio', href: '/admin/studio', label: 'Studio certification', hint: 'Review integration evidence and publications' },
  ] },
  { id: 'ai', label: 'AI Copilot', items: [
    { id: 'ai-settings', href: '/admin/ai-settings', label: 'AI Settings', hint: 'Provider, model and channel settings' },
    { id: 'ai-analytics', href: '/admin/ai-analytics', label: 'AI Analytics', hint: 'Requests, tokens and estimated cost' },
    { id: 'ai-learning', href: '/admin/ai-learning', label: 'AI Learning', hint: 'Shared glossary and feedback' },
  ] },
  { id: 'growth', label: 'Campaigns', items: [
    { id: 'flight', href: '/admin/flight', label: 'Flight FloFi', hint: 'Registrations, boarding and emails' },
  ] },
  { id: 'security', label: 'Security', items: [
    { id: 'access', href: '/admin/access', label: 'Access & audit', hint: 'Your session and the audit trail' },
  ] },
] as const;
type NavItem = (typeof ADMIN_NAV_GROUPS)[number]['items'][number];
export const ADMIN_NAV: readonly NavItem[] = ADMIN_NAV_GROUPS.flatMap(group => group.items as readonly NavItem[]);
export type AdminNavId = NavItem['id'];
const short = (account: string) => `${account.slice(0, 6)}…${account.slice(-4)}`;
const groupOf = (id: AdminNavId) => ADMIN_NAV_GROUPS.find(group => (group.items as readonly NavItem[]).some(item => item.id === id))!;

export async function AdminShell({ active, context, title, description, actions, children }: { active: AdminNavId; context: AdminContext; title: string;
  description?: string; actions?: ReactNode; children: ReactNode }) {
  const { language } = await requestLanguage();
  const { copy } = finopsCopy(language);
  const operator = context.principal.role === 'OPERATOR';
  const groups = <div className="admin-nav-groups">
    {ADMIN_NAV_GROUPS.map(group => <div key={group.id} className="admin-nav-group">
      <span className="admin-nav-group-label" aria-hidden="true">{copy(group.label)}</span>
      <ul aria-label={copy(group.label)}>{group.items.map(item => <li key={item.id}>
        <a href={item.href} aria-current={item.id === active ? 'page' : undefined} title={copy(item.hint)}>{copy(item.label)}</a></li>)}</ul>
    </div>)}
  </div>;
  return <div className="admin-layout">
    <a className="admin-skip" href="#admin-content">{copy('Skip to content')}</a>
    <nav className="admin-nav" aria-label="Admin">
      <a href="/admin" className="admin-brand-link" aria-label={copy('FloFi Admin home')}><AdminBrand/></a>
      <div className="admin-nav-desktop">{groups}</div>
      <details className="admin-nav-mobile">
        <summary>{copy('Admin navigation')} <span>{copy(ADMIN_NAV.find(item => item.id === active)!.label)}</span></summary>
        {groups}
      </details>
      <div className="admin-nav-foot">
        <div className="admin-account">
          <code title={context.principal.account}>{short(context.principal.account)}</code>
          <span className="admin-badge" data-tone={operator ? 'info' : undefined} title={copy(operator ? 'Can change settings' : 'Read only')}>{context.principal.role}</span>
        </div>
        <AdminSignOut csrf={context.csrf} language={language}/>
      </div>
    </nav>
    <main className="admin-main" id="admin-content" tabIndex={-1}>
      <header className="admin-header">
        <div className="admin-header-text">
          <span className="admin-eyebrow">{copy(groupOf(active).label)}</span>
          <h1>{copy(title)}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="admin-header-actions">{actions}</div> : null}
      </header>
      {children}
    </main>
  </div>;
}

const UNAVAILABLE: Record<string, string> = {
  ADMIN_STORE_NOT_CONFIGURED: 'This deployment has no PostgreSQL admin connection (DATABASE_ADMIN_URL), so the console cannot authenticate anyone.',
  ADMIN_SCHEMA_NOT_CURRENT: 'The database schema does not match this build. Check the deployment’s supported migration history.',
  ADMIN_STORE_UNAVAILABLE: 'The admin store is unreachable right now.',
};
export function AdminUnavailable({ code }: { code: string }) {
  return <div className="admin-sign-in"><div className="admin-card"><h2>Admin console unavailable</h2>
    <p>{UNAVAILABLE[code] ?? 'The console cannot serve requests right now.'}</p><p className="admin-diff"><code>{code}</code></p></div></div>;
}
