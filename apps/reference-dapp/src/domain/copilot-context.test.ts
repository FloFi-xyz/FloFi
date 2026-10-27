// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseArbitrumTokenList } from '@defi-workflow-engine/action-registry';
import { registerNetworkCatalog, resetNetworkCatalogs, resolveAssetReference } from './asset-catalogs';
import { baseCatalog } from '../server/base-mainnet.test-harness';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { canonicalStrategy } from '../channels/core/strategy';
import { composeStrategy } from '../engine/strategy-engine';
import { startTurn, finishTurn } from './copilot-conversation';
import { editorReducer } from './editor';
import { parseCopilotIntentV2 } from './copilot-intent-v2';
import { applyCommand } from './copilot-test-fixtures';

const bytes = readFileSync(new URL('../../../../packages/action-registry/test/fixtures/arbitrum-token-list-fixture.json', import.meta.url), 'utf8');
// Real public identities; isolated list-format fixture, never a production fallback or route assertion.
const list = JSON.parse(bytes) as { tokens: unknown[] };
list.tokens.push({ chainId: 42161, address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', name: 'Tether USD', symbol: 'USDT', decimals: 6 });
const loadArbitrum = () => registerNetworkCatalog(parseArbitrumTokenList(JSON.stringify(list), '2026-10-27T00:00:00Z'));
beforeEach(() => { registerNetworkCatalog(baseCatalog()); loadArbitrum(); });
afterEach(resetNetworkCatalogs);

describe('BUILD-COPILOT-CONTEXT-001 regression', () => {
  it('uses the explicitly requested destination when the model substitutes the source token', () => {
    const s = new CopilotSession();
    const reply = s.say('quero bridge de 1 usdc na base para WETH na arbitrum', intent.action(act.bridge({
      sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', outputAsset: 'USDC', amount: '1',
    }), 'PT'));
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_UNIVERSAL_BRIDGE', input: { inputAsset: 'USDC', outputAsset: 'WETH' } } });
  });

  it('keeps a typed outputAsset question and accepts a bare catalog token without reinterpreting the request', () => {
    const s = new CopilotSession();
    const reply = s.say('quero bridge de 1 cbBTC na base para Solana', intent.action(act.bridge({
      sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'cbBTC', amount: '1',
    }), 'PT'));
    expect(reply?.kind).toBe('CLARIFICATION');
    expect(s.state.draft).toMatchObject({ expected: ['outputAsset'] });
    expect(s.say('USDT')).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_UNIVERSAL_BRIDGE', input: { inputAsset: 'cbBTC', outputAsset: 'USDT' } } });
    expect(s.turns.at(-1)?.local).toBe('ENGINE');
  });
});

describe('chain-scoped asset and command matrix', () => {
  it.each(['usdt', 'USDT', 'uSdT', 'WETH', 'Wrapped Ether', 'WBTC', 'Wrapped BTC', 'LINK', 'DAI', 'USDC.e',
    '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9@6'])('grounds %s independently of the model output', output => {
    const s = new CopilotSession();
    const reply = s.say(`quero bridge de 1 usdc na base para ${output} na arbitrum`, intent.action(act.bridge({
      sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', outputAsset: 'USDC', amount: '1',
    }), 'PT'))!;
    expect(reply.kind, reply.text).toBe('PROPOSAL');
    expect(reply.command).toMatchObject({ type: 'ADD_UNIVERSAL_BRIDGE', input: { inputAsset: 'USDC', amount: '1' } });
    const node = editorReducer({ workflow: s.workflow, error: null }, reply.command!, s.context).workflow.nodes.at(-1)!;
    expect(JSON.stringify(node)).not.toContain('MOCKED');
    const channel = canonicalStrategy(reply.command!);
    const mcp = composeStrategy({ action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USDC', outputAsset: /^0x[0-9a-f]{40}$/i.test(output) ? `${output}@6` : output, amount: '1' });
    expect(channel.ok).toBe(true); expect(mcp.ok).toBe(true);
    if (!channel.ok || !mcp.ok) throw Error('PARITY_COMPOSITION_FAILED');
    expect(channel.workflowHash).toBe(mcp.workflowHash);
    expect(reply.options).toEqual([]);
  });
  it.each([null, 'USDC', 'WETH'])('repairs an omitted or incorrect model destination (%s) from the user clause', modelOutput => {
    const s = new CopilotSession();
    expect(s.say('Please bridge 2 USDC from Base to LINK on Arbitrum', intent.action(act.bridge({
      sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', outputAsset: modelOutput, amount: '2',
    })))).toMatchObject({ kind: 'PROPOSAL', command: { input: { inputAsset: 'USDC', outputAsset: 'LINK' } } });
  });
  it('retains a certified same-asset Router route', () => {
    const s = new CopilotSession();
    expect(s.say('please bridge 1 USDC from Base to Arbitrum', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', amount: '1' }))))
      .toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_ROUTER_BRIDGE' } });
  });
  it.each(['AERO', '1INCH'])('does not substitute %s absent from the loaded destination catalog', output => {
    const s = new CopilotSession();
    const reply = s.say(`quero bridge de 1 USDC na Base para ${output} na Arbitrum`, intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', outputAsset: 'USDC', amount: '1' }), 'PT'))!;
    expect(reply).toMatchObject({ kind: 'UNSUPPORTED', code: 'ASSET_UNKNOWN' });
    expect(reply.text).toContain(output); expect(reply.command).toBeUndefined();
    expect(composeStrategy({ action: 'bridge', sourceNetwork: 'base', destinationNetwork: 'arbitrum-one', asset: 'USDC', outputAsset: output, amount: '1' }))
      .toMatchObject({ ok: false, code: 'ASSET_UNKNOWN' });
    expect(s.state.draft?.expected).toEqual(['outputAsset']);
    expect(s.say('LINK')).toMatchObject({ kind: 'PROPOSAL', command: { input: { inputAsset: 'USDC', outputAsset: 'LINK' } } });
  });
  it('recovers the active request after catalog failure without asking for the transaction again', () => {
    resetNetworkCatalogs();
    const s = new CopilotSession();
    const reply = s.say('please bridge 1 USDC from Base to LINK on Arbitrum', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', outputAsset: 'LINK', amount: '1' })))!;
    expect(reply).toMatchObject({ kind: 'FAILED', code: 'ASSET_CATALOG_UNAVAILABLE' });
    expect(reply.text).toContain('catalog'); expect(reply.command).toBeUndefined();
    loadArbitrum();
    expect(s.say('LINK')).toMatchObject({ kind: 'PROPOSAL', command: { input: { inputAsset: 'USDC', outputAsset: 'LINK', amount: '1' } } });
  });
  it('keeps identity ambiguity separate from an unknown token', () => {
    const ambiguous = { ...list, tokens: [...list.tokens, { chainId: 42161, address: '0x0000000000000000000000000000000000001234', name: 'ChainLink Token', symbol: 'LINK2', decimals: 18 }] };
    registerNetworkCatalog(parseArbitrumTokenList(JSON.stringify(ambiguous), '2026-10-27T00:00:00Z'));
    expect(resolveAssetReference('eip155:42161', 'ChainLink Token').kind).toBe('AMBIGUOUS');
    const s = new CopilotSession();
    expect(s.say('please bridge 1 USDC from Base to ChainLink Token on Arbitrum', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', outputAsset: 'ChainLink Token', amount: '1' }))))
      .toMatchObject({ kind: 'CLARIFICATION', options: ['LINK', 'LINK2'] });
    expect(s.state.draft?.expected).toEqual(['outputAsset']);
    expect(s.say('LINK')).toMatchObject({ kind: 'PROPOSAL', command: { input: { outputAsset: 'LINK' } } });
  });
  it('distinguishes invalid explicit decimals from unavailable routes and never accepts a model-invented contract', () => {
    const s = new CopilotSession();
    expect(s.say('please bridge 1 USDC from Base to 0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9@18 on Arbitrum', intent.action(act.bridge({
      sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', amount: '1', outputAsset: null,
    })))).toMatchObject({ kind: 'UNSUPPORTED', code: 'UNIVERSAL_ASSET_DECIMALS_MISMATCH' });
    const invented = new CopilotSession().say('bridge 1 USDC from Base to Arbitrum please', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', amount: '1', outputAsset: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9@6' })))!;
    expect(invented.kind).toBe('CLARIFICATION'); expect(invented.command).toBeUndefined();
  });
  it('parses full explicit EVM references in the strict model contract', () => {
    expect(parseCopilotIntentV2(intent.action(act.bridge({ asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@6' })))).toMatchObject({ kind: 'ACTION', action: { asset: expect.stringContaining('@6') } });
  });
  it('keeps an explicitly requested Solana mint independent of the destination recipient', () => {
    const mint = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    const s = new CopilotSession();
    expect(s.say(`Please bridge 1 USDC from Base to Solana receiving ${mint}@6`, intent.action(act.bridge({
      sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'USDC', outputAsset: `${mint}@6`, amount: '1',
    })))).toMatchObject({ kind: 'PROPOSAL', command: { input: { inputAsset: 'USDC', outputAsset: `${mint}@6`, recipient: '' } } });
    const recipient = 'GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq';
    expect(new CopilotSession().say(`Please bridge 1 USDC from Base to Solana receiving ${mint}@6 for ${recipient}`, intent.action(act.bridge({
      sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'USDC', outputAsset: `${mint}@6`, amount: '1', recipient,
    })))).toMatchObject({ kind: 'PROPOSAL', command: { input: { outputAsset: `${mint}@6`, recipient } } });
  });
  it('does not ground a model recipient from the contract written only as a source asset', () => {
    const token = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const s = new CopilotSession();
    expect(s.say(`Please bridge 1 ${token}@6 from Base to WETH on Arbitrum`, intent.action(act.bridge({
      sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: `${token}@6`, outputAsset: 'WETH', amount: '1', recipient: token,
    })))).toMatchObject({ kind: 'CLARIFICATION' });
    expect(s.state.draft?.expected).toEqual(['recipient']);
  });
});

describe('persistent fields, corrections and stale context', () => {
  it('allows progress through four typed clarifications while keeping a bounded request and no model re-extraction', () => {
    const s = new CopilotSession();
    s.say('please bridge to Solana', intent.action(act.bridge({ destinationNetwork: 'SOLANA' })));
    for (const answer of ['Base', 'cbBTC', '1']) expect(s.say(answer)?.kind).toBe('CLARIFICATION');
    expect(s.state.draft?.expected).toEqual(['outputAsset']);
    expect(s.say('USDT')).toMatchObject({ kind: 'PROPOSAL', command: { input: { inputAsset: 'cbBTC', outputAsset: 'USDT', amount: '1' } } });
    expect(s.turns.filter(turn => turn.request !== null)).toHaveLength(1);
  });

  it('keeps the active draft after an interpreter failure so a later slot answer still works', () => {
    const s = new CopilotSession();
    s.say('please bridge 1 cbBTC from Base to Solana', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'cbBTC', amount: '1' })));
    expect(s.say('could you explain the options?', { failure: 'COPILOT_UNAVAILABLE' })?.kind).toBe('FAILED');
    expect(s.state.draft?.expected).toEqual(['outputAsset']);
    expect(s.say('USDT')).toMatchObject({ kind: 'PROPOSAL', command: { input: { outputAsset: 'USDT' } } });
  });

  it('retains the structured request when a model asks another clarification or the user asks a read-only question', () => {
    const s = new CopilotSession();
    s.say('please bridge 1 cbBTC from Base to Solana', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'cbBTC', amount: '1' })));
    s.say('can you explain which field?', intent.clarify(['outputAsset'], 'Which token should arrive on Solana?'));
    expect(s.state.draft).toMatchObject({ intent: { kind: 'ACTION', action: { asset: 'cbBTC', amount: '1' } }, expected: ['outputAsset'] });
    expect(s.say('how much will I receive?', intent.question('MARKET_DATA'))?.kind).toBe('ANSWER');
    expect(s.state.draft?.expected).toEqual(['outputAsset']);
    expect(s.say('USDT')).toMatchObject({ kind: 'PROPOSAL', command: { input: { inputAsset: 'cbBTC', outputAsset: 'USDT', amount: '1' } } });
  });

  it('preserves grounded fields when a subsequent model action omits or contradicts them', () => {
    const s = new CopilotSession();
    s.say('Please bridge USDC from Base to USDT on Arbitrum', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', outputAsset: 'USDT' })));
    expect(s.state.draft?.expected).toContain('amount');
    const reply = s.say('use exactly 2', intent.action(act.bridge({ sourceNetwork: null, destinationNetwork: null, asset: 'WETH', outputAsset: null, amount: '2' })))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', command: { input: { inputAsset: 'USDC', outputAsset: 'USDT', amount: '2' } } });
  });
  it('accepts two explicit destination corrections and keeps source and amount unchanged', () => {
    const s = new CopilotSession();
    s.say('Please bridge 1 USDC from Base to WETH on Arbitrum', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', outputAsset: 'WETH', amount: '1' })));
    expect(s.say('não, quero USDT', intent.edit({ outputAsset: 'USDT' }, {}, 'PT'))).toMatchObject({ kind: 'PROPOSAL', command: { input: { inputAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@6', outputAsset: 'USDT', amount: '1' } } });
    expect(s.say('actually receive LINK', intent.edit({ outputAsset: 'LINK' }))).toMatchObject({ kind: 'PROPOSAL', command: { input: { inputAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@6', outputAsset: 'LINK', amount: '1' } } });
    expect(s.workflow.revision).toBe(0);
  });
  it.each(['ACTION', 'EDIT'] as const)('preserves the source when a %s interpretation changes both networks for a destination-only correction', kind => {
    const s = new CopilotSession();
    s.say('Please bridge USDC from Base to USDT on Arbitrum', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', outputAsset: 'USDT' })));
    s.say('muda o destino para Solana', kind === 'ACTION'
      ? intent.action(act.bridge({ sourceNetwork: 'SOLANA', destinationNetwork: 'SOLANA', asset: 'USDC', outputAsset: 'USDT' }), 'PT')
      : intent.edit({ network: 'SOLANA', destinationNetwork: 'SOLANA' }, {}, 'PT'));
    expect(s.state.draft?.intent).toMatchObject({ kind: 'ACTION', action: { sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'USDC', outputAsset: 'USDT' } });
    expect(s.say('1')).toMatchObject({ kind: 'PROPOSAL', command: { input: { source: 'base', destination: 'solana', inputAsset: 'USDC', outputAsset: 'USDT', amount: '1' } } });
  });
  it.each(['wallet', 'chain', 'workflow', 'proposal'] as const)('rejects a %s change during clarification, including replies without options', changed => {
    const s = new CopilotSession();
    s.say('please bridge 1 cbBTC from Base to Solana', intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'SOLANA', asset: 'cbBTC', amount: '1' })));
    if (changed === 'wallet') s.wallet = '0x2222222222222222222222222222222222222222';
    if (changed === 'chain') s.walletChainId = 'eip155:1';
    if (changed === 'workflow') s.workflow = applyCommand(s.workflow, { type: 'ADD', kind: 'read', source: 'CANVAS', baseRevision: 0 });
    if (changed === 'proposal') s.pending = { command: { type: 'ADD', kind: 'read', source: 'CANVAS', baseRevision: 0 }, diff: [] };
    expect(s.say('USDT')).toMatchObject({ kind: 'FAILED' });
    expect(s.state.draft).toBeNull();
  });
  it('checks the current snapshot after a model call as well', () => {
    const s = new CopilotSession(), start = startTurn(s.state, 'please bridge 1 USDC from Base to USDT on Arbitrum', s.env());
    if (start.kind !== 'REMOTE') throw Error('EXPECTED_REMOTE');
    s.wallet = null;
    expect(finishTurn(start.turn, { ok: true, intent: intent.action(act.bridge({ sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', outputAsset: 'USDT', amount: '1' })) }, s.env()).reply.kind).toBe('FAILED');
  });
});

describe('shared action clarifications', () => {
  it.each([',', ';', '!', '?', ''])('does not treat a polite clause before %s as the requested output asset', punctuation => {
    const s = new CopilotSession();
    expect(s.say(`Por favor${punctuation} troca 10 USDC por WETH na Arbitrum`, intent.action(act.swap({
      network: 'ARBITRUM', inputAsset: 'USDC', outputAsset: 'WETH', amount: '10',
    }), 'PT'))).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 10 USDC to WETH on Arbitrum One slippage 100 bps' });
  });
  it('keeps separate receiving clauses so the last explicit correction takes precedence', () => {
    const s = new CopilotSession();
    expect(s.say('Please bridge 1 USDC from Base to Arbitrum receiving WETH, actually receive LINK', intent.action(act.bridge({
      sourceNetwork: 'BASE', destinationNetwork: 'ARBITRUM', asset: 'USDC', outputAsset: 'WETH', amount: '1',
    })))).toMatchObject({ kind: 'PROPOSAL', command: { input: { inputAsset: 'USDC', outputAsset: 'LINK' } } });
  });
  it('retains the supported composition fields while the interpreter fills only the missing borrow amount', () => {
    const s = new CopilotSession();
    s.say('Please supply 5 USDC, then borrow USDC and swap the borrowed USDC for WETH on Base Sepolia', intent.composition([
      act.lending('SUPPLY', { network: 'BASE_SEPOLIA', asset: 'USDC', amount: '5' }),
      act.lending('BORROW', { network: 'BASE_SEPOLIA', asset: 'USDC' }),
      act.swap({ network: 'BASE_SEPOLIA', inputAsset: 'USDC', outputAsset: 'WETH' }),
    ]));
    expect(s.state.draft?.expected).toEqual(['amount']);
    expect(s.say('borrow 2 USDC', intent.composition([
      act.lending('SUPPLY'), act.lending('BORROW', { amount: '2' }), act.swap(),
    ]))).toMatchObject({ kind: 'PROPOSAL', command: { type: 'AUTHOR_LENDING' },
      sentence: 'compose supply 5 USDC to Aave then borrow 2 USDC then swap borrowed USDC to WETH on Base Sepolia slippage 100 bps' });
  });

  it('uses the same catalog validation for an explicit swap contract and decimals', () => {
    const s = new CopilotSession();
    expect(s.say('please swap 3 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@6 for AERO on Base', intent.action(act.swap({
      network: 'BASE', inputAsset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@6', outputAsset: 'AERO', amount: '3',
    })))).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 3 USDC to AERO on Base slippage 100 bps' });
    expect(resolveAssetReference('eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913@18').kind).toBe('DECIMALS_MISMATCH');
    expect(resolveAssetReference('eip155:8453', '0x1234@6').kind).toBe('INVALID_REFERENCE');
  });

  it.each([
    ['swap', 'please swap 3 USDC on Base', act.swap({ network: 'BASE', inputAsset: 'USDC', amount: '3' }), 'outputAsset', 'AERO', 'ADD_CRYPTO_ACTION'],
    ['transfer', 'please send 3 on Base to me', act.transfer({ network: 'BASE', amount: '3' }), 'asset', 'EURC', 'ADD_RH_TRANSFER'],
    ['lending', 'please supply 3 on Aave Base', act.lending('SUPPLY', { network: 'BASE', amount: '3' }), 'asset', 'USDC', 'ADD_SUPPLY'],
  ] as const)('%s fills only the requested field', (_name, text, action, field, answer, command) => {
    const s = new CopilotSession();
    expect(s.say(text, intent.action(action))?.kind).toBe('CLARIFICATION');
    expect(s.state.draft?.expected).toEqual([field]);
    expect(s.say(answer)).toMatchObject({ kind: 'PROPOSAL', command: { type: command } });
    expect(s.turns.at(-1)?.request).toBeNull();
  });
  it('keeps both liquidity maxima while the model fills the range', () => {
    const s = new CopilotSession();
    const deposits = [{ asset: 'USDC', maxAmount: '5' }, { asset: 'AERO', maxAmount: '3' }];
    s.say('Please add liquidity 5 USDC and 3 AERO on Base in a price range', intent.action(act.liquidity({ network: 'BASE', deposits, rangeUnit: 'PRICE' })));
    expect(s.state.draft?.expected).toContain('range');
    expect(s.say('full range please', intent.action(act.liquidity({ network: null, rangeUnit: 'FULL' })))).toMatchObject({ kind: 'PROPOSAL', command: { type: 'ADD_CRYPTO_ACTION' }, sentence: 'add liquidity 5 USDC and 3 AERO on Base slippage 100 bps' });
  });
  it('retains a separate typed automation draft and accepts a time without a new model call', () => {
    const s = new CopilotSession();
    const draft = { kind: 'SCHEDULED_DCA', asset: 'ETH', side: 'BUY', network: 'BASE', amount: '5', spendAsset: 'USDC', time: null, condition: null, threshold: null, percent: null };
    expect(s.say('Buy 5 USDC of ETH every day on Base', { version: '2', kind: 'AUTOMATION', language: 'EN', draft })?.kind).toBe('CLARIFICATION');
    expect(s.state.draft?.expected).toEqual(['time']);
    expect(s.say('09:00')).toMatchObject({ kind: 'AUTOMATION_PROPOSAL', automation: { action: { amount: '5', network: 'base' }, schedule: { time: '09:00' } } });
    expect(s.turns.at(-1)?.request).toBeNull();
  });
});
