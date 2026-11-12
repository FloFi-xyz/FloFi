// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopilotPanel } from './copilot-panel';
import { EditorOverviewPanel } from './editor-overview-panel';
import { NetworkChoices, networkChoiceOptions, orderNetworkChoices } from './conversation-cards';
import type { EditorOverview, EditorStep } from '../domain/editor-overview';
import { FLOFI_WELCOME, FLOFI_WELCOME_COMMANDS } from '../domain/assistant-welcome';
import { LocaleProvider, translate } from '../i18n/locale';
import { conversationCopy } from '../domain/conversation-copy';
import { shownMessage } from '../domain/chat-message';
import type { ChatMessage, FlofiConversation } from '../state/flofi-conversation';

// Presentation unit: the conversation itself is covered by the lifecycle and interpreter suites.
function conversation(direct: boolean, messages: ChatMessage[] = []): FlofiConversation {
  return { messages: [{ id: 0, role: 'system', text: direct ? FLOFI_WELCOME_COMMANDS
    : 'Review each proposed change before applying it.' }, ...messages], input: '', setInput: vi.fn(), send: vi.fn(), busy: false,
    copilot: { mode: 'off', enabled: false, busy: false, mayInterpret: false }, automation: null, dismissAutomation: vi.fn(), phase: direct ? 'AUTHORING' : null,
    question: null, execution: null, direct } as unknown as FlofiConversation;
}
describe('Copilot product presentation', () => {
  it('BUILD-FLOFI-BRIDGE-LIVE-FIX-003: is the FloFi Assistant (official symbol + title), with a product prompt and no internal guidance', () => {
    const html = renderToStaticMarkup(createElement(CopilotPanel, { conversation: conversation(false) }));
    expect(html).toMatch(/<h2 class="assistant-title"><span class="flofi-avatar flofi-avatar-title" aria-hidden="true">.*\/brand\/flofi-symbol-light\.svg.*<\/span><span>FloFi Assistant<\/span><\/h2>/);
    expect(html).toContain('aria-label="FloFi Assistant"');
    expect(html).not.toContain('ASSISTANT'); expect(html).not.toContain('<h2>Copilot</h2>');
    // P0 approved UX (board 04): the label stays for assistive technology, visually hidden.
    expect(html).toContain('<label for="mock-prompt" class="sr-only">Describe your flow</label>');
    expect(html).toContain('Review each proposed change before applying it.');
    // Exclude the legacy input id: it is not visible copy and stays compatible with integrations.
    const visibleCopy = html.replace(/<[^>]*>/g, '');
    expect(visibleCopy).not.toMatch(/GRYLOO|mock|demo|local command|no model|slippage 50 bps|ticks/i);
  });
  it('BUILD-FLOFI-CONVERSATIONAL-001 / BUILD-FLOFI-BRIDGE-LIVE-FIX-003: the workspace chat welcomes briefly: simulate, review, and execute with the wallet', () => {
    // The signing and risk disclosures live at the Review card and the wallet request (covered by the conversation-card and lifecycle suites).
    const html = renderToStaticMarkup(createElement(CopilotPanel, { conversation: conversation(true) }));
    expect(html).toContain('data-conversation-phase="AUTHORING"');
    expect(html).toContain('Then simulate, review, and execute with your wallet.');
    expect(html).not.toContain('Review each proposed change before applying it.');
  });
  it('offers suggested answers only on FloFi’s latest message, so an older button cannot answer a newer question', () => {
    const html = renderToStaticMarkup(createElement(CopilotPanel, { conversation: conversation(true, [
      { id: 1, role: 'flofi', language: 'EN', text: 'Swap added to your workflow: 1 USDC.', question: 'Would you like to add another action or review your workflow?', options: ['Add another action', 'Review workflow'] },
      { id: 2, role: 'you', text: 'Review workflow' },
      { id: 3, role: 'flofi', language: 'EN', text: 'Here is the review of your workflow.', question: 'Do you confirm this workflow?', options: ['Yes, I confirm', 'No'] },
    ]) }));
    expect(html).toContain('Yes, I confirm'); expect(html).toContain('Do you confirm this workflow?');
    expect(html).not.toContain('>Add another action</button>'); expect(html).not.toContain('>Review workflow</button>');
    expect(html.match(/class="copilot-options"/g)).toHaveLength(1);
  });
});

