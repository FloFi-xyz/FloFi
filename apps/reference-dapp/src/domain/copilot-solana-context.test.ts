// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { isBoundComposition } from '@defi-workflow-engine/action-registry';
import { readConcentratedLiquiditySource, type SemanticWorkflow } from '@defi-workflow-engine/workflow-contracts';
import { commandIsValid, parseLocalCommand, type Command } from './commands';
import { editorReducer, initialEditor, type EditorState } from './editor';
import { act, CopilotSession, intent } from './copilot-session.test-harness';
import { applyCommand, buildWorkflow, contextFor, FIXTURE } from './copilot-test-fixtures';
import type { CopilotVerified } from './copilot-conversation';
import { priceBoundsAround } from './pool-price-bounds';
import { poolPriceBounds } from '../components/pool-price-range';
import { fullOutputCap, solanaLiquidityDetails, type SolanaLiquidityInput } from './solana-liquidity-authoring';
import type { SolanaSwapInput } from './jupiter-authoring';

/**
 * PR B: context-aware Solana Devnet authoring in the Copilot. Every proposal still goes through the exact grammar and the editor, the owner applies
 * it, and every financial step is simulated, reviewed and signed separately; these tests run the real engine with a scripted model and no network.
 */
const MINT = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', OTHER_MINT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const verified = (extra: Partial<CopilotVerified> = {}): CopilotVerified => ({ orcaPrice: { price: '150', tickCurrentIndex: -18_880 }, solanaOwner: 'Owner1111111111111111111111111111111111111',
  orcaPositions: [], remaining: [], ...extra });
const position = (positionMint = MINT, status = 'ACTIVE') => ({ positionMint, status, tickLower: -19_200, tickUpper: -18_560, liquidity: '1000000000' });
const swap: SolanaSwapInput = { network: 'Solana Devnet', from: 'SOL', to: 'devUSDC', amount: '0.1', slippage: '100' };
const tenPercent = { rangeUnit: 'PERCENT', lower: null, upper: '10' };
/** The Canvas path: add the swap, add the position, connect them (canvas-connect); each step through the same reducer. */
function canvas(liquidity: SolanaLiquidityInput, from: EditorState = initialEditor()): EditorState {
  const context = contextFor(from.workflow);
  const step = (state: EditorState, command: Record<string, unknown>) => {
    const next = editorReducer(state, { ...command, source: 'CANVAS', baseRevision: state.workflow.revision } as Command, context);
    expect(next.error).toBeNull();
    return next;
  };
  const swapped = step(from, { type: 'ADD_SOLANA_SWAP', input: swap });
  const pooled = step(swapped, { type: 'ADD_SOLANA_LIQUIDITY', input: liquidity });
  return step(pooled, { type: 'CONNECT', from: swapped.workflow.nodes.at(-1)!.nodeId, to: pooled.workflow.nodes.at(-1)!.nodeId });
}
const structure = (workflow: EditorState['workflow']) => JSON.stringify({ revision: workflow.revision, nodes: workflow.nodes, resourceEdges: workflow.resourceEdges });

describe('token aliases and the devUSDC network', () => {
  it('reads devUSDC in any case and infers Solana Devnet from it, with a note and never a mainnet', () => {
    const session = new CopilotSession();
    const upper = session.say('please swap 0.1 sol into DEVUSDC on solana devnet', intent.action(act.swap({ network: 'SOLANA_DEVNET', inputAsset: 'sol', outputAsset: 'DEVUSDC', amount: '0.1' })))!;
    expect(upper).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 0.1 SOL to devUSDC on Solana Devnet slippage 100 bps', command: { type: 'ADD_SOLANA_SWAP' } });
    session.dismiss();
    const implied = session.say('swap 0.2 sol for devusdc', intent.action(act.swap({ inputAsset: 'sol', outputAsset: 'devusdc', amount: '0.2' })))!;
    expect(implied).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 0.2 SOL to devUSDC on Solana Devnet slippage 100 bps' });
    expect(implied.notes).toContain('devUSDC exists only on Solana Devnet (test tokens), so Flofi used Solana Devnet.');
    // Without a test token, an unnamed network is still asked for.
    expect(session.say('swap 0.2 SOL for USDC', intent.action(act.swap({ inputAsset: 'SOL', outputAsset: 'USDC', amount: '0.2' })))).toMatchObject({ kind: 'CLARIFICATION' });
  });
});

