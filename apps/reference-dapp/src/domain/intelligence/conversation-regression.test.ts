// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001 certification: the mandatory conversation regressions (cases 1–13 and goal-to-workflow acceptance) through the real
 * conversation engine, exact grammar, editor and catalogs, with scripted model answers and the committed official token-list fixtures. Engineering
 * evidence only: no model, provider, wallet or network is reached, and nothing is simulated, signed or executed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CopilotSession, act, intent } from '../copilot-session.test-harness';
import { TEST_WALLET } from '../copilot-test-fixtures';
import { editorReducer } from '../editor';
import { setActiveNetworkScope } from '../network-scope';
import { workflowSequence } from '../workflow-sequence';
import { lintWorkflow } from '@defi-workflow-engine/reference-linter';
import type { Command } from '../commands';
import { registerFixtureCatalogs, resetNetworkCatalogs } from './intelligence.test-harness';

beforeAll(registerFixtureCatalogs);
afterAll(() => { resetNetworkCatalogs(); setActiveNetworkScope(null); });
beforeEach(() => setActiveNetworkScope('PUBLIC_MAINNET'));
const mainnet = () => { const s = new CopilotSession(); s.walletChainId = 'eip155:8453'; return s; };
const nodeOf = (s: CopilotSession, command: Command) => editorReducer({ workflow: s.workflow, error: null }, command, s.context).workflow.nodes.at(-1)!;
const assetOut = (s: CopilotSession, command: Command) => nodeOf(s, command).inputs.find(input => input.name === 'asset-out')?.value;
/** No clarification in the session ever asked again for a field FloFi had already asked about in the same request. */
const noRepeats = (s: CopilotSession) => expect(s.state.ledger?.repeats ?? 0).toBe(0);

describe('cases 1–3: casing and decimals never change meaning', () => {
  it('1–2: lowercase, uppercase and mixed case resolve to the same catalog identities, by the exact grammar and by the engine', () => {
    const exact = mainnet();
    expect(exact.say('swap 1 usdc to eth on base')).toBeNull();
    const reference = exact.pending!.command;
    for (const [written, input, output] of [['Please swap 1 usdc to eth on base for me', 'usdc', 'eth'], ['Please Swap 1 UsDc to eTh on Base for me', 'UsDc', 'eTh'],
      ['PLEASE SWAP 1 USDC TO ETH ON BASE FOR ME', 'USDC', 'ETH']] as const) {
      const s = mainnet();
      const reply = s.say(written, intent.action(act.swap({ network: 'BASE', inputAsset: input, outputAsset: output, amount: '1' })))!;
      expect(reply, written).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 1 USDC to ETH on Base slippage 100 bps' });
      expect(JSON.stringify(reply.command)).toBe(JSON.stringify(reference));
    }
  });
  it('cbBTC in any case is the one catalog asset cbBTC', () => {
    const sentences = (['cbbtc', 'CBBTC', 'cbBTC'] as const).map(written => {
      const s = mainnet();
      return s.say(`Please swap 1 ${written} to USDC on Base for me`, intent.action(act.swap({ network: 'BASE', inputAsset: written, outputAsset: 'USDC', amount: '1' })))!.sentence;
    });
    expect(new Set(sentences)).toEqual(new Set(['swap 1 cbBTC to USDC on Base slippage 100 bps']));
  });
  it('3: "quero trocar 0,0001 usdc por eth na base" keeps the exact amount, assets and network', () => {
    const reply = mainnet().say('quero trocar 0,0001 usdc por eth na base', intent.action(act.swap({ network: 'BASE', inputAsset: 'usdc', outputAsset: 'eth', amount: '0.0001' }), 'PT'))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 0.0001 USDC to ETH on Base slippage 100 bps' });
    expect(reply.text).toMatch(/^Interpretado como/);
  });
  it('a model amount that is a different reading than the decimal the user wrote is never accepted', () => {
    const reply = mainnet().say('quero trocar 0,005 usdc por eth na base', intent.action(act.swap({ network: 'BASE', inputAsset: 'usdc', outputAsset: 'eth', amount: '5' }), 'PT'))!;
    expect(reply.kind).toBe('CLARIFICATION');
    expect(reply.command).toBeUndefined();
  });
  it('an ambiguous grouping ("1,000") is asked, then the bare answer settles it locally', () => {
    const s = mainnet();
    const asked = s.say('Please swap 1,000 usdc to eth on base for me', intent.action(act.swap({ network: 'BASE', inputAsset: 'usdc', outputAsset: 'eth', amount: '1000' })))!;
    expect(asked).toMatchObject({ kind: 'CLARIFICATION', options: ['1', '1000'] });
    expect(s.say('1000')).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 1000 USDC to ETH on Base slippage 100 bps' });
    expect(s.turns.at(-1)!.request).toBeNull();
  });
});

