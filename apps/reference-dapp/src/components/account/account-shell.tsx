// SPDX-License-Identifier: AGPL-3.0-only
'use client';
/**
 * BUILD-FLOFI-AUTH-WALLETS-001: the two-column frame of sign-in and wallet onboarding. Left: the task. Right: the FloFi brand panel
 * (decorative, hidden from assistive technology except its text). On phones the brand becomes a band above the task.
 * The theme defaults to dark here unless the person chose light; the choice is the same `flofi.theme` preference the app uses.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocale } from '../../i18n/locale';
import { AccountIcon } from './account-icons';
import styles from './account.module.css';

import { darkTheme, readTheme, selectTheme, subscribeTheme } from '../../accounts/account-theme';

function ThemeToggle() {
  const { t } = useLocale();
  const dark = useSyncExternalStore(subscribeTheme, readTheme, darkTheme) === 'dark';
  return <button type="button" role="switch" aria-checked={dark} aria-label={t('Dark theme')} className={styles.themeToggle}
    onClick={() => selectTheme(dark ? 'light' : 'dark')}>
    <span><AccountIcon name="moon" size={14}/><AccountIcon name="sun" size={14}/></span></button>;
}
function LanguageSwitch() {
  const { t, language, setLanguage } = useLocale();
  return <div className={styles.language} role="group" aria-label={t('Language')}>
    <button type="button" lang="pt-BR" aria-pressed={language === 'PT'} onClick={() => setLanguage('PT')}>PT</button>
    <button type="button" lang="en" aria-pressed={language === 'EN'} onClick={() => setLanguage('EN')}>EN</button>
  </div>;
}

/**
 * BUILD-FLOFI-IDENTITY-RECOVERY-UX-001 (UX-03): each capability around the account carries its own mark. FloFi line icons (the app's own
 * navigation geometry where one exists) drawn in the chip's colour; EVM and Solana use the repository's official brand marks
 * (public/brand/crypto/sources.md), shown as images, never redrawn. Decorative: the orbit is aria-hidden and every chip keeps its text.
 */
type ChipMark = 'build' | 'simulate' | 'copilot' | 'evm' | 'dashboard' | 'solana' | 'agents' | 'execute';
const CHIPS: readonly { label: string; mark: ChipMark; x: string; y: string; color: string }[] = [
  { label: 'Build', mark: 'build', x: '18%', y: '10%', color: '#93A6FF' }, { label: 'Simulate', mark: 'simulate', x: '64%', y: '8%', color: '#5FD4F5' },
  { label: 'Copilot', mark: 'copilot', x: '2%', y: '34%', color: '#F5B94A' }, { label: 'EVM', mark: 'evm', x: '82%', y: '32%', color: '#93A6FF' },
  { label: 'Dashboard', mark: 'dashboard', x: '0%', y: '62%', color: '#A4ABB8' }, { label: 'Solana', mark: 'solana', x: '80%', y: '62%', color: '#9C7BFF' },
  { label: 'AI agents (MCP)', mark: 'agents', x: '14%', y: '86%', color: '#4ADE80' }, { label: 'Execute', mark: 'execute', x: '62%', y: '88%', color: '#7C93FF' },
];
const MOBILE_CHIPS: readonly ChipMark[] = ['evm', 'solana', 'copilot', 'agents'];
const MOBILE_LABEL: Readonly<Partial<Record<ChipMark, string>>> = { evm: 'EVM', solana: 'Solana', copilot: 'Copilot', agents: 'AI agents (MCP)' };
const LINE: Readonly<Record<Exclude<ChipMark, 'evm' | 'solana'>, ReactNode>> = {
  build: <><rect x="3" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="16" width="7" height="5" rx="1.5"/><path d="M6.5 8v7a3.5 3.5 0 0 0 3.5 3.5h4M14 5.5h7m-3-3 3 3-3 3"/></>,
  simulate: <path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>,
  copilot: <><path d="M12 3.5 13.9 9 19.5 11l-5.6 2-1.9 5.5-1.9-5.5L4.5 11l5.6-2Z"/><path d="M19 3v3m-1.5-1.5h3"/></>,
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
  agents: <><rect x="4" y="7" width="16" height="13" rx="3"/><path d="M12 3v4M2 12h2m16 0h2M9 16h6"/><path d="M9 11v1m6-1v1"/></>,
  execute: <><circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l5.5-3.5Z"/></>,
};
function ChipIcon({ mark }: { mark: ChipMark }) {
  if (mark === 'evm') return <img className={`${styles.chipMark} ${styles.chipMarkEvm}`} src="/brand/crypto/ethereum.svg" alt="" width={14} height={14}/>;
  if (mark === 'solana') return <img className={styles.chipMark} src="/brand/crypto/solana.svg" alt="" width={14} height={14}/>;
  return <svg className={styles.chipMark} viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true">{LINE[mark]}</svg>;
}
type Slide = 'account' | 'wallets' | 'review';
const SLIDES: readonly Slide[] = ['account', 'wallets', 'review'];
const SLIDE_TEXT: Readonly<Record<Slide, { title: string; body: string }>> = {
  account: { title: 'One account. Every workflow.', body: 'Keep your workflows and wallets with one FloFi account. Your wallet still reviews and signs every transaction.' },
  wallets: { title: 'Your wallets, your keys.', body: 'Create or import wallets with our wallet provider, or keep using MetaMask, Phantom and Solflare. FloFi never holds a key.' },
  review: { title: 'Nothing moves without you.', body: 'Signing in never approves a transaction. Every one is simulated, reviewed and signed by your own wallet.' },
};

