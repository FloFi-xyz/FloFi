// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-CROSSCHAIN-UNIVERSAL-001: the universal bridge through every channel. The Copilot plans a natural request into the exact chat grammar,
 * that sentence parses to the same command, and the shared platform (MCP, Telegram, WhatsApp through `canonicalStrategy`) composes it back to
 * the same canonical IR and workflow hash; the Canvas Bridge card authors the same node (scenario O). Values come only from the user's words,
 * real funds are never inferred, and nothing here quotes, signs or executes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseLocalCommand, type Command } from './commands';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { canonicalStrategy } from '../channels/core/strategy';
import { composeStrategy, composeWorkflow } from '../engine/strategy-engine';
import { workflowPlan } from '../mcp/execution';
import { planNamespace, planNamespaces } from '../platform/approvals';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { TEST_WALLET } from './copilot-test-fixtures';
import { baseCatalog } from '../server/base-mainnet.test-harness';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';
import { editorReducer } from './editor';
import { parseUniversalChat, universalCanvasInput, universalChatSentence } from './universal-bridge-authoring';

const SOL_WALLET = 'GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq';
beforeAll(() => { registerNetworkCatalog(baseCatalog()); registerNetworkCatalog(officialCatalog()); });
afterAll(() => resetNetworkCatalogs());

const nodeOf = (session: CopilotSession, command: Command) => editorReducer({ workflow: session.workflow, error: null }, command, session.context).workflow.nodes.at(-1);
/** Copilot ≡ Chat (the canonical sentence) ≡ MCP (`compose_strategy`) ≡ Telegram/WhatsApp (`canonicalStrategy`): the same command, IR and hash. */
function expectParity(session: CopilotSession, command: Command, sentence: string, mcp: Record<string, unknown>) {
  expect(parseLocalCommand(sentence, session.workflow, session.context, TEST_WALLET)).toEqual(command);
  const channel = canonicalStrategy(command);
  expect(channel, sentence).toMatchObject({ ok: true });
  const composed = composeStrategy(mcp);
  expect(composed.ok, sentence).toBe(true);
  if (!channel.ok || !composed.ok) return;
  expect(channel.workflowHash).toBe(composed.workflowHash);
  expect(JSON.stringify(nodeOf(session, channel.command))).toBe(JSON.stringify(nodeOf(session, command)));
  return channel;
}

describe('BUILD-CROSSCHAIN-UNIVERSAL-001 Copilot and channel parity', () => {
  it('O: "move 25 USDC from Solana to Base" is the same universal bridge in Copilot, Chat, MCP, Telegram and the Canvas card', () => {
    const s = new CopilotSession();
    const reply = s.say('Can you move 25 USDC from Solana over to Base?', intent.action(act.bridge({ sourceNetwork: 'SOLANA', destinationNetwork: 'BASE', asset: 'USDC', amount: '25' })))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 25 USDC from Solana to Base receive USDC via best slippage 50 bps', command: { type: 'ADD_UNIVERSAL_BRIDGE' } });
    expect(reply.notes.join(' ')).toMatch(/You receive USDC on Base.*the EVM wallet you connect in the Flofi app.*Solana → Base uses real funds\. Flofi charges no fee/s);
    const channel = expectParity(s, reply.command!, reply.sentence!, { action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'base', asset: 'USDC', amount: '25' });
    expect(channel).toMatchObject({ fundsClass: 'REAL_FUNDS', intendedWallet: null });
    // The Canvas Bridge card (Solana → Base, 25) applies the same command, hence the same node.
    const canvas = { type: 'ADD_UNIVERSAL_BRIDGE', input: universalCanvasInput({ source: 'solana', destination: 'base' }, '25'), source: 'CHAT', baseRevision: s.workflow.revision } as Command;
    expect(JSON.stringify(nodeOf(s, canvas))).toBe(JSON.stringify(nodeOf(s, reply.command!)));
  });
  it('PT: "levar 10 USDC da Base para a Solana e receber SOL" names the destination asset; the Solana wallet is bound at Review', () => {
    const s = new CopilotSession();
    const reply = s.say('Quero levar 10 USDC da Base para a Solana e receber SOL', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'USDC', amount: '10' }), 'PT'))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 10 USDC from Base to Solana receive SOL via best slippage 50 bps' });
    expect(reply.notes.join(' ')).toMatch(/Destinatário: a carteira Solana que você conectar no app Flofi/);
    expectParity(s, reply.command!, reply.sentence!, { action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'solana', asset: 'USDC', outputAsset: 'SOL', amount: '10' });
  });
  it('a Solana recipient written in the message, native ETH → SOL, and an EVM recipient refused for a Solana destination', () => {
    const s = new CopilotSession();
    const reply = s.say(`Please send 0.2 ETH from Arbitrum over to Solana for ${SOL_WALLET}, receiving SOL`, intent.action(act.bridge({ sourceNetwork: 'ARBITRUM',
      destinationNetwork: 'SOLANA', asset: 'ETH', amount: '0.2' })))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: `bridge 0.2 ETH from Arbitrum One to Solana receive SOL to ${SOL_WALLET} via best slippage 50 bps` });
    expectParity(s, reply.command!, reply.sentence!, { action: 'bridge', sourceNetwork: 'arbitrum-one', destinationNetwork: 'solana', asset: 'ETH', outputAsset: 'SOL', amount: '0.2', recipient: SOL_WALLET });
    const wrong = new CopilotSession().say('Please send 1 USDC from Base over to Solana for 0x3333333333333333333333333333333333333333', intent.action(act.bridge({
      sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'USDC', amount: '1', recipient: '0x3333333333333333333333333333333333333333' })))!;
    expect(wrong).toMatchObject({ kind: 'UNSUPPORTED' });
    expect(wrong.text).toContain('must be a Solana address');
  });
  it('a named provider (Relay) or another asset on a certified pair is a universal bridge; the certified pair itself is unchanged', () => {
    const relay = new CopilotSession().say('Please send 5 USDC from Base over to Arbitrum using Relay', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', amount: '5' })))!;
    expect(relay).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 5 USDC from Base to Arbitrum One receive USDC via relay slippage 50 bps', command: { type: 'ADD_UNIVERSAL_BRIDGE' } });
    const certified = new CopilotSession().say('Please send 5 USDC from Base over to Arbitrum', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', amount: '5' })))!;
    expect(certified).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_ROUTER_BRIDGE' } });
  });
  it('asks for what is missing, never infers real funds, and refuses unknown assets', () => {
    const missing = new CopilotSession().say('move 5 USDC to Solana', intent.action(act.bridge({ destinationNetwork: 'SOLANA', asset: 'USDC', amount: '5' })))!;
    expect(missing).toMatchObject({ kind: 'CLARIFICATION' });
    expect(missing.options).toEqual(['Base', 'Arbitrum One', 'Ethereum', 'Robinhood Chain']);
    const test = new CopilotSession().say('move 5 test USDC from Solana over to Base', intent.action(act.bridge({ sourceNetwork: 'SOLANA', destinationNetwork: 'BASE', asset: 'USDC', amount: '5' })))!;
    expect(test).toMatchObject({ kind: 'CLARIFICATION' });
    const unknown = new CopilotSession().say('move 5 FOO from Solana over to Base', intent.action(act.bridge({ sourceNetwork: 'SOLANA', destinationNetwork: 'BASE', asset: 'FOO', amount: '5' })))!;
    expect(unknown).toMatchObject({ kind: 'UNSUPPORTED' });
    expect(unknown.text).toContain('FOO is not an asset Flofi knows on Solana');
  });
});

