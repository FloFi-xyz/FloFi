// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001: natural-language Copilot parity on the catalog networks (Base, Robinhood Chain). A Copilot proposal is the very command
 * FloFi's chat parses from the canonical sentence, and that command composes to the same canonical IR and hash on the shared platform as
 * MCP and the channels produce. Every token resolves only in the network's validated catalog and must be the user's own words; real
 * funds are never inferred; an unknown or unloaded catalog fails closed. Nothing here signs, quotes or executes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseLocalCommand, type Command } from './commands';
import { registerNetworkCatalog, resetNetworkCatalogs } from './asset-catalogs';
import { canonicalStrategy } from '../channels/core/strategy';
import { CopilotSession, act, intent } from './copilot-session.test-harness';
import { TEST_WALLET } from './copilot-test-fixtures';
import { BASE_TOKEN_LIST_TEXT, baseAsset, baseCatalog } from '../server/base-mainnet.test-harness';
import { officialCatalog } from '../server/robinhood-mainnet.test-harness';
import { editorReducer } from './editor';
import { setActiveNetworkScope } from './network-scope';

const RECIPIENT = '0x3333333333333333333333333333333333333333';
beforeAll(() => { registerNetworkCatalog(baseCatalog()); registerNetworkCatalog(officialCatalog()); });
afterAll(() => resetNetworkCatalogs());
afterEach(() => setActiveNetworkScope(null));

