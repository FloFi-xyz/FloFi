// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BETA-CRITICAL-RECOVERY-001: the four conversational beta incidents of 25-11-2026, reproduced through the real conversation engine,
 * editor and sequence runtime model with scripted model answers (MOCKED interpreter output; no model, wallet, provider or network is reached,
 * nothing is simulated, signed or executed). Each case failed on main at 52b87cf before this build.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { lintWorkflow } from '@defi-workflow-engine/reference-linter';
import { act, CopilotSession, intent } from '../copilot-session.test-harness';
import { OTHER_ADDRESS } from '../copilot-test-fixtures';
import { awaitingAmount } from '../copilot-conversation';
import { setActiveNetworkScope } from '../network-scope';
import { workflowSequence } from '../workflow-sequence';
import { registerFixtureCatalogs, resetNetworkCatalogs } from './intelligence.test-harness';

beforeAll(registerFixtureCatalogs);
afterAll(() => { resetNetworkCatalogs(); setActiveNetworkScope(null); });
beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));
const session = (language: 'PT' | 'EN' = 'PT') => { const s = new CopilotSession(); s.interfaceLanguage = language; s.walletChainId = 'eip155:8453'; return s; };
const sequenceOf = (s: CopilotSession) => workflowSequence(s.workflow, candidate => lintWorkflow(candidate, s.context))!;
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

describe('incident 1 · "Levar 1 USDC da Ethereum para a Base e emprestar na Aave."', () => {
  const bridge = act.bridge({ sourceNetwork: 'ETHEREUM', destinationNetwork: 'BASE', asset: 'USDC', amount: '1' });
  it.each([['the Supply names Base', act.lending('SUPPLY', { network: 'BASE', asset: 'USDC' })], ['the Supply names no network', act.lending('SUPPLY', { asset: 'USDC' })]])(
    'a composition whose Supply names no amount spends what the bridge delivers (%s), capped by the user\'s own 1 USDC', (_label, supply) => {
      const s = session();
      const reply = s.say('Levar 1 USDC da Ethereum para a Base e emprestar na Aave.', intent.composition([bridge, supply], 'PT'))!;
      // Before: "Para preparar este Aave Supply, o Flofi ainda precisa saber: o valor."
      expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SEQUENCE', steps: [{}, { type: 'ADD_SUPPLY', input: { network: 'Base', asset: 'USDC', amount: '1' } }] } });
      expect(reply.notes.join(' ')).toContain('O passo seguinte gasta o que o anterior realmente entregou');
      s.apply();
      const [first, second] = sequenceOf(s).steps;
      expect(first).toMatchObject({ fundedBy: null, input: { chainId: 'eip155:1', amount: '1000000' }, output: { chainId: 'eip155:8453', address: BASE_USDC } });
      expect(second).toMatchObject({ fundedBy: 0, input: { chainId: 'eip155:8453', address: BASE_USDC, amount: '1000000' } });
    });
  it('the goal reading of the same sentence keeps proposing the same two funded steps', () => {
    const reply = session().say('Levar 1 USDC da Ethereum para a Base e emprestar na Aave.',
      intent.goal({ network: 'ETHEREUM', asset: 'USDC', amount: '1' }, { network: 'BASE', asset: 'USDC', use: 'SUPPLY' }, {}, 'PT'))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SEQUENCE' } });
  });
});

describe('incident 2 · "Quero trocar Solana por USDC na Solana", then "0.001"', () => {
  it.each(['Solana', 'SOL', 'solana'])('the interpreter\'s %s is the coin SOL, and the follow-up amount is kept exactly', input => {
    const s = session();
    const asked = s.say('Quero trocar Solana por USDC na Solana', intent.action(act.swap({ network: 'SOLANA', inputAsset: input, outputAsset: 'USDC' }), 'PT'))!;
    expect(asked.kind).toBe('CLARIFICATION');
    // Answered locally (no model call): before, "Swaps na Solana aceitam SOL, USDC e USDT." or "O Flofi não encontrou o token SOL na sua mensagem."
    const proposed = s.say('0.001')!;
    expect(proposed).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SOLANA_SWAP', input: { network: 'Solana', from: 'SOL', to: 'USDC', amount: '0.001', slippage: '100' } } });
  });
  it('English works the same way, and "solana" as the network still names the network', () => {
    const s = session('EN');
    s.say('swap solana for USDC on Solana', intent.action(act.swap({ network: 'SOLANA', inputAsset: 'SOL', outputAsset: 'USDC' })));
    expect(s.say('0.25')).toMatchObject({ kind: 'PROPOSAL', command: { input: { from: 'SOL', to: 'USDC', amount: '0.25' } } });
  });
  it('a coin-position "solana" alone never names the Solana network (one word never grounds both)', () => {
    const asked = session().say('Quero trocar 1 solana por USDC', intent.action(act.swap({ network: 'SOLANA', inputAsset: 'SOL', outputAsset: 'USDC', amount: '1' }), 'PT'))!;
    expect(asked.kind).not.toBe('PROPOSAL');
  });
  it('USDC spelled "Solana" is never read as SOL: a token the user did not write is still asked about', () => {
    const asked = session().say('Quero trocar USDC por USDT na Solana', intent.action(act.swap({ network: 'SOLANA', inputAsset: 'SOL', outputAsset: 'USDT', amount: '1' }), 'PT'))!;
    expect(asked.kind).not.toBe('PROPOSAL');
  });
});