describe('BUILD-FLOFI-BRIDGE-LIVE-FIX-003 FloFi Assistant avatars and welcome', () => {
  const chat = (language: 'EN' | 'PT', mode: 'live' | 'replay' | 'unavailable') => ({ messages: [{ id: 0, role: 'system', text: FLOFI_WELCOME_COMMANDS },
    { id: 1, role: 'you', text: 'Swap 0.001 ETH to USDC on Base' }, { id: 2, role: 'flofi', text: 'Swap added to your workflow.', language }],
    input: '', setInput: () => undefined, send: () => undefined, busy: false, copilot: { mode, enabled: true, busy: false, mayInterpret: true },
    automation: null, dismissAutomation: () => undefined, phase: null, question: null, execution: null, direct: true }) as unknown as Parameters<typeof CopilotPanel>[0]['conversation'];
  it('shows the official FloFi symbol beside the assistant and a person beside the owner, keeping each role name for screen readers', () => {
    const html = renderToStaticMarkup(createElement(CopilotPanel, { conversation: chat('EN', 'live') }));
    expect(html.match(/class="chat-row chat-row-flofi"><span class="flofi-avatar flofi-avatar-message"/g)).toHaveLength(2);
    expect(html).toMatch(/class="chat-row chat-row-you"><div class="message you"><small class="sr-only">YOU<\/small><p>Swap 0.001 ETH to USDC on Base<\/p><\/div><span class="user-avatar" aria-hidden="true"><svg/);
    expect(html).toContain('<small class="sr-only">FLOFI</small>');
    expect(html).not.toMatch(/<img[^>]+src="(?!\/brand\/flofi-symbol-(?:light|dark)\.svg)/);
  });
  it('welcomes in one short paragraph (EN exact), and says so when no AI model reads the words', () => {
    expect(renderToStaticMarkup(createElement(CopilotPanel, { conversation: chat('EN', 'live') }))).toContain(`<p>${FLOFI_WELCOME}</p>`);
    expect(FLOFI_WELCOME).toBe('Hi FloFier! Describe an action in your own words, change a step, or ask about this workflow. Then simulate, review, and execute with your wallet.');
    expect(renderToStaticMarkup(createElement(CopilotPanel, { conversation: chat('EN', 'replay') }))).toContain('Replay mode: recorded answers, no AI model.');
    expect(renderToStaticMarkup(createElement(CopilotPanel, { conversation: chat('EN', 'unavailable') }))).toContain('as an exact command');
  });
  it('the PT-BR welcome is the exact approved copy', () => {
    expect(translate('PT', FLOFI_WELCOME)).toBe('Olá, FloFier! Descreva uma ação com suas palavras, altere uma etapa ou tire dúvidas sobre seu fluxo. Depois simule, revise e execute com sua carteira.');
    // P0 approved UX (board 16 §4, intentional change): the approved Brazilian Portuguese name.
    expect(translate('PT', 'FloFi Assistant')).toBe('Assistente FloFi');
  });
});

describe('P0 approved UX: the FloFi panel (board 04) and choosing the network in the chat (board 05)', () => {
  it('Send is an icon button inside the field, neutral until there is text, with the approved placeholder', () => {
    const empty = renderToStaticMarkup(createElement(CopilotPanel, { conversation: conversation(true) }));
    expect(empty).toMatch(/<div class="chat-input"><input id="mock-prompt"[^>]*placeholder="Ask or request a change"[^>]*\/><button type="submit" class="chat-send" aria-label="Send message" title="Send message" disabled=""><svg[^>]*aria-hidden="true"/);
    // Empty: disabled, so it never looks inert while being clickable.
    expect(empty).not.toContain('data-ready');
    expect(empty).not.toMatch(/>Send<\/button>/);
    const typed = renderToStaticMarkup(createElement(CopilotPanel, { conversation: { ...conversation(true), input: 'swap 1 usdc for eth' } as FlofiConversation }));
    expect(typed).toContain('class="chat-send" aria-label="Send message" title="Send message" data-ready="true"');
    const busy = renderToStaticMarkup(createElement(CopilotPanel, { conversation: { ...conversation(true), input: 'x', busy: true } as FlofiConversation }));
    expect(busy).toMatch(/class="chat-send" aria-label="Send message" title="Send message" aria-busy="true" disabled=""><span class="chat-send-spinner" aria-hidden="true">/);
  });

  const step = (n: number, kind: EditorStep['status']['kind'] = 'configured'): EditorStep => ({ nodeId: `n${n}`, step: n, action: 'Swap', flow: 'USDC → WETH',
    status: { kind, label: kind === 'configured' ? 'Configured' : kind === 'draft' ? 'Draft' : 'Needs attention', detail: 'detail' } });
  const plan = (steps: EditorStep[]): EditorOverview => ({ count: steps.length, steps, networks: ['Base'], state: 'configured',
    attention: steps.filter(item => item.status.kind === 'attention'), drafts: 0, invalid: false });
  it('shows no workflow summary for one step, and one collapsed "Plan · n steps" line for two or more, without repeating "Configured"', () => {
    const showStep = vi.fn();
    expect(renderToStaticMarkup(createElement(EditorOverviewPanel, { overview: plan([step(1)]), showStep }))).toBe('');
    expect(renderToStaticMarkup(createElement(EditorOverviewPanel, { overview: plan([]), showStep }))).toBe('');
    const html = renderToStaticMarkup(createElement(CopilotPanel, { conversation: conversation(true), overview: createElement(EditorOverviewPanel, { overview: plan([step(1), step(2)]), showStep }) }));
    expect(html).toMatch(/<button type="button" class="editor-overview-toggle" aria-expanded="false" aria-controls="([^"]+)"><span>Plan · 2 steps<\/span>[\s\S]*?<div id="\1" class="editor-overview-body" hidden="">/);
    expect(html).not.toMatch(/Workflow summary|Configured|editor-state-pill/);
    // Each step brings its own card into view (the expanded list), with its label only when something needs doing.
    expect(html).toContain('aria-label="Show step 1: Swap"');
    const attention = renderToStaticMarkup(createElement(EditorOverviewPanel, { overview: plan([step(1), step(2, 'attention')]), showStep }));
    expect(attention).toContain('aria-label="Show step 2: Swap (Needs attention)"');
    expect(attention).toMatch(/<span>Plan · 2 steps<\/span><span class="editor-card-status" data-card-status="attention">Needs attention<\/span>/);
    expect(showStep).not.toHaveBeenCalled();
  });

  const networkQuestion: ChatMessage = { id: 1, role: 'ai', text: 'Which network should Flofi use for the swap?', options: ['Base Sepolia', 'Base', 'Arbitrum One', 'Ethereum'] };
  it('lists the answers to a network question as 48 px network buttons (icon + name) instead of chips, each sending its own answer', () => {
    const send = vi.fn();
    const html = renderToStaticMarkup(createElement(CopilotPanel, { conversation: { ...conversation(true, [networkQuestion]), send } as FlofiConversation }));
    expect(html).toContain('<div class="conversation-network-choices" role="group" aria-label="Choose a network">');
    expect(html).not.toContain('class="copilot-options"');
    expect([...html.matchAll(/class="conversation-network-choice"[^>]*aria-label="([^"]+)"/g)].map(match => match[1])).toEqual(['Base Sepolia', 'Base', 'Arbitrum One', 'Ethereum']);
    expect(html.match(/<span class="conversation-network-icon" aria-hidden="true">/g)).toHaveLength(4);
    // Nothing is chosen or sent by showing the list, and no answer is marked as the wallet's without a connected wallet.
    expect(html).not.toMatch(/data-wallet|aria-pressed|Your wallet/);
    expect(send).not.toHaveBeenCalled();
    // Answers that are not networks keep the suggestion chips.
    expect(networkChoiceOptions(['Add another action', 'Review workflow'])).toBeNull();
    expect(networkChoiceOptions(['Base'])).toBeNull();
    expect(networkChoiceOptions(['Base (8453)', 'Arbitrum One'])).toEqual(['Base (8453)', 'Arbitrum One']);
  });

  it('lists the connected wallet’s network first, tagged "Your wallet", without selecting it', () => {
    const options = ['Arbitrum One', 'Ethereum', 'Base', 'Robinhood Chain'];
    expect(orderNetworkChoices(options, 'eip155:8453')).toEqual({ options: ['Base', 'Arbitrum One', 'Ethereum', 'Robinhood Chain'], wallet: 'Base' });
    expect(orderNetworkChoices(options, 'eip155:10')).toEqual({ options, wallet: null });
    expect(orderNetworkChoices(options, null)).toEqual({ options, wallet: null });
    const onPick = vi.fn();
    const html = renderToStaticMarkup(createElement(NetworkChoices, { options, walletChain: 'eip155:8453', onPick }));
    expect(html).toMatch(/<div class="conversation-network-choices" role="group" aria-label="Choose a network"><button type="button" class="conversation-network-choice" data-wallet="true" aria-label="Base" aria-describedby="([^"]+)">[\s\S]*?<span id="\1" class="conversation-network-wallet">Your wallet<\/span><\/button>/);
    expect(html.match(/data-wallet/g)).toHaveLength(1);
    expect(html).not.toMatch(/aria-pressed|aria-checked|aria-selected/);
    expect(onPick).not.toHaveBeenCalled();
    expect(translate('PT', 'Your wallet')).toBe('Sua carteira'); expect(translate('PT', 'Choose a network')).toBe('Escolha uma rede');
  });
});