describe('Swap → Orca liquidity funded by the swap output', () => {
  it('authors the swap and the linked position in one proposal whose IR equals the Canvas add-and-connect path', () => {
    const session = new CopilotSession();
    session.verified = verified();
    const reply = session.say('Swap 0.1 SOL to devUSDC on Solana Devnet and add liquidity with these tokens and at most 0.05 SOL in a 10% range',
      intent.composition([act.swap({ network: 'SOLANA_DEVNET', inputAsset: 'SOL', outputAsset: 'DEVUSDC', amount: '0.1' }),
        act.liquidity({ deposits: [{ asset: 'SOL', maxAmount: '0.05' }], ...tenPercent, funding: 'SWAP_OUTPUT' })]))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SOLANA_COMPOSITION', from: null, swap } });
    expect(reply.sentence).toBe('swap 0.1 SOL to devUSDC on Solana Devnet slippage 100 bps then add liquidity all swapped devUSDC and 0.05 SOL from 135 to 165 devUSDC per SOL slippage 100 bps');
    expect(reply.notes).toEqual(expect.arrayContaining(['Range ±10% around the current verified pool price (150 devUSDC per SOL): 135–165 devUSDC per SOL, aligned outward to usable ticks.',
      'The position uses 100% of the swap’s actual reconciled devUSDC output, never other devUSDC already in your wallet.']));
    expect(session.workflow.revision).toBe(0);
    session.apply();
    // Canvas parity: the same percentage bounds as the Canvas range control, then the same add-and-connect reducers.
    const bounds = poolPriceBounds({ price: '150' }, 10);
    expect(bounds).toEqual(priceBoundsAround('150', -10, 10));
    const expected = canvas({ network: 'Solana Devnet', maxSol: '0.05', maxDevUsdc: fullOutputCap(1), ...bounds, slippage: '100' });
    expect(structure(session.workflow)).toBe(structure(expected.workflow));
    expect(isBoundComposition(session.workflow as unknown as SemanticWorkflow)).toBe(true);
  });
  it('asks for the other token’s maximum and takes a bare amount without a model call', () => {
    const session = new CopilotSession();
    session.verified = verified();
    const asked = session.say('swap 0.1 SOL to devUSDC on Solana Devnet then put these tokens in a 10% range position', intent.composition([
      act.swap({ network: 'SOLANA_DEVNET', inputAsset: 'SOL', outputAsset: 'DEVUSDC', amount: '0.1' }), act.liquidity({ ...tenPercent, funding: 'SWAP_OUTPUT' })]))!;
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', text: 'How much SOL at most should the position use together with the swapped devUSDC?' });
    const proposed = session.say('0.05')!;
    expect(session.turns.at(-1)!.request).toBeNull();
    expect(proposed).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SOLANA_COMPOSITION', liquidity: { maxSol: '0.05', maxDevUsdc: fullOutputCap(1) } } });
  });
  it('links "these tokens" to the swap step the user just applied, keeping the swap untouched', () => {
    const session = new CopilotSession([FIXTURE.devnetSwap]);
    const reply = session.say('add liquidity with these tokens and at most 0.5 SOL, ticks -1024 to 1024', intent.action(act.liquidity({ deposits: [{ asset: 'SOL', maxAmount: '0.5' }],
      rangeUnit: 'TICK', lower: '-1024', upper: '1024', funding: 'SWAP_OUTPUT' })))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'add liquidity all devUSDC from node-002 and 0.5 SOL ticks -1024 to 1024 on Solana Devnet slippage 100 bps',
      command: { type: 'ADD_SOLANA_COMPOSITION', swap: null, from: 'node-002' } });
    const before = session.workflow.nodes.find(node => node.nodeId === 'node-002');
    session.apply();
    const pool = session.workflow.nodes.at(-1)!;
    expect(readConcentratedLiquiditySource(pool as never).source).toMatchObject({ nodeId: 'node-002', token: 1 });
    expect(session.workflow.nodes.find(node => node.nodeId === 'node-002')).toEqual(before);
    // A second "these tokens" request finds no swap left to fund a position.
    expect(session.say('add liquidity with these tokens and 0.5 SOL ticks -1024 to 1024', intent.action(act.liquidity({ deposits: [{ asset: 'SOL', maxAmount: '0.5' }],
      rangeUnit: 'TICK', lower: '-1024', upper: '1024', funding: 'SWAP_OUTPUT' })))).toMatchObject({ kind: 'UNSUPPORTED', text: 'That swap already funds a position. Unlink it first, or describe a new swap.' });
  });
  it('turns a visible swap proposal plus "these tokens" into one composed proposal', () => {
    const session = new CopilotSession();
    session.verified = verified();
    session.say('swap 0.1 SOL to devUSDC on Solana Devnet slippage 50 bps');
    expect(session.pending?.command.type).toBe('ADD_SOLANA_SWAP');
    const reply = session.say('and add liquidity with these tokens plus 0.05 SOL in a 10% range', intent.action(act.liquidity({ deposits: [{ asset: 'SOL', maxAmount: '0.05' }],
      ...tenPercent, funding: 'SWAP_OUTPUT' })))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SOLANA_COMPOSITION', swap, from: null } });
  });
  it('explains instead of guessing: no swap, no verified price, another pool', () => {
    const session = new CopilotSession();
    const liquidity = act.liquidity({ deposits: [{ asset: 'SOL', maxAmount: '0.05' }], ...tenPercent, funding: 'SWAP_OUTPUT' });
    expect(session.say('add liquidity with these tokens and 0.05 SOL in a 10% range', intent.action(liquidity)))
      .toMatchObject({ kind: 'UNSUPPORTED', text: 'Flofi cannot tell which tokens you mean: there is no Solana Devnet swap in this workflow or proposal. Describe the swap too.' });
    const priced = session.say('swap 0.1 SOL to devUSDC on Solana Devnet and add liquidity with these tokens and 0.05 SOL in a 10% range', intent.composition([
      act.swap({ network: 'SOLANA_DEVNET', inputAsset: 'SOL', outputAsset: 'DEVUSDC', amount: '0.1' }), liquidity]))!;
    expect(priced.kind).toBe('FAILED');
    expect(priced.text).toContain('could not verify the current pool price');
    expect(session.say('swap 3 USDC to WETH on Base Sepolia and add these tokens to Uniswap', intent.composition([
      act.swap({ network: 'BASE_SEPOLIA', inputAsset: 'USDC', outputAsset: 'WETH', amount: '3' }), act.liquidity({ protocol: 'UNISWAP_V3', funding: 'SWAP_OUTPUT' })])))
      .toMatchObject({ kind: 'UNSUPPORTED', text: 'Flofi can fund a position with a swap’s output only from a Solana Devnet SOL ⇄ devUSDC swap into the Orca SOL/devUSDC pool.' });
    expect(session.pending).toBeNull();
  });
});

