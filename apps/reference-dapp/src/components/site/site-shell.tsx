// SPDX-License-Identifier: AGPL-3.0-only
import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SITE_COPY, SITE_LINKS } from './site-copy';
import type { SiteLanguage } from './site-language';
import { SitePreferences } from './site-preferences';
import styles from './site.module.css';

export type SitePage = 'home' | 'how' | 'developers' | 'docs' | 'faq';
/** The sign-in entry every "Entrar / Open" control leads to (the builder stays reachable from sign-in without an account). */
export const SIGN_IN = '/login';

function Brand({ label, size }: { label: string; size: 'header' | 'footer' }) {
  return <Link href="/" aria-label={label} className={styles.brand}>
    <Image src="/brand/site/flofi-mark.svg" alt="" width={size === 'header' ? 38 : 32} height={size === 'header' ? 36 : 30} unoptimized priority={size === 'header'}/>
    <Image src="/brand/site/flofi-wordmark.svg" alt="FloFi" width={size === 'header' ? 63 : 54} height={size === 'header' ? 26 : 22} unoptimized priority={size === 'header'}/>
  </Link>;
}

const SOCIAL = [
  ['X', SITE_LINKS.x, <svg key="x" aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.78L17.75 3zm-1.08 16.17h1.7L7.4 4.74H5.58l11.09 14.43z"/></svg>],
  ['Discord', SITE_LINKS.discord, <svg key="d" aria-hidden="true" width="23" height="23" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>],
  ['LinkedIn', SITE_LINKS.linkedin, <svg key="l" aria-hidden="true" width="21" height="21" viewBox="0 0 24 24" fill="currentColor"><path d="M4.98 3.5a2.5 2.5 0 1 1-.01 5 2.5 2.5 0 0 1 .01-5zM3 9h4v12H3zM9 9h3.8v1.7h.05c.53-1 1.83-2.05 3.77-2.05 4.03 0 4.78 2.65 4.78 6.1V21h-4v-5.6c0-1.34-.03-3.06-1.86-3.06-1.87 0-2.15 1.46-2.15 2.96V21H9z"/></svg>],
  ['Telegram', SITE_LINKS.telegram, <svg key="t" aria-hidden="true" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round"><path d="M21.5 3.5 2.8 10.9c-.9.36-.85 1.66.08 1.94l4.62 1.4 1.78 5.6c.24.76 1.2.98 1.75.4l2.6-2.7 4.55 3.36c.66.49 1.6.12 1.76-.69L22.9 4.9c.19-.95-.6-1.75-1.4-1.4z"/><path d="m7.5 14.2 10-7.2-7.7 8.6"/></svg>],
] as const;

/** BUILD-FLOFI-SITE-001: the approved site's header and footer around a page, in the visitor's language. */
/** `skipTo` is where "skip to content" lands (the Docs pass their article, past the sidebar); `guide` marks a guide below /docs, so the header's
 * Docs link reads as the current section, not the current page. */
export function SiteShell({ language, page, guide = false, skipTo = 'conteudo', children }: { language: SiteLanguage; page: SitePage; guide?: boolean; skipTo?: string; children: ReactNode }) {
  const t = SITE_COPY[language];
  return <div className={styles.site} lang={t.lang} data-site-page={page}>
    <a className={styles.skip} href={`#${skipTo}`}>{t.skip}</a>
    <header className={styles.header}>
      <Brand label={t.header.home} size="header"/>
      <nav aria-label={t.header.nav} className={styles.nav}>
        <Link href="/how-it-works" aria-current={page === 'how' ? 'page' : undefined}>{t.header.how}</Link>
        <Link href="/docs" aria-current={page === 'docs' ? (guide ? 'true' : 'page') : undefined}>{t.header.docs}</Link>
        <SitePreferences language={language} labels={t.header}/>
        <a href={SIGN_IN} className={styles.pillBlue}>{t.header.open}</a>
      </nav>
    </header>
    <div id="conteudo" tabIndex={-1}>{children}</div>
    <div className={styles.footerWrap}><footer className={styles.footer}>
      {/* BUILD-FLOFI-LAUNCH-001: the approved landing's footer adds the line under the brand and the FAQ. */}
      <div className={styles.footerBrand}><Brand label={t.header.home} size="footer"/><span>{t.footer.tagline}</span></div>
      <nav aria-label={t.footer.nav} className={styles.footerNav}>
        <Link href="/how-it-works">{t.header.how}</Link>
        <Link href="/docs">{t.header.docs}</Link>
        <Link href="/developers" aria-current={page === 'developers' ? 'page' : undefined}>{t.header.developers}</Link>
        <Link href="/faq" aria-current={page === 'faq' ? 'page' : undefined}>{t.footer.faq}</Link>
      </nav>
      <div className={styles.footerBottom}>
        <p>{t.footer.legal}</p>
        <div className={styles.social}>{SOCIAL.map(([name, href, icon]) => <a key={name} href={href} aria-label={t.footer.on(name)} target="_blank" rel="noopener noreferrer">{icon}</a>)}</div>
      </div>
    </footer></div>
  </div>;
}
