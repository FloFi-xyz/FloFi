// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: natural-language Copilot parity on the catalog networks (Base, Robinhood Chain). A Copilot proposal is the very command
 * FloFi's chat parses from the canonical sentence, and that command composes to the same canonical IR and hash on the shared platform as
 * MCP and the channels produce. Every token resolves only in the network's validated catalog and must be the user's own words; real
 * funds are never inferred; an unknown or unloaded catalog fails closed. Nothing here signs, quotes or executes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseLocalCommand, type Command } from './commands';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { canonicalStrategy } from '../channels/core/strategy';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { TEST_WALLET } from './copilot-test-fixtures';
import { baseAsset, baseCatalog } from '../server/base-mainnet.test-harness';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';
import { editorReducer } from './editor';

const RECIPIENT = '0x3333333333333333333333333333333333333333';
beforeAll(() => { registerNetworkCatalog(baseCatalog()); registerNetworkCatalog(officialCatalog()); });
afterAll(() => resetNetworkCatalogs());

/** Copilot ≡ Chat (the same command from the canonical sentence) ≡ MCP/channels (the platform composes it back, same IR and hash). */
function expectParity(session: CopilotSession, command: Command, sentence: string) {
  expect(parseLocalCommand(sentence, session.workflow, session.context, TEST_WALLET)).toEqual(command);
  const shared = canonicalStrategy(command);
  expect(shared, sentence).toMatchObject({ ok: true });
  if (!shared.ok) return;
  const node = (c: Command) => editorReducer({ workflow: session.workflow, error: null }, c, session.context).workflow.nodes.at(-1);
  expect(JSON.stringify(node(shared.command))).toBe(JSON.stringify(node(command)));
}

