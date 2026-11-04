// SPDX-License-Identifier: AGPL-3.0-only
import Image from 'next/image';
import Link from 'next/link';
import { NETWORKS_LINE, SITE_COPY, type ExampleCard } from './site-copy';
import type { SiteLanguage } from './site-language';
import { SIGN_IN, SiteShell } from './site-shell';
import styles from './site.module.css';

const ART = { coin: 'mascot-coin', wave: 'mascot-wave', check: 'mascot-check', search: 'mascot-search', cheer: 'mascot-cheer' } as const;

/**
 * BUILD-FLOFI-SITE-001: Início / Home of the approved site. Every control leads somewhere real: "Entrar / Open" to sign-in (from which the builder
 * is reachable without an account), the examples to the start section (as the approved board does), "API e SDK" to For developers.
 */
export function HomePage({ language }: { language: SiteLanguage }) {
  const t = SITE_COPY[language].home, open = SITE_COPY[language].header.open;
  return <SiteShell language={language} page="home">
    <main>
      <section id="top" className={styles.hero} aria-labelledby="home-title">
        <Image src="/brand/site/mascot-wave.svg" alt="" width={200} height={200} unoptimized priority/>
        <h1 id="home-title">{t.heroTitle[0]} <br/>{t.heroTitle[1]}</h1>
        <p>{t.heroBody}</p>
        <div className={styles.actions}><a href={SIGN_IN} className={styles.pillInk}>{open}</a><a href="#exemplos" className={styles.pillOutline}>{t.heroExamples}</a></div>
        <span className={styles.mono}>{t.heroNote}</span>
      </section>
      <section id="exemplos" className={`${styles.section} ${styles.soft}`} aria-labelledby="examples-title">
        <div className={`${styles.wrap} ${styles.stack}`}>
          <h2 id="examples-title" className={styles.h2}>{t.examplesTitle}</h2>
          <div className={styles.examples}>
            {t.examples.map(example => <a key={example.prompt} href="#entrar" className={styles.example}>
              <div><strong>&quot;{example.prompt}&quot;</strong><span className={styles.mono}>{example.meta}</span></div>
              <Image src={`/brand/site/${ART[example.art as ExampleCard['art']]}.svg`} alt="" width={104} height={104} unoptimized/>
            </a>)}
            <div className={styles.soonCard}><span className={styles.soonTag}>{t.soon}</span><strong>&quot;{t.soonExample}&quot;</strong></div>
          </div>
          <a href="#entrar" className={styles.writeYourWay}><span aria-hidden="true">+</span>{t.writeYourWay}</a>
        </div>
      </section>
      <section id="como-funciona" className={styles.section} aria-labelledby="steps-title">
        <div className={`${styles.wrap} ${styles.stack}`}>
          <h2 id="steps-title" className={`${styles.h2} ${styles.center}`}>{t.stepsTitle}</h2>
          <ol className={styles.pills}>
            {t.steps.map(([title, body], index) => <li key={title} className={`${styles.pillStep}${index === 2 ? ` ${styles.pillStepDark}` : ''}`}>
              <span className={index === 2 ? styles.numWhite : styles.num}>{index + 1}</span><div><strong>{title}</strong><span className={styles.pillDesc}>{body}</span></div>
            </li>)}
          </ol>
        </div>
      </section>
      <section id="seguranca" className={`${styles.section} ${styles.soft}`} aria-labelledby="safety-title">
        <div className={`${styles.wrap} ${styles.stack} ${styles.stackWide}`}>
          <div className={styles.split}>
            <h2 id="safety-title" className={styles.h2}>{t.safetyTitle}</h2>
            <div className={styles.ruleList}>{t.safety.map(([title, body]) => <div key={title}><strong>{title}</strong><span>{body}</span></div>)}</div>
          </div>
          <p className={styles.networks}><span className={styles.mono}>{t.networksLabel}</span><strong>{NETWORKS_LINE}</strong></p>
        </div>
      </section>
      <section id="canais" className={styles.section} aria-labelledby="channels-title">
        <div className={`${styles.wrap} ${styles.channelGrid}`}>
          <div className={styles.channelLead}><h2 id="channels-title">{t.channelsTitle}</h2></div>
          <div className={styles.channelList}>
            {t.channels.map(([name, status], index) => index === 3
              ? <Link key={name} href="/developers" className={styles.channelRow}><span>{name}</span><span className={styles.mono}>{status}</span></Link>
              : <div key={name} className={styles.channelRow}><span>{name}</span><span className={styles.mono} data-tone={index === 0 ? 'beta' : undefined}>{status}</span></div>)}
          </div>
        </div>
      </section>
      <section id="entrar" className={styles.finalWrap} aria-labelledby="final-title">
        <div className={styles.final}>
          <Image src="/brand/site/mascot-cheer.svg" alt="" width={180} height={180} unoptimized/>
          <div><h2 id="final-title">{t.finalTitle}</h2><a href={SIGN_IN} className={styles.pillWhite}>{open}</a></div>
        </div>
      </section>
    </main>
  </SiteShell>;
}
