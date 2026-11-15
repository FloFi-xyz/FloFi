// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIFIED-COPILOT-001: Telegram and WhatsApp share the web's conversational intelligence — DeFi explanations and their follow-ups,
 * resuming an open request, platform guidance and automation behaviour — through the same engine, with every turn persisted as JSON. A chat never
 * creates or changes an automation or saves a recipient: it says so and links to the FloFi page (a relative path delivery resolves on its origin).
 */
import { describe, expect, it } from 'vitest';
import { act, intent } from '../../domain/copilot-session.test-harness';
import type { CopilotRequestV2 } from '../../domain/copilot-conversation';
import { decideTurn, freshState, parseState, type ChannelInterpreter, type ChannelState, type TurnDecision } from './conversation.ts';
import { outputSafe, pageLink, sealReply, workspaceLink } from './delivery.ts';

function chat(script: Record<string, unknown>[] = [], surface: 'TELEGRAM' | 'WHATSAPP' = 'TELEGRAM') {
  const requests: CopilotRequestV2[] = [];
  const interpret: ChannelInterpreter = async request => { requests.push(request); const next = script.shift(); if (!next) throw new Error('unexpected model call'); return { ok: true, intent: next as never }; };
  let state: ChannelState = { ...freshState('PT'), greeted: true };
  const say = async (text: string): Promise<TurnDecision> => {
    const decided = await decideTurn({ content: { kind: 'TEXT', text }, state, optedOut: false, interpret, support: 'support@flofi.test', privacy: 'https://flofi.test/privacy', surface });
    state = parseState(JSON.stringify(decided.state), 'PT');
    return decided;
  };
  return { say, requests, get state() { return state; } };
}

describe('channel conversations share the Copilot\'s education, continuity and guidance', () => {
  it('explains a concept with follow-up choices, then more simply, locally (no model call), across JSON persistence', async () => {
    const c = chat();
    const first = await c.say('O que é colateral?');
    expect(first).toMatchObject({ action: 'REPLY', outcome: 'COPILOT_ANSWER' });
    expect(first.replies[0]!.text).toMatch(/^Colateral é o que você deposita/);
    expect(first.replies[0]!.choices.map(choice => choice.label)).toEqual(['Explica mais simples', 'Me dá um exemplo', 'Como funciona na Aave?', 'Mais detalhes']);
    expect((await c.say('Não entendi')).replies[0]!.text).toMatch(/^Colateral é um depósito que garante um empréstimo/);
    expect((await c.say('Como funciona na Aave?')).replies[0]!.text).toMatch(/^Na Aave V3/);
    expect(c.requests).toHaveLength(0);
  });
  it('keeps an open request across an explanation and resumes it on "vamos continuar"', async () => {
    const c = chat([intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'WETH' }), 'PT')]);
    const asked = await c.say('quero trocar USDC por WETH na Base');
    expect(asked.outcome).toBe('COPILOT_CLARIFICATION');
    const explained = await c.say('o que é slippage?');
    expect(explained.replies[0]!.text).toMatch(/^Slippage é a diferença/);
    expect(explained.replies[0]!.text).toMatch(/Seu pedido continua aberto/);
    const resumed = await c.say('ok, vamos continuar');
    expect(resumed).toMatchObject({ outcome: 'COPILOT_CLARIFICATION' });
    expect(resumed.replies[0]!.text).toMatch(/^Vamos continuar\./);
    expect((await c.say('2')).action).toBe('PROPOSE');
    expect(c.requests).toHaveLength(1);
  });
  it('answers configuration questions with a relative FloFi page that delivery resolves on its own origin, and never applies a change', async () => {
    const c = chat([], 'WHATSAPP');
    const reply = (await c.say('Como vejo as transações anteriores?')).replies[0]!;
    expect(reply.link).toEqual({ label: 'Seus fluxos', url: '/app/workflows' });
    expect(pageLink('/app/workflows')).toBe(true);
    expect(pageLink('https://evil.example/app/workflows')).toBe(false);
    expect(workspaceLink('https://flofi.xyz/app/credentials', 'https://flofi.xyz')).toBe(true);
    expect(workspaceLink('https://flofi.xyz/app/settings', 'https://flofi.xyz')).toBe(false);
    expect(outputSafe({ ...reply, link: { label: reply.link!.label, url: 'https://flofi.xyz/app/workflows' } }, 'https://flofi.xyz')).toBe(true);
    expect(outputSafe({ ...reply, link: { label: 'x', url: 'https://flofi.xyz/approve' } }, 'https://flofi.xyz')).toBe(false);
    expect(sealReply).toBeTypeOf('function');
  });
  it('hands automation creation and management to the FloFi app with an honest message, never a dead-end button', async () => {
    const draft = { kind: 'SCHEDULED_DCA', asset: 'ETH', side: 'BUY', network: 'BASE', amount: '20', spendAsset: 'USDC', time: '10:00', condition: null, threshold: null, percent: null };
    const c = chat([{ version: '2', language: 'PT', kind: 'AUTOMATION', draft }, { version: '2', language: 'PT', kind: 'AUTOMATION_MANAGE', operation: 'LIST' }]);
    const proposed = (await c.say('Compra 20 USDC de ETH toda sexta às 10h na Base')).replies[0]!;
    expect(proposed.text).toMatch(/^Para criar esta automação, abra Automações no app FloFi/);
    expect(proposed.link).toEqual({ label: 'Automações', url: '/app/automations' });
    expect((await c.say('E se o preço cair?')).replies[0]!.text).toMatch(/^Uma compra recorrente propõe a compra/);
    const listed = (await c.say('quais automações eu tenho?')).replies[0]!;
    expect(listed.text).toMatch(/Nada é alterado por este chat/);
    expect(listed.link).toEqual({ label: 'Automações', url: '/app/automations' });
  });
  it('never holds account data: a persisted save offer is dropped and a tampered concept is discarded', async () => {
    const c = chat();
    await c.say('O que é colateral?');
    const tampered = { ...c.state, copilot: { ...(c.state.copilot as object), concept: { id: 'EVIL', level: 'STANDARD', protocol: null },
      recipientOffer: { address: '0x1111111111111111111111111111111111111111', ecosystem: 'EVM', suggestion: null, naming: true } } };
    const d = await decideTurn({ content: { kind: 'TEXT', text: 'Não entendi' }, state: tampered as ChannelState, optedOut: false,
      interpret: async () => ({ ok: false, code: 'COPILOT_UNAVAILABLE' }), support: 's', privacy: 'p', surface: 'TELEGRAM' });
    // The tampered concept never answered the follow-up: the turn went to the interpreter instead.
    expect(d.outcome).toBe('COPILOT_FAILED');
    expect(JSON.stringify(d.state.copilot)).not.toMatch(/EVIL|recipientOffer":\{/);
  });
});
