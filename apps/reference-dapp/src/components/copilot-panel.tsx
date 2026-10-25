// SPDX-License-Identifier: AGPL-3.0-only
'use client';
import { useLocale } from '../i18n/locale';

import { CopilotAutomationProposal } from './copilot-automation-proposal';
import type { AutomationInput } from '../automations/definition';
import type { WorkflowOwner } from '../domain/saved-workflow';
import type { useWalletProof } from './wallet-proof';
import { useState, type FormEvent } from 'react';
import { parseLocalCommand, summarize } from '../domain/commands';
import { editorReducer } from '../domain/editor';
import { activeNetworkScope, introducedTestNetworks, testNetworkMessage } from '../domain/network-scope';
import { ensureNetworkCatalog } from '../state/asset-catalog-store';
import { catalogNetworksNamed } from '../domain/network-registry';
import { useWorkflow } from '../state/workflow-store';
import { completeSendDestination, sendDestinationIssue, SEND_DESTINATION_INVALID, SEND_DESTINATION_QUESTION } from '../domain/send-destination';

import { useBuild009Wallet } from '../state/build009-wallet-store';
import { CopilotMessage, COPILOT_PLACEHOLDER, copilotHelp, copilotIntro, copilotLabel, useCopilotInterpreter, useFollowLatest } from './copilot-ai';

type Message = { role: 'system' | 'you' | 'ai'; text: string; notes?: readonly string[]; options?: readonly string[] };
export function CopilotPanel({ interactive = true, owner = null, proof }: { interactive?: boolean; owner?: WorkflowOwner | null; proof?: ReturnType<typeof useWalletProof> }) {
  const { t: tr } = useLocale();
  const { state, context, propose, dismissProposal } = useWorkflow();
  const wallet = useBuild009Wallet();
  const copilot = useCopilotInterpreter();
  const guidance = copilotHelp(copilot.mode) ?? 'This request could not be understood. Check the action, amount, asset and chain, then try again.';
  const [automation, setAutomation] = useState<AutomationInput | null>(null);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([{ role: 'system', text: 'Review each proposed change before applying it.' }]);
  // UX-001: an exact Send waiting for its destination ("Which wallet should I send it to?").
  const [destination, setDestination] = useState<{ request: string; network: string } | null>(null);
  const log = useFollowLatest(copilot.enabled, messages.length, copilot.busy);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || copilot.busy) return;
    setInput('');
    void send(text);
  }
  async function send(text: string) {
    // BUILD-RH-002: Robinhood Chain Stock Tokens resolve only in the validated official catalog; load it (where enabled) before parsing.
    // BUILD-RH-002 / BUILD-BASE-001: catalog-network symbols resolve only in validated catalogs; load those the sentence names first.
    await Promise.all(catalogNetworksNamed(text).map(network => ensureNetworkCatalog(false, network.chain)));
    setAutomation(null);
    if (text.toLowerCase() === 'explain') {
      dismissProposal();
      // Display the same authored actions as the canvas; the canonical scaffold stays untouched.
      const nodes = state.workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
      const summary = nodes.length ? summarize({ ...state.workflow, nodes }, context) : 'Your flow has no actions yet. Add an action to start building.';
      setMessages(old => [...old, { role: 'you', text }, { role: 'system', text: summary }]);
      return;
    }
    // UX-001: a one-word answer completes the pending exact Send with that destination; anything else starts a new request.
    let request = text;
    if (destination && /^\S+$/.test(text)) {
      const completed = completeSendDestination(destination.request, destination.network, text);
      if (!completed) { setMessages(old => [...old, { role: 'you', text }, { role: 'system', text: SEND_DESTINATION_INVALID }]); return; }
      request = completed;
    }
    setDestination(null);
    try {
      const command = parseLocalCommand(request, state.workflow, context, wallet.account);
      const issue = sendDestinationIssue(command, request);
      if (issue) {
        dismissProposal();
        if (issue.kind === 'MISSING') setDestination({ request, network: issue.network });
        setMessages(old => [...old, { role: 'you', text }, { role: 'system', text: issue.kind === 'MISSING' ? SEND_DESTINATION_QUESTION : SEND_DESTINATION_INVALID }]);
        return;
      }
      // BUILD-FLOFI-MAINNET-PRODUCT-001: a test network named in chat is refused in the public product, never moved to a mainnet for the owner.
      const preview = editorReducer(state, command, context), introduced = preview.error ? [] : introducedTestNetworks(state.workflow, preview.workflow, activeNetworkScope());
      if (introduced.length) {
        dismissProposal(); copilot.reset();
        setMessages(old => [...old, { role: 'you', text }, { role: 'system', text: testNetworkMessage(introduced) }]);
        return;
      }
      propose(command);
      copilot.reset();
      setMessages(old => [...old, { role: 'you', text }, { role: 'system', text: `Proposal: ${request}. Review against revision ${command.baseRevision} before applying.` }]);
    } catch {
      // BUILD-COPILOT-002: the Copilot keeps the pending proposal visible while it interprets ("make it 2", questions about it).
      if (copilot.mayInterpret) {
        setMessages(old => [...old, { role: 'you', text }]);
        void copilot.respond(text).then(reply => { if (reply?.automation) setAutomation(reply.automation); setMessages(old => [...old,
          reply ? { role: 'ai', text: reply.text, notes: reply.notes, options: reply.options } : { role: 'system', text: guidance }]); });
        return;
      }
      dismissProposal();
      setMessages(old => [...old, { role: 'you', text }, { role: 'system', text: guidance }]);
    }
  }
  return <aside className="copilot panel" aria-label={tr("Workflow assistant")}>
    <div className="copilot-head"><div><p className="eyebrow">{tr("ASSISTANT")}</p><h2>{tr("Copilot")}</h2></div></div>
    <div ref={log} className="chat-messages" role="log" aria-live="polite" aria-label={tr("Conversation")}>{messages.map((message, index) =>
      <div key={index} className={`message ${message.role}`}>{(message.role === 'you' || copilot.enabled) && <small>{tr(message.role === 'you' ? 'YOU' : copilotLabel(message.role, copilot.mode))}</small>}{message.role === 'ai'
        ? <CopilotMessage text={message.text} notes={message.notes} options={message.options} disabled={copilot.busy} onPick={send}/>
        : <p>{message.role === 'you' ? message.text : tr((index === 0 && copilot.enabled && copilotIntro(copilot.mode)) || message.text)}</p>}</div>)}
      {copilot.busy && <div className="message ai" role="status"><small>{tr(copilotLabel('ai', copilot.mode))}</small><p>{tr("Interpreting your message…")}</p></div>}
      {automation && <CopilotAutomationProposal input={automation} owner={owner} {...(proof ? { proof } : {})} dismiss={() => setAutomation(null)}/>}
    </div>
    <form className="chat-form" onSubmit={submit}><label htmlFor="mock-prompt">{tr("Describe your flow")}</label><div><input id="mock-prompt" disabled={!interactive} value={input} onChange={event => setInput(event.target.value)} placeholder={tr(copilot.enabled ? COPILOT_PLACEHOLDER : 'Action, amount, asset and chain')} maxLength={1024} autoComplete="off" enterKeyHint="send"/><button type="submit" disabled={!interactive || copilot.busy}>{tr("Send")}</button></div></form>
  </aside>;
}
