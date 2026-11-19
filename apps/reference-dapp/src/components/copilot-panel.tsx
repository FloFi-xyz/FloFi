// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { CopilotAutomationProposal } from './copilot-automation-proposal';
import type { WorkflowOwner } from '../domain/saved-workflow';
import type { useWalletProof } from './wallet-proof';
import type { FormEvent, ReactNode } from 'react';
import type { FlofiConversation } from '../state/flofi-conversation';
import { shownMessage } from '../domain/chat-message';
import { ConversationReviewCard, NetworkChoices, networkChoiceOptions } from './conversation-cards';
import { ChatActions, CopilotMessage, copilotIntro, copilotLabel, useFollowLatest } from './copilot-ai';
import { CopilotAutomationManager } from './copilot-automation-manager';
import { AmountShortcuts } from './amount-shortcuts';
import type { AwaitingAmount } from '../domain/amount-shortcuts';
import { FloFiAvatar, UserAvatar } from './flofi-avatar';

/**
 * The FloFi chat. BUILD-FLOFI-CONVERSATIONAL-001: presentation only — the conversation lives in the workspace shell (`useFlofiConversation`), so
 * this panel can render beside any stage without losing it. Suggested answers appear only on FloFi's latest message: an older button can never
 * answer a newer question.
 */
