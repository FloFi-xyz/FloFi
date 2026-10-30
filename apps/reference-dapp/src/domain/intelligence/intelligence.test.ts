// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-INTELLIGENCE-001: the pure intelligence layer — Capability API, goal planner, asset resolution, prose grounding, operational state and
 * turn metrics — against FloFi's real registries and the committed token-list fixtures. No network, model, wallet or execution.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTHORING_CAPABILITIES } from '../authoring-capabilities';
import { NETWORKS } from '../network-registry';
import { setActiveNetworkScope } from '../network-scope';
import { CopilotSession, act, intent } from '../copilot-session.test-harness';
import { emptyConversation } from '../copilot-conversation';
import { codeCapabilities } from '../../engine/capability-catalog';
import { composeWorkflow } from '../../engine/strategy-engine';
import { capabilityGap, networkCapabilityProfile, networkCapabilityProfiles, networksWith, universalBridgeNetworks } from './capability-api';
import { fiatCandidates, fiatReference, lookupAsset } from './asset-resolution';
import { planGoal, type Goal } from './goal-planner';
import { goalStrategy } from './goal-strategy';
import { factNumbers, groundedProse } from './grounding';
import { contextCard, contextKey, operationalState, redactCard } from './operational-state';
import { parseTurnMetrics, turnMetrics } from './turn-metrics';
import { registerFixtureCatalogs, resetNetworkCatalogs } from './intelligence.test-harness';

beforeAll(registerFixtureCatalogs);
afterAll(() => { resetNetworkCatalogs(); setActiveNetworkScope(null); });
const goal = (source: Partial<Goal['source']>, target: Partial<Goal['target']>, extra: Partial<Goal> = {}): Goal =>
  ({ source: { network: null, asset: null, amount: null, ...source }, target: { network: null, asset: null, use: 'HOLD', ...target }, preference: null, cap: null, ...extra });
const BENEFICIARY = '0x1111111111111111111111111111111111111111';

