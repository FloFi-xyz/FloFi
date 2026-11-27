// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 (KAN-20, WS02 surfaces 9.2 item 2): a Solana Batch Payment from FloFi Chat / the Copilot. Several Solana
 * sends of one asset, each paired in the person's own words with its exact base58 recipient, are ONE Batch Payment (never separate transfers); the
 * recipients are kept exactly as written (letter case is part of the key); a placeholder ("wallet A") is never turned into an address; anything the
 * interpretation did not pair exactly is asked about, never chosen. The same request composes to the same workflow hash in the Editor (the card), the
 * chat, MCP and Telegram. A scripted interpreter only: no network, no wallet, nothing signed.
 */
import { describe, expect, it } from 'vitest';
import { canonicalStrategy } from '../channels/core/strategy';
import { editorWorkflowStrategy } from '../editor/workflow-strategy';
import { composeWorkflow } from '../engine/strategy-engine';
import { batchPaymentDetails } from './batch-payment-authoring';
import type { Command } from './commands';
import { act, CopilotSession, intent } from './copilot-session.test-harness';

// Seed-derived Ed25519 wallet keys (on the curve; never paid). A_CASE is another, also on-curve, spelling of A: a different wallet.
const A = '2CERLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb', B = 'C4o8DvwfiPWCQPPH4AfDLBtG7vbCixVKYdwj1S4pDrty', C = '8WcnkMD1aZFGDppfnerV37Fob9W1ij3yHkCL3LWgVKiG';
const A_CASE = '2CErLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb';
const sol = (amount: string, recipient: string | null, asset = 'SOL') => act.transfer({ network: 'SOLANA', asset, amount, recipient });
const OWNER_EXAMPLE = `Send 0.01 SOL to ${A}, 0.02 SOL to ${B} and 0.03 SOL to ${C}`;
const STRATEGY = { action: 'batch_payment', network: 'solana', asset: 'SOL',
  recipients: [{ recipient: A, amount: '0.01' }, { recipient: B, amount: '0.02' }, { recipient: C, amount: '0.03' }] };

/** The Editor's card, the chat's command, MCP's strategy and Telegram's channel strategy of one request: one workflow hash for all of them. */
function hashes(command: Command) {
  const session = new CopilotSession([]);
  session.propose(command); session.apply();
  const editor = editorWorkflowStrategy(session.workflow), mcp = composeWorkflow(STRATEGY), telegram = canonicalStrategy(command);
  if (!editor.ok || !mcp.ok || !telegram.ok) throw new Error('NOT_COMPOSED');
  const node = session.workflow.nodes.find(n => n.actionType === 'asset.transfer.batch')!;
  return { editor: editor.workflowHash, mcp: mcp.workflowHash, telegram: telegram.workflowHash, details: batchPaymentDetails(node as Parameters<typeof batchPaymentDetails>[0])! };
}

