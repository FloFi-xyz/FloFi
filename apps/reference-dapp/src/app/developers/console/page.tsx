// SPDX-License-Identifier: AGPL-3.0-only
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SessionGuard } from '../../../components/account/session-guard';
import { ConsoleForm } from '../../../components/site/developer-console';
import { projectCopy } from '../../../components/site/site-copy';
import { SiteShell } from '../../../components/site/site-shell';
import { siteLanguage } from '../../../components/site/site-language';
import styles from '../../../components/site/site.module.css';
import { DEVELOPER_CONSOLE_PATH, developerConsoleHost } from '../../../server/developer-console-host';
import { DEVELOPER_SCOPES } from '../../../developer/config';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'FloFi Developer Console', robots: { index: false, follow: false }, referrer: 'no-referrer' };

export default async function DeveloperConsole({ searchParams }: { searchParams: Promise<{ project?: string | string[] }> }) {
  const [language, host, params] = await Promise.all([siteLanguage(), developerConsoleHost().catch(() => ({ status: 'unavailable' } as const)), searchParams]);
  const t = projectCopy[language];
  const id = typeof params.project === 'string' && /^prj_[a-z2-7]{26}$/.test(params.project) ? params.project : null;
  const returnTo = id ? `${DEVELOPER_CONSOLE_PATH}?project=${id}` : DEVELOPER_CONSOLE_PATH;
  if (host.status === 'other-account') redirect('/board');
  if (host.status === 'signed-out') redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  const projects = host.status === 'signed-in' ? await host.store.list() : [];
  const selected = host.status === 'signed-in' && id ? await host.store.details(id) : null;
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
              <small>{key.scopes.join(', ')} · {t.lastUse} {key.lastUsedAt ? new Intl.DateTimeFormat(language === 'PT' ? 'pt-PT' : 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(key.lastUsedAt) + ' UTC' : '—'}</small>
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
