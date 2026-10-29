// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopilotPanel } from './copilot-panel';
import { FLOFI_WELCOME, FLOFI_WELCOME_COMMANDS } from '../domain/assistant-welcome';
import { translate } from '../i18n/locale';
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
    expect(html).toContain('>Describe your flow</label>');
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
    expect(translate('PT', FLOFI_WELCOME)).toBe('Olá, FloFier! Descreva uma ação com suas palavras, altere uma etapa ou tire dúvidas sobre seu workflow. Depois simule, revise e execute com sua carteira.');
    expect(translate('PT', 'FloFi Assistant')).toBe('FloFi Assistant');
  });
});
