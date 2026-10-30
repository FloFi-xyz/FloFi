// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { CopilotAutomationProposal } from './copilot-automation-proposal';
import type { WorkflowOwner } from '../domain/saved-workflow';
import type { useWalletProof } from './wallet-proof';
import type { FormEvent, ReactNode } from 'react';
import type { FlofiConversation } from '../state/flofi-conversation';
import { ConversationReviewCard } from './conversation-cards';
import { CopilotMessage, COPILOT_PLACEHOLDER, copilotIntro, copilotLabel, useFollowLatest } from './copilot-ai';
import { FloFiAvatar, UserAvatar } from './flofi-avatar';

/**
 * The FloFi chat. BUILD-FLOFI-CONVERSATIONAL-001: presentation only — the conversation lives in the workspace shell (`useFlofiConversation`), so
 * this panel can render beside any stage without losing it. Suggested answers appear only on FloFi's latest message: an older button can never
 * answer a newer question.
 */
export function CopilotPanel({ conversation, interactive = true, owner = null, proof }: { conversation: FlofiConversation; interactive?: boolean; owner?: WorkflowOwner | null;
  proof?: ReturnType<typeof useWalletProof> }) {
  const { t: tr, language } = useLocale();
  const { copilot, messages, busy, input, setInput, send } = conversation;
  const log = useFollowLatest(copilot.enabled || conversation.direct, messages.length, busy);
  const last = messages.at(-1);
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
    <div ref={log} className="chat-messages" role="log" aria-live="polite" aria-label={tr("Conversation")}>{messages.map((message, index) => {
      const options = message === last && message.role !== 'you' ? message.options : undefined;
      return row(message.role === 'you', message.id, <div className={`message ${message.role === 'flofi' ? 'system flofi' : message.role}`}>
        {(message.role === 'you' || showLabels) && <small className="sr-only">{tr(message.role === 'you' ? 'YOU' : message.role === 'flofi' || message.role === 'system' && !copilot.enabled ? 'FLOFI' : copilotLabel(message.role, copilot.mode))}</small>}
        {message.role === 'ai' || message.role === 'flofi' ? <>
          <CopilotMessage text={message.text} notes={message.role === 'ai' || !message.review ? message.notes : undefined} options={message.review || message.question ? undefined : options} disabled={busy} onPick={send}/>
          {message.review && <ConversationReviewCard review={message.review} language={message.language ?? language}/>}
          {message.review && message.notes && message.notes.length > 0 && <ul className="copilot-notes">{message.notes.map((note, at) => <li key={at}>{note}</li>)}</ul>}
          {message.question && <p className="conversation-question"><strong>{message.question}</strong></p>}
          {(message.review || message.question) && options && options.length > 0 && <div className="copilot-options" role="group" aria-label={tr("Suggested answers")}>
            {options.map(option => <button key={option} type="button" className="quiet" disabled={busy} onClick={() => send(option)}>{option}</button>)}</div>}
        </> : <p>{message.role === 'you' ? message.text : tr((index === 0 && copilot.enabled && copilotIntro(copilot.mode, conversation.direct)) || message.text)}</p>}
      </div>);
    })}
      {/* BUILD0-UX-001: no execution report card in the chat. FloFi's own short messages announce each phase (wallet request, uncertainty, the
          result and what to do next); the Execute stage and the Dashboard keep the steps, transactions and evidence. */}
      {busy && row(false, 'busy', <div className="message ai" role="status"><small className="sr-only">{tr(copilotLabel('ai', copilot.mode))}</small><p>{tr("Interpreting your message…")}</p></div>)}
      {conversation.automation && <CopilotAutomationProposal input={conversation.automation} owner={owner} {...(proof ? { proof } : {})} dismiss={conversation.dismissAutomation}/>}
    </div>
    <form className="chat-form" onSubmit={submit}><label htmlFor="mock-prompt">{tr("Describe your flow")}</label><div><input id="mock-prompt" disabled={!interactive} value={input} onChange={event => setInput(event.target.value)} placeholder={tr(copilot.enabled ? COPILOT_PLACEHOLDER : 'Action, amount, asset and chain')} maxLength={1024} autoComplete="off" enterKeyHint="send"/><button type="submit" disabled={!interactive || busy}>{tr("Send")}</button></div></form>
  </aside>;
}
