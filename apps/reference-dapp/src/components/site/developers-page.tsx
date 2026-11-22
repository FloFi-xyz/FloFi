// SPDX-License-Identifier: AGPL-3.0-only
import Link from 'next/link';
import { DEVELOPER_ENDPOINTS, SITE_COPY } from './site-copy';
import type { SiteLanguage } from './site-language';
import { SiteShell } from './site-shell';
import styles from './site.module.css';

/** BUILD-FLOFI-SITE-001: Para desenvolvedores / For developers of the approved site. The endpoints are the real Developer API v1 paths. */
export function DevelopersPage({ language, consoleConfigured }: { language: SiteLanguage; consoleConfigured: boolean }) {
  const t = SITE_COPY[language].developers;
  return <SiteShell language={language} page="developers">
    <main>
      <section className={styles.devHeroWrap} aria-labelledby="dev-title">
        <div className={styles.devHero}>
          <div>
            <h1 id="dev-title">{t.heroTitle}</h1>
            <p>{t.heroBody}</p>
            <div className={styles.devActions}>
              {consoleConfigured && <Link href="/developers/console" className={styles.pillWhite}>{language === 'PT' ? 'Começar a desenvolver' : 'Start building'}</Link>}
              <Link href="/docs/developer-api" className={consoleConfigured ? styles.pillOutlineDark : styles.pillWhite}>{t.readDocs}</Link>
            </div>
          </div>
          <div className={styles.terminal}>
            <h2>{t.terminalTitle}</h2>
            <code>/api/developer/v1</code>
            <ul>{DEVELOPER_ENDPOINTS.map(([method, path]) => <li key={path}><code><b>{method}</b> {path}</code></li>)}</ul>
          </div>
        </div>
      </section>
      <section className={styles.section} aria-labelledby="dev-product">
        <div className={`${styles.wrap} ${styles.stack}`}>
          <h2 id="dev-product" className={styles.h2s}>{t.productTitle}</h2>
          <div className={styles.getGrid}>{t.product.map(([title, body, href]) => <div key={title}><h3><Link href={href}>{title}</Link></h3><p>{body}</p></div>)}</div>
        </div>
      </section>
      <section className={`${styles.section} ${styles.soft}`} aria-labelledby="dev-get">
        <div className={`${styles.wrap} ${styles.stack}`}>
          <h2 id="dev-get" className={styles.h2s}>{t.getTitle}</h2>
          <div className={styles.getGrid}>{t.get.map(([title, body, href]) => <div key={title}><h3><Link href={href}>{title}</Link></h3><p>{body}</p></div>)}</div>
        </div>
      </section>
      <section className={styles.section} aria-labelledby="dev-decide">
        <div className={`${styles.wrap} ${styles.split}`}>
          <h2 id="dev-decide" className={styles.h2s}>{t.availabilityTitle}</h2>
          <p className={styles.devAvailability}>{t.availability}</p>
        </div>
      </section>
      <section className={`${styles.section} ${styles.soft}`} aria-labelledby="dev-flow">
        <div className={`${styles.wrap} ${styles.split}`}>
          <h2 id="dev-flow" className={styles.h2s}>{t.flowTitle}</h2>
          <div className={styles.devFlow}>
            <ol>{t.flow.map(step => <li key={step}>{step}</li>)}</ol>
            <p>{t.flowEvidence}</p>
          </div>
        </div>
      </section>
      <section id="entrar" className={styles.section} aria-labelledby="dev-final">
        <div className={`${styles.finalBlue} ${styles.devFinal}`}>
          <h2 id="dev-final">{t.finalTitle}</h2>
          {consoleConfigured
            ? <Link href="/developers/console" className={styles.pillWhite}>{language === 'PT' ? 'Abrir console' : 'Open console'}</Link>
            : <Link href="/docs/developer-api#strategy-to-handoff" className={styles.pillWhite}>{language === 'PT' ? 'Ver exemplo de integração' : 'See integration example'}</Link>}
        </div>
      </section>
    </main>
  </SiteShell>;
}
