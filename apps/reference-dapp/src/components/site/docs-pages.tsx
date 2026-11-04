// SPDX-License-Identifier: AGPL-3.0-only
import Image from 'next/image';
import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { DOCS, type DocBlock, type DocInline, type DocPage } from './docs-content';
import { DocsSidebar } from './docs-sidebar';
import { SITE_COPY } from './site-copy';
import type { SiteLanguage } from './site-language';
import { SiteShell } from './site-shell';
import styles from './site.module.css';

/** Section titles of every guide, for the sidebar search (the visitor's language). */
function searchIndex(language: SiteLanguage): Record<string, string> {
  return Object.fromEntries(DOCS[language].pages.map(page => [`/docs/${page.slug}`, [page.lead, ...page.sections.map(section => section.title)].join(' ')]));
}

function DocsLayout({ language, current, children }: { language: SiteLanguage; current: string; children: ReactNode }) {
  return <SiteShell language={language} page="docs" guide={current !== '/docs'} skipTo="artigo">
    <div className={styles.docs}>
      <DocsSidebar chrome={DOCS[language].chrome} current={current} index={searchIndex(language)} empty={SITE_COPY[language].docsHome.noResults}/>
      {children}
    </div>
  </SiteShell>;
}

function Inline({ parts }: { parts: readonly DocInline[] }) {
  return <>{parts.map((part, index) => typeof part === 'string' ? <Fragment key={index}>{part}</Fragment>
    : 'code' in part ? <code key={index}>{part.code}</code>
    : 'strong' in part ? <strong key={index}>{part.strong}</strong>
    : 'em' in part ? <em key={index}>{part.em}</em>
    : part.href.startsWith('https://') ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">{part.link}</a>
    // The application and the served OpenAPI file load as full documents, the way the site enters sign-in.
    : part.href === '/app' || part.href.endsWith('.json') ? <a key={index} href={part.href}>{part.link}</a>
    : <Link key={index} href={part.href}>{part.link}</Link>)}</>;
}

function Block({ block }: { block: DocBlock }) {
  switch (block.kind) {
    case 'p': return <p><Inline parts={block.text}/></p>;
    case 'note': return <div className={block.tone === 'warning' ? styles.noteWarn : styles.note} role="note"><strong>{block.title}</strong><span><Inline parts={block.text}/></span></div>;
    case 'code': return <div className={styles.code}><div>{block.label}</div><pre tabIndex={0}><code>{block.code}</code></pre></div>;
    case 'table': return <div className={styles.docTableBox} role="region" aria-label={block.head.join(' · ')} tabIndex={0}><table className={styles.docTable}>
      <thead><tr>{block.head.map(head => <th key={head} scope="col">{head}</th>)}</tr></thead>
      <tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}><Inline parts={cell}/></td>)}</tr>)}</tbody>
    </table></div>;
    case 'steps': return <ol className={styles.steps}>{block.items.map((item, index) => <li key={index}><span aria-hidden="true">{index + 1}</span><span><Inline parts={item}/></span></li>)}</ol>;
    case 'cards': return <div className={styles.cards}>{block.cards.map(card => <div key={card.title}><strong>{card.title}</strong>
      <dl>{card.rows.map(row => <div key={row.term}><dt>{row.term}</dt><dd><Inline parts={row.text}/></dd></div>)}</dl></div>)}</div>;
  }
}