/** What a message proposes: the Copilot's reply, or (when the exact grammar already parses it, as Chat does) the exact command. */
function proposalOf(session: CopilotSession, text: string, model: Record<string, unknown>): { command: Command; sentence: string; notes: readonly string[] } {
  const reply = session.say(text, model);
  if (reply === null) return { command: session.pending!.command, sentence: text, notes: [] };
  expect(reply, text).toMatchObject({ kind: 'PROPOSAL' });
  return { command: reply.command!, sentence: reply.sentence!, notes: reply.notes };
}
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
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 100 USDC to cbBTC on Base slippage 100 bps', command: { type: 'ADD_CRYPTO_ACTION' } });
    expect(reply.notes.join(' ')).toContain('Real funds on Base');
    expectParity(s, reply.command!, reply.sentence!);
    const node = editorReducer({ workflow: s.workflow, error: null }, reply.command!, s.context).workflow.nodes.at(-1)!;
    expect(JSON.stringify(node)).toContain(baseAsset(baseCatalog(), 'cbBTC').address!);
  });
  it('keeps Base USDC ⇄ WETH on its BUILD-002 sentence and command', () => {
    const s = new CopilotSession();
    const reply = s.say('swap 2 USDC into ETH on Base please', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'ETH', amount: '2' })))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 2 USDC to WETH on Base slippage 100 bps', command: { type: 'ADD_SWAP', direction: 'USDC_TO_WETH' } });
    expect(reply.notes.join(' ')).toContain('not native ETH');
  });
  it('grounds a Robinhood Stock Token by its symbol or its full catalog name, never by the model alone', () => {
    const s = new CopilotSession();
    const byName = s.say('Buy Tesla with 50 USDG on Robinhood Chain', intent.action(act.swap({ network: 'ROBINHOOD', inputAsset: 'USDG', outputAsset: 'TSLA', amount: '50' })))!;
    expect(byName).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 50 USDG to TSLA on Robinhood Chain slippage 100 bps', command: { type: 'ADD_CRYPTO_ACTION' } });
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
    setActiveNetworkScope('PUBLIC_MAINNET');
    const unnamed = new CopilotSession().say('Send 5 USDC to ' + RECIPIENT, intent.action(act.transfer({ asset: 'USDC', amount: '5', recipient: RECIPIENT })))!;
    // Audit A9: the Ethereum Sepolia and Robinhood Chain Testnet self-transfers are not offered until the owner approves their agent rollout.
    // BUILD-FLOFI-MAINNET-PRODUCT-001: public product offers mainnets only (Solana Devnet is engineering).
    expect(unnamed).toMatchObject({ kind: 'CLARIFICATION', options: ['Base', 'Arbitrum One', 'Ethereum', 'Solana', 'Robinhood Chain'] });
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
    expect(bridge).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 20 USDC from Arbitrum to Base via auto slippage 100 bps', command: { type: 'ADD_ROUTER_BRIDGE' } });
    const out = new CopilotSession().say('Please move 5 USDG from Robinhood to Base', intent.action(act.bridge({ sourceNetwork: 'ROBINHOOD', destinationNetwork: 'BASE', asset: 'USDG', amount: '5' })))!;
    expect(out).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 5 USDG from Robinhood Chain to Base via auto slippage 100 bps' });
    const wrongToken = new CopilotSession().say('Bridge 5 USDC from Robinhood to Base', intent.action(act.bridge({ sourceNetwork: 'ROBINHOOD', destinationNetwork: 'BASE', asset: 'USDC', amount: '5' })))!;
    // BUILD-CROSSCHAIN-UNIVERSAL-001: another token on a mainnet route is a universal bridge, so the refusal is now the catalog's own: USDC does not exist on
    // Robinhood Chain. A token that does (WETH) is proposed as a universal bridge with the same canonical workflow every surface composes.
    expect(wrongToken).toMatchObject({ kind: 'UNSUPPORTED' });
    expect(wrongToken.text).toContain('not in the official Robinhood Chain catalog');
    const s2 = new CopilotSession();
    const universal = s2.say('Please move 0.5 WETH from Robinhood over to Base', intent.action(act.bridge({ sourceNetwork: 'ROBINHOOD', destinationNetwork: 'BASE', asset: 'WETH', amount: '0.5' })))!;
    expect(universal).toMatchObject({ kind: 'PROPOSAL', sentence: 'bridge 0.5 WETH from Robinhood Chain to Base receive WETH via best slippage 100 bps', command: { type: 'ADD_UNIVERSAL_BRIDGE' } });
    expectParity(s2, universal.command!, universal.sentence!);
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
  // BUILD-BASE-001 (owner addendum): one shared asset resolver. A symbol in any case or the whole catalog name of exactly one asset, always in the
  // named network's catalog; ambiguity is asked, an unknown token refused, a name never silently replaced.
  it('resolves "Tesla" by its catalog name, in English or Portuguese, to the same canonical TSLA swap as the symbol and the exact grammar', () => {
    const turns = [
      ['Buy Tesla with 50 USDG on Robinhood Chain', 'Tesla', 'EN'],
      ['Compre ações da Tesla com 50 USDG na Robinhood', 'Tesla', 'PT'],
      ['Swap 50 USDG for TSLA on Robinhood Chain', 'TSLA', 'EN'],
      ['swap 50 usdg for tsla on robinhood', 'tsla', 'EN'],
    ] as const;
    const tsla = baseAsset(officialCatalog(), 'TSLA');
    const proposals = turns.map(([text, outputAsset, language]) => {
      const session = new CopilotSession();
      const proposal = proposalOf(session, text, intent.action(act.swap({ network: 'ROBINHOOD', inputAsset: /usdg/.test(text) ? 'usdg' : 'USDG', outputAsset, amount: '50' }), language));
      expect(proposal.command, text).toMatchObject({ type: 'ADD_CRYPTO_ACTION' });
      expectParity(session, proposal.command, 'swap 50 USDG to TSLA on Robinhood Chain slippage 100 bps');
      const node = editorReducer({ workflow: session.workflow, error: null }, proposal.command, session.context).workflow.nodes.at(-1)!;
      expect(JSON.stringify(node)).toContain(tsla.address!);
      const shared = canonicalStrategy(proposal.command);
      return { ...proposal, node: JSON.stringify(node), hash: shared.ok ? shared.workflowHash : shared.code };
    });
    // The natural-language turns are the Copilot's; the exact sentences are Chat's own grammar. One canonical command, node and platform
    // workflow hash, whichever way the user named the token.
    expect(proposals.map(p => p.sentence).slice(0, 2)).toEqual(['swap 50 USDG to TSLA on Robinhood Chain slippage 100 bps', 'swap 50 USDG to TSLA on Robinhood Chain slippage 100 bps']);
    expect(new Set(proposals.map(p => JSON.stringify(p.command))).size).toBe(1);
    expect(new Set(proposals.map(p => p.node)).size).toBe(1);
    expect(new Set(proposals.map(p => p.hash)).size).toBe(1);
    expect(proposals[0]!.hash).toMatch(/^0x[0-9a-f]{64}$/);
    // A name is never replaced silently: the reply says which catalog asset it is, in the user's language.
    expect(proposals[0]!.notes.join(' ')).toContain('“Tesla” is TSLA (Tesla) in the official Robinhood Chain catalog.');
    expect(proposals[1]!.notes.join(' ')).toContain('“Tesla” é TSLA (Tesla) no catálogo oficial da Robinhood Chain.');
  });
  it('resolves a non-featured Stock Token by its company name (Salesforce → CRM, Coinbase → COIN)', () => {
    for (const [name, symbol] of [['Salesforce', 'CRM'], ['Coinbase', 'COIN']] as const) {
      expect(['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN']).not.toContain(symbol);
      const s = new CopilotSession();
      const reply = s.say(`Buy ${name} with 20 USDG on Robinhood Chain`, intent.action(act.swap({ network: 'ROBINHOOD', inputAsset: 'USDG', outputAsset: name, amount: '20' })))!;
      expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: `swap 20 USDG to ${symbol} on Robinhood Chain slippage 100 bps` });
      expectParity(s, reply.command!, reply.sentence!);
    }
  });
  it('keeps chain context mandatory: the same name means nothing on another network, and no network is never guessed', () => {
    const base = new CopilotSession().say('Buy Tesla with 50 USDC on Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'Tesla', amount: '50' })))!;
    expect(base).toMatchObject({ kind: 'UNSUPPORTED' });
    expect(base.text).toContain('Tesla is not in the official Base catalog');
    const unnamed = new CopilotSession().say('Buy Tesla with 50 USDG', intent.action(act.swap({ network: null, inputAsset: 'USDG', outputAsset: 'Tesla', amount: '50' })))!;
    expect(unnamed).toMatchObject({ kind: 'CLARIFICATION' });
    expect(unnamed.command).toBeUndefined();
    // On Base, "Coinbase" is only a fragment of "Coinbase Wrapped BTC": refused, not completed.
    const fragment = new CopilotSession().say('Swap 10 USDC for Coinbase on Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'Coinbase', amount: '10' })))!;
    expect(fragment).toMatchObject({ kind: 'UNSUPPORTED' });
  });
  it('asks when a name belongs to more than one asset, and never trusts a name the user did not write', () => {
    const data = JSON.parse(BASE_TOKEN_LIST_TEXT) as { tokens: Record<string, unknown>[] };
    data.tokens = data.tokens.map(token => token.symbol === 'DEGEN' ? { ...token, name: 'Aerodrome' } : token);
    registerNetworkCatalog(baseCatalog(JSON.stringify(data)));
    try {
      const ambiguous = new CopilotSession().say('Swap 10 USDC for Aerodrome on Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'Aerodrome', amount: '10' })))!;
      expect(ambiguous).toMatchObject({ kind: 'CLARIFICATION', options: ['AERO', 'DEGEN'] });
      expect(ambiguous.text).toContain('names more than one token in the official Base catalog');
      expect(ambiguous.command).toBeUndefined();
    } finally { registerNetworkCatalog(baseCatalog()); }
    const invented = new CopilotSession().say('Buy the electric car company with 50 USDG on Robinhood Chain', intent.action(act.swap({ network: 'ROBINHOOD', inputAsset: 'USDG',
      outputAsset: 'Tesla', amount: '50' })))!;
    expect(invented).toMatchObject({ kind: 'CLARIFICATION' });
    expect(invented.command).toBeUndefined();
  });
  it('resolves Base tokens by their list name in normal language, for swaps, pools and transfers alike', () => {
    const swap = new CopilotSession().say('Please swap 100 USDC for some Coinbase Wrapped BTC on Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC',
      outputAsset: 'Coinbase Wrapped BTC', amount: '100' })))!;
    expect(swap).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 100 USDC to cbBTC on Base slippage 100 bps' });
    const pool = new CopilotSession().say('Put 100 USDC and 50 Aerodrome into a pool on Base at 0.3%', intent.action(act.catalogLiquidity({ network: 'BASE',
      deposits: [{ asset: 'USDC', maxAmount: '100' }, { asset: 'Aerodrome', maxAmount: '50' }], feeTier: '0.3' })))!;
    expect(pool).toMatchObject({ kind: 'PROPOSAL', sentence: 'add liquidity 100 USDC and 50 AERO on Base fee 0.3% slippage 100 bps' });
    const send = new CopilotSession().say(`Please send 3 Toshi on Base over to ${RECIPIENT}`, intent.action(act.transfer({ network: 'BASE', asset: 'Toshi', amount: '3', recipient: RECIPIENT })))!;
    expect(send).toMatchObject({ kind: 'PROPOSAL', sentence: `transfer 3 TOSHI on Base to ${RECIPIENT}` });
    for (const reply of [swap, pool, send]) expectParity(new CopilotSession(), reply.command!, reply.sentence!);
  });
  it('answers in Portuguese with the same proposal', () => {
    const reply = new CopilotSession().say('Quero trocar 100 USDC por cbBTC na Base', intent.action(act.swap({ network: 'BASE', inputAsset: 'USDC', outputAsset: 'cbBTC', amount: '100' }), 'PT'))!;
    expect(reply).toMatchObject({ kind: 'PROPOSAL', sentence: 'swap 100 USDC to cbBTC on Base slippage 100 bps' });
    expect(reply.notes.join(' ')).toContain('Fundos reais na Base');
  });
});