describe('cases 4–5: corrections keep every settled value', () => {
  it('4: "actually make it 2" changes only the amount', () => {
    const s = mainnet();
    expect(s.say('swap 1 usdc to eth on base')).toBeNull();
    const reply = s.say('actually make it 2', intent.edit({ amount: '2' }))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 2 USDC to ETH on Base slippage 100 bps' });
    expect(reply.notes.join(' ')).toMatch(/Kept from the pending proposal: network, token, slippage/);
  });
  it('5: bridge corrections — amount, destination asset, "keep the same source" — never re-ask a settled field', () => {
    const s = mainnet();
    expect(s.say('bridge 1 USDC from Base to Arbitrum')).toBeNull();
    expect(s.say('make it 2', intent.edit({ amount: '2' }))).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 2 USDC from Base to Arbitrum via auto slippage 100 bps' });
    // The committed Arbitrum One catalog fixture lists no USDT: FloFi says so from the catalog and keeps the pending 2 USDC bridge.
    const usdt = s.say('actually I want USDT on the destination', intent.edit({ outputAsset: 'USDT' }))!;
    expect(usdt).toMatchObject({ kind: 'UNSUPPORTED', code: 'ASSET_UNKNOWN' });
    expect(usdt.text).toContain('USDT is not in the official Arbitrum One catalog');
    expect(s.pending!.command).toMatchObject({ type: 'ADD_ROUTER_BRIDGE', input: { amount: '2', source: 'Base', destination: 'Arbitrum' } });
    // "Keep the same source" restates Base: carried, so no "which source network?" question.
    const kept = s.say('keep the same source', intent.edit({ network: 'BASE' }))!;
    expect(kept.kind).toBe('PROPOSAL');
    expect(kept.sentence).toBe('bridge 2 USDC from Base to Arbitrum via auto slippage 100 bps');
    noRepeats(s);
  });
  it('5 (catalog that lists the asset): the destination asset correction becomes a universal bridge receiving it, amount and networks kept', () => {
    const s = mainnet();
    expect(s.say('bridge 1 USDC from Arbitrum to Base')).toBeNull(); // the exact grammar: a certified route
    expect(s.pending!.command).toMatchObject({ type: 'ADD_ROUTER_BRIDGE' });
    expect(s.say('make it 2', intent.edit({ amount: '2' }))).toMatchObject({ kind: 'PROPOSAL' });
    const usdt = s.say('actually I want USDT on the destination', intent.edit({ outputAsset: 'USDT' }))!;
    expect(usdt).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 2 USDC from Arbitrum One to Base receive USDT via best slippage 100 bps', command: { type: 'ADD_UNIVERSAL_BRIDGE' } });
    // Restating the source re-proposes exactly the same canonical step (FloFi re-authors the carried assets by their catalog identity).
    const kept = s.say('keep the same source', intent.edit({ network: 'ARBITRUM' }))!;
    expect(kept.kind).toBe('PROPOSAL');
    expect(JSON.stringify(nodeOf(s, kept.command!))).toBe(JSON.stringify(nodeOf(s, usdt.command!)));
    noRepeats(s);
  });
});

