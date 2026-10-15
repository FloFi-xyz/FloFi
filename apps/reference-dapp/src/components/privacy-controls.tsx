// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useCallback, useEffect, useState } from 'react';
import { useLocale } from '../i18n/locale';
import { learningApply, learningErase, learningSettings, learningStatus } from '../app/learning-action';
import { targetLabel } from '../domain/copilot-learning-copy';
import { isLexiconTarget } from '../domain/copilot-lexicon';
import type { LearningStatusView } from '../learning/web-actions';
import { LEARNING_CHANGED, type useWalletProof } from './wallet-proof';

type Namespace = 'eip155' | 'solana';
type Ready = Extract<LearningStatusView, { enabled: true }>;
const ORIGIN: Readonly<Record<string, string>> = { STATED: 'you told FloFi', LEARNED: 'learned from your choices', REMEMBERED: 'saved with Remember' };

/**
 * BUILD-CHAT-LEARNING-002: Privacy & memory — outside the chat. What FloFi keeps about the words the proven wallet uses with the Copilot, how each
 * meaning came to be, what was observed but not used, and the user's choices: automatic learning (per the deployment's legal basis: opt-in under
 * consent, opt-out under legitimate interest), pausing saved meanings, contributing to the shared glossary, deleting one meaning or everything, and
 * downloading a copy. Nothing here touches a workflow, a proposal, an approval or a wallet signature; the Copilot works the same whatever is chosen.
 */