describe('KAN-20: a Solana Batch Payment from the chat', () => {
  it('the owner\'s acceptance example is ONE Batch Payment card: three recipients verbatim, total 0.06 SOL, one hash on every surface', () => {
    // The exact grammar authors it with no interpretation at all.
    const exact = new CopilotSession([]);
    expect(exact.say(OWNER_EXAMPLE)).toBeNull();
    const command = exact.pending!.command as Extract<Command, { type: 'ADD_BATCH_PAYMENT' }>;
    expect(command).toEqual({ type: 'ADD_BATCH_PAYMENT', source: 'CHAT', baseRevision: 0,
      input: { network: 'Solana', asset: 'SOL', payments: [{ recipient: A, amount: '0.01' }, { recipient: B, amount: '0.02' }, { recipient: C, amount: '0.03' }] } });
    const same = hashes(command);
    expect(same.editor).toBe(same.mcp);
    expect(same.telegram).toBe(same.mcp);
    expect(same.details).toMatchObject({ network: 'Solana', asset: 'SOL', total: '0.06', payments: [{ recipient: A }, { recipient: B }, { recipient: C }] });
    // The Copilot reads the same request (worded so the exact grammar does not take it) as the same ONE Batch Payment.
    const session = new CopilotSession([]);
    const reply = session.say(`Please send 0.01 SOL to ${A}, 0.02 SOL to ${B} and 0.03 SOL to ${C} on Solana, thanks`,
      intent.composition([sol('0.01', A), sol('0.02', B), sol('0.03', C)]))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_BATCH_PAYMENT', input: command.input } });
    expect(reply.text).toContain(`One Batch Payment on Solana to 3 recipients: 1. 0.01 SOL → ${A} 2. 0.02 SOL → ${B} 3. 0.03 SOL → ${C} It runs only as one atomic authorization of your wallet`);
    expect(hashes(session.pending!.command).mcp).toBe(same.mcp);
    // In Portuguese too.
    const pt = new CopilotSession([]);
    expect(pt.say(`Por favor, envie 0.01 SOL para ${A}, 0.02 SOL para ${B} e 0.03 SOL para ${C} na Solana`,
      intent.composition([sol('0.01', A), sol('0.02', B), sol('0.03', C)], 'PT'))).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_BATCH_PAYMENT', input: command.input } });
  });

  it('placeholders ("wallet A") are never an address: FloFi asks, and nothing is proposed, even when the interpretation invents addresses', () => {
    const text = 'Send 0.01 SOL to wallet A, 0.02 SOL to wallet B and 0.03 SOL to wallet C';
    // An interpretation with no recipient, or with addresses the person never wrote: FloFi asks a question.
    for (const model of [intent.composition([sol('0.01', null), sol('0.02', null), sol('0.03', null)]),
      intent.composition([sol('0.01', A), sol('0.02', B), sol('0.03', C)])]) {
      const session = new CopilotSession([]);
      const reply = session.say(text, model)!;
      expect(reply.kind, JSON.stringify(model)).toBe('CLARIFICATION');
      expect(reply.command, JSON.stringify(model)).toBeUndefined();
      expect(session.pending, JSON.stringify(model)).toBeNull();
      expect(reply.text, JSON.stringify(model)).not.toContain(A);
    }
    // With the network named, the question is the recipient itself (as for an EVM send).
    const named = new CopilotSession([]);
    expect(named.say(`${text} on Solana`, intent.composition([sol('0.01', null), sol('0.02', null), sol('0.03', null)])))
      .toMatchObject({ kind: 'CLARIFICATION', text: 'Which wallet should I send it to?' });
    expect(named.pending).toBeNull();
    // An interpretation that carries the placeholder itself as a recipient is not a valid answer: it is discarded, nothing is proposed.
    const literal = new CopilotSession([]);
    const discarded = literal.say(text, intent.composition([sol('0.01', 'wallet A'), sol('0.02', 'wallet B'), sol('0.03', 'wallet C')]))!;
    expect(discarded).toMatchObject({ kind: 'FAILED', code: 'COPILOT_INTENT_INVALID' });
    expect(discarded.command).toBeUndefined();
    expect(literal.pending).toBeNull();
  });

  it('letter case is part of the key: A and its case variant are two recipients, never merged into one', () => {
    const session = new CopilotSession([]);
    const reply = session.say(`Please send 1 SOL to ${A} and 2 SOL to ${A_CASE} on Solana`, intent.composition([sol('1', A), sol('2', A_CASE)]))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_BATCH_PAYMENT',
      input: { network: 'Solana', payments: [{ recipient: A, amount: '1' }, { recipient: A_CASE, amount: '2' }] } } });
    // An interpretation that folds the two spellings into one wallet does not pair the person's payments: FloFi lists both and asks.
    const merged = new CopilotSession([]);
    const asked = merged.say(`Please send 1 SOL to ${A} and 2 SOL to ${A_CASE} on Solana`, intent.composition([sol('1', A), sol('2', A)]))!;
    expect(asked.kind).toBe('CLARIFICATION'); expect(merged.pending).toBeNull();
    expect(asked.text).toContain(`Your message pairs: 1. 1 SOL → ${A}; 2. 2 SOL → ${A_CASE}.`);
    expect(asked.text).toContain('for example “send 0.01 SOL to <Solana address> and 0.02 SOL to <Solana address>”');
    // An exact repeat is refused, never merged.
    const twice = new CopilotSession([]);
    const refused = twice.say(`Please send 1 SOL to ${A} and 2 SOL to ${A} on Solana`, intent.composition([sol('1', A), sol('2', A)]))!;
    expect(refused.kind).toBe('UNSUPPORTED'); expect(twice.pending).toBeNull();
    expect(refused.text).toBe(`${A} appears more than once. A Batch Payment pays each recipient once and FloFi never merges or drops a payment: say the one amount for that recipient.`);
  });

  it('a Solana address outside every "<amount> <asset> to <address>" clause is never left out silently', () => {
    const session = new CopilotSession([]);
    const reply = session.say(`Please send 1 SOL to ${A}, ${B} and 2 SOL to ${C} on Solana`, intent.composition([sol('1', A), sol('2', C)]))!;
    expect(reply.kind).toBe('CLARIFICATION'); expect(reply.command).toBeUndefined(); expect(session.pending).toBeNull();
  });

  it('one send read from a message that pairs three payments would drop two recipients: FloFi lists what it read and asks (in EN and PT)', () => {
    const session = new CopilotSession([]);
    const reply = session.say(`Please send 0.01 SOL to ${A}, 0.02 SOL to ${B} and 0.03 SOL to ${C} on Solana`, intent.action(sol('0.01', A)))!;
    expect(reply.kind).toBe('CLARIFICATION'); expect(session.pending).toBeNull();
    expect(reply.text).toContain(`Your message pairs: 1. 0.01 SOL → ${A}; 2. 0.02 SOL → ${B}; 3. 0.03 SOL → ${C}. The interpretation read: 1. 0.01 SOL → ${A}.`);
    expect(reply.text).toContain('for example “send 0.01 SOL to <Solana address> and 0.02 SOL to <Solana address>”');
    const pt = new CopilotSession([]);
    const perguntou = pt.say(`Por favor, envie 0.01 SOL para ${A} e 0.02 SOL para ${B} na Solana`, intent.action(sol('0.01', A), 'PT'))!;
    expect(perguntou.kind).toBe('CLARIFICATION'); expect(pt.pending).toBeNull();
    expect(perguntou.text).toContain('por exemplo “envie 0.01 SOL para <endereço Solana> e 0.02 SOL para <endereço Solana>”');
  });

  it('EVM pay lists keep their own example and lower-case-insensitive pairing (unchanged)', () => {
    const X = '0x2222222222222222222222222222222222222222', Y = '0x3333333333333333333333333333333333333333';
    const session = new CopilotSession([]);
    const asked = session.say(`Send 1 USDC to ${X} and 1000 USDC to ${Y} on Base`,
      intent.composition([act.transfer({ network: 'BASE', asset: 'USDC', amount: '1000', recipient: X }), act.transfer({ network: 'BASE', asset: 'USDC', amount: '1', recipient: Y })]))!;
    expect(asked.kind).toBe('CLARIFICATION');
    expect(asked.text).toContain('for example “send 25 USDC to 0x… and 50 USDC to 0x… on Base”');
  });
});