describe('cases 6–7: asset identity is never substituted', () => {
  it('6: "usd" is a currency: FloFi offers the network\'s own USD stablecoins and authors only what the user picks', () => {
    const s = mainnet();
    const asked = s.say('swap 1 usd to eth on base', intent.action(act.swap({ network: 'BASE', inputAsset: 'usd', outputAsset: 'eth', amount: '1' })))!;
    expect(asked.kind).toBe('CLARIFICATION');
    expect(asked.text).toContain('is a currency (USD), not a token on Base');
    expect(asked.options).toEqual(['USDC', 'USDT', 'USDbC']);
    expect(asked.command).toBeUndefined();
    expect(s.say('USDT')).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 1 USDT to ETH on Base slippage 100 bps' });
  });
  it('6 (PT): "dólares" is asked the same way, in Portuguese', () => {
    // The model contract carries ASCII references only: the interpreter writes "dolares"; FloFi matches it to the user's "dólares".
    const reply = mainnet().say('quero trocar 5 dólares por eth na base', intent.action(act.swap({ network: 'BASE', inputAsset: 'dolares', outputAsset: 'eth', amount: '5' }), 'PT'))!;
    expect(reply).toMatchObject({ kind: 'CLARIFICATION', options: ['USDC', 'USDT', 'USDbC'] });
    expect(reply.text).toContain('é uma moeda (USD)');
  });
  it('7: "I want ETH, not WETH" makes the pending swap pay native ETH; WETH stays the ERC-20', () => {
    const s = mainnet();
    expect(s.say('please swap 1 usdc to weth on base', intent.action(act.swap({ network: 'BASE', inputAsset: 'usdc', outputAsset: 'weth', amount: '1' }))))
      .toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 1 USDC to WETH on Base slippage 100 bps' });
    const weth = s.pending!.command;
    const reply = s.say('I want ETH, not WETH', intent.edit({ outputAsset: 'ETH' }))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 1 USDC to ETH on Base slippage 100 bps' });
    expect(reply.notes.join(' ')).toMatch(/native ETH itself \(not WETH\)/);
    expect(assetOut(s, reply.command!)).toEqual({ chainId: 'eip155:8453', nativeId: 'ETH', decimals: 18 });
    expect(assetOut(s, weth)).toEqual({ chainId: 'eip155:8453', address: '0x4200000000000000000000000000000000000006', decimals: 18 });
  });
});

describe('cases 8–11: grounded answers, failures and the mainnet boundary', () => {
  it('8: "what can I do on Arbitrum?" is answered from the Capability API, with registered functionality kept apart from deployment', () => {
    const reply = mainnet().say('what can I do on Arbitrum?', intent.question('CAPABILITIES'))!;
    expect(reply.kind).toBe('ANSWER');
    expect(reply.text).toMatch(/^On Arbitrum One \(mainnet, real funds\), FloFi can author/);
    expect(reply.text).toMatch(/swaps: any official catalog token/);
    expect(reply.text).toMatch(/Aave V3 supply: USDC/);
    expect(reply.text).not.toMatch(/Sepolia|Devnet|Testnet/);
    expect(reply.notes[0]).toMatch(/Registered functionality.*decided at Review/);
  });
  it('8 (test network): the public product says Base Sepolia is a test network instead of listing anything', () => {
    expect(mainnet().say('what can I do on Base Sepolia?', intent.question('CAPABILITIES'))!.text).toBe('Base Sepolia is a test network. FloFi\'s public product runs on mainnets only, so nothing can be authored there.');
  });
  it('9: "what does my current workflow do?" is answered from the canonical workflow, and the model only ever sees FloFi\'s sanitized card', () => {
    const s = mainnet();
    s.say('swap 1 usdc to eth on base'); s.apply();
    s.say('bridge 1 USDC from Base to Arbitrum'); s.apply();
    const reply = s.say('what does my current workflow do?', intent.question('WORKFLOW_OVERVIEW'))!;
    expect(reply.kind).toBe('ANSWER');
    expect(reply.text).toMatch(/2 steps/);
    const card = s.turns.at(-1)!.request!.context!;
    expect(card.steps.map(step => [step.index, step.kind, step.network])).toEqual([[1, 'SWAP', 'Base'], [2, 'BRIDGE', 'Base']]);
    expect(JSON.stringify(card)).not.toMatch(/0x[0-9a-fA-F]{40}|node-\d|eip155:|solana:/);
    expect(card.wallet).toEqual({ evm: { connected: true, network: 'Base' }, solana: { connected: false } });
  });
  it('9: a model explanation shows only when grounded in FloFi\'s facts; an invented number is dropped', () => {
    const s = mainnet();
    s.say('swap 1 usdc to eth on base'); s.apply();
    const grounded = s.say('what does it do?', intent.question('WORKFLOW_OVERVIEW', null, 'EN'))!;
    expect(grounded.notes.join(' ')).not.toMatch(/AI explanation/);
    const explained = s.say('explain my workflow', { ...intent.question('WORKFLOW_OVERVIEW'), answer: 'Your one step swaps 1 USDC for native ETH on Base.' })!;
    expect(explained.notes[0]).toBe('AI explanation (from FloFi\'s verified data): Your one step swaps 1 USDC for native ETH on Base.');
    const invented = s.say('and the yield?', { ...intent.question('WORKFLOW_OVERVIEW'), answer: 'It yields 7.5% per year.' })!;
    expect(invented.notes.join(' ')).not.toMatch(/7\.5|AI explanation/);
  });
  it('10: an unreachable composition is explained with grounded alternatives; nothing is proposed', () => {
    const reply = mainnet().say('swap some USDC for WETH on Base and put both in a liquidity position', intent.goal({ network: 'BASE', asset: 'USDC' }, { asset: 'WETH', use: 'LIQUIDITY' }))!;
    expect(reply.kind).toBe('UNSUPPORTED');
    expect(reply.text).toMatch(/cannot yet run a conversion and a liquidity position as one reviewed workflow on Base: liquidity is not a sequence step/);
    expect(reply.text).toMatch(/swap first as its own step/);
    expect(reply.command).toBeUndefined();
  });
  it('11: a test-network request is refused without moving it to a mainnet', () => {
    const s = mainnet();
    const action = s.say('please swap 1 USDC to WETH on Base Sepolia', intent.action(act.swap({ network: 'BASE_SEPOLIA', inputAsset: 'USDC', outputAsset: 'WETH', amount: '1' })))!;
    expect(action.kind).toBe('UNSUPPORTED');
    expect(action.text).toBe('Base Sepolia is a test network. FloFi runs on mainnets only: name the mainnet you want to use.');
    expect(action.command).toBeUndefined();
    const goal = s.say('I have 5 USDC on Base Sepolia and want WETH there', intent.goal({ network: 'BASE_SEPOLIA', asset: 'USDC', amount: '5' }, { network: 'BASE_SEPOLIA', asset: 'WETH' }))!;
    expect(goal).toMatchObject({ kind: 'UNSUPPORTED' });
    expect(goal.text).toMatch(/Base Sepolia is a test network\. FloFi runs on mainnets only/);
    expect(s.pending).toBeNull();
  });
});

