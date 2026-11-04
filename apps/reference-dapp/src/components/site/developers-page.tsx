// SPDX-License-Identifier: AGPL-3.0-only
import Link from 'next/link';
import { DEVELOPER_ENDPOINTS, SITE_COPY, SITE_LINKS } from './site-copy';
import type { SiteLanguage } from './site-language';
import { SiteShell } from './site-shell';
import styles from './site.module.css';

/** BUILD-FLOFI-SITE-001: Para desenvolvedores / For developers of the approved site. The endpoints are the real Developer API v1 paths. */
export function DevelopersPage({ language }: { language: SiteLanguage }) {
  const t = SITE_COPY[language].developers;
  return <SiteShell language={language} page="developers">
    <main>
      <section className={styles.devHeroWrap} aria-labelledby="dev-title">
        <div className={styles.devHero}>
          <div>
            <span className={styles.devBadge}>{t.badge}</span>
            <h1 id="dev-title">{t.heroTitle}</h1>
            <p>{t.heroBody}</p>
            <div className={styles.devActions}><Link href="/docs" className={styles.pillWhite}>{t.readDocs}</Link>
              <a href={SITE_LINKS.x} className={styles.pillOutlineDark} target="_blank" rel="noopener noreferrer">{t.talk}</a></div>
          </div>
          <p className={styles.terminal}>{DEVELOPER_ENDPOINTS.map(([method, path]) => <span key={path}><b>{method}</b> {path}<br/></span>)}<i aria-hidden="true">→</i> {t.terminalLast}</p>
        </div>
      </section>
      <section className={styles.section} aria-labelledby="dev-get">
        <div className={`${styles.wrap} ${styles.stack}`}>
          <h2 id="dev-get" className={styles.h2s}>{t.getTitle}</h2>
          <div className={styles.getGrid}>{t.get.map(([title, body]) => <div key={title}><strong>{title}</strong><span>{body}</span></div>)}</div>
        </div>
      </section>
      <section className={`${styles.section} ${styles.soft}`} aria-labelledby="dev-decide">
        <div className={`${styles.wrap} ${styles.split}`}>
          <h2 id="dev-decide" className={styles.h2s}>{t.decideTitle}</h2>
          <div className={styles.ruleList}>{t.decide.map(([title, body]) => <div key={title}><strong>{title}</strong><span>{body}</span></div>)}</div>
        </div>
      </section>
      <section id="entrar" className={styles.section} aria-labelledby="dev-final">
        <div className={styles.finalBlue}><h2 id="dev-final">{t.finalTitle}</h2><a href={SITE_LINKS.x} className={styles.pillWhite} target="_blank" rel="noopener noreferrer">{t.talk}</a></div>
      </section>
    </main>
  </SiteShell>;
}