function Showcase({ initial }: { initial: Slide }) {
  const { t } = useLocale();
  const [slide, setSlide] = useState<Slide>(initial);
  const [paused, setPaused] = useState(false), [stopped, setStopped] = useState(false);
  useEffect(() => {
    if (paused || stopped || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = setInterval(() => setSlide(current => SLIDES[(SLIDES.indexOf(current) + 1) % SLIDES.length]!), 8000);
    return () => clearInterval(timer);
  }, [paused, stopped]);
  const text = SLIDE_TEXT[slide];
  return <aside className={styles.showcase} aria-label={t('About FloFi accounts')} onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
    onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
    {slide === 'account' ? <div className={styles.orbit} aria-hidden="true">
      <svg className={styles.orbitRings} viewBox="0 0 540 400" preserveAspectRatio="none" aria-hidden="true">
        <ellipse cx="270" cy="200" rx="250" ry="178"/><ellipse className={styles.orbitTrack} cx="270" cy="200" rx="178" ry="128"/>
      </svg>
      {CHIPS.map(chip => <span key={chip.label} className={styles.chip} style={{ left: chip.x, top: chip.y, ['--chip' as string]: chip.color }}>
        <ChipIcon mark={chip.mark}/>{t(chip.label)}</span>)}
      <div className={styles.orbitCore}><img src="/brand/flofi-droplet-wave-dark.svg" alt=""/><small>FLOFI</small><strong>{t('Your account')}</strong><span>{t('One account for FloFi')}</span></div>
    </div> : slide === 'wallets' ? <div className={styles.preview} aria-hidden="true">
      <div className={styles.previewCard}><small>EVM</small><p>{t('FloFi wallet · Generated')}</p><p><code>0x7a3…e91c</code></p></div>
      <div className={styles.previewCard}><small>SOLANA</small><p>{t('Phantom · Connected')}</p><p><code>9xQe…4Lm2</code></p></div>
      <div className={styles.previewCard}><small>{t('PROTECTED BY PRIVY')}</small><p>{t('Keys are created and kept by Privy, not by FloFi.')}</p></div>
    </div> : <div className={styles.preview} aria-hidden="true">
      <div className={styles.previewCard}><small>{t('YOUR WORKFLOW')}</small><p>{t('Swap 500 USDC → ETH on Base')}</p>
        <div className={styles.steps}><span>{t('Build')}</span><span>{t('Simulate')}</span><span>{t('Execute')}</span></div></div>
      <div className={styles.previewCard}><small>{t('STRATEGY MANIFEST')}</small><p>{t('Review fees, route and limits — then your wallet signs.')}</p></div>
    </div>}
    <div className={styles.showcaseText}><h2>{t(text.title)}</h2><p>{t(text.body)}</p></div>
    <div className={styles.dots} role="group" aria-label={t('Highlights')}>
      {SLIDES.map((value, index) => <button key={value} type="button" aria-label={t('Highlight {0} of {1}', index + 1, SLIDES.length)}
        aria-current={value === slide ? 'true' : undefined} onClick={() => setSlide(value)}/>)}
      <button type="button" className={styles.pause} aria-pressed={stopped} onClick={() => setStopped(value => !value)}>{t(stopped ? 'Play highlights' : 'Pause highlights')}</button>
    </div>
  </aside>;
}

export function AccountShell({ children, showcase = 'account', start = false }: { children: ReactNode; showcase?: Slide; start?: boolean }) {
  const { t } = useLocale();
  return <div className={styles.shell}>
    <main className={styles.panel}>
      <div className={styles.top}>
        <a className={styles.brand} href="/" aria-label={t('FloFi home')}>
          <img className={styles.wordmarkDark} src="/brand/flofi-wordmark-dark.png" alt="FloFi" height={30}/>
          <img className={styles.wordmarkLight} src="/brand/flofi-wordmark-light.png" alt="FloFi" height={30}/>
        </a>
        <div className={styles.controls}><LanguageSwitch/><ThemeToggle/></div>
      </div>
      <div className={styles.mobileBrand} aria-hidden="true"><strong>{t(SLIDE_TEXT[showcase].title)}</strong><span>{t('One account for FloFi')}</span>
        <div className={styles.mobileChips}>{MOBILE_CHIPS.map(mark => <span key={mark} className={styles.chip}
          style={{ ['--chip' as string]: CHIPS.find(chip => chip.mark === mark)!.color }}><ChipIcon mark={mark}/>{t(MOBILE_LABEL[mark]!)}</span>)}</div></div>
      <div className={`${styles.content}${start ? ` ${styles.contentStart}` : ''}`}>{children}</div>
    </main>
    <Showcase initial={showcase}/>
  </div>;
}
export { styles as accountStyles };