describe('"same tokens" and "remaining tokens"', () => {
  it('carries the pool from the swap’s pair, but never the amounts', () => {
    const session = new CopilotSession([FIXTURE.devnetSwap]);
    session.verified = verified();
    const reply = session.say('add 0.05 and 5 of the same tokens to a pool in a 10% range', intent.action(act.liquidity({ deposits: [{ asset: 'SOL', maxAmount: '0.05' },
      { asset: 'DEVUSDC', maxAmount: '5' }], ...tenPercent }), 'EN', { from: { step: 'SWAP', ordinal: null }, fields: ['asset'] }))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'add liquidity 0.05 SOL and 5 devUSDC from 135 to 165 devUSDC per SOL on Solana Devnet slippage 100 bps',
      command: { type: 'ADD_SOLANA_LIQUIDITY' } });
    // An amount the user did not write is never carried.
    session.dismiss();
    expect(session.say('add the same tokens to a pool in a 10% range', intent.action(act.liquidity({ deposits: [{ asset: 'SOL', maxAmount: '1' }, { asset: 'DEVUSDC', maxAmount: '5' }],
      ...tenPercent }), 'EN', { from: { step: 'SWAP', ordinal: null }, fields: ['asset'] }))).toMatchObject({ kind: 'CLARIFICATION' });
  });
  it('uses only what a reconciled execution left over, and asks when there is none', () => {
    const session = new CopilotSession();
    session.verified = verified();
    const action = act.liquidity({ deposits: [{ asset: 'SOL', maxAmount: '0.05' }], ...tenPercent, funding: 'REMAINING' });
    expect(session.say('add the remaining tokens and 0.05 SOL to Orca in a 10% range', intent.action(action)))
      .toMatchObject({ kind: 'CLARIFICATION', text: 'Flofi uses “remaining tokens” only from a reconciled execution, and none is available. How much of each token should the position use at most?' });
    session.state = { ...session.state, draft: null, segment: [], clarifications: 0 };
    session.verified = verified({ remaining: [{ token: 'devUSDC', amount: '4.5' }] });
    const reply = session.say('add the remaining tokens and 0.05 SOL to Orca in a 10% range', intent.action(action))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_SOLANA_LIQUIDITY', input: { maxSol: '0.05', maxDevUsdc: '4.5' } } });
    expect(reply.notes).toContain('Remaining devUSDC: 4.5, from a reconciled execution.');
  });
});

