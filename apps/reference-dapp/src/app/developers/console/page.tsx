// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SessionGuard } from '../../../components/account/session-guard';
import { ConsoleForm, DeveloperPlayground } from '../../../components/site/developer-console';
import { DeveloperStudio } from '../../../components/site/developer-studio';
import { projectCopy } from '../../../components/site/site-copy';
import { SiteShell } from '../../../components/site/site-shell';
import { siteLanguage } from '../../../components/site/site-language';
import styles from '../../../components/site/site.module.css';
import { DEVELOPER_CONSOLE_PATH, developerConsoleHost } from '../../../server/developer-console-host';
import { DEVELOPER_SCOPES } from '../../../developer/config';
import { createStudioStore, studioInstalled } from '../../../studio/integration-store';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'FloFi Developer Console', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function DeveloperConsole({ searchParams }: { searchParams: Promise<{ project?: string | string[] }> }) {
  const [language, host, params] = await Promise.all([siteLanguage(), developerConsoleHost().catch(() => ({ status: 'unavailable' } as const)), searchParams]);
  const t = projectCopy[language];
  const id = typeof params.project === 'string' && /^prj_[a-z2-7]{26}$/.test(params.project) ? params.project : null;
  const returnTo = id ? `${DEVELOPER_CONSOLE_PATH}?project=${id}` : DEVELOPER_CONSOLE_PATH;
  if (host.status === 'other-account') redirect('/board');
  if (host.status === 'signed-out') redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  const [projects, selected, activity] = host.status === 'signed-in' ? await Promise.all([
    host.store.list(),
    id ? host.store.details(id) : null,
    id ? host.store.activity(id, new Date()) : [],
  ]) : [[], null, []] as const;
  const studio = selected && host.status === 'signed-in'
    ? await (async () => {
      if (!await studioInstalled(host.db)) return null;
      const store = createStudioStore(host.db, host.tenantId, host.session.accountId);
      const [versions, events] = await Promise.all([store.list(selected.id), store.activity(selected.id)]);
      return { versions, events };
    })().catch(() => null)
    : null;
  const locale = language === 'PT' ? 'pt-BR' : 'en';
  return <SiteShell language={language} page="developers" skipTo="developer-console">
    <SessionGuard/>
    <main id="developer-console" tabIndex={-1} className={`${styles.wrap} ${styles.console}`}>
      <header><h1>Developer Console</h1><Link href="/docs/developer-api">{t.docs}</Link></header>
      {host.status === 'unavailable' ? <p role="status">{t.unavailable}</p> : <>
        <section aria-labelledby="projects">
          <h2 id="projects">{t.projects}</h2>
          {projects.length > 0 && <ul className={styles.consoleList}>{projects.map(project => <li key={project.id}>
            <Link href={`${DEVELOPER_CONSOLE_PATH}?project=${project.id}`} aria-current={project.id === selected?.id ? 'page' : undefined}>{project.name}</Link>
            <span>{project.status === 'ACTIVE' ? t.active : t.disabled}</span>
          </li>)}</ul>}
          <details open={projects.length === 0}><summary>{t.create}</summary>
            <ConsoleForm language={language} operation="create" submit={t.create}><ProjectFields language={language}/></ConsoleForm>
          </details>
        </section>
        {id && !selected && <p role="status">{t.missing}</p>}
        {selected && <section key={selected.id} aria-labelledby="project-title">
          <h2 id="project-title">{selected.name}</h2>
          <code>{selected.id}</code>
          {selected.description && <p>{selected.description}</p>}
          {selected.status === 'ACTIVE' && <details><summary>{t.settings}</summary>
            <ConsoleForm language={language} operation="edit" projectId={selected.id} submit={t.save}>
              <ProjectFields language={language} name={selected.name} description={selected.description}/>
            </ConsoleForm>
            <ConsoleForm language={language} operation="disable" projectId={selected.id} submit={t.disable}>
              <label className={styles.consoleCheck}><input type="checkbox" name="confirm" required/>{t.confirmDisable}</label>
            </ConsoleForm>
          </details>}
          <h3>{t.credentials}</h3>
          {!host.environment && <p>{t.livePending}</p>}
          {selected.keys.length > 0 && <ul className={styles.consoleList}>{selected.keys.map(key => <li key={key.keyId}>
            <div><code>…{key.hint}</code> · {key.environment} · {key.status === 'ACTIVE' ? t.active : t.revoked}<br/>
              <small>{key.scopes.join(', ')} · {t.lastUse} {key.lastUsedAt ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(key.lastUsedAt) + ' UTC' : '—'}</small>
            </div>
            {key.status === 'ACTIVE' && selected.status === 'ACTIVE' && <div className={styles.consoleButtons}>
              {key.environment === host.environment && <ConsoleForm language={language} operation="rotate" projectId={selected.id} keyId={key.keyId} submit={t.rotate}/>}
              <ConsoleForm language={language} operation="revoke" projectId={selected.id} keyId={key.keyId} submit={t.revoke}/>
            </div>}
          </li>)}</ul>}
          {host.environment && selected.status === 'ACTIVE' && <details><summary>{t.issue} ({host.environment})</summary>
            <ConsoleForm language={language} operation="issue" projectId={selected.id} submit={t.issue}>
              <fieldset><legend>{t.scopes}</legend>{DEVELOPER_SCOPES.map(scope => <label key={scope} className={styles.consoleCheck}>
                <input type="checkbox" name="scope" value={scope}/>{scope}
              </label>)}</fieldset>
            </ConsoleForm>
          </details>}
          <h3>{t.usage}</h3>
          {activity.length > 0 ? <ul className={styles.consoleList}>{activity.map(row => <li key={`${row.environment}-${row.metric}`}>
            <span>{t.metrics[row.metric]} · {row.environment}</span>
            <strong>{new Intl.NumberFormat(locale).format(BigInt(row.total))}</strong>
          </li>)}</ul> : <p>{t.noUsage}</p>}
          <h3>{t.openApprovals}</h3>
          {selected.awaiting.length > 0 ? <ul className={styles.consoleList}>{selected.awaiting.map(row => <li key={`${row.environment}-${row.status}`}>
            <span>{t.approvalStatuses[row.status]} · {row.environment}</span>
            <strong>{new Intl.NumberFormat(locale).format(BigInt(row.total))}</strong>
          </li>)}</ul> : <p>{t.noOpenApprovals}</p>}
          <details>
            <summary>{t.webhooks}</summary>
            <p><Link href="/docs/typescript-sdk#webhooks">{t.webhookDocs}</Link></p>
            {selected.endpoints.length > 0 ? <ul className={styles.consoleList}>{selected.endpoints.map(endpoint => <li key={endpoint.endpoint_id}>
              <code>{endpoint.endpoint_id}</code><span>{endpoint.environment}</span>
            </li>)}</ul> : <p>{t.noEndpoints}</p>}
            {selected.deliveries.length > 0 && <>
              <h4>{t.recentDeliveries}</h4>
              <ul className={styles.consoleList}>{selected.deliveries.map(delivery => <li key={delivery.deliveryId}>
                <span>{delivery.eventType}</span>
                <span>{t.deliveryStatuses[delivery.status]}{delivery.lastError ? <> · <code>{delivery.lastError}</code></> : null}</span>
              </li>)}</ul>
            </>}
          </details>
          <DeveloperStudio language={language} projectId={selected.id} active={selected.status === 'ACTIVE'}
            versions={studio?.versions ?? null} activity={studio?.events ?? []}
            now={new Date().toISOString()}/>
          {selected.status === 'ACTIVE' && <DeveloperPlayground language={language} projectId={selected.id}/>}
        </section>}
      </>}
    </main>
  </SiteShell>;
}

function ProjectFields({ language, name = '', description = '' }: { language: keyof typeof projectCopy; name?: string; description?: string }) {
  const t = projectCopy[language];
  return <>
    <label>{t.name}<input name="name" defaultValue={name} required maxLength={64}/></label>
    <label>{t.description}<input name="description" defaultValue={description} maxLength={500}/></label>
  </>;
}
