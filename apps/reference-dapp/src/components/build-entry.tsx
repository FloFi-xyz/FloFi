// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import Image from 'next/image';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useLocale } from '../i18n/locale';
import { BUILD_ENTRY_SUGGESTIONS, buildEntryOutcome, type BuildEntryOutcome, type BuildEntrySnapshot, type BuildEntrySuggestion } from '../domain/build-entry';
import type { FlofiConversation } from '../state/flofi-conversation';
import styles from './build-entry.module.css';

const icons: Record<BuildEntrySuggestion['icon'], ReactNode> = {
  yield: <><circle cx="10" cy="10" r="6.5"/><circle cx="10" cy="10" r="3" fill="currentColor" stroke="none"/></>,
  swap: <path d="M3 10h14M6.5 6.5 3 10l3.5 3.5M13.5 6.5 17 10l-3.5 3.5"/>,
  liquidity: <path d="M10 17v-4.2M10 12.8a3 3 0 1 1-2.7-4.3A3 3 0 1 1 12.7 8.5a3 3 0 1 1-2.7 4.3ZM7.6 17h4.8"/>,
  collateral: <path d="m10 3.8 6.2 6.2-6.2 6.2L3.8 10Z"/>,
  multi: <path d="M3.5 5h4.5M12 5h4.5M3.5 10h4.5M12 10h4.5M3.5 15h4.5M12 15h4.5"/>,
};
const Icon = ({ children, className }: { children: ReactNode; className?: string | undefined }) =>
  <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>;

export type BuildEntryProps = {
  conversation: FlofiConversation;
  workflow: { readonly workflowId: string; readonly revision: number };
  /** The workflow's current proposal (the Canvas review), compared by identity. */
  proposal: unknown;
  /** Actions the current workflow already holds: a request typed here is added to that workflow, exactly as in the chat. */
  actions: number;
  /** Lifted to the shell, so the request survives a visit to another section. */
  draft: string; setDraft(value: string): void;
  interactive: boolean;
  /** Opens Build 1, the existing builder (Canvas and chat). */
  openBuilder(): void;
};

/**
 * BUILD0-UX-001: Build 0, "What do you want to do?". The request goes to the same FloFi conversation as the Build 1 chat (exact commands, then the
 * configured Copilot); that conversation commits it to the canonical workflow or leaves the existing Canvas proposal for review. Nothing here
 * simulates, quotes, signs or executes, and no wallet is needed.
 */