describe('"yes" and "no"', () => {
  it('never applies, signs or guesses from a bare yes or no', () => {
    const session = new CopilotSession();
    expect(session.say('yes')).toMatchObject({ kind: 'ANSWER', text: 'There is no open question. Describe what you want to do.' });
    session.say(FIXTURE.devnetSwap);
    const pending = session.pending;
    expect(session.say('Yes!')).toMatchObject({ kind: 'ANSWER', text: 'To use the proposal, choose Apply below it. Flofi never applies or signs anything from chat.' });
    expect(session.say('ok')).toMatchObject({ kind: 'ANSWER', text: 'To use the proposal, choose Apply below it. Flofi never applies or signs anything from chat.' });
    expect(session.say('no')).toMatchObject({ kind: 'ANSWER', text: 'OK. Nothing changed. Choose Dismiss to discard the proposal.' });
    expect(session.pending).toBe(pending);
    expect(session.workflow.revision).toBe(0);
    expect(session.turns.every(turn => turn.request === null)).toBe(true);
  });
  it('takes yes as the single offered answer, asks which one among several, and drops the request on no', () => {
    const session = new CopilotSession();
    // Aave on Base Sepolia offers one asset: "yes" is that button.
    expect(session.say('supply 5 on Aave Base Sepolia', intent.action(act.lending('SUPPLY', { network: 'BASE_SEPOLIA', amount: '5' })))).toMatchObject({ kind: 'CLARIFICATION', options: ['USDC'] });
    expect(session.say('yes')).toMatchObject({ kind: 'PROPOSAL', sentence: expect.stringMatching(/^supply 5 USDC to Aave on Base Sepolia/) });
    session.dismiss();
    const asked = session.say('Quero colocar 5 USDC na Aave.', intent.action(act.lending('SUPPLY', { asset: 'USDC', amount: '5' }), 'PT'))!;
    expect(asked.options.length).toBeGreaterThan(1);
    expect(session.say('sim')).toMatchObject({ kind: 'CLARIFICATION', text: 'Qual delas? Escolha uma das opções.', options: asked.options });
    expect(session.say('não')).toMatchObject({ kind: 'ANSWER', text: 'Certo, o Flofi descartou esse pedido. Nada mudou.' });
    expect(session.state.draft).toBeNull();
    expect(session.pending).toBeNull();
    expect(session.turns.filter(turn => ['yes', 'sim', 'não'].includes(turn.text)).every(turn => turn.request === null)).toBe(true);
  });
});