describe('BUILD-CROSSCHAIN-UNIVERSAL-001 exact chat grammar', () => {
  it('parses and prints the universal sentence; certified Router sentences keep their own command', () => {
    const input = parseUniversalChat('bridge 1.5 SOL from Solana to Ethereum receive ETH via relay slippage 75 bps')!;
    expect(input).toEqual({ source: 'solana', destination: 'ethereum', inputAsset: 'SOL', outputAsset: 'ETH', amount: '1.5', recipient: '', slippage: '75', routing: 'RELAY' });
    expect(universalChatSentence(input)).toBe('bridge 1.5 SOL from Solana to Ethereum receive ETH via relay slippage 75 bps');
    expect(parseUniversalChat('bridge 2 usdc from Solana to Robinhood Chain')).toMatchObject({ inputAsset: 'USDC', outputAsset: 'USDG', routing: 'BEST', slippage: '50' });
    const s = new CopilotSession();
    expect(parseLocalCommand('bridge 10 USDC from Base to Arbitrum via auto slippage 50 bps', s.workflow, s.context, TEST_WALLET).type).toBe('ADD_ROUTER_BRIDGE');
    expect(parseLocalCommand('bridge 10 WETH from Base to Arbitrum', s.workflow, s.context, TEST_WALLET).type).toBe('ADD_UNIVERSAL_BRIDGE');
    expect(parseUniversalChat('bridge 1 USDC from Solana Devnet to Base')).toBeNull();
    expect(parseUniversalChat('bridge 1 USDC from Base to Base')).toBeNull();
    expect(() => parseUniversalChat('bridge 1 USDC from Base to Solana to 0x3333333333333333333333333333333333333333')).toThrow('UNIVERSAL_RECIPIENT_INVALID');
  });
  it('a channel never authors a Mayan-pinned bridge (quotes only), and a bridge from Solana names no claiming wallet', () => {
    const input = parseUniversalChat('bridge 1 USDC from Solana to Base via Mayan')!;
    expect(canonicalStrategy({ type: 'ADD_UNIVERSAL_BRIDGE', input, source: 'CHAT', baseRevision: 0 } as Command)).toEqual({ ok: false, code: 'CHANNEL_COMMAND_NOT_AUTHORING' });
  });
});

describe('BUILD-CROSSCHAIN-UNIVERSAL-001 approval handoff', () => {
  it('a bridge is claimed by the wallet of its source network and executes on the universal flow', () => {
    const plan = (spec: Record<string, unknown>) => { const w = composeWorkflow(spec); if (!w.ok) throw new Error(w.code); return workflowPlan(w); };
    const fromSolana = plan({ action: 'bridge', sourceNetwork: 'solana', destinationNetwork: 'base', asset: 'USDC', amount: '25' });
    expect(fromSolana).toMatchObject({ kind: 'SINGLE_FLOW', flow: 'crosschain-universal', fundsClass: 'REAL_FUNDS' });
    expect(planNamespace(fromSolana)).toBe('solana');
    expect(planNamespaces(fromSolana)).toEqual(['eip155', 'solana']);
    expect(planNamespace(plan({ action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'solana', asset: 'USDC', amount: '25' }))).toBe('eip155');
    expect(planNamespace(plan({ action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USDC', amount: '25' }))).toBe('eip155');
  });
});