describe('incident 3 · "Converta todo o USDC que tenho em ETH."', () => {
  it('asks for the network first, then raises the structured amount question marked as ALL of the balance (never a guessed number)', () => {
    const s = session();
    // Before: "…ainda precisa saber: o valor, a rede." with no network options.
    expect(s.say('Converta todo o USDC que tenho em ETH.', intent.action(act.swap({ inputAsset: 'USDC', outputAsset: 'ETH' }), 'PT')))
      .toMatchObject({ kind: 'CLARIFICATION', options: expect.arrayContaining(['Base', 'Ethereum']) });
    expect(s.say('Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'ETH' }), 'PT'))).toMatchObject({ kind: 'CLARIFICATION' });
    expect(awaitingAmount(s.state)).toMatchObject({ field: 'amount', action: 'SWAP', asset: 'USDC', network: 'BASE', relative: { kind: 'ALL' } });
    expect(s.pending).toBeNull();
    // The balance shortcut answers with the amount it read; the proposal carries exactly that amount.
    expect(s.say('12.5')).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 12.5 USDC to ETH on Base slippage 100 bps' });
  });
  it('an absolute amount is never marked relative', () => {
    const s = session();
    s.say('Troque USDC por ETH na Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'ETH' }), 'PT'));
    expect(awaitingAmount(s.state)?.relative).toBeUndefined();
  });
});

describe('incident 4 · "Troque 1 USDC por ETH e depois troque o ETH recebido por USDC."', () => {
  const steps = (network: string | null) => [act.swap({ network, inputAsset: 'USDC', outputAsset: 'ETH', amount: '1' }), act.swap({ network: null, inputAsset: 'ETH', outputAsset: 'USDC' })];
  it('asks for the network (before: refused as an unsupported composition), then for the cap of the dependent swap, then funds it by the first', () => {
    const s = session();
    // Before: "O FloFi não conseguiu construir esta sequência com os dados verificados das ações."
    expect(s.say('Troque 1 USDC por ETH e depois troque o ETH recebido por USDC.', intent.composition(steps(null), 'PT')))
      .toMatchObject({ kind: 'CLARIFICATION', options: expect.arrayContaining(['Base']) });
    const cap = s.say('Base', intent.composition(steps('BASE'), 'PT'))!;
    expect(cap).toMatchObject({ kind: 'CLARIFICATION' });
    expect(cap.text).toContain('O passo 2 usa o ETH que o passo 1 entrega');
    expect(s.pending).toBeNull();
    const proposed = s.say('0.0004')!;
    expect(proposed).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SEQUENCE' } });
    expect(proposed.sentence).toBe('swap 1 USDC to ETH on Base slippage 100 bps then swap 0.0004 ETH to USDC on Base slippage 100 bps');
    s.apply();
    const [first, second] = sequenceOf(s).steps;
    expect(first).toMatchObject({ fundedBy: null, input: { amount: '1000000' }, output: { chainId: 'eip155:8453', address: null, decimals: 18 } });
    // The second swap spends only what the first actually delivers (reconciled), at most the user's own 0.0004 ETH: never the same funds twice.
    expect(second).toMatchObject({ fundedBy: 0, input: { chainId: 'eip155:8453', address: null, amount: '400000000000000' } });
  });
});

describe('specialist review: FloFi never claims funding the runtime does not give', () => {
  it('a bridge delivered to someone else does not fund the next step (chat review H1a): refused, never the wallet\'s own balance', () => {
    const s = session();
    const reply = s.say(`Levar 1 USDC da Ethereum para a Base para ${OTHER_ADDRESS} e emprestar na Aave.`, intent.composition([
      act.bridge({ sourceNetwork: 'ETHEREUM', destinationNetwork: 'BASE', asset: 'USDC', amount: '1', recipient: OTHER_ADDRESS }),
      act.lending('SUPPLY', { network: 'BASE', asset: 'USDC' })], 'PT'))!;
    expect(reply.kind).not.toBe('PROPOSAL');
    expect(s.pending).toBeNull();
  });
  it('native ETH delivered by a bridge never funds a WETH Supply by name (workflow review): the Supply\'s amount is asked, never copied', () => {
    const s = session();
    const reply = s.say('Levar 0.01 ETH da Ethereum para a Base e depositar WETH na Aave.', intent.composition([
      act.bridge({ sourceNetwork: 'ETHEREUM', destinationNetwork: 'BASE', asset: 'ETH', amount: '0.01' }), act.lending('SUPPLY', { network: 'BASE', asset: 'WETH' })], 'PT'))!;
    expect(reply.kind).not.toBe('PROPOSAL');
    expect(JSON.stringify(reply)).not.toContain('O passo seguinte gasta o que o anterior realmente entregou');
  });
  it('the cap of a dependent step must be written in that step\'s token (chat review M4)', () => {
    const s = session();
    s.say('Troque 1 USDC por ETH na Base e depois troque o ETH recebido por USDC.', intent.composition([
      act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'ETH', amount: '1' }), act.swap({ inputAsset: 'ETH', outputAsset: 'USDC' })], 'PT'));
    expect(s.say('0.0004 USDC')).toMatchObject({ kind: 'CLARIFICATION' });
    expect(s.pending).toBeNull();
    expect(s.say('0.0004 ETH')).toMatchObject({ kind: 'PROPOSAL' });
  });
  it('the newest turn\'s relative amount wins (chat review M2)', () => {
    const s = session();
    s.say('Troque metade do meu USDC por ETH', intent.action(act.swap({ inputAsset: 'USDC', outputAsset: 'ETH' }), 'PT'));
    s.say('não, todo o USDC', intent.action(act.swap({ inputAsset: 'USDC', outputAsset: 'ETH' }), 'PT'));
    s.say('Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'ETH' }), 'PT'));
    expect(awaitingAmount(s.state)?.relative).toEqual({ kind: 'ALL' });
  });
});