// P0 hotfix (locale contract): FloFi's deterministic messages are rendered in both languages when written and shown in the CURRENT language, so
// switching language never leaves "Review workflow" or "Step 2 of 2" behind in a Portuguese chat (or Portuguese in an English one).
describe('chat messages follow the current interface language', () => {
  const both = (build: (c: ReturnType<typeof conversationCopy>) => { text: string; options?: string[]; question?: string }) =>
    ({ EN: build(conversationCopy('EN')), PT: build(conversationCopy('PT')) });
  const written: ChatMessage = { id: 1, role: 'flofi', language: 'EN', text: conversationCopy('EN').stepCompleted(2, 2, null),
    variants: both(c => ({ text: c.stepCompleted(2, 2, null), question: c.nextQuestion, options: [c.addAnother, c.review] })) };
  const page = (language: 'EN' | 'PT', messages: ChatMessage[]) => renderToStaticMarkup(createElement(LocaleProvider, { initialLanguage: language,
    children: createElement(CopilotPanel, { conversation: conversation(true, messages) }) }));
  it('a message written in English is shown in Portuguese after the switch, and back', () => {
    const pt = page('PT', [written]), en = page('EN', [written]);
    expect(pt).toContain(conversationCopy('PT').stepCompleted(2, 2, null)); expect(pt).toContain(conversationCopy('PT').review);
    for (const english of ['Review workflow', 'Step 2 of 2', conversationCopy('EN').nextQuestion]) expect(pt, english).not.toContain(english);
    expect(en).toContain('Step 2 of 2'); expect(en).toContain('Review workflow'); expect(en).not.toContain(conversationCopy('PT').review);
    expect(shownMessage(written, 'PT')).toMatchObject({ language: 'PT', text: conversationCopy('PT').stepCompleted(2, 2, null) });
  });
  it('a catalog system message carries its values as parameters, rendered in the current language', () => {
    const proposal: ChatMessage = { id: 2, role: 'system', text: 'Proposal: {0}. Review against revision {1} before applying.', params: ['swap 2 USDC to WETH', '3'] };
    expect(page('PT', [proposal])).toContain(translate('PT', 'Proposal: {0}. Review against revision {1} before applying.', 'swap 2 USDC to WETH', '3'));
    expect(page('EN', [proposal])).toContain('Proposal: swap 2 USDC to WETH. Review against revision 3 before applying.');
  });
  it('a message without renderings (model text) stays as written; the catalog translates what it knows', () => {
    const model: ChatMessage = { id: 3, role: 'ai', text: 'Simulate again', options: ['Base'] };
    expect(page('PT', [model])).toContain(translate('PT', 'Simulate again'));
    expect(shownMessage(model, 'PT')).toBe(model);
  });
});