export function BuildEntry({ conversation, workflow, proposal, actions, draft, setDraft, interactive, openBuilder }: BuildEntryProps) {
  const { t: tr, language } = useLocale();
  const [attempt, setAttempt] = useState<{ before: BuildEntrySnapshot; settled: boolean } | null>(null);
  const [refused, setRefused] = useState<Extract<BuildEntryOutcome, { kind: 'REFUSED' }> | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const busy = Boolean(attempt && !attempt.settled) || conversation.busy;
  const snapshot = (): BuildEntrySnapshot => ({ workflowId: workflow.workflowId, revision: workflow.revision, proposal, messages: conversation.messages.length,
    question: conversation.question, automation: conversation.automation });

  async function submit() {
    const text = draft.trim();
    if (!text || busy || !interactive) return;
    setRefused(null);
    const before = snapshot();
    setAttempt({ before, settled: false });
    try { await conversation.submit(text); } finally { setAttempt(current => current?.before === before ? { before, settled: true } : current); }
  }
  // Read once the conversation has settled, from the stored workflow and FloFi's own reply (never from the request text).
  useEffect(() => {
    if (!attempt?.settled) return;
    const outcome = buildEntryOutcome(attempt.before, { ...snapshot(), log: conversation.messages });
    setAttempt(null);
    if (outcome.kind === 'REFUSED') { setRefused(outcome); return; }
    setDraft('');
    openBuilder();
  // `snapshot` reads the current render's values; this runs once per settled attempt.
  }, [attempt]);
  // The request stays editable after a refusal: focus returns to it once the field is enabled again.
  useEffect(() => { if (refused) field.current?.focus(); }, [refused]);

  function onSubmit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void submit(); }
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  }
  function suggest(item: BuildEntrySuggestion) {
    setDraft(item.example[language === 'PT' ? 'PT' : 'EN']); setRefused(null);
    field.current?.focus();
  }
  const refusal = refused?.message ? refused.language ? refused.message : tr(refused.message) : null;
  return <section className={styles.root} aria-labelledby="build-entry-title" data-build-entry="">
    <div className={styles.content}>
      <div className={styles.mascot} aria-hidden="true">
        <Image className={styles.mascotLight} src="/brand/flofi-droplet-wave.svg" alt="" width={168} height={168} priority unoptimized draggable={false}/>
        <Image className={styles.mascotDark} src="/brand/flofi-droplet-wave-dark.svg" alt="" width={168} height={168} priority unoptimized draggable={false}/>
        <span className={styles.mascotShadow}/>
      </div>
      <h1 id="build-entry-title" className={styles.title}>{tr('What do you ')}<span>{tr('want to do?')}</span></h1>
      <p className={styles.description}>{tr('Describe your goal in one sentence. FloFi turns it into a workflow you can review before simulating or executing.')}</p>

      <form className={styles.composer} onSubmit={onSubmit} aria-busy={busy}>
        <Icon className={styles.spark}><path d="M10 1.8c.5 4.2 2.3 6.4 7.2 8.2-4.9 1.8-6.7 4-7.2 8.2-.5-4.2-2.3-6.4-7.2-8.2 4.9-1.8 6.7-4 7.2-8.2Z" fill="currentColor" stroke="none"/></Icon>
        <label className="sr-only" htmlFor="build-entry-request">{tr('Describe your strategy')}</label>
        <textarea ref={field} id="build-entry-request" value={draft} rows={2} maxLength={1024} disabled={busy}
          placeholder={tr('I want to put 2,000 USDC to work on Solana with low risk.')}
          aria-describedby={refusal || refused ? 'build-entry-error' : 'build-entry-hint'}
          onChange={event => { setDraft(event.target.value); setRefused(null); }} onKeyDown={onKeyDown}/>
        <button className={styles.create} type="submit" disabled={!draft.trim() || busy || !interactive}>
          <Icon className={styles.createIcon}><path d="M6 14 14 6M7.5 6H14v6.5"/></Icon>{tr(busy ? 'Preparing…' : 'Create strategy')}
        </button>
      </form>
      <p id="build-entry-hint" className="sr-only">{tr('Press Enter to create the strategy, or Shift+Enter for a new line.')}</p>
      {busy && <p className={styles.status} role="status">{tr('Understanding your request and preparing the workflow…')}</p>}
      {refused && <div id="build-entry-error" className={styles.error} role="alert">
        <p>{refusal ?? tr('FloFi could not build this strategy yet. Try describing it differently or start manually.')}</p>
        <p className={styles.errorNote}>{tr('Your text was kept. Edit it and try again, or open the editor.')}</p>
        <div><button type="button" onClick={() => void submit()} disabled={!draft.trim() || busy}>{tr('Try again')}</button>
          <button type="button" onClick={openBuilder}>{tr('Build manually')}</button></div>
      </div>}
      {actions > 0 && !refused && <p className={styles.context} role="note">{tr(actions === 1 ? 'Your workflow already has 1 action. A new request is added to it.' : 'Your workflow already has {0} actions. A new request is added to it.', actions)}{' '}
        <button type="button" onClick={openBuilder}>{tr('Open the editor')}</button></p>}

      <div className={styles.suggestions} role="group" aria-label={tr('Example requests')}>
        {BUILD_ENTRY_SUGGESTIONS.map(item => <button key={item.id} type="button" disabled={busy} onClick={() => suggest(item)}>
          <Icon className={styles.chipIcon}>{icons[item.icon]}</Icon>{tr(item.label)}</button>)}
      </div>
      <button className={styles.manual} type="button" onClick={openBuilder}>{tr('Prefer the editor? Build manually')} <span aria-hidden="true">→</span></button>
      <div className={styles.trust}>
        <span className={styles.check} aria-hidden="true"><Icon><path d="m5.5 10.4 3 3 6-7"/></Icon></span>
        <div><strong>{tr('Nothing executes without your review and authorization.')}</strong><p>{tr('You can start without connecting a wallet.')}</p></div>
      </div>
    </div>
  </section>;
}
