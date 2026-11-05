// SPDX-License-Identifier: AGPL-3.0-only
import Image from 'next/image';
import { SITE_COPY, SITE_LINKS } from './site-copy';
import type { SiteLanguage } from './site-language';
import { SiteShell } from './site-shell';
import styles from './site.module.css';

export type FaqItem = readonly [id: string, question: string, answer: string];
type FaqId = (typeof SITE_COPY)['EN']['faq']['groups'][number]['items'][number][0];

/** The approved answers by id, in the order asked (the home page previews four of them). */
export function faqItems(language: SiteLanguage, ids: readonly FaqId[]): FaqItem[] {
  const all = SITE_COPY[language].faq.groups.flatMap(group => group.items);
  return ids.map(id => { const item = all.find(([key]) => key === id); if (!item) throw new Error(`FAQ_ITEM_MISSING:${id}`); return item; });
}

/** Native disclosure rows (keyboard and assistive technology for free): the question is the summary, its answer the panel. */
export function FaqList({ items, openFirst = false }: { items: readonly FaqItem[]; openFirst?: boolean }) {
  return <div className={styles.faqList}>
    {items.map(([id, question, answer], index) => <details key={id} id={`faq-${id}`} className={styles.faqItem} open={openFirst && index === 0}>
      <summary>{question}<span aria-hidden="true" className={styles.faqSign}>+</span></summary>
      <p>{answer}</p>
    </details>)}
  </div>;
}

/**
 * BUILD-FLOFI-LAUNCH-001: Perguntas frequentes / FAQ of the team-approved launch landing (Claude Artifact "FloFi — opção hero digitando",
 * version 1793885744-1380): four groups of approved answers and the team's Discord for anything else.
 */
export function FaqPage({ language }: { language: SiteLanguage }) {
  const t = SITE_COPY[language].faq;
  return <SiteShell language={language} page="faq">
    <main className={styles.faqPage}>
      <div className={styles.faqHero}>
        <div><h1>{t.heading}</h1><p>{t.lead}</p></div>
        <Image src="/brand/site/mascot-check.svg" alt="" width={150} height={150} unoptimized priority/>
      </div>
      {t.groups.map((group, index) => <section key={group.title} className={styles.faqGroup} aria-labelledby={`faq-group-${index}`}>
        <h2 id={`faq-group-${index}`}>{group.title}</h2>
        <FaqList items={group.items} openFirst={index === 0}/>
      </section>)}
      <div className={styles.faqMore}>
        <div><strong>{t.moreTitle}</strong><span>{t.moreBody}</span></div>
        <a href={SITE_LINKS.discord} className={styles.pillBlue} target="_blank" rel="noopener noreferrer">{t.discord}</a>
      </div>
    </main>
  </SiteShell>;
}
