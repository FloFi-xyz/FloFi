// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './landing.module.css';
import type { LandingCopy, LandingLocale } from './landing-copy';
import { CryptoMark, type CryptoName } from './crypto-visuals';
import { MascotDock, MASCOT_REACT_EVENT, type MascotReaction } from './mascot-journey';
import { useScriptedSteps } from './scripted-steps';

type Copy = keyof LandingCopy;
type Card = { readonly label: Copy; readonly assets: readonly CryptoName[]; readonly network: string; readonly amount: readonly [string, string] | null };
type Scenario = { readonly id: string; readonly chip: Copy; readonly prompt: Copy; readonly route: string; readonly guard: 'minimum' | 'limit'; readonly cards: readonly Card[] };

/**
 * BUILD-FLOFI-UX-UI-002 (UX/UI-006): a scripted, bounded illustration. The visitor picks one of three fixed requests; each plays the same
 * honest sequence — request → mascot reaction → workflow cards → preview → execution journey — and stops before any signature. Only the
 * visitor's own example amounts appear: no quote, output, fee, APY, balance, hash, timestamp or confirmation is shown, and nothing is
 * fetched, stored or sent.
 */
export const DEMO_SCENARIOS: readonly Scenario[] = [
  { id: 'swap', chip: 'demoSwapChip', prompt: 'demoSwapPrompt', route: 'Uniswap · Base', guard: 'minimum',
    cards: [{ label: 'demoCardSwap', assets: ['ETH', 'USDC'], network: 'Base', amount: ['0.5', 'ETH → USDC'] }] },
  { id: 'bridge', chip: 'demoBridgeChip', prompt: 'demoBridgePrompt', route: 'Uniswap · Across / LI.FI', guard: 'minimum',
    cards: [{ label: 'demoCardSwap', assets: ['ETH', 'USDC'], network: 'Base', amount: ['0.5', 'ETH → USDC'] },
      { label: 'demoCardBridge', assets: ['Base', 'Arbitrum'], network: 'Base → Arbitrum', amount: null }] },
  { id: 'lend', chip: 'demoLendChip', prompt: 'demoLendPrompt', route: 'Aave · Ethereum', guard: 'limit',
    cards: [{ label: 'demoCardSupply', assets: ['ETH'], network: 'Ethereum', amount: ['1', 'ETH'] },
      { label: 'demoCardBorrow', assets: ['USDC'], network: 'Ethereum', amount: ['500', 'USDC'] }] },
];
export const DEMO_LAST_STEP = 5;
const amountText = ([value, unit]: readonly [string, string], locale: LandingLocale) => `${locale === 'pt' ? value.replace('.', ',') : value} ${unit}`;

export function ConversationDemo({ t, locale }: { t: LandingCopy; locale: LandingLocale }) {
  const [index, setIndex] = useState(0), [run, setRun] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const step = useScriptedSteps(stageRef, DEMO_LAST_STEP, `${index}:${run}`);
  const scenario = DEMO_SCENARIOS[index]!;
  // The existing mascot controller answers only while this section's dock is its active dock.
  useEffect(() => {
    if (step !== 2 && step !== 3) return;
    window.dispatchEvent(new CustomEvent<MascotReaction>(MASCOT_REACT_EVENT, { detail: { scene: 'demo', state: step === 2 ? 'look' : 'jump' } }));
  }, [step]);
  const shown = (from: number) => step >= from ? 'true' : 'false';
  const journey = [t.demoStepOpen, t.demoStepWallet, t.demoStepSimulate, t.demoStepReview, t.demoStepSign, t.demoStepTrack];
  return <section id="demo" className={styles.demoSection} aria-labelledby="demo-title">
    <div className={styles.container}>
      <div className={styles.scenariosHeading}><div><p className={styles.kicker}>{t.demoEyebrow}</p><h2 id="demo-title">{t.demoTitle}</h2></div><p>{t.demoBody}</p></div>
      <div ref={stageRef} className={styles.demoStage} data-demo={scenario.id} data-demo-step={step}>
        <div className={styles.demoChat} role="group" aria-label={t.demoChatLabel}>
          <div className={styles.demoChatHead}><MascotDock scene="demo" compact/><div><strong>{t.demoAssistant}</strong><span className={styles.demoBadge}>{t.demoIllustration}</span></div></div>
          <ol className={styles.demoMessages}>
            <li className={`${styles.demoUser} ${styles.reveal}`} data-shown={shown(1)}>{t[scenario.prompt]}</li>
            <li className={`${styles.demoThinking} ${styles.reveal}`} data-shown={step === 2 ? 'true' : 'false'} aria-hidden="true"><i/><i/><i/><span>{t.demoThinking}</span></li>
            <li className={`${styles.demoReply} ${styles.reveal}`} data-shown={shown(3)}>{t.demoReply}</li>
          </ol>
          <div className={styles.demoChoices} role="group" aria-labelledby="demo-choices">
            <span id="demo-choices">{t.demoChoose}</span>
            {DEMO_SCENARIOS.map((item, i) => <button type="button" key={item.id} aria-pressed={i === index} data-demo-choice={item.id}
              onClick={() => { setIndex(i); setRun(n => n + 1); }}>{t[item.chip]}</button>)}
          </div>
        </div>
        <div className={styles.demoCanvas} role="group" aria-label={`${t.demoWorkflow} · ${t.demoIllustration}`}>
          <p className={styles.demoPanelTitle}>{t.demoWorkflow}</p>
          <ol className={`${styles.demoCards} ${styles.reveal}`} data-shown={shown(3)}>
            {scenario.cards.map((card, i) => <li key={`${scenario.id}-${i}`} data-demo-card={i + 1}>
              <span className={styles.demoCardIcons}>{card.assets.map(asset => <CryptoMark key={asset} name={asset}/>)}</span>
              <span><strong>{t[card.label]}</strong><small>{card.network}</small></span>
              {card.amount ? <span className={styles.demoAmount}>{amountText(card.amount, locale)}</span> : <span className={styles.demoAmount}>USDC</span>}
            </li>)}
          </ol>
          {scenario.guard === 'minimum' && <p className={`${styles.demoSlippage} ${styles.reveal}`} data-shown={shown(3)}>{t.demoSlippage}</p>}
          <div className={`${styles.demoPreview} ${styles.reveal}`} data-shown={shown(4)}>
            <p className={styles.demoPanelTitle}>{t.demoPreview}</p>
            <dl>
              <div><dt>{t.demoRoute}</dt><dd>{scenario.route}</dd></div>
              <div><dt>{scenario.guard === 'limit' ? t.demoLimit : t.demoMinimum}</dt><dd>{scenario.guard === 'limit' ? t.demoLimitValue : t.demoMinimumValue}</dd></div>
              <div><dt>{t.demoCost}</dt><dd>{t.demoCostValue}</dd></div>
              <div><dt>{t.demoPermissions}</dt><dd>{t.demoPermissionsValue}</dd></div>
            </dl>
          </div>
          <div className={`${styles.demoJourney} ${styles.reveal}`} data-shown={shown(5)}>
            <p className={styles.demoPanelTitle}>{t.demoJourney}</p>
            <ol>{journey.map((label, i) => <li key={i} data-sign={i === 4 || undefined}><span aria-hidden="true">{i + 1}</span>{label}</li>)}</ol>
            <p className={styles.demoFinal}>{t.demoFinal}</p>
          </div>
        </div>
      </div>
      <p className={styles.scenariosNote}>{t.demoNote}</p>
    </div>
  </section>;
}
