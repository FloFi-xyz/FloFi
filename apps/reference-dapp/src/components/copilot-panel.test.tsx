// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopilotPanel } from './copilot-panel';
import type { ChatMessage, FlofiConversation } from '../state/flofi-conversation';

// Presentation unit: the conversation itself is covered by the lifecycle and interpreter suites.
function conversation(direct: boolean, messages: ChatMessage[] = []): FlofiConversation {
  return { messages: [{ id: 0, role: 'system', text: direct ? 'Describe an action to add it to your workflow. Funds move only after you review, confirm and sign in your wallet.'
    : 'Review each proposed change before applying it.' }, ...messages], input: '', setInput: vi.fn(), send: vi.fn(), busy: false,
    copilot: { mode: 'off', enabled: false, busy: false, mayInterpret: false }, automation: null, dismissAutomation: vi.fn(), phase: direct ? 'AUTHORING' : null,
    question: null, execution: null, direct } as unknown as FlofiConversation;
}
describe('Copilot product presentation', () => {
  it('keeps Assistant and Copilot, with a product prompt and no internal guidance', () => {
    const html = renderToStaticMarkup(createElement(CopilotPanel, { conversation: conversation(false) }));
    expect(html).toContain('ASSISTANT');
    expect(html).toContain('<h2>Copilot</h2>');
    expect(html).toContain('>Describe your flow</label>');
    expect(html).toContain('Review each proposed change before applying it.');
    // Exclude the legacy input id: it is not visible copy and stays compatible with integrations.
    const visibleCopy = html.replace(/<[^>]*>/g, '');
    expect(visibleCopy).not.toMatch(/GRYLOO|mock|demo|local command|no model|slippage 50 bps|ticks/i);
  });
  it('BUILD-FLOFI-CONVERSATIONAL-001: the workspace chat states that funds move only after review, confirmation and a wallet signature', () => {
    const html = renderToStaticMarkup(createElement(CopilotPanel, { conversation: conversation(true) }));
    expect(html).toContain('data-conversation-phase="AUTHORING"');
    expect(html).toContain('Funds move only after you review, confirm and sign in your wallet.');
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