describe('Capability API: one registry-driven view per network', () => {
  it('the public scope lists mainnets only, each action from the canonical examples, with code facts from the execution registry', () => {
    const profiles = networkCapabilityProfiles('PUBLIC_MAINNET');
    expect(profiles.map(profile => profile.key)).toEqual(['base', 'arbitrum-one', 'ethereum', 'solana', 'robinhood']);
    expect(profiles.every(profile => profile.environment === 'MAINNET' && profile.availability === 'PUBLIC' && profile.realFunds)).toBe(true);
    const rows = codeCapabilities('PUBLIC_MAINNET');
    for (const profile of profiles) for (const action of profile.actions) {
      expect(AUTHORING_CAPABILITIES.some(capability => capability.network.key === profile.key && capability.action === action.action), `${profile.key}/${action.action}`).toBe(true);
      const row = rows.find(item => item.network === profile.key && item.action === action.action);
      expect(action.eligibility.execute, `${profile.key}/${action.action}`).toBe(Boolean(row?.ownerWalletExecutionImplemented));
      expect(action.eligibility.deployment).toBe('DECIDED_BY_RUNTIME_AT_REVIEW');
      expect(action.requiredParameters.length).toBeGreaterThan(0);
    }
    expect(universalBridgeNetworks('PUBLIC_MAINNET')).toEqual(['base', 'arbitrum-one', 'ethereum', 'solana', 'robinhood']);
  });
  it('engineering certification keeps test networks, marked engineering-only; the public product never offers them', () => {
    const engineering = networkCapabilityProfiles('ENGINEERING');
    expect(engineering.filter(profile => profile.availability === 'ENGINEERING_ONLY').map(profile => profile.key)).toEqual(expect.arrayContaining(['base-sepolia', 'solana-devnet']));
    expect(engineering.every(profile => profile.availability === 'ENGINEERING_ONLY' ? !profile.universalBridge : true)).toBe(true);
    expect(networkCapabilityProfile('PUBLIC_MAINNET', 'base-sepolia')).toBeNull();
    expect(capabilityGap('PUBLIC_MAINNET', 'swap', 'Base Sepolia')).toBe('TEST_NETWORK_NOT_AVAILABLE');
    expect(capabilityGap('PUBLIC_MAINNET', 'swap', 'Optimism')).toBe('NETWORK_UNKNOWN');
    expect(capabilityGap('PUBLIC_MAINNET', 'supply', 'solana')).toBe('ACTION_NOT_ON_NETWORK');
    expect(capabilityGap('PUBLIC_MAINNET', 'add_liquidity', 'solana')).toBeNull();
    expect(capabilityGap('PUBLIC_MAINNET', 'supply', 'Arbitrum One')).toBeNull();
  });
  it('catalog networks report catalog availability; lending binds its registered asset; required parameters come from the strategy schema', () => {
    const base = networkCapabilityProfile('PUBLIC_MAINNET', 'base')!;
    expect(base.actions.find(action => action.action === 'swap')!.assets).toMatchObject({ kind: 'OFFICIAL_CATALOG', loaded: true });
    expect(base.actions.find(action => action.action === 'supply')!.assets).toEqual({ kind: 'LISTED', symbols: ['USDC'] });
    expect(base.actions.find(action => action.action === 'supply')!.requiredParameters).toEqual(['network', 'asset', 'amount', 'beneficiary']);
    expect(base.actions.find(action => action.action === 'repay')!.limitations).toContain('PARTIAL_AMOUNTS_ONLY');
    expect(networksWith('PUBLIC_MAINNET', 'supply')).toEqual(['Base', 'Arbitrum One', 'Ethereum']);
  });
  it('a network is discoverable exactly when the registries give it a certified example (no list is maintained here)', () => {
    const fromRegistry = NETWORKS.filter(network => network.environment === 'MAINNET' && AUTHORING_CAPABILITIES.some(capability => capability.network === network || capability.destination === network))
      .map(network => network.key);
    expect(networkCapabilityProfiles('PUBLIC_MAINNET').map(profile => profile.key)).toEqual(fromRegistry);
  });
});