/** BUILD-FLOFI-SITE-001: one documentation guide of the approved site (/docs/<slug>), in the visitor's language. */
export function DocsArticlePage({ language, page }: { language: SiteLanguage; page: DocPage }) {
  const t = SITE_COPY[language].docsHome;
  return <DocsLayout language={language} current={`/docs/${page.slug}`}>
    <main id="artigo" tabIndex={-1} className={styles.article} aria-labelledby="doc-title">
      <div className={styles.articleHead}>
        <nav aria-label={t.breadcrumbs} className={styles.crumbs}><Link href="/docs">Docs</Link> / {page.group}</nav>
        <div className={styles.titleRow}><h1 id="doc-title">{page.title}</h1><span className={styles.status}>{page.status}</span></div>
        <p>{page.lead}</p>
      </div>
      {page.sections.map(section => <section key={section.id || section.title} className={styles.articleSection} aria-labelledby={section.id || undefined}>
        <h2 id={section.id || undefined}>{section.title}</h2>
        {section.blocks.map((block, index) => <Block key={index} block={block}/>)}
      </section>)}
      {page.sources && <p className={styles.sources}>{page.sources}</p>}
      <nav className={styles.pager} aria-label={`${t.previous.replace('←', '').trim()} / ${t.next.replace('→', '').trim()}`}>
        {page.prev && <Link href={page.prev.href}><span>{t.previous}</span><strong>{page.prev.title}</strong></Link>}
        {page.next && <Link href={page.next.href} data-next=""><span>{t.next}</span><strong>{page.next.title}</strong></Link>}
      </nav>
    </main>
  </DocsLayout>;
}

/** BUILD-FLOFI-SITE-001: the Docs home of the approved site (/docs). */
export function DocsHomePage({ language }: { language: SiteLanguage }) {
  const t = SITE_COPY[language].docsHome;
  return <DocsLayout language={language} current="/docs">
    <main id="artigo" tabIndex={-1} className={styles.docsMain} aria-labelledby="docs-title">
      <div className={styles.docsHead}><span className={styles.mono}>{t.eyebrow}</span><h1 id="docs-title">{t.heading}</h1><p>{t.lead}</p></div>
      <div className={styles.docsHero}>
        <div>
          <span className={styles.devBadge}>{t.heroTag}</span>
          <h2>{t.heroTitle} <br/><span>{t.heroAccent}</span></h2>
          <p>{t.heroBody}</p>
          <div className={styles.devActions}><Link href="/docs/getting-started" className={styles.pillWhite}>{t.start}</Link><Link href="/docs/developer-api" className={styles.pillOutlineDark}>{t.api}</Link></div>
        </div>
        <Image src="/brand/site/mascot-check.svg" alt="" width={180} height={165} unoptimized/>
      </div>
      <section className={styles.docsSection} aria-labelledby="start-building">
        <div><h2 id="start-building">{t.buildTitle}</h2><p>{t.buildBody}</p></div>
        <div className={styles.guideGrid}>{t.guides.map(([slug, title, body], index) => <Link key={slug} href={`/docs/${slug}`}>
          <span className={styles.mono}>{String(index + 1).padStart(2, '0')}</span><strong>{title}</strong><span>{body}</span></Link>)}</div>
      </section>
      <section className={styles.docsSection} aria-labelledby="lifecycle">
        <div><h2 id="lifecycle">{t.lifecycleTitle}</h2><p>{t.lifecycleBody}</p></div>
        <div className={styles.lifeGrid}>{t.lifecycle.map(([slug, title, body], index) => <Link key={slug + title} href={`/docs/${slug}`} data-dark={index === 3 || undefined}>
          <span className={index === 3 ? styles.numWhite : styles.num}>{index + 1}</span><strong>{title}</strong><span>{body}</span></Link>)}</div>
      </section>
      <section className={styles.docsSection} aria-labelledby="build-on-flofi">
        <div><h2 id="build-on-flofi">{t.integrateTitle}</h2><p>{t.integrateBody}</p></div>
        <div className={styles.intList}>{t.integrations.map(([slug, icon, title, body]) => <Link key={slug} href={`/docs/${slug}`}>
          <span className={styles.intIcon} aria-hidden="true">{icon}</span><div><strong>{title}</strong><span>{body}</span></div><span className={styles.intArrow} aria-hidden="true">→</span></Link>)}</div>
        <div className={styles.boundary}><strong>{t.boundaryTitle}</strong><span>{t.boundary[0]}<Link href="/docs/security">{t.boundary[1]}</Link>{t.boundary[2]}<Link href="/docs/architecture">{t.boundary[3]}</Link>{t.boundary[4]}</span></div>
      </section>
    </main>
  </DocsLayout>;
}
