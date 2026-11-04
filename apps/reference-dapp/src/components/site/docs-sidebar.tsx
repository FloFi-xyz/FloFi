// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Link from 'next/link';
import { useId, useState } from 'react';
import type { DocsChrome } from './docs-content';
import styles from './site.module.css';

const fold = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

/**
 * BUILD-FLOFI-SITE-001: the documentation sidebar of the approved site. The search filters the guides by title, group and section titles in the
 * visitor's language (accent-insensitive); clearing it restores the full list. Navigation only.
 */
export function DocsSidebar({ chrome, current, index, empty }: { chrome: DocsChrome; current: string; index: Readonly<Record<string, string>>; empty: string }) {
  const [query, setQuery] = useState('');
  const id = useId();
  const words = fold(query).split(/\s+/).filter(Boolean);
  const matches = (href: string, title: string, group: string) => !words.length || words.every(word => fold(`${title} ${group} ${index[href] ?? ''}`).includes(word));
  const groups = chrome.nav.map(group => ({ ...group, items: group.items.filter(item => matches(item.href, item.title, group.group)) })).filter(group => group.items.length);
  return <aside className={styles.docsAside}>
    <label htmlFor={id} className={styles.srOnly}>{chrome.search}</label>
    <div className={styles.search}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id={id} type="search" placeholder={chrome.search.split(' ')[0]} value={query} onChange={event => setQuery(event.target.value)} autoComplete="off"/>
    </div>
    <Link href="/docs" className={styles.docsHomeLink} aria-current={current === '/docs' ? 'page' : undefined}>{chrome.home}</Link>
    {groups.map(group => <nav key={group.group} aria-label={group.group} className={styles.docsNav}>
      <span>{group.group}</span>
      {group.items.map(item => <Link key={item.href} href={item.href} aria-current={current === item.href ? 'page' : undefined}>{item.title}</Link>)}
    </nav>)}
    {!groups.length && <p className={styles.docsEmpty} role="status">{empty}</p>}
  </aside>;
}
