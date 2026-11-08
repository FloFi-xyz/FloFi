// SPDX-License-Identifier: AGPL-3.0-only
import Image from 'next/image';
import Link from 'next/link';
import { SITE_COPY, SITE_NETWORKS, type SiteNetwork } from './site-copy';
import type { SiteLanguage } from './site-language';
import { SIGN_IN, SiteShell } from './site-shell';
import { FaqList, faqItems } from './faq-page';
import { TypingText } from './typing-text';
import styles from './site.module.css';

/** The board's tangle of apps, actions, networks and states (decorative), at its own positions in a 600 × 450 box. */
const CHAOS = [
  ['app', 'Uniswap', 20, 24, -6], ['action', 'approve', 236, 0, 4], ['app', 'Bridge', 410, 56, -4], ['network', 'Base', 0, 128, 3],
  ['app', 'Aave', 168, 104, -8], ['network', 'Arbitrum', 330, 150, 6], ['action', 'buyGas', 48, 214, -4], ['error', 'wrongNetwork', 250, 236, 2],
  ['app', 'Jupiter', 430, 262, -7], ['network', 'Solana', 110, 306, 5], ['pending', 'pending', 330, 338, -3], ['app', 'Orca', 8, 372, -2],
  ['confirm', 'confirm', 160, 396, 3],
] as const;
/** A network's logo in its round frame (decorative: the name is the link's or the tag's own label). */
function NetworkMark({ network }: { network: SiteNetwork }) {
  return <span className={styles.networkMark} data-glyph={network.glyph || undefined} aria-hidden="true">
    <img src={network.mark} alt="" width={44} height={44} loading="lazy" decoding="async" draggable={false}/></span>;
}
const networkNamed = (name: string) => SITE_NETWORKS.find(network => network.name === name);
/** The questions the approved landing previews; "See all" opens the full list at /faq. */
const PREVIEW = ['wallet', 'cost', 'audit', 'stuck'] as const;

const longest = (phrases: readonly string[]) => phrases.reduce((a, b) => b.length > a.length ? b : a, '');

/** A heading of two lines whose last word takes the accent colour, as the approved boards set them. */
function Accented({ lines: [first, second, accent] }: { lines: readonly [string, string, string] }) {
  return <>{first}<br/>{second} <span className={styles.accent}>{accent}</span></>;
}

/** The approved "Try it" box: the typed request on the left, the button on the right; one link into the product's sign-in entry. */
function TryBox({ language, dark = false }: { language: SiteLanguage; dark?: boolean }) {
  const t = SITE_COPY[language].home;
  return <a className={`${styles.tryBox}${dark ? ` ${styles.tryBoxOnInk}` : ''}`} href={SIGN_IN} aria-label={t.tryLabel}>
    <span aria-hidden="true" className={styles.tryText}><TypingText kind="sentence" phrases={t.heroSentences}/><span className={styles.caretSmall}/></span>
    <span className={styles.tryButton}>{t.tryIt} <span aria-hidden="true">→</span></span>
  </a>;
}

/**
 * BUILD-FLOFI-LAUNCH-001: Início / Home of the team-approved launch landing (Claude Artifact "FloFi — opção hero digitando", version
 * 1793885744-1380), in English by default and in Portuguese on request. Every control leads somewhere real: "Open" and both "Try it" boxes to
 * sign-in (from which an account can be created, a wallet connected, or the builder explored without an account), the requests the product
 * serves today and the plan's "Sign in your wallet" to the closing "Try it" (as the approved board does), "API and SDK" to For developers and
 * "See all" to the FAQ. Nothing here signs, simulates or moves funds; the mock plan and wallet prompt only illustrate the steps.
 */
