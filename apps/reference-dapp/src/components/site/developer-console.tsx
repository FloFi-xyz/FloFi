// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState, type ReactNode } from 'react';
import { changeDeveloperProject, inspectDeveloperWorkflow } from '../../app/developer-console-action';
import { projectCopy } from './site-copy';
import styles from './site.module.css';

export function ConsoleForm({ language, operation, projectId, keyId, submit, children }: {
  language: keyof typeof projectCopy; operation: string; projectId?: string; keyId?: string; submit: string; children?: ReactNode;
}) {
  const t = projectCopy[language];
  const router = useRouter();
  const [secret, setSecret] = useState<string | null>(null);
  useEffect(() => {
    if (!secret) return;
    const clear = () => setSecret(null);
    window.addEventListener('pagehide', clear);
    return () => window.removeEventListener('pagehide', clear);
  }, [secret]);
  const [result, action, pending] = useActionState(async (_previous: { ok: false; code: string } | { ok: true; projectId: string } | null, data: FormData) => {
    setSecret(null);
    const next = await changeDeveloperProject(null, data);
    if (!next.ok) return next;
    if (next.key) setSecret(next.key);
    if (operation === "create") router.push(`/developers/console?project=${next.projectId}`);
    return { ok: true as const, projectId: next.projectId };
  }, null);
  const code = result && !result.ok ? result.code : null;
  const consolePath = projectId ? `/developers/console?project=${projectId}` : '/developers/console';
  return <form action={action} className={styles.consoleForm}>
    <input type="hidden" name="operation" value={operation}/>
    {projectId && <input type="hidden" name="projectId" value={projectId}/>}
    {keyId && <input type="hidden" name="keyId" value={keyId}/>}
    {children}
    <button className={styles.pillBlue} disabled={pending} type="submit">{pending ? t.saving : submit}</button>
    {!pending && code && <p role="alert">
      {code === 'ACCOUNT_REAUTHENTICATION_REQUIRED' ? <>{t.reauth} <Link href={`/login?reauth=1&returnTo=${encodeURIComponent(consolePath)}`}>{t.reauthLink}</Link></>
        : code === 'CONSOLE_RATE_LIMITED' ? t.rate : code === 'SCOPES_INVALID' ? t.scopeMissing : t.failed}
    </p>}
    {!pending && secret && <div className={styles.consoleSecret}>
      <p role="status">{t.keyNotice}</p><code data-testid="developer-one-time-key">{secret}</code>
      <button type="button" onClick={() => { setSecret(null); router.refresh(); }}>{t.hide}</button>
    </div>}
    {!pending && result?.ok && !secret && <p role="status">
      {t.saved}
    </p>}
  </form>;
}

export function DeveloperPlayground({ language, projectId }: { language: keyof typeof projectCopy; projectId: string }) {
  const t = projectCopy[language];
  const [result, action, pending] = useActionState(inspectDeveloperWorkflow, null);
  return <details>
    <summary>{t.playground}</summary>
    <p>{t.playgroundHelp}</p>
    <form action={action} className={styles.consoleForm}>
      <input type="hidden" name="projectId" value={projectId}/>
      <label>StrategySpec JSON<textarea name="strategy" required maxLength={16_000} rows={8}/></label>
      <label>{t.playgroundSubject}<input name="simulationSubject" maxLength={100} spellCheck={false}/></label>
      <button className={styles.pillBlue} disabled={pending} type="submit">{pending ? t.checking : t.inspect}</button>
    </form>
    {!pending && result && (result.ok ? <pre className={styles.consoleOutput} tabIndex={0} aria-label={t.playgroundResult}>{result.output}</pre>
      : <p role="alert">{t.playgroundFailed} <code>{result.code}</code></p>)}
  </details>;
}