export function CopilotPanel({ conversation, interactive = true, owner = null, proof, overview, reviewInPanel = false, placeholder = 'Ask or request a change', stageNote = null }: { conversation: FlofiConversation; interactive?: boolean; owner?: WorkflowOwner | null;
  /** BUILD-FLOFI-UX-EDITOR-FINOPS-001 (section 10): the composer's hint for the Editor stage (Create, Simulate or Execute). */
  placeholder?: string | undefined;
  /** A local hint for the stage (e.g. C2: the Review expired): shown beside the conversation, never sent, stored or added to it. */
  stageNote?: string | null;
  proof?: ReturnType<typeof useWalletProof>;
  /**
   * Board 06: the Editor shows the whole-workflow Review beside the cards with its one primary action (Authorize) in the footer. The chat then
   * shows no second Review card; FloFi's own text, its notes (e.g. what a requote changed) and its answers are unchanged. Presentation only: the
   * conversation keeps every message and answer.
   */
  reviewInPanel?: boolean;
  /** BUILD-FLOFI-BUILDER-UX-002: the Editor's live workflow summary (Canvas only), above the unchanged conversation and composer. */
  overview?: ReactNode }) {
  const { t: tr, language } = useLocale();
  const { copilot, messages, busy, input, setInput, send } = conversation;
  const log = useFollowLatest(copilot.enabled || conversation.direct, messages.length, busy);
  const last = messages.at(-1);
  // UX-02: balance shortcuts only under FloFi's latest message when it is the structured amount question the engine still waits for, unchanged.
  const sameRequest = (request: AwaitingAmount | null | undefined, asked: AwaitingAmount | undefined) => !!request && !!asked && request.question === asked.question
    && request.asset === asked.asset && request.network === asked.network;
  const awaiting = last?.awaitingAmount ? copilot.awaitingAmount?.() ?? null : null;
  const shortcuts = awaiting && sameRequest(awaiting.request, last?.awaitingAmount) ? awaiting : null;
  // Read at the moment of a pick (after any balance re-read): FloFi must still wait for exactly this amount, under its latest message.
  const stillOpen = (asked: AwaitingAmount) => () => sameRequest(copilot.awaitingAmount?.()?.request, asked) && sameRequest(asked, conversation.messages.at(-1)?.awaitingAmount);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    send(text);
  }
  const showLabels = copilot.enabled || conversation.direct;
  // BUILD-FLOFI-BRIDGE-LIVE-FIX-003: the FloFi Assistant — the official FloFi symbol beside the assistant's messages, a person beside the owner's.
  // The role names stay for screen readers; the avatars and bubbles carry the visual distinction.
  const row = (you: boolean, key: number | string, bubble: ReactNode) => <div key={key} className={`chat-row ${you ? 'chat-row-you' : 'chat-row-flofi'}`}>
    {you ? <>{bubble}<UserAvatar/></> : <><FloFiAvatar/>{bubble}</>}</div>;
  return <aside className="copilot panel" aria-label={tr("FloFi Assistant")} data-conversation-phase={conversation.phase ?? undefined}>
    <div className="copilot-head"><h2 className="assistant-title"><FloFiAvatar size="title"/><span>{tr("FloFi Assistant")}</span></h2></div>
    {overview}
    <div ref={log} className="chat-messages" role="log" aria-live="polite" aria-label={tr("Conversation")}>{messages.map((written, index) => {
      // P0 hotfix (locale contract): FloFi's deterministic messages follow the CURRENT interface language (rendered in both when written).
      const message = shownMessage(written, language === 'PT' ? 'PT' : 'EN');
      const offered = written === last && message.role !== 'you' ? message.options : undefined;
      // P0 approved UX (board 05): answers that are all networks become a list of network buttons; any other answers stay suggestion chips.
      const networks = networkChoiceOptions(offered), options = networks ? undefined : offered;
      return row(message.role === 'you', message.id, <div className={`message ${message.role === 'flofi' ? 'system flofi' : message.role}`}>
        {(message.role === 'you' || showLabels) && <small className="sr-only">{tr(message.role === 'you' ? 'YOU' : message.role === 'flofi' || message.role === 'system' && !copilot.enabled ? 'FLOFI' : copilotLabel(message.role, copilot.mode))}</small>}
        {message.role === 'ai' || message.role === 'flofi' ? <>
          <CopilotMessage text={message.text} notes={message.role === 'ai' || !message.review ? message.notes : undefined} options={message.review || message.question ? undefined : options} link={message.link} verbatim={message.verbatim} disabled={busy} onPick={send}/>
          {message.review && !reviewInPanel && <ConversationReviewCard review={message.review} language={message.language ?? language}/>}
          {message.review && message.notes && message.notes.length > 0 && <ul className="copilot-notes">{message.notes.map((note, at) => <li key={at}>{tr(note)}</li>)}</ul>}
          {message.question && <p className="conversation-question"><strong>{tr(message.question)}</strong></p>}
          {(message.review || message.question) && options && options.length > 0 && <ChatActions options={options} verbatim={message.verbatim} busy={busy} onPick={send}/>}
          {networks && <NetworkChoices options={networks} disabled={busy} onPick={send}/>}
          {written === last && shortcuts && <AmountShortcuts request={shortcuts.request} evm={shortcuts.evm} solana={shortcuts.solana} workflow={shortcuts.workflow}
            disabled={busy || !interactive} stillOpen={stillOpen(shortcuts.request)} onPick={send}/>}
        </> : <p>{message.role === 'you' ? message.text : tr((index === 0 && copilot.enabled && copilotIntro(copilot.mode, conversation.direct)) || message.text, ...message.params ?? [])}</p>}
      </div>);
    })}
      {/* BUILD0-UX-001: no execution report card in the chat. FloFi's own short messages announce each phase (wallet request, uncertainty, the
          result and what to do next); the Execute stage and the Dashboard keep the steps, transactions and evidence. */}
      {busy && row(false, 'busy', <div className="message ai" role="status"><small className="sr-only">{tr(copilotLabel('ai', copilot.mode))}</small><p>{tr("Interpreting your message…")}</p></div>)}
      {conversation.automation && <CopilotAutomationProposal input={conversation.automation} owner={owner} {...(proof ? { proof } : {})} dismiss={conversation.dismissAutomation}
        onCreated={() => conversation.copilot.automationCreated?.()}/>}
      {conversation.manage && <CopilotAutomationManager operation={conversation.manage.operation} request={conversation.manage.request} owner={owner} {...(proof ? { proof } : {})}
        dismiss={conversation.dismissManage}/>}
    </div>
    {stageNote && <div className="chat-row chat-row-flofi copilot-stage-note" role="note"><FloFiAvatar/><div className="message system flofi"><p>{tr(stageNote)}</p></div></div>}
    {/* P0 approved UX (board 04): the label stays for assistive technology (visually hidden); Send is an icon inside the field, neutral until
        there is text, and shows a spinner while FloFi is answering. Submitting is unchanged. */}
    <form className="chat-form" onSubmit={submit}><label htmlFor="mock-prompt" className="sr-only">{tr("Describe your flow")}</label><div className="chat-input"><input id="mock-prompt" disabled={!interactive} value={input} onChange={event => setInput(event.target.value)} placeholder={tr(placeholder)} maxLength={1024} autoComplete="off" enterKeyHint="send"/>
      <button type="submit" className="chat-send" aria-label={tr('Send message')} title={tr('Send message')} data-ready={Boolean(input.trim()) && !busy || undefined} aria-busy={busy || undefined} disabled={!interactive || busy || !input.trim()}>
        {busy ? <span className="chat-send-spinner" aria-hidden="true"/> : <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>}
      </button></div></form>
  </aside>;
}