export function HomePage({ language }: { language: SiteLanguage }) {
  const t = SITE_COPY[language].home;
  return <SiteShell language={language} page="home">
    <main>
      <section id="top" className={styles.typingHero} aria-labelledby="home-title">
        <Image src="/brand/site/mascot-wave.svg" alt="" width={160} height={160} unoptimized priority/>
        <h1 id="home-title" aria-label={t.heroLabel}>
          <span aria-hidden="true" className={styles.heroLines}>
            <span className={styles.heroGhost}>{t.heroLead}<br/>{t.heroWant} <span>{longest(t.heroVerbs)}</span><span className={styles.caret}/></span>
            <span data-typed="">{t.heroLead}<br/>{t.heroWant} <span className={styles.accent}><TypingText kind="word" phrases={t.heroVerbs}/></span><span className={styles.caret}/></span>
          </span>
        </h1>
        <p>{t.heroBody}</p>
        <TryBox language={language}/>
        <span className={styles.mono}>{t.heroNote}</span>
      </section>

      <section id="dor" className={styles.pain} aria-labelledby="pain-title">
        <div className={styles.splitRow}>
          <div className={styles.splitText}>
            <h2 id="pain-title" className={styles.h2}><Accented lines={t.painTitle}/></h2>
            <ul className={styles.plainList}>{t.pain.map(line => <li key={line}>{line}</li>)}</ul>
          </div>
          <div aria-hidden="true" className={styles.chaosWrap}><div className={styles.chaos}>
            {CHAOS.map(([kind, label, x, y, r]) => <span key={label} className={styles.chaosTag} data-kind={kind}
              style={{ left: x, top: y, transform: `rotate(${r}deg)` }}>
              {kind === 'app' && <span className={styles.chaosIcon}/>}{(kind === 'error' || kind === 'pending') && <span className={styles.dot}/>}
              {kind === 'network' && networkNamed(label) ? <NetworkMark network={networkNamed(label)!}/>
                : kind === 'app' || kind === 'network' ? label : t.chaos[label as keyof typeof t.chaos]}
            </span>)}
          </div></div>
        </div>
      </section>

      <section id="como-funciona" className={styles.section} aria-labelledby="plan-title">
        <div className={`${styles.splitRow} ${styles.splitRowPlan}`}>
          <div className={`${styles.splitText} ${styles.splitTextTight}`}>
            <h2 id="plan-title" className={styles.h2}><Accented lines={t.planTitle}/></h2>
            <p className={styles.planLead}>{t.planBody}</p>
          </div>
          <div className={styles.planStage}>
            <div className={styles.planCard}>
              <span className={styles.planLabel}><span className={styles.planNum}>1</span>{t.planSay}</span>
              <p className={styles.bubble}>{t.planPrompt}</p>
              <span className={styles.planLabel}><span className={styles.planNum}>2</span>{t.planBuild}</span>
              <ol className={styles.planSteps}>{t.planSteps.map(([title, route], index) => <li key={title}>
                <span className={styles.planStepNum}>{index + 1}</span><span><strong>{title}</strong><span className={styles.mono}>{route}</span></span>
              </li>)}</ol>
              <span className={styles.simulated}><span className={styles.dot}/>{t.planSimulated}</span>
              <span className={styles.planLabel}><span className={styles.planNum}>3</span>{t.planSign}</span>
              <a href="#entrar" className={styles.planSign}>{t.planSignButton}</a>
            </div>
          </div>
        </div>
      </section>

      <section id="hoje" className={`${styles.section} ${styles.soft}`} aria-labelledby="today-title">
        <div className={`${styles.wrap} ${styles.todayStack}`}>
          <h2 id="today-title" className={styles.h2}>{t.todayTitle}</h2>
          <div className={styles.asks}>
            {t.asks.map(ask => <a key={ask} href="#entrar" className={styles.ask} aria-label={t.askLabel(ask)}>{ask}</a>)}
            <span className={styles.askSoon}>{t.soonAsk}<span className={styles.soonTag}>{t.soon}</span></span>
          </div>
          <div className={styles.todayGrid}>
            <div><span id="today-networks" className={styles.mono}>{t.networksLabel}</span>
              <ul className={styles.networkLogos} aria-labelledby="today-networks">{SITE_NETWORKS.map(network => <li key={network.name}>
                <a href={network.href} target="_blank" rel="noopener noreferrer" aria-label={network.name} title={network.name} className={styles.networkLink}>
                  <NetworkMark network={network}/></a>
              </li>)}</ul>
            </div>
            <div><span className={styles.mono}>{t.channelsLabel}</span>
              <ul className={styles.channelsInline}>{t.channels.map(([name, status], index) => <li key={name}>
                {index === 3
                  ? <Link href="/developers">{name}<span className={styles.badge}>{status}</span></Link>
                  : <span>{name}<span className={styles.badge} data-tone={index === 0 ? 'beta' : undefined}>{status}</span></span>}
              </li>)}</ul>
            </div>
          </div>
        </div>
      </section>

      <section id="seguranca" className={styles.section} aria-labelledby="safety-title">
        <div className={styles.splitRow}>
          <div className={styles.splitText}>
            <h2 id="safety-title" className={styles.h2}><Accented lines={t.safetyTitle}/></h2>
            <ul className={styles.plainList}>{t.safety.map(line => <li key={line}>{line}</li>)}</ul>
          </div>
          <div className={styles.walletStage} aria-hidden="true">
            <div className={styles.walletMock}>
              <div className={styles.walletCard}>
                <div className={styles.walletTop}><span>{t.wallet.label}</span><span className={styles.walletNet}><span className={styles.dot}/>Arbitrum</span></div>
                <strong>{t.wallet.title}</strong>
                <dl><div><dt>{t.wallet.action}</dt><dd>{t.wallet.actionValue}</dd></div><div><dt>{t.wallet.signer}</dt><dd>{t.wallet.signerValue}</dd></div></dl>
                <div className={styles.walletButtons}><span>{t.wallet.reject}</span><span>{t.wallet.approve}</span></div>
              </div>
              <Image src="/brand/site/mascot-check.svg" alt="" width={124} height={124} unoptimized className={styles.walletMascot}/>
            </div>
          </div>
        </div>
      </section>

      <section id="perguntas" className={styles.section} aria-labelledby="faq-title">
        <div className={styles.faqPreview}>
          <div className={styles.faqPreviewLead}>
            <h2 id="faq-title" className={styles.h2}>{t.faqTitle}</h2>
            <Link href="/faq" className={styles.pillOutline}>{t.faqAll}</Link>
          </div>
          <FaqList items={faqItems(language, PREVIEW)}/>
        </div>
      </section>

      <section id="entrar" className={styles.finalWrap} aria-labelledby="final-title">
        <div className={styles.finalTry}>
          <h2 id="final-title">{t.finalTitle}</h2>
          <TryBox language={language} dark/>
        </div>
      </section>
    </main>
  </SiteShell>;
}