describe('BUILD-BASE-001 Copilot parity on catalog networks', () => {
  it('swaps any Base catalog token the user names (cbbtc → cbBTC) through the same exact grammar, with a real-funds note', () => {
    const s = new CopilotSession();
    const reply = s.say('Please swap 100 USDC for some cbbtc on Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'cbbtc', amount: '100' })))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 100 USDC to cbBTC on Base slippage 50 bps', command: { type: 'ADD_CRYPTO_ACTION' } });
    expect(reply.notes.join(' ')).toContain('Real funds on Base');
    expectParity(s, reply.command!, reply.sentence!);
    const node = editorReducer({ workflow: s.workflow, error: null }, reply.command!, s.context).workflow.nodes.at(-1)!;
    expect(JSON.stringify(node)).toContain(baseAsset(baseCatalog(), 'cbBTC').address!);
  });
  it('keeps Base USDC ⇄ WETH on its BUILD-002 sentence and command', () => {
    const s = new CopilotSession();
    const reply = s.say('swap 2 USDC into ETH on Base please', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'ETH', amount: '2' })))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 2 USDC to WETH on Base slippage 50 bps', command: { type: 'ADD_SWAP', direction: 'USDC_TO_WETH' } });
    expect(reply.notes.join(' ')).toContain('not native ETH');
  });
  it('grounds a Robinhood Stock Token by its symbol or its full catalog name, never by the model alone', () => {
    const s = new CopilotSession();
    const byName = s.say('Buy Tesla with 50 USDG on Robinhood Chain', intent.action(act.swap({ network: 'ROBINHOOD', inputAsset: 'USDG', outputAsset: 'TSLA', amount: '50' })))!;
    expect(byName).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 50 USDG to TSLA on Robinhood Chain slippage 50 bps', command: { type: 'ADD_CRYPTO_ACTION' } });
    expectParity(s, byName.command!, byName.sentence!);
    const guessed = new CopilotSession().say('Buy that car company with 50 USDG on Robinhood', intent.action(act.swap({ network: 'ROBINHOOD', inputAsset: 'USDG',
      outputAsset: 'TSLA', amount: '50' })))!;
    expect(guessed).toMatchObject({ kind: 'CLARIFICATION' });
    expect(guessed.text).toContain('could not find the token TSLA');
  });
  it('refuses a symbol outside the validated catalog and fails closed while the catalog is unavailable', () => {
    const unknown = new CopilotSession().say('Swap 10 USDC for NOTATOKEN on Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'NOTATOKEN', amount: '10' })))!;
    expect(unknown).toMatchObject({ kind: 'UNSUPPORTED' });
    expect(unknown.text).toContain('NOTATOKEN is not in the official Base catalog');
    resetNetworkCatalogs();
    try {
      const unloaded = new CopilotSession().say('Swap 10 USDC for cbBTC on Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'cbBTC', amount: '10' })))!;
      expect(unloaded).toMatchObject({ kind: 'FAILED' });
      expect(unloaded.text).toContain('asset catalog is unavailable');
      expect(unloaded.command).toBeUndefined();
    } finally { registerNetworkCatalog(baseCatalog()); registerNetworkCatalog(officialCatalog()); }
  });
  it('never infers real funds: an unnamed or test-worded mainnet is asked, not chosen', () => {
    const unnamed = new CopilotSession().say('Send 5 USDC to ' + RECIPIENT, intent.action(act.transfer({ asset: 'USDC', amount: '5', recipient: RECIPIENT })))!;
    expect(unnamed).toMatchObject({ kind: 'CLARIFICATION', options: ['Base', 'Robinhood Chain'] });
    const testWords = new CopilotSession().say('Swap 10 USDC for cbBTC on the Base test network', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'cbBTC', amount: '10' })))!;
    expect(testWords).toMatchObject({ kind: 'CLARIFICATION' });
    expect(testWords.text).toContain('uses real funds');
  });
  it('transfers ETH or a catalog token on a catalog network to a typed address or the connected owner', () => {
    const s = new CopilotSession();
    const eth = s.say(`Please send 0.01 ETH on Base over to ${RECIPIENT}`, intent.action(act.transfer({ network: 'BASE', asset: 'ETH', amount: '0.01', recipient: RECIPIENT })))!;
    expect(eth).toMatchObject({ kind: 'PROPOSAL', sentence: `transfer 0.01 ETH on Base to ${RECIPIENT}`, command: { type: 'ADD_RH_TRANSFER', input: { network: 'Base', asset: 'ETH' } } });
    expectParity(s, eth.command!, eth.sentence!);
    const stock = new CopilotSession().say('Could you move 2 TSLA on Robinhood to me', intent.action(act.transfer({ network: 'ROBINHOOD', asset: 'TSLA', amount: '2' })))!;
    expect(stock).toMatchObject({ kind: 'PROPOSAL', sentence: 'transfer 2 TSLA on Robinhood Chain', command: { input: { recipient: 'CONNECTED_OWNER' } } });
    expect(stock.notes.join(' ')).toContain('your connected wallet');
  });
  it('adds a Base position on any two catalog tokens at the named fee tier (full range by default)', () => {
    const s = new CopilotSession();
    const reply = s.say('Put 100 USDC and 0.001 cbBTC into a Uniswap pool on Base at 0.05%', intent.action(act.catalogLiquidity({ network: 'BASE',
      deposits: [{ asset: 'USDC', maxAmount: '100' }, { asset: 'cbBTC', maxAmount: '0.001' }], feeTier: '0.05' })))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'add liquidity 100 USDC and 0.001 cbBTC on Base fee 0.05% slippage 100 bps', command: { type: 'ADD_CRYPTO_ACTION' } });
    expect(reply.notes.join(' ')).toContain('full price range');
    expectParity(s, reply.command!, reply.sentence!);
    const ungroundedFee = new CopilotSession().say('Put 100 USDC and 0.001 cbBTC into a pool on Base', intent.action(act.catalogLiquidity({ network: 'BASE',
      deposits: [{ asset: 'USDC', maxAmount: '100' }, { asset: 'cbBTC', maxAmount: '0.001' }], feeTier: '1' })))!;
    expect(ungroundedFee).toMatchObject({ kind: 'CLARIFICATION' });
  });
  it('lends USDC on Base mainnet and bridges Arbitrum One → Base and USDG out of Robinhood Chain', () => {
    const s = new CopilotSession();
    const supply = s.say('Please lend 100 USDC on Aave on Base', intent.action(act.lending('SUPPLY', { network: 'BASE', asset: 'USDC', amount: '100' })))!;
    expect(supply).toMatchObject({ kind: 'PROPOSAL', sentence: 'supply 100 USDC to Aave on Base', command: { type: 'ADD_SUPPLY', input: { network: 'Base', beneficiary: TEST_WALLET } } });
    expect(supply.notes.join(' ')).toContain('Real funds on Base');
    expectParity(s, supply.command!, supply.sentence!);
    const bridge = new CopilotSession().say('Move 20 USDC from Arbitrum over to Base', intent.action(act.bridge({ sourceNetwork: 'ARBITRUM', destinationNetwork: 'BASE', asset: 'USDC', amount: '20' })))!;
    expect(bridge).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 20 USDC from Arbitrum to Base via auto slippage 50 bps', command: { type: 'ADD_ROUTER_BRIDGE' } });
    const out = new CopilotSession().say('Move 5 USDG from Robinhood to Base', intent.action(act.bridge({ sourceNetwork: 'ROBINHOOD', destinationNetwork: 'BASE', asset: 'USDG', amount: '5' })))!;
    expect(out).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 5 USDG from Robinhood Chain to Base via auto slippage 50 bps' });
    const wrongToken = new CopilotSession().say('Bridge 5 USDC from Robinhood to Base', intent.action(act.bridge({ sourceNetwork: 'ROBINHOOD', destinationNetwork: 'BASE', asset: 'USDC', amount: '5' })))!;
    expect(wrongToken).toMatchObject({ kind: 'UNSUPPORTED' });
    expect(wrongToken.text).toContain('bridges USDG only');
  });
  it('edits, refers to and removes catalog steps with the Canvas commands', () => {
    const s = new CopilotSession();
    s.say('Please swap 100 USDC for cbBTC on Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'cbBTC', amount: '100' })));
    s.apply();
    const edited = s.say('make the swap 200', intent.edit({ amount: '200' }, { step: 'SWAP' }))!;
    expect(edited).toMatchObject({ kind: 'PROPOSAL', command: { type: 'SET_CRYPTO_ACTION', input: { amount: '200', selection: { network: 'Base', from: 'USDC', to: 'cbBTC' } } } });
    // A transfer stays alone in its workflow (TRANSFER_ISOLATED_ONLY), so it is referred to in its own session.
    const t = new CopilotSession();
    t.say(`Please send 1 USDC on Base over to ${RECIPIENT}`, intent.action(act.transfer({ network: 'BASE', asset: 'USDC', amount: '1', recipient: RECIPIENT })));
    t.apply();
    const amended = t.say('make the transfer 2', intent.edit({ amount: '2' }, { step: 'TRANSFER' }))!;
    expect(amended).toMatchObject({ kind: 'PROPOSAL', command: { type: 'SET_RH_TRANSFER', input: { amount: '2', network: 'Base', recipient: RECIPIENT } } });
    t.dismiss();
    const removed = t.say('remove the transfer', intent.remove({ step: 'TRANSFER' }))!;
    expect(removed).toMatchObject({ kind: 'PROPOSAL', command: { type: 'REMOVE' } });
  });
  it('answers in Portuguese with the same proposal', () => {
    const reply = new CopilotSession().say('Quero trocar 100 USDC por cbBTC na Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'cbBTC', amount: '100' }), 'PT'))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 100 USDC to cbBTC on Base slippage 50 bps' });
    expect(reply.notes.join(' ')).toContain('Fundos reais na Base');
  });
});
