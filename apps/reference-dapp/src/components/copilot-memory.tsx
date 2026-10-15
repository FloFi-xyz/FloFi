// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useState } from 'react';
import { useLocale } from '../i18n/locale';
import { learningApply, learningErase, learningSettings } from '../app/learning-action';
import { targetLabel } from '../domain/copilot-learning-copy';
import { isLexiconTarget } from '../domain/copilot-lexicon';
import type { LearningStatusView } from '../learning/web-actions';
import type { useWalletProof } from './wallet-proof';

type Namespace = 'eip155' | 'solana';
/**
 * BUILD-CHAT-LEARNING-001: the Copilot's Memory — what FloFi remembers for the wallet proven in this browser, and the two separate choices
 * (use my saved preferences; help improve FloFi's shared glossary). View, delete one entry, pause, or delete everything. Nothing here touches a
 * workflow, a proposal, an approval or a wallet signature; the chat works the same with memory off.
 */
export function CopilotMemory({ view, onChange, proof }: { view: LearningStatusView; onChange(identity?: Namespace | null): Promise<unknown>;
  proof?: ReturnType<typeof useWalletProof> | undefined }) {
  const { t: tr, language } = useLocale();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [confirming, setConfirming] = useState(false);
  if (!view.enabled) return null;
  const identity = view.identity?.namespace ?? undefined;
  async function act(work: () => Promise<{ ok: boolean; code?: string }>) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await work();
      if (!result.ok) setError(result.code === 'LEARNING_RATE_LIMITED' ? 'Too many memory changes right now. Try again later.' : 'Memory could not be changed right now.');
      await onChange();
    } catch { setError('Memory could not be changed right now.'); } finally { setBusy(false); setConfirming(false); }
  }
  const saved = view.entries.length;
  const summary = view.learning.memory === 'UNAVAILABLE' ? tr('unavailable') : !view.identity ? tr('this conversation only') : view.paused ? tr('paused')
    : tr('{0} saved', saved);
  return <details className="copilot-memory">
    <summary>{tr('Memory')} <span className="muted">· {summary}</span></summary>
    <div className="copilot-memory-body">
      <p className="muted">{tr('FloFi can remember words you use, like “arb” for Arbitrum, for your proven wallet only. Memory never fills in amounts, addresses or networks you did not name, and every proposal says how your words were read.')}</p>
      {view.learning.memory === 'UNAVAILABLE' ? <p role="status">{tr('Memory is unavailable right now. The Copilot works as usual.')}</p>
        : !view.identity ? <>
          <p>{tr('Prove your wallet to keep preferences across sessions. Without it, what you tell the Copilot lasts only for this conversation.')}</p>
          {proof && <div className="copilot-options">
            <button type="button" className="quiet" disabled={proof.busy} onClick={() => void proof.proveEvm().then(() => onChange())}>{tr('Prove an EVM wallet')}</button>
            <button type="button" className="quiet" disabled={proof.busy} onClick={() => void proof.proveSolana().then(() => onChange())}>{tr('Prove a Solana wallet')}</button>
          </div>}
        </> : <>
          {view.identities.length > 1 && <label className="copilot-memory-identity">{tr('Memory for')}{' '}
            <select value={view.identity.namespace} disabled={busy} onChange={event => void onChange(event.target.value as Namespace)}>
              <option value="eip155">{tr('EVM wallet')}</option><option value="solana">{tr('Solana wallet')}</option>
            </select></label>}
          <p>{tr('Memory for wallet')} <code>{view.identity.short}</code> ({view.identity.namespace === 'solana' ? 'Solana' : 'EVM'})</p>
          <label className="copilot-memory-toggle"><input type="checkbox" checked={view.memoryEnabled} disabled={busy}
            onChange={event => void act(() => learningSettings({ memory: event.target.checked }, identity))}/> {tr('Use my saved preferences')}</label>
          <label className="copilot-memory-toggle"><input type="checkbox" checked={view.contributeEnabled} disabled={busy}
            onChange={event => void act(() => learningSettings({ contribute: event.target.checked }, identity))}/> {tr('Help improve FloFi’s shared glossary with generalized words (never your messages or wallet)')}</label>
          {saved ? <ul className="copilot-memory-list" aria-label={tr('Saved meanings')}>{view.entries.map(entry => <li key={entry.term}>
            <span><code>{entry.term}</code> → {isLexiconTarget(entry.target) ? targetLabel(entry.target, language) : entry.target}</span>
            <button type="button" className="quiet" disabled={busy} aria-label={tr('Forget “{0}”', entry.term)} onClick={() => void act(() => learningApply({ op: 'FORGET', term: entry.term }, identity))}>
              {tr('Forget')}</button></li>)}</ul>
            : <p className="muted">{tr('Nothing saved yet. Tell the Copilot, for example: “whenever I say arb, I mean Arbitrum”.')}</p>}
          {view.learning.language && <p>{tr('Reply language: {0}', view.learning.language === 'PT' ? tr('Portuguese') : tr('English'))}</p>}
          <div className="copilot-options">
            {confirming ? <><button type="button" className="quiet" disabled={busy} onClick={() => void act(() => learningErase(identity))}>{tr('Confirm: delete everything')}</button>
              <button type="button" className="quiet" disabled={busy} onClick={() => setConfirming(false)}>{tr('Keep')}</button></>
              : <button type="button" className="quiet" disabled={busy} onClick={() => setConfirming(true)}>{tr('Delete all memory')}</button>}
          </div>
        </>}
      {error && <p role="alert">{tr(error)}</p>}
      <p className="muted"><a href={language === 'PT' ? '/privacy#memoria-copilot' : '/privacy#copilot-memory'}>{tr('How FloFi uses memory')}</a></p>
    </div>
  </details>;
}