describe('case 12: a long conversation keeps typed state and asks nothing twice', () => {
  it('18 turns of proposals, applies, corrections, questions and clarifications', () => {
    const s = mainnet();
    const say = (text: string, model?: Parameters<CopilotSession['say']>[1]) => s.say(text, model);
    say('swap 1 usdc to eth on base');                                                                   // 1 exact grammar
    expect(say('make it 3', intent.edit({ amount: '3' }))!.sentence).toBe('swap 3 USDC to ETH on Base slippage 100 bps'); // 2
    s.apply();
    expect(say('what does my workflow do?', intent.question('WORKFLOW_OVERVIEW'))!.kind).toBe('ANSWER'); // 3
    const missing = say('now bridge some USDC to Arbitrum', intent.action(act.bridge({ destinationNetwork: 'ARBITRUM', asset: 'USDC' })))!; // 4
    expect(missing.kind).toBe('CLARIFICATION');
    expect(say('from Base, 4 USDC', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', amount: '4' })))) // 5
      .toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 4 USDC from Base to Arbitrum via auto slippage 100 bps' });
    expect(say('actually 5', intent.edit({ amount: '5' }))!.sentence).toBe('bridge 5 USDC from Base to Arbitrum via auto slippage 100 bps'); // 6
    expect(say('keep the same destination', intent.edit({ destinationNetwork: 'ARBITRUM' }))!.sentence).toBe('bridge 5 USDC from Base to Arbitrum via auto slippage 100 bps'); // 7
    s.apply();
    expect(say('what can I do on Base?', intent.question('CAPABILITIES'))!.text).toMatch(/^On Base \(mainnet, real funds\)/); // 8
    expect(say('swap 2 usd to weth on base', intent.action(act.swap({ network: 'BASE', inputAsset: 'usd', outputAsset: 'weth', amount: '2' })))!.kind).toBe('CLARIFICATION'); // 9
    expect(say('USDC')).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 2 USDC to WETH on Base slippage 100 bps' }); // 10
    expect(say('I want ETH, not WETH', intent.edit({ outputAsset: 'ETH' }))!.sentence).toBe('swap 2 USDC to ETH on Base slippage 100 bps'); // 11
    expect(say('slippage 50 bps', intent.edit({ slippageBps: '50' }))!.sentence).toBe('swap 2 USDC to ETH on Base slippage 50 bps'); // 12
    s.apply();
    expect(say('change the first swap to 7', intent.edit({ amount: '7' }, { step: 'SWAP', ordinal: 'FIRST' }))!.sentence).toBe('swap 7 USDC to ETH on Base slippage 100 bps'); // 13
    s.dismiss();
    expect(say('change the last swap to 8', intent.edit({ amount: '8' }, { step: 'SWAP', ordinal: 'LAST' }))!.sentence).toBe('swap 8 USDC to ETH on Base slippage 50 bps'); // 14
    s.apply();
    expect(say('remove the bridge', intent.remove({ step: 'BRIDGE' }))!.kind).toBe('PROPOSAL'); // 15
    s.apply();
    const overview = say('what does my workflow do now?', intent.question('WORKFLOW_OVERVIEW'))!; // 16
    expect(overview.text).toMatch(/2 steps/);
    expect(say('supply 1 USDC on Aave on Base', intent.action(act.lending('SUPPLY', { network: 'BASE', asset: 'USDC', amount: '1' })))!.sentence).toBe('supply 1 USDC to Aave on Base'); // 17
    expect(say('make it 1,5', intent.edit({ amount: '1.5' }))!.sentence).toBe(`supply 1.5 USDC to Aave on Base beneficiary ${TEST_WALLET}`); // 18
    expect(s.turns).toHaveLength(18);
    // The transcript sent to the model stays bounded; the typed state (workflow, pending proposal, referents) carries the conversation.
    for (const turn of s.turns) if (turn.request) expect(turn.request.messages.filter(message => message.role === 'user').length).toBeLessThanOrEqual(8);
    noRepeats(s);
  });
});

describe('case 13: a context change during a model or tool request is never applied', () => {
  it('a wallet, workflow or pending-proposal change while the model works discards its answer', () => {
    const wallet = mainnet();
    expect(wallet.say('please swap 1 usdc to eth on base', intent.action(act.swap({ network: 'BASE', inputAsset: 'usdc', outputAsset: 'eth', amount: '1' })),
      session => { session.wallet = '0x2222222222222222222222222222222222222222'; })).toMatchObject({ kind: 'FAILED' });
    expect(wallet.pending).toBeNull();
    const network = mainnet();
    expect(network.say('please swap 1 usdc to eth on base', intent.action(act.swap({ network: 'BASE', inputAsset: 'usdc', outputAsset: 'eth', amount: '1' })),
      session => { session.walletChainId = 'eip155:42161'; })).toMatchObject({ kind: 'FAILED' });
    const revision = mainnet();
    revision.say('swap 1 usdc to eth on base'); revision.apply();
    expect(revision.say('make it 2', intent.edit({ amount: '2' }), session => { session.canvas(workflow => ({ ...workflow, revision: workflow.revision + 1 })); }))
      .toMatchObject({ kind: 'FAILED' });
  });
  it('a server answer bound to another context card (tool facts read for a different context) is refused', () => {
    const s = mainnet();
    const reply = s.say('please swap 1 usdc to eth on base', request => ({ ok: true, intent: intent.action(act.swap({ network: 'BASE', inputAsset: 'usdc', outputAsset: 'eth', amount: '1' })),
      contextKey: request.contextKey === 'c0000000000000000' ? 'c1111111111111111' : 'c0000000000000000' }))!;
    expect(reply.kind).toBe('FAILED');
    expect(s.pending).toBeNull();
    const ok = mainnet().say('please swap 1 usdc to eth on base', request => ({ ok: true, intent: intent.action(act.swap({ network: 'BASE', inputAsset: 'usdc', outputAsset: 'eth', amount: '1' })),
      contextKey: request.contextKey! }))!;
    expect(ok.kind).toBe('PROPOSAL');
  });
});

describe('goal-to-workflow acceptance: one message, a complete reviewable proposal, no Canvas', () => {
  it('"I have 25 USDC on Base and want SOL on Solana" → one universal bridge that converts in the route', () => {
    const s = mainnet();
    const reply = s.say('I have 25 USDC on Base and want SOL on Solana', intent.goal({ network: 'BASE', asset: 'USDC', amount: '25' }, { network: 'SOLANA', asset: 'SOL' }))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 25 USDC from Base to Solana receive SOL via best slippage 100 bps', command: { type: 'ADD_UNIVERSAL_BRIDGE' } });
    expect(reply.text).toMatch(/^Here is the step that reaches your goal:/);
    expect(reply.notes).toEqual(expect.arrayContaining(['The route converts the asset itself, so no separate swap step is needed.']));
  });
  it('"supply 10 USDC on Aave on Arbitrum, my USDC is on Base" → bridge then a funded supply, as one executable reviewed sequence', () => {
    const s = mainnet();
    const reply = s.say('I want to supply 10 USDC on Aave on Arbitrum; my USDC is on Base', intent.goal({ network: 'BASE', asset: 'USDC', amount: '10' }, { network: 'ARBITRUM', use: 'SUPPLY' }))!;
    expect(reply.kind).toBe('PROPOSAL');
    expect(reply.command).toMatchObject({ type: 'ADD_SEQUENCE', steps: [{ type: 'ADD_ROUTER_BRIDGE' }, { type: 'ADD_SUPPLY', input: { amount: '10', beneficiary: TEST_WALLET } }] });
    expect(reply.text).toMatch(/1\. bridge 10 USDC from Base to Arbitrum via auto slippage 100 bps 2\. supply 10 USDC to Aave on Arbitrum One/);
    expect(reply.notes).toEqual(expect.arrayContaining(['Its cap is your own amount: a bridge delivers at most what it sends.',
      'Each step gets its own fresh simulation, your Review and your wallet signature, in order.']));
    s.apply();
    const sequence = workflowSequence(s.workflow, workflow => lintWorkflow(workflow, s.context))!;
    expect(sequence.steps.map(step => step.fundedBy)).toEqual([null, 0]);
  });
  it('"move my funds to Arbitrum with minimal total cost" asks each missing field once, then plans the cheapest-at-Review route', () => {
    const s = mainnet();
    const goal = (extra: Record<string, unknown>) => intent.goal({ ...extra }, { network: 'ARBITRUM' }, { preference: 'LOWEST_COST' });
    expect(s.say('Find a supported way to move my funds to Arbitrum with minimal total cost', goal({}))).toMatchObject({ kind: 'CLARIFICATION', text: 'Which token do you have (or want to use)?' });
    expect(s.say('USDC', goal({ asset: 'USDC' }))).toMatchObject({ kind: 'CLARIFICATION', text: 'Which network is that token on?' });
    expect(s.say('Base')).toMatchObject({ kind: 'CLARIFICATION', text: 'How much do you want to use? Write it in digits.' });
    const planned = s.say('3')!;
    expect(planned).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 3 USDC from Base to Arbitrum One receive USDC via best slippage 100 bps' });
    expect(planned.notes).toEqual(expect.arrayContaining(['Lowest total cost: the live quotes (fees, gas and the guaranteed amount) are compared at Review, not guessed now.',
      'Alternative: say "certified route" to use the certified Cross-chain Router route instead.']));
    noRepeats(s);
  });
  it('a conversion before a supply asks for the funded step\'s cap instead of inventing one', () => {
    const s = mainnet();
    const asked = s.say('Use my 0.01 ETH on Base to supply USDC on Aave on Arbitrum', intent.goal({ network: 'BASE', asset: 'ETH', amount: '0.01' }, { network: 'ARBITRUM', asset: 'USDC', use: 'SUPPLY' }))!;
    expect(asked).toMatchObject({ kind: 'CLARIFICATION' });
    expect(asked.text).toMatch(/Step 2 supplies USDC.*What is the most USDC it may supply\?/);
    const planned = s.say('20')!;
    expect(planned.command).toMatchObject({ type: 'ADD_SEQUENCE', steps: [{ type: 'ADD_UNIVERSAL_BRIDGE', input: { inputAsset: 'ETH', outputAsset: 'USDC', amount: '0.01' } },
      { type: 'ADD_SUPPLY', input: { amount: '20' } }] });
  });
  it('a goal value the user did not write is never used (the model\'s network guess is asked instead)', () => {
    const reply = mainnet().say('I have 25 USDC and want SOL on Solana', intent.goal({ network: 'BASE', asset: 'USDC', amount: '25' }, { network: 'SOLANA', asset: 'SOL' }))!;
    expect(reply).toMatchObject({ kind: 'CLARIFICATION', text: 'Which network is that token on?' });
  });
});
