// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { useLocale } from '../i18n/locale';
import { learningAgree, learningNotice } from '../app/learning-action';
import { privacyNoticeCookie, privacyNoticeFromCookies, type PrivacyNoticeChoice } from '../domain/privacy-notice';
import { LEARNING_CHANGED } from '../domain/wallet-proof-events';
import styles from './privacy-notice.module.css';

type Notice = Awaited<ReturnType<typeof learningNotice>>;

/**
 * BUILD-FLOFI-CHAT-E2E-DASHBOARD-UX-001: the first-access Privacy & Memory notice on /app — a centered dialog over a dimmed page with one
 * checkbox ("I agree"), Continue and "Not now". No wallet proof is asked. The answer is kept in this browser (`domain/privacy-notice.ts`).
 * The copy follows the deployment's basis for automatic learning and repeats the learning notice the Settings toggle shows. Under an opt-in
 * basis, agreeing turns learning on for the wallet this browser can use at that moment only (proven here or held by the signed-in FloFi
 * account), never overriding that wallet's own choice and never for a wallet that appears later. Nothing here changes a workflow, approval,
 * signature or funds; every choice stays reviewable and reversible in Privacy & memory.
 */
export function PrivacyNotice({ initial }: { initial: PrivacyNoticeChoice | 'UNANSWERED' }) {
  const { t: tr, language } = useLocale();
  // The server's reading on the first render (no hydration flip); a later remount (client navigation) reads the answer given since.
  const [answer, setAnswer] = useState<PrivacyNoticeChoice | null>(() => initial !== 'UNANSWERED' ? initial
    : typeof document === 'undefined' ? null : privacyNoticeFromCookies(document.cookie));
  const [agreed, setAgreed] = useState(false), [notice, setNotice] = useState<Notice | null>(null), [ready, setReady] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), title = useId(), checkbox = useId(), description = useId();
  const open = answer === null;
  // Continue waits for the deployment's basis, so an agreement is never recorded without its effect (a failed read still lets the person answer).
  useEffect(() => { if (open) void learningNotice().then(setNotice, () => setNotice(null)).finally(() => setReady(true)); }, [open]);
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open && typeof element.showModal === 'function') element.showModal();
  }, [open]);
  function decide(choice: PrivacyNoticeChoice) {
    document.cookie = privacyNoticeCookie(choice, window.location.protocol === 'https:');
    dialog.current?.close();
    setAnswer(choice);
    // Once, for the wallet available now; best effort (the answer above is kept either way).
    if (choice === 'AGREED' && notice?.tier === 'ENABLED' && notice.automatic === 'CONSENT')
      void learningAgree().then(result => { if (result.applied) window.dispatchEvent(new Event(LEARNING_CHANGED)); }, () => undefined);
  }
  if (!open) return null;
  const learning = notice?.tier === 'ENABLED' && notice.automatic !== 'OFF';
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={title} aria-describedby={description} onCancel={event => { event.preventDefault(); decide('NOT_NOW'); }}>
    <form className={styles.panel} method="dialog" onSubmit={event => { event.preventDefault(); if (agreed) decide('AGREED'); }}>
      <h2 id={title}>{tr('Privacy & Memory')}</h2>
      <p id={description}>{tr('FloFi’s Copilot can remember how you write to it, per wallet: the words you use for networks, tokens and actions, and preferences such as your reply language, so it understands you faster.')}</p>
      {learning && <p>{tr('When you answer FloFi’s questions or correct how it read a network, token or action, FloFi can keep that meaning for this wallet after repeated evidence. Never amounts, addresses, balances or decisions, and a meaning it learned never selects a real-funds network on its own.')}{' '}
        {tr(notice.automatic === 'CONSENT' ? 'Off unless you turn it on.' : 'On unless you turn it off. Turning it off deletes what it learned.')}</p>}
      {learning && notice.automatic === 'CONSENT' && <p>{tr('If you agree, it is turned on for the wallet you use now (verified in this browser, or held by the FloFi account you are signed in to), never for a wallet used later. With no such wallet now, nothing is stored; you can turn it on later in Privacy & memory.')}</p>}
      {learning && notice.automatic === 'LEGITIMATE_INTEREST' && <p>{tr('“Not now” is not an objection: to object, turn learning off in Privacy & memory.')}</p>}
      {notice?.tier === 'ENABLED' && notice.automatic === 'OFF' && <p className={styles.muted}>{tr('On this FloFi deployment nothing is learned automatically: FloFi keeps only the meanings you save yourself with Remember, for that wallet.')}</p>}
      {notice?.tier === 'OFF' && <p className={styles.muted}>{tr('Copilot learning is not enabled on this FloFi deployment: nothing about how you write is kept.')}</p>}
      {notice?.tier === 'SESSION' && <p className={styles.muted}>{tr('FloFi keeps nothing about how you write: the Copilot adapts to your words within a conversation only.')}</p>}
      <ul>
        <li>{tr('This never changes a workflow, an approval, a signature or any movement of funds.')}</li>
        <li>{tr('No wallet proof is needed to answer.')}</li>
        <li>{tr('You can see, download or delete what is kept, or change this choice, at any time in Privacy & memory.')}</li>
      </ul>
      <label className={styles.agree} htmlFor={checkbox}><input id={checkbox} type="checkbox" checked={agreed} onChange={event => setAgreed(event.target.checked)}/>{tr('I agree')}</label>
      <div className={styles.actions}>
        <button type="button" className="quiet" onClick={() => decide('NOT_NOW')}>{tr('Not now')}</button>
        <button type="submit" className="primary" disabled={!agreed || !ready}>{tr('Continue')}</button>
      </div>
      <p className={styles.muted}><a href={language === 'PT' ? '/privacy#memoria-copilot' : '/privacy#copilot-memory'}>{tr('How FloFi uses memory')}</a></p>
    </form>
  </dialog>;
}
