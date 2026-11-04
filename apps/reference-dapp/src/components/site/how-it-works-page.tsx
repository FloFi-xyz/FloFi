// SPDX-License-Identifier: AGPL-3.0-only
import Image from 'next/image';
import { SITE_COPY } from './site-copy';
import type { SiteLanguage } from './site-language';
import { SIGN_IN, SiteShell } from './site-shell';
import styles from './site.module.css';

/** BUILD-FLOFI-SITE-001: Como funciona / How it works of the approved site (five steps, today's capabilities, who decides). */
export function HowItWorksPage({ language }: { language: SiteLanguage }) {
  const t = SITE_COPY[language].how, open = SITE_COPY[language].header.open;
  return <SiteShell language={language} page="how">
    <main>
      <section className={styles.pageHero} aria-labelledby="how-title">
        <div><h1 id="how-title">{t.heroTitle}</h1><p>{t.heroBody}</p></div>
        <Image src="/brand/site/mascot-check.svg" alt="" width={200} height={183} unoptimized priority/>
      </section>
      <section className={styles.stepsSection}>
        <div>
          <ol className={styles.fiveSteps}>{t.steps.map(([title, body], index) => <li key={title}>
            <span className={index === 3 ? styles.numInk : styles.num}>{index + 1}</span><strong>{title}</strong><span>{body}</span>
          </li>)}</ol>
        </div>
      </section>
      <section className={`${styles.section} ${styles.soft}`} aria-labelledby="today-title">
        <div className={`${styles.wrap} ${styles.stack} ${styles.stackTight}`}>
          <div className={styles.titleBlock}><h2 id="today-title" className={styles.h2s}>{t.todayTitle}</h2><p className={styles.lead}>{t.todayBody}</p></div>
          <div className={styles.tableBox} role="region" aria-labelledby="today-title" tabIndex={0}>
            <table className={styles.capTable}>
              <thead><tr>{t.tableHead.map(head => <th key={head} scope="col">{head}</th>)}</tr></thead>
              <tbody>{t.tableRows.map(([network, ...cells]) => <tr key={network}><th scope="row">{network}</th>
                {cells.map((cell, index) => <td key={index} data-empty={cell === '—' || undefined}>{cell}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </div>
      </section>
      <section className={styles.section} aria-labelledby="decide-title">
        <div className={`${styles.wrap} ${styles.stack}`}>
          <h2 id="decide-title" className={`${styles.h2s} ${styles.center}`}>{t.splitTitle}</h2>
          <div className={styles.decide}>
            <div><strong>{t.flofiDoes}</strong>{t.flofiItems.map(item => <p key={item}>{item}</p>)}</div>
            <div><strong>{t.youDo}</strong>{t.youItems.map(item => <p key={item}>{item}</p>)}</div>
          </div>
        </div>
      </section>
      <section id="entrar" className={styles.finalWrap} aria-labelledby="how-final">
        <div className={styles.finalBlue}><h2 id="how-final">{t.finalTitle}</h2><a href={SIGN_IN} className={styles.pillWhite}>{open}</a></div>
      </section>
    </main>
  </SiteShell>;
}