describe('managing a FloFi position from chat', () => {
  it('needs a connected Solana Devnet wallet and only manages positions FloFi opened', () => {
    const session = new CopilotSession();
    expect(session.say('remove 50% of my liquidity', intent.position('DECREASE', '50'))).toMatchObject({ kind: 'UNSUPPORTED',
      text: 'Connect a Solana Devnet wallet first (Simulate stage) so Flofi can find your positions. Nothing changed.' });
    session.verified = verified();
    expect(session.say('remove 50% of my liquidity', intent.position('DECREASE', '50'))).toMatchObject({ kind: 'UNSUPPORTED',
      text: 'Flofi found no active position it opened for this wallet on the Orca SOL/devUSDC pool. Nothing changed.' });
    expect(session.say('remove 50% of my Uniswap liquidity', intent.position('DECREASE', '50', 'EN', { protocol: 'UNISWAP_V3' }))).toMatchObject({ kind: 'UNSUPPORTED',
      text: 'Flofi manages only positions it opened on the Orca SOL/devUSDC pool on Solana Devnet.' });
  });
  it('prepares a partial removal of the verified position as the workflow’s only step', () => {
    const session = new CopilotSession();
    session.verified = verified({ orcaPositions: [position(), position(OTHER_MINT, 'CLOSED')] });
    const reply = session.say('remove 50% of my liquidity', intent.position('DECREASE', '50'))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'remove 50% of the liquidity of the Flofi Orca position on Solana Devnet',
      command: { type: 'MANAGE_SOLANA_POSITION', positionMint: MINT, operation: 'DECREASE_PARTIAL', partBps: 5000, input: { rangeUnit: 'TICK', lower: '-19200', upper: '-18560' } } });
    expect(reply.text).toContain('Remove 50% of the liquidity of your Flofi position 7xKX…gAsU');
    session.apply();
    const steps = session.workflow.nodes.filter(node => !node.actionType.startsWith('mock-'));
    expect(steps).toHaveLength(1);
    expect(solanaLiquidityDetails(steps[0]!)).toMatchObject({ tickLower: -19_200, tickUpper: -18_560, source: null });
  });
  it('exits from a composed workflow: the swap step is removed and the position step is unlinked', () => {
    let state = initialEditor();
    state = canvas({ network: 'Solana Devnet', maxSol: '0.05', maxDevUsdc: fullOutputCap(1), rangeUnit: 'TICK', lower: '-19200', upper: '-18560', slippage: '100' }, state);
    const session = new CopilotSession(state.workflow);
    session.verified = verified({ orcaPositions: [position()] });
    const reply = session.say('close my position', intent.position('EXIT'))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'MANAGE_SOLANA_POSITION', operation: 'EXIT', partBps: null } });
    expect(reply.notes).not.toContain('The position step’s maxima only limit adding liquidity; a removal never deposits.');
    session.apply();
    expect(session.workflow.nodes.filter(node => !node.actionType.startsWith('mock-')).map(node => node.nodeId)).toEqual(['node-003']);
    expect(session.workflow.resourceEdges).toEqual([]);
  });
  it('asks which position and how much with buttons, then proposes without a model call', () => {
    const session = new CopilotSession();
    session.verified = verified({ orcaPositions: [position(), position(OTHER_MINT)] });
    const which = session.say('remove some of my liquidity', intent.position('DECREASE'))!;
    expect(which).toMatchObject({ kind: 'CLARIFICATION', text: 'Which position do you mean?',
      options: ['Position 7xKX…gAsU · ticks -19200 to -18560', 'Position 9WzD…AWWM · ticks -19200 to -18560'] });
    const portion = session.say('Position 9WzD…AWWM · ticks -19200 to -18560')!;
    expect(portion).toMatchObject({ kind: 'CLARIFICATION', text: 'How much of the position should Flofi remove?', options: ['25%', '50%', '75%', 'All (exit)'] });
    expect(session.say('All (exit)')).toMatchObject({ kind: 'PROPOSAL', command: { positionMint: OTHER_MINT, operation: 'EXIT' } });
    expect(session.turns.slice(1).every(turn => turn.request === null)).toBe(true);
  });
  it('reads "half", never an unwritten percentage, and refuses a workflow with other steps', () => {
    const session = new CopilotSession();
    session.verified = verified({ orcaPositions: [position()] });
    expect(session.say('withdraw half of my position', intent.position('DECREASE', '50'))).toMatchObject({ kind: 'PROPOSAL', command: { partBps: 5000 } });
    session.dismiss();
    expect(session.say('remove some liquidity', intent.position('DECREASE', '30'))).toMatchObject({ kind: 'CLARIFICATION', text: 'How much of the position should Flofi remove?' });
    const busy = new CopilotSession([FIXTURE.testnetSwap]);
    busy.verified = verified({ orcaPositions: [position()] });
    expect(busy.say('exit my position', intent.position('EXIT'))).toMatchObject({ kind: 'UNSUPPORTED', text: expect.stringContaining('This workflow has other steps.') });
  });
});

