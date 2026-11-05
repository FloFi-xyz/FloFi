// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-001: the approved boarding passes, filled only with the holder's real pass: the Founding card ("Peça 2 · Cartão",
 * fixed parts and the developer map's variable fields A–G) and the passenger card shown once the 100 Founding seats are taken ("Peça 3").
 * Variable fields: handle (A), FROM/TO network codes (B, C), up to 4 steps or 3 and "+N steps" (D), seat (E), departure date (F) and route
 * size (G). Never an amount.
 */
import { visibleSteps } from '../../flight/campaign';
import type { FlightPass } from '../../flight/store';
import type { FlightCopy } from './flight-copy';
import styles from './flight.module.css';

/** "04 NOV 2026", in English as the developer map asks, on the Brazilian calendar day of boarding. */
export function departureDate(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'short', year: 'numeric' }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${get('day')} ${get('month').toUpperCase()} ${get('year')}`;
}

export function Flaps({ text, cells, big = false, hi = false, label }: { text: string; cells?: number; big?: boolean; hi?: boolean; label?: string }) {
  const chars = [...text.toUpperCase()], length = Math.max(cells ?? chars.length, chars.length);
  return <span className={styles.flaps} role="img" aria-label={label ?? text}>
    {Array.from({ length }, (_, index) => <span key={index} aria-hidden="true" className={`${styles.flap}${big ? ` ${styles.flapBig}` : ''}${hi && chars[index]?.trim() ? ` ${styles.flapHi}` : ''}`}>
      {chars[index] ?? ''}</span>)}
  </span>;
}

export function FoundingPass({ pass, copy }: { pass: FlightPass; copy: FlightCopy }) {
  const t = copy.pass, { shown, more } = visibleSteps(pass.route);
  return <div className={styles.passStage} aria-labelledby="pass-title">
    <span className={`${styles.sticker} ${styles.passSticker}`} aria-hidden="true">{copy.boarding.sticker}</span>
    <p className={`${styles.lbl} ${styles.passEyebrow}`} id="pass-title">{t.eyebrowFounding}</p>
    <div className={styles.passWrap}>
      <article className={styles.card} aria-label={`${t.boardingPass}: ${pass.route.from} → ${pass.route.to}, ${t.foundingMember} ${pass.seat}`}>
        <div className={styles.cardMain}>
          <div className={styles.cardHead}><strong>{t.flight}</strong><span>{t.boardingPass}</span></div>
          <div className={styles.cardBody}>
            <div><div className={styles.cardLabel}>{t.passenger}</div><div className={styles.cardHandle}>{pass.handle ? `@${pass.handle}` : t.noHandle}</div></div>
            <div><div className={styles.cardLabel}>{t.departure}</div><div className={styles.cardDate}>{departureDate(pass.departedAt)}</div></div>
            <div className={styles.cardRoute}>
              <div><span className={styles.cardLabel}>{t.from}</span><span className={styles.cardCode}>{pass.route.from}</span></div>
              <span className={styles.cardArrow} aria-hidden="true">→</span>
              <div><span className={styles.cardLabel}>{t.to}</span><span className={styles.cardCode}>{pass.route.to}</span></div>
            </div>
            <div className={styles.via}>
              <span className={styles.cardLabel}>{t.via}</span>
              <ol>{shown.map((step, index) => <li key={index}><span className={styles.viaNo}>{index + 1}</span><span className={styles.viaAction}>{step.action}</span>
                <span className={styles.viaDetail}>{step.detail}</span></li>)}
                {more > 0 && <li><span className={styles.viaDetail}>{t.more(more)}</span></li>}</ol>
            </div>
            <div className={styles.cardFoot}>
              <div><span className={styles.cardLabel}>{t.seat}</span><span className={styles.cardFootValue}>{pass.foundingSeat ? `${t.foundingMember} ${pass.seat}` : pass.seat}</span></div>
              <div><span className={styles.cardLabel}>{t.route}</span><span className={styles.cardFootValue}>{t.steps(pass.route.stepCount, pass.route.networkCount)}</span></div>
              <div><span className={styles.cardLabel}>{t.gate}</span><span className={styles.cardGate}>{t.youApprove}</span></div>
            </div>
          </div>
        </div>
        <div className={styles.stub} aria-hidden="true">
          <img src="/brand/flight/flofi-logo.svg" alt=""/>
          <span className={styles.stamp}>{t.checked}</span>
          <span className={styles.barcode}/>
          <span className={styles.stubUrl}>flofi.xyz</span>
        </div>
      </article>
    </div>
    <img className={styles.seal} src="/brand/flight/seal-founding.svg" alt=""/>
    <img className={styles.passGota} src="/brand/flight/gota-card.svg" alt=""/>
  </div>;
}

export function PassengerPass({ pass, copy }: { pass: FlightPass; copy: FlightCopy }) {
  const t = copy.pass;
  return <div className={styles.standby} aria-labelledby="pass-title">
    <div className={styles.board}>
      <Flaps text={`${t.standbyBoard[0]} · ${t.standbyBoard[1]}`} big label={`${t.standbyBoard[0]} · ${t.standbyBoard[1]}`}/>
      <div className={styles.standbyRow}>
        <div><span className={styles.boardLabel}>{t.passenger}</span><Flaps text={pass.handle ? `@${pass.handle}` : '@—'} cells={16} big label={pass.handle ? `@${pass.handle}` : t.noHandle}/></div>
        <div><span className={styles.boardLabel}>{t.seat}</span><Flaps text={pass.seat} cells={6} big hi/></div>
      </div>
      <div><span className={styles.boardLabel}>{t.gate}</span><Flaps text={t.youApprove} big/></div>
    </div>
    <h2 className={styles.standbyTitle} id="pass-title">{t.standbyTitle[0]}<span className={styles.accentPeri}>{t.standbyTitle[1]}</span></h2>
    <p className={styles.heroBody}>{t.standbyBody}</p>
    <p className={styles.small}>{pass.route.from} → {pass.route.to} · {t.steps(pass.route.stepCount, pass.route.networkCount)} · {departureDate(pass.departedAt)}</p>
    <span className={styles.urlPill}>flofi.xyz</span>
    <img className={styles.standbyGota} src="/brand/flight/gota-standby.svg" alt=""/>
  </div>;
}