describe('asset resolution: identity, ambiguity and currencies', () => {
  it('symbols resolve case-insensitively within one network; native ETH and WETH stay distinct', () => {
    for (const written of ['usdc', 'USDC', 'UsDc']) expect(lookupAsset('base', written)).toMatchObject({ kind: 'FOUND', identity: { symbol: 'USDC', native: false } });
    for (const written of ['cbbtc', 'CBBTC']) expect(lookupAsset('base', written)).toMatchObject({ kind: 'FOUND', identity: { symbol: 'cbBTC' } });
    expect(lookupAsset('base', 'eth')).toMatchObject({ kind: 'FOUND', identity: { symbol: 'ETH', native: true, address: null } });
    expect(lookupAsset('base', 'weth')).toMatchObject({ kind: 'FOUND', identity: { symbol: 'WETH', native: false, address: '0x4200000000000000000000000000000000000006' } });
    expect(lookupAsset('solana', 'sol')).toMatchObject({ kind: 'FOUND', identity: { symbol: 'SOL', native: true } });
    expect(lookupAsset('solana', 'usdc')).toMatchObject({ kind: 'FOUND', identity: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' } });
  });
  it('a currency is FIAT with the network\'s own stablecoins, never a token', () => {
    for (const written of ['usd', 'USD', 'dollars', 'dólar', 'US$']) expect(fiatReference(written), written).toBe('USD');
    expect(fiatReference('USDC')).toBeNull();
    expect(lookupAsset('base', 'usd')).toEqual({ kind: 'FIAT', currency: 'USD', candidates: ['USDC', 'USDT', 'USDbC'] });
    expect(fiatCandidates('solana', 'USD')).toEqual(['USDC', 'USDT']);
    expect(fiatCandidates('base', 'EUR')).toEqual(['EURC']);
    expect(fiatCandidates('ethereum', 'BRL')).toEqual([]);
  });
  it('unknown references and networks fail closed with a kind, never a guess', () => {
    expect(lookupAsset('base', 'NOTATOKEN')).toEqual({ kind: 'UNKNOWN' });
    expect(lookupAsset('optimism', 'USDC')).toEqual({ kind: 'UNKNOWN' });
    expect(lookupAsset('nowhere', 'USDC')).toEqual({ kind: 'NETWORK_UNKNOWN' });
  });
});

describe('goal planner: registry-driven steps, reasons and honest refusals', () => {
  const scope = 'PUBLIC_MAINNET' as const;
  it('same network → one swap; same asset → nothing to do', () => {
    expect(planGoal(goal({ network: 'base', asset: 'USDC', amount: '5' }, { network: 'base', asset: 'ETH' }), scope))
      .toMatchObject({ kind: 'PLAN', steps: [{ action: 'swap', network: 'base', inputAsset: 'USDC', outputAsset: 'ETH', amount: '5', fundedBy: null }], reasons: ['SAME_NETWORK_SWAP', 'REAL_FUNDS'] });
    expect(planGoal(goal({ network: 'base', asset: 'USDC', amount: '5' }, { network: 'base', asset: 'usdc' }), scope)).toEqual({ kind: 'NOTHING_TO_DO', network: 'Base', asset: 'USDC' });
  });
  it('another network: a certified route for its asset, else the universal router (which converts inside the route)', () => {
    expect(planGoal(goal({ network: 'base', asset: 'USDC', amount: '5' }, { network: 'arbitrum-one' }), scope))
      .toMatchObject({ kind: 'PLAN', steps: [{ action: 'bridge', routing: null }], reasons: ['CERTIFIED_ROUTE', 'REAL_FUNDS'], alternatives: [{ code: 'UNIVERSAL_BEST' }] });
    expect(planGoal(goal({ network: 'base', asset: 'USDC', amount: '5' }, { network: 'arbitrum-one' }, { preference: 'LOWEST_COST' }), scope))
      .toMatchObject({ kind: 'PLAN', steps: [{ routing: 'BEST' }], reasons: ['UNIVERSAL_ROUTE', 'LOWEST_COST_AT_REVIEW', 'REAL_FUNDS'], alternatives: [{ code: 'CERTIFIED_ROUTE' }] });
    expect(planGoal(goal({ network: 'base', asset: 'USDC', amount: '5' }, { network: 'solana', asset: 'SOL' }), scope))
      .toMatchObject({ kind: 'PLAN', steps: [{ action: 'bridge', outputAsset: 'SOL', routing: 'BEST' }], reasons: ['UNIVERSAL_ROUTE', 'CONVERTS_IN_ROUTE', 'REAL_FUNDS'] });
    expect(planGoal(goal({ network: 'base', asset: 'USDC', amount: '5' }, { network: 'arbitrum-one' }, { preference: 'FASTEST' }), scope))
      .toMatchObject({ kind: 'PLAN', reasons: expect.arrayContaining(['FASTEST_NOT_SELECTABLE']) });
  });
  it('supply: the market network first, a same-asset funded supply capped by the user\'s amount, or the user\'s own cap after a conversion', () => {
    expect(planGoal(goal({ asset: 'USDC' }, { use: 'SUPPLY' }), scope)).toEqual({ kind: 'NEEDS', field: 'targetNetwork', options: ['Base', 'Arbitrum One', 'Ethereum'] });
    expect(planGoal(goal({ network: 'base', asset: 'USDC', amount: '10' }, { network: 'base', use: 'SUPPLY' }), scope))
      .toMatchObject({ kind: 'PLAN', steps: [{ action: 'supply', amount: '10', fundedBy: null }] });
    expect(planGoal(goal({ network: 'base', asset: 'USDC', amount: '10' }, { network: 'arbitrum-one', use: 'SUPPLY' }), scope)).toMatchObject({ kind: 'PLAN',
      steps: [{ action: 'bridge' }, { action: 'supply', amount: '10', fundedBy: 0 }], reasons: expect.arrayContaining(['FUNDED_BY_PREVIOUS_STEP', 'CAP_IS_YOUR_AMOUNT', 'EACH_STEP_REVIEWED']) });
    expect(planGoal(goal({ network: 'base', asset: 'ETH', amount: '0.01' }, { network: 'base', use: 'SUPPLY', asset: 'USDC' }), scope))
      .toEqual({ kind: 'NEEDS', field: 'cap', options: [], step: 1, asset: 'USDC' });
    expect(planGoal(goal({ network: 'base', asset: 'ETH', amount: '0.01' }, { network: 'base', use: 'SUPPLY', asset: 'USDC' }, { cap: '20' }), scope))
      .toMatchObject({ kind: 'PLAN', steps: [{ action: 'swap' }, { action: 'supply', amount: '20', fundedBy: 0 }] });
    expect(planGoal(goal({ network: 'base', asset: 'WETH', amount: '1' }, { network: 'base', use: 'SUPPLY', asset: 'WETH' }), scope)).toMatchObject({ kind: 'UNSUPPORTED', code: 'LENDING_ASSET_NOT_SUPPORTED' });
    expect(planGoal(goal({ network: 'base', asset: 'USDC', amount: '1' }, { network: 'solana', use: 'SUPPLY' }), scope)).toMatchObject({ kind: 'UNSUPPORTED', code: 'LENDING_NOT_ON_NETWORK' });
  });
  it('liquidity retains the goal, asks for position parameters, then composes the conversion and funded position', () => {
    expect(planGoal(goal({ network: 'base' }, { use: 'LIQUIDITY' }), scope)).toEqual({ kind: 'NEEDS', field: 'deposits', options: [] });
    const liquidity = act.liquidity({ network: 'BASE', deposits: [{ asset: 'USDC', maxAmount: '10' }, { asset: 'WETH', maxAmount: '0.005' }], rangeUnit: 'FULL', slippageBps: '50' }) as NonNullable<Goal['liquidity']>;
    const plan = planGoal(goal({ network: 'base', asset: 'USDC', amount: '5' }, { network: 'base', asset: 'WETH', use: 'LIQUIDITY' }, { liquidity }), scope);
    expect(plan).toMatchObject({ kind: 'PLAN', steps: [{ action: 'swap', outputAsset: 'WETH' }, { action: 'add_liquidity', fundedBy: 0, inputAsset: 'WETH' }] });
    if (plan.kind !== 'PLAN') throw new Error('plan expected');
    const strategy = goalStrategy(plan.steps, null);
    expect(strategy.ok).toBe(true);
    if (!strategy.ok) throw new Error('strategy expected');
    expect(strategy.strategy).toMatchObject({ version: 2, bindings: [{ step: 1, amountFrom: 0 }] });
    expect(composeWorkflow(strategy.strategy)).toMatchObject({ ok: true, bindings: [{ step: 1, amountFrom: 0, inputAsset: 'WETH' }] });
    const composed = composeWorkflow(strategy.strategy);
    expect(composed.ok && composed.steps[1]!.strategy).toMatchObject({ slippageBps: 50 });
  });
  it('missing fields are asked one at a time with registry options; test networks, currencies and unknown networks are refused', () => {
    expect(planGoal(goal({}, { network: 'arbitrum-one' }), scope)).toMatchObject({ kind: 'NEEDS', field: 'sourceAsset' });
    expect(planGoal(goal({ asset: 'USDC' }, { network: 'arbitrum-one' }), scope)).toMatchObject({ kind: 'NEEDS', field: 'sourceNetwork', options: ['Arbitrum One', 'Base', 'Ethereum', 'Solana', 'Robinhood Chain'] });
    expect(planGoal(goal({ asset: 'USDC', network: 'base' }, { network: 'arbitrum-one' }), scope)).toEqual({ kind: 'NEEDS', field: 'amount', options: [] });
    expect(planGoal(goal({ asset: 'USDC', network: 'base-sepolia', amount: '1' }, { network: 'arbitrum-sepolia' }), scope)).toMatchObject({ kind: 'UNSUPPORTED', code: 'TEST_NETWORK_NOT_AVAILABLE', network: 'Base Sepolia' });
    expect(planGoal(goal({ asset: 'usd', network: 'base', amount: '1' }, { asset: 'ETH' }), scope)).toMatchObject({ kind: 'UNSUPPORTED', code: 'FIAT_NOT_AN_ASSET' });
    // Optimism is a network FloFi names but authors nothing on: no route reaches it; an unregistered name is unknown.
    expect(planGoal(goal({ asset: 'USDC', network: 'optimism', amount: '1' }, { network: 'base' }), scope)).toMatchObject({ kind: 'UNSUPPORTED', code: 'NO_ROUTE_BETWEEN_NETWORKS' });
    expect(planGoal(goal({ asset: 'USDC', network: 'nowhere', amount: '1' }, { network: 'base' }), scope)).toMatchObject({ kind: 'UNSUPPORTED', code: 'NETWORK_UNKNOWN' });
  });
  it('every plan composes through the deterministic engine as one strategy; funded steps carry typed bindings', () => {
    const plans = [goal({ network: 'base', asset: 'USDC', amount: '5' }, { network: 'base', asset: 'ETH' }), goal({ network: 'base', asset: 'USDC', amount: '5' }, { network: 'solana', asset: 'SOL' }),
      goal({ network: 'base', asset: 'USDC', amount: '10' }, { network: 'arbitrum-one', use: 'SUPPLY' }), goal({ network: 'ethereum', asset: 'USDC', amount: '3' }, { network: 'base' }, { preference: 'LOWEST_COST' })];
    for (const g of plans) {
      const plan = planGoal(g, scope);
      if (plan.kind !== 'PLAN') throw new Error(plan.kind);
      const strategy = goalStrategy(plan.steps, BENEFICIARY);
      if (!strategy.ok) throw new Error(strategy.code);
      const composed = composeWorkflow(strategy.strategy);
      expect(composed.ok, JSON.stringify(g)).toBe(true);
      if (composed.ok) expect(composed.bindings.map(b => [b.step, b.amountFrom])).toEqual(plan.steps.flatMap((step, index) => step.fundedBy === null ? [] : [[index, step.fundedBy]]));
    }
    const supply = planGoal(plans[2]!, scope);
    expect(supply.kind === 'PLAN' && goalStrategy(supply.steps, null)).toEqual({ ok: false, code: 'GOAL_BENEFICIARY_REQUIRED' });
  });
});

describe('grounded prose: every number must be a fact', () => {
  const facts = ['{"expectedOutput":"24.81","fees":[{"amount":"0.12","symbol":"USDC"}],"estimatedDurationSeconds":30}', 'bridge 25 USDC from Base to Solana', '{"slippageBps":100}'];
  it('keeps prose whose numbers are tool facts or the user\'s words (bps and percentages interchangeable, step structure ignored)', () => {
    expect(groundedProse('Step 1 sends 25 USDC; you would receive about 24.81 after a 0.12 USDC fee, in roughly 30 seconds, within 1% slippage.', facts))
      .toMatchObject({ ok: true });
    expect(factNumbers(['100 bps'])).toEqual(new Set(['100', '1', '10000']));
  });
  it('drops invented amounts, fees, APY, links, addresses and authority claims', () => {
    expect(groundedProse('You will earn 7% APY.', facts)).toEqual({ ok: false, reason: 'UNGROUNDED_NUMBER' });
    expect(groundedProse('The fee is 0.50 USDC.', facts)).toEqual({ ok: false, reason: 'UNGROUNDED_NUMBER' });
    expect(groundedProse('See https://example.com', facts)).toEqual({ ok: false, reason: 'UNSAFE' });
    expect(groundedProse('Send to 0x1111111111111111111111111111111111111111', facts)).toEqual({ ok: false, reason: 'UNSAFE' });
    expect(groundedProse('The bridge was executed.', facts)).toEqual({ ok: false, reason: 'UNSAFE' });
    expect(groundedProse('x'.repeat(901), facts)).toEqual({ ok: false, reason: 'TOO_LONG' });
    expect(groundedProse('', facts)).toEqual({ ok: false, reason: 'EMPTY' });
  });
});

describe('operational state and the sanitized context card', () => {
  it('distinguishes validated, carried, corrected and missing fields, and the card carries no address, node id or chain id', () => {
    setActiveNetworkScope('PUBLIC_MAINNET');
    const s = new CopilotSession(); s.walletChainId = 'eip155:8453';
    s.say('please bridge 5 USDC to Arbitrum', intent.action(act.bridge({ destinationNetwork: 'ARBITRUM', asset: 'USDC', amount: '5' })));
    const state = operationalState(s.state, s.env());
    expect(state.request).toMatchObject({ open: true, kind: 'ACTION', operations: ['bridge'], missing: ['sourceNetwork'], asked: { sourceNetwork: 1 }, repeatedQuestions: 0, clarifications: 1 });
    expect(state.request.fields).toEqual(expect.arrayContaining([{ step: 0, field: 'amount', value: '5', status: 'VALIDATED', verification: 'NOT_APPLICABLE' },
      { step: 0, field: 'destinationNetwork', value: 'ARBITRUM', status: 'VALIDATED', verification: 'NOT_APPLICABLE' },
      { step: 0, field: 'sourceNetwork', value: null, status: 'MISSING', verification: 'NOT_APPLICABLE' }]));
    s.say('swap 1 usdc to eth on base'); s.apply();
    s.say('send 1 USDC on Base to 0x2222222222222222222222222222222222222222', intent.action(act.transfer({ network: 'BASE', asset: 'USDC', amount: '1', recipient: '0x2222222222222222222222222222222222222222' })));
    const card = contextCard(operationalState(s.state, s.env()));
    expect(JSON.stringify(card)).not.toMatch(/0x[0-9a-fA-F]{40}|node-\d|eip155:|solana:/);
    expect(card.pending?.summary).toBe('Send 1 USDC · Base');
    expect(contextKey(card)).toBe(contextKey(JSON.parse(JSON.stringify(card)) as typeof card));
    expect(contextKey(card)).not.toBe(contextKey({ ...card, revision: card.revision + 1 }));
    expect(redactCard('to GsWtMd3S5133XPhnfeR1CvPLcLxBSknhVhmaW7fHevBq')).toBe('to [address]');
  });
  it('turn metrics are counters and codes only, and strict parsing refuses anything else', () => {
    const s = new CopilotSession();
    const before = s.state;
    const reply = s.say('please bridge 5 USDC to Arbitrum', intent.action(act.bridge({ destinationNetwork: 'ARBITRUM', asset: 'USDC', amount: '5' })))!;
    const metrics = turnMetrics(before, reply, s.state, 'ACTION', 'WEB');
    expect(metrics).toEqual({ event: 'flofi.copilot.turn', version: 1, surface: 'WEB', outcome: 'CLARIFICATION', code: null, interpreted: 'ACTION', mismatch: true, clarifications: 1,
      repeatedQuestions: 0, corrections: 0, turnsInRequest: 1, proposalSteps: 0 });
    expect(parseTurnMetrics(metrics)).toEqual(metrics);
    expect(parseTurnMetrics({ ...metrics, text: 'bridge 5 USDC' })).toBeNull();
    expect(parseTurnMetrics({ ...metrics, code: 'not a code' })).toBeNull();
    expect(parseTurnMetrics({ ...metrics, clarifications: 1e9 })).toBeNull();
    expect(turnMetrics(emptyConversation(), { kind: 'ANSWER', text: 'x', notes: [], options: [] }, emptyConversation(), 'LOCAL', 'CHANNEL').mismatch).toBe(false);
  });
});