describe('exact grammar and commands', () => {
  const workflow = buildWorkflow([FIXTURE.devnetSwap]), context = contextFor(workflow);
  it('parses both composition sentences and checks the swapped token', () => {
    expect(parseLocalCommand('swap 0.1 SOL to devUSDC on Solana Devnet slippage 50 bps then add liquidity 5 swapped devUSDC and 0.05 SOL ticks -1024 to 1024 slippage 100 bps',
      workflow, context)).toMatchObject({ type: 'ADD_SOLANA_COMPOSITION', swap, from: null, liquidity: { maxSol: '0.05', maxDevUsdc: '5' } });
    expect(parseLocalCommand('add liquidity all devUSDC from node-002 and 0.5 SOL ticks -1024 to 1024 on Solana Devnet slippage 100 bps', workflow, context))
      .toMatchObject({ type: 'ADD_SOLANA_COMPOSITION', swap: null, from: 'node-002', liquidity: { maxDevUsdc: fullOutputCap(1) } });
    expect(() => parseLocalCommand('add liquidity all SOL from node-002 and 5 devUSDC ticks -1024 to 1024 on Solana Devnet slippage 100 bps', workflow, context))
      .toThrow('COMPOSITION_TOKEN_MISMATCH');
    expect(() => parseLocalCommand('swap 0.1 SOL to devUSDC on Solana Devnet slippage 50 bps then add liquidity all swapped SOL and 5 devUSDC ticks -1024 to 1024 slippage 100 bps',
      workflow, context)).toThrow('COMPOSITION_TOKEN_MISMATCH');
  });
  it('validates the position command strictly', () => {
    const input: SolanaLiquidityInput = { network: 'Solana Devnet', maxSol: '0.05', maxDevUsdc: '5', rangeUnit: 'TICK', lower: '-1024', upper: '1024', slippage: '100' };
    const base = { type: 'MANAGE_SOLANA_POSITION', input, positionMint: MINT, source: 'CHAT', baseRevision: 0 };
    expect(commandIsValid({ ...base, operation: 'DECREASE_PARTIAL', partBps: 5000 })).toBe(true);
    expect(commandIsValid({ ...base, operation: 'EXIT', partBps: null })).toBe(true);
    for (const bad of [{ operation: 'DECREASE_PARTIAL', partBps: 10_000 }, { operation: 'DECREASE_PARTIAL', partBps: null }, { operation: 'EXIT', partBps: 5000 },
      { operation: 'OPEN', partBps: null }]) expect(commandIsValid({ ...base, ...bad })).toBe(false);
    expect(commandIsValid({ ...base, operation: 'EXIT', partBps: null, positionMint: '0xabc' })).toBe(false);
    // A workflow with another network's step is never rewritten into a position step.
    const other = buildWorkflow([FIXTURE.testnetSwap]);
    expect(editorReducer({ workflow: other, error: null }, { ...base, operation: 'EXIT', partBps: null, baseRevision: other.revision } as Command, contextFor(other)).error)
      .toBe('POSITION_WORKFLOW_HAS_OTHER_STEPS');
    expect(applyCommand(workflow, { ...base, operation: 'EXIT', partBps: null, baseRevision: workflow.revision } as Command).nodes.some(node => node.nodeId === 'node-002')).toBe(false);
  });
});