export function PrivacyControls({ proof }: { proof?: ReturnType<typeof useWalletProof> | undefined }) {
  const { t: tr, language } = useLocale();
  const [view, setView] = useState<LearningStatusView | null>(null), [identity, setIdentity] = useState<Namespace | undefined>(undefined);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [confirming, setConfirming] = useState(false);
  const load = useCallback(async (namespace?: Namespace) => setView(await learningStatus(namespace).catch(() => null)), []);
  useEffect(() => { void load(identity); }, [load, identity]);
  async function act(work: () => Promise<{ ok: boolean; code?: string }>) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await work();
      if (!result.ok) setError(result.code === 'LEARNING_RATE_LIMITED' ? 'Too many changes right now. Try again later.' : 'This could not be changed right now.');
      await load(identity);
      window.dispatchEvent(new Event(LEARNING_CHANGED));
    } catch { setError('This could not be changed right now.'); } finally { setBusy(false); setConfirming(false); }
  }
  const label = (target: string) => isLexiconTarget(target) ? targetLabel(target, language) : target;
  const heading = <header className="secondary-workspace-heading"><h1>{tr('Privacy & memory')}</h1>
    <p>{tr('What FloFi keeps about the words you use with the Copilot, and your choices. Nothing here changes a workflow, an approval or a signature.')}</p></header>;
  if (!view) return <>{heading}<p role="status">{tr('Loading…')}</p></>;
  if (!view.enabled || view.learning.memory === 'SESSION') return <>{heading}<section className="workspace-section privacy-controls">
    <p>{tr(view.enabled ? 'FloFi keeps nothing about how you write: the Copilot adapts to your words within a conversation only.'
      : 'Copilot learning is not enabled on this FloFi deployment: nothing about how you write is kept.')}</p>
    <p><a href={language === 'PT' ? '/privacy#memoria-copilot' : '/privacy#copilot-memory'}>{tr('How FloFi uses memory')}</a></p></section></>;
  const ready: Ready = view;
  const download = () => {
    const data = { exportedAt: new Date().toISOString(), wallet: ready.identity, notice: ready.noticeVersion, automaticLearning: ready.automatic, memoryEnabled: ready.memoryEnabled,
      contributeEnabled: ready.contributeEnabled, replyLanguage: ready.learning.language, startingLanguage: ready.languageHint,
      meanings: ready.entries.map(entry => ({ term: entry.term, meaning: entry.target, origin: entry.origin, savedAt: entry.createdAt })),
      observedNotUsed: ready.pending.map(entry => ({ term: entry.term, meaning: entry.target, weight: entry.weight, lastSeenAt: entry.lastSeenAt })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = 'flofi-copilot-memory.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  const mode = ready.automatic.mode;
  return <>{heading}
    <section className="workspace-section privacy-controls" aria-labelledby="privacy-identity">
      <h2 id="privacy-identity">{tr('Copilot memory')}</h2>
      {ready.learning.memory === 'UNAVAILABLE' ? <p role="status">{tr('Memory is unavailable right now. The Copilot works as usual.')}</p>
        : !ready.identity ? <>
          <p>{tr('Prove a wallet to see and manage what FloFi keeps for it. Proving signs a sign-in message only; it never moves funds.')}</p>
          {proof && <div className="workspace-secondary-actions">
            <button type="button" className="quiet" disabled={proof.busy} onClick={() => void proof.proveEvm().then(() => load(identity))}>{tr('Prove an EVM wallet')}</button>
            <button type="button" className="quiet" disabled={proof.busy} onClick={() => void proof.proveSolana().then(() => load(identity))}>{tr('Prove a Solana wallet')}</button>
          </div>}
        </> : <>
          {ready.identities.length > 1 && <label className="privacy-field">{tr('Memory for')}{' '}
            <select value={ready.identity.namespace} disabled={busy} onChange={event => setIdentity(event.target.value as Namespace)}>
              <option value="eip155">{tr('EVM wallet')}</option><option value="solana">{tr('Solana wallet')}</option>
            </select></label>}
          <p>{tr('Memory for wallet')} <code>{ready.identity.short}</code> ({ready.identity.namespace === 'solana' ? 'Solana' : 'EVM'}). {tr('Other wallets and chat accounts never share it.')}</p>
          {mode !== 'OFF' && <label className="privacy-toggle"><input type="checkbox" checked={ready.automatic.permitted} disabled={busy}
            onChange={event => void act(() => learningSettings({ automatic: event.target.checked }, ready.identity!.namespace))}/>
            <span><strong>{tr('Learn from how I use the Copilot')}</strong><br/>
              {tr('When you answer FloFi’s questions or correct how it read a network, token or action, FloFi can keep that meaning for this wallet after repeated evidence. Never amounts, addresses, balances or decisions, and a meaning it learned never selects a real-funds network on its own.')}
              {' '}{tr(mode === 'CONSENT' ? 'Off unless you turn it on.' : 'On unless you turn it off. Turning it off deletes what it learned.')}</span></label>}
          {ready.consented && <label className="privacy-toggle"><input type="checkbox" checked={ready.memoryEnabled} disabled={busy}
            onChange={event => void act(() => learningSettings({ memory: event.target.checked }, ready.identity!.namespace))}/> <span>{tr('Use my saved meanings')}</span></label>}
          <label className="privacy-toggle"><input type="checkbox" checked={ready.contributeEnabled} disabled={busy}
            onChange={event => void act(() => learningSettings({ contribute: event.target.checked }, ready.identity!.namespace))}/>
            <span>{tr('Help improve FloFi’s shared glossary with generalized words (never your messages or wallet)')}</span></label>
          <h3>{tr('Saved meanings')}</h3>
          {ready.entries.length ? <ul className="privacy-list" aria-label={tr('Saved meanings')}>{ready.entries.map(entry => <li key={entry.term}>
            <span><code>{entry.term}</code> → {label(entry.target)} <small className="muted">· {tr(ORIGIN[entry.origin] ?? entry.origin)}</small></span>
            <button type="button" className="quiet" disabled={busy} aria-label={tr('Forget “{0}”', entry.term)}
              onClick={() => void act(() => learningApply({ op: 'FORGET', term: entry.term }, ready.identity!.namespace))}>{tr('Forget')}</button></li>)}</ul>
            : <p className="muted">{tr('FloFi keeps no meanings for this wallet.')}</p>}
          {ready.pending.length > 0 && <>
            <h3>{tr('Observed, not used')}</h3>
            <p className="muted">{tr('FloFi uses an observed meaning only after repeated evidence; these expire after 90 days.')}</p>
            <ul className="privacy-list" aria-label={tr('Observed, not used')}>{ready.pending.map(entry => <li key={`${entry.term}:${entry.target}`}>
              <span><code>{entry.term}</code> → {label(entry.target)}</span>
              <button type="button" className="quiet" disabled={busy} aria-label={tr('Forget “{0}”', entry.term)}
                onClick={() => void act(() => learningApply({ op: 'FORGET', term: entry.term }, ready.identity!.namespace))}>{tr('Forget')}</button></li>)}</ul>
          </>}
          {ready.learning.language && <p>{tr('Reply language: {0}', ready.learning.language === 'PT' ? tr('Portuguese') : tr('English'))}</p>}
          {ready.languageHint && <p>{tr('Conversations start in: {0}', ready.languageHint === 'PT' ? tr('Portuguese') : tr('English'))}</p>}
          <div className="workspace-secondary-actions">
            <button type="button" className="quiet" onClick={download}>{tr('Download my data')}</button>
            {confirming ? <><button type="button" className="quiet" disabled={busy} onClick={() => void act(() => learningErase(ready.identity!.namespace))}>{tr('Confirm: delete everything')}</button>
              <button type="button" className="quiet" disabled={busy} onClick={() => setConfirming(false)}>{tr('Keep')}</button></>
              : <button type="button" className="quiet" disabled={busy} onClick={() => setConfirming(true)}>{tr('Delete everything')}</button>}
          </div>
        </>}
      {error && <p role="alert">{tr(error)}</p>}
      <p className="muted"><a href={language === 'PT' ? '/privacy#memoria-copilot' : '/privacy#copilot-memory'}>{tr('How FloFi uses memory')}</a></p>
    </section>
  </>;
}