describe('Solana wallet context and explicit remaining-token caps', () => {
  it('discards a position answer when the connected Solana wallet changes during interpretation', () => {
    const session = new CopilotSession();
    session.verified = verified({ orcaPositions: [position()] });
    const reply = session.say('remove 50% of my liquidity', intent.position('DECREASE', '50'), s => {
      s.verified = verified({ solanaOwner: OTHER_MINT, orcaPositions: [position(OTHER_MINT)] });
    });
    expect(reply).toMatchObject({ kind: 'FAILED', text: expect.stringContaining('wallet or its network changed') });
    expect(session.pending).toBeNull();
  });
  it('invalidates a position-selection clarification after switching Solana wallets', () => {
    const session = new CopilotSession();
    session.verified = verified({ orcaPositions: [position(), position(OTHER_MINT)] });
    const asked = session.say('close my position', intent.position('EXIT'))!;
    session.verified = verified({ solanaOwner: OTHER_MINT, orcaPositions: [position(OTHER_MINT)] });
    expect(session.say(asked.options[1]!)).toMatchObject({ kind: 'FAILED' });
    expect(session.pending).toBeNull();
  });
  it.each([['2', '2'], ['10', '4.5']])('keeps the lesser of explicit cap %s and reconciled output', (cap, expected) => {
    const session = new CopilotSession();
    session.verified = verified({ remaining: [{ token: 'devUSDC', amount: '4.5' }] });
    expect(session.say(`add the remaining tokens, at most ${cap} devUSDC and 0.05 SOL, in a 10% range`, intent.action(act.liquidity({
      deposits: [{ asset: 'DEVUSDC', maxAmount: cap }, { asset: 'SOL', maxAmount: '0.05' }], ...tenPercent, funding: 'REMAINING'
    })))).toMatchObject({ kind: 'PROPOSAL', command: { input: { maxDevUsdc: expected } } });
  });
  it.each(['devUSDC', 'DEVUSDC', 'DevUSDC', 'devusdc', 'testUSDC', 'TESTUSDC'])('normalizes %s without allowing it on mainnet', asset => {
    const session = new CopilotSession();
    expect(session.say(`please swap 0.1 SOL for ${asset} on Solana Devnet`, intent.action(act.swap({
      network: 'SOLANA_DEVNET', inputAsset: 'SOL', outputAsset: asset, amount: '0.1'
    })))).toMatchObject({ kind: 'PROPOSAL', command: { input: { network: 'Solana Devnet', to: 'devUSDC' } } });
    session.dismiss();
    expect(session.say(`please swap 0.1 SOL for ${asset} on Solana`, intent.action(act.swap({
      network: 'SOLANA', inputAsset: 'SOL', outputAsset: asset, amount: '0.1'
    })))?.kind).not.toBe('PROPOSAL');
  });
});

it.each(['dev USDC', 'test USDC'])('grounds the %s wording as the Devnet asset without defaulting to mainnet', wording => {
  const session = new CopilotSession();
  expect(session.say(`please swap 0.1 SOL for ${wording}`, intent.action(act.swap({ inputAsset: 'SOL', outputAsset: 'DEVUSDC', amount: '0.1' }))))
    .toMatchObject({ kind: 'PROPOSAL', command: { input: { network: 'Solana Devnet', to: 'devUSDC' } } });
});

it('does not invent a full exit when the model supplies EXIT for an unspecified removal', () => {
  const session = new CopilotSession();
  session.verified = verified({ orcaPositions: [position()] });
  expect(session.say('remove some of my liquidity', intent.position('EXIT'))).toMatchObject({ kind: 'CLARIFICATION', text: 'How much of the position should Flofi remove?' });
  expect(session.pending).toBeNull();
  expect(session.say('All (exit)')).toMatchObject({ kind: 'PROPOSAL', command: { operation: 'EXIT' } });
});
