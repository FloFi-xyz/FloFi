// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { STRATEGY_EXAMPLES } from '../engine/strategy-examples';
import { composeStrategy } from '../engine/strategy-engine';
import { codeCapabilities, strategyInScope, supportedAssets, supportedNetworks } from '../engine/capability-catalog';
import { compileSchema, PUBLIC_NETWORK_IDS, PUBLIC_STRATEGY_ACTIONS, PublicStrategyInputSchema, TEST_NETWORK_IDS, type StrategyInput } from '../engine/strategy-spec';
import { TEST_NETWORK_NOT_AVAILABLE } from '../domain/network-scope';
import { networkIdentity } from '../domain/network-registry';
import { bindStrategy, verifyBinding } from '../automations/binding';
import { readDelegationConfig } from '../delegation/config';
import { composeWorkflowOrRefuse, strategyTestNetworks, validateStrategy } from './strategy.ts';
import { PlatformRefusal } from './refusal.ts';

const refusal = (run: () => unknown) => { try { run(); } catch (cause) { return cause instanceof PlatformRefusal ? { code: cause.message, extra: cause.extra } : cause; } return null; };
const testnetExamples = STRATEGY_EXAMPLES.filter(e => !strategyInScope(e.strategy)), mainnetExamples = STRATEGY_EXAMPLES.filter(e => strategyInScope(e.strategy));
const publicSchema = compileSchema<StrategyInput>(PublicStrategyInputSchema);

describe('BUILD-FLOFI-MAINNET-PRODUCT-001: public composition, discovery and handoff are Mainnet-only', () => {
  it('refuses every test-network strategy in the public product, never mapping it to its mainnet, and composes it in engineering', () => {
    expect(testnetExamples.length).toBeGreaterThan(10);
    for (const { id, strategy } of testnetExamples) {
      const refused = refusal(() => composeWorkflowOrRefuse(strategy, undefined, 'PUBLIC_MAINNET')) as { code: string; extra: { networks: string[]; mainnets: string[] } };
      expect(refused?.code, id).toBe(TEST_NETWORK_NOT_AVAILABLE);
      expect(refused.extra.networks.every(n => TEST_NETWORK_IDS.includes(n as never)), id).toBe(true);
      expect(refused.extra.mainnets.every(n => networkIdentity(n)?.environment === 'MAINNET'), id).toBe(true);
      expect(validateStrategy(strategy, undefined, 'PUBLIC_MAINNET'), id).toMatchObject({ valid: false, code: TEST_NETWORK_NOT_AVAILABLE });
      expect(composeWorkflowOrRefuse(strategy, undefined, 'ENGINEERING').ok, id).toBe(true);
    }
    // A step list with one test-network step is refused as a whole, naming the step.
    const sequence = { version: 2, steps: [mainnetExamples.find(e => e.strategy.action === 'swap')!.strategy, testnetExamples.find(e => e.strategy.action === 'swap')!.strategy] };
    const refused = refusal(() => composeWorkflowOrRefuse(sequence, undefined, 'PUBLIC_MAINNET')) as { code: string; extra: { issues: { path: string }[] } };
    expect(refused.code).toBe(TEST_NETWORK_NOT_AVAILABLE);
    expect(refused.extra.issues.map(i => i.path)).toEqual(['/steps/1/network']);
  });
  it('composes every mainnet strategy unchanged in the public product (same canonical IR and hash as before)', () => {
    for (const { id, strategy } of mainnetExamples) {
      const before = composeStrategy(strategy), after = composeWorkflowOrRefuse(strategy, undefined, 'PUBLIC_MAINNET');
      if (!before.ok) throw new Error(id);
      expect(after.workflowHash, id).toBe(before.workflowHash);
      expect(strategyTestNetworks(after), id).toEqual([]);
    }
  });
  it('offers only mainnets in the public strategy contract, and every public strategy is a valid full-contract strategy', () => {
    const text = JSON.stringify(PublicStrategyInputSchema);
    for (const id of TEST_NETWORK_IDS) expect(text).not.toContain(`"${id}"`);
    expect(text).not.toMatch(/sepolia|devnet|testnet|test USDC|devUSDC|lending_composition/i);
    for (const { id, strategy } of mainnetExamples) expect(publicSchema.check(strategy), id).toBe(true);
    for (const { id, strategy } of testnetExamples) expect(publicSchema.check(strategy), id).toBe(false);
    expect(PUBLIC_NETWORK_IDS.every(id => networkIdentity(id)?.environment === 'MAINNET')).toBe(true);
    expect(PUBLIC_STRATEGY_ACTIONS).not.toContain('lending_composition');
  });
  it('discovers mainnets, their assets and their capability rows only', () => {
    const networks = supportedNetworks('PUBLIC_MAINNET');
    expect(networks.map(n => n.id).sort()).toEqual([...PUBLIC_NETWORK_IDS].sort());
    expect(networks.every(n => n.class === 'MAINNET' && n.funds === 'REAL_FUNDS' && !n.actions.includes('lending_composition'))).toBe(true);
    const assets = supportedAssets('PUBLIC_MAINNET');
    expect(assets.length).toBeGreaterThan(0);
    expect(assets.every(a => PUBLIC_NETWORK_IDS.includes(a.network))).toBe(true);
    expect(assets.some(a => a.symbol === 'devUSDC')).toBe(false);
    expect(supportedAssets('PUBLIC_MAINNET', 'base-sepolia')).toEqual([]);
    const rows = codeCapabilities('PUBLIC_MAINNET');
    expect(rows.length).toBe(mainnetExamples.length);
    expect(rows.every(r => r.funds === 'REAL_FUNDS' && r.publicEnvironment === 'MAINNET')).toBe(true);
    // Engineering certification still sees every registered row.
    expect(codeCapabilities('ENGINEERING').length).toBe(STRATEGY_EXAMPLES.length);
  });
  it('automates mainnet actions only, and a test-network automation proposes nothing more', () => {
    const testnetSwap = testnetExamples.find(e => e.strategy.action === 'swap')!.strategy, mainnetSwap = mainnetExamples.find(e => e.strategy.action === 'swap')!.strategy;
    const env = process.env.FLOFI_NETWORK_SCOPE;
    try {
      delete process.env.FLOFI_NETWORK_SCOPE;
      expect(bindStrategy(testnetSwap)).toEqual({ ok: false, code: TEST_NETWORK_NOT_AVAILABLE });
      expect(bindStrategy(mainnetSwap).ok).toBe(true);
      const composed = composeStrategy(testnetSwap);
      if (!composed.ok) throw new Error('compose');
      expect(verifyBinding({ strategy: composed.strategy, workflowHash: composed.workflowHash })).toEqual({ ok: false, code: TEST_NETWORK_NOT_AVAILABLE });
    } finally { process.env.FLOFI_NETWORK_SCOPE = env; }
    expect(bindStrategy(testnetSwap).ok).toBe(true);
  });
  it('has no delegated execution in the public product (it exists on test networks only)', () => {
    expect(readDelegationConfig({ FLOFI_DELEGATION: 'enabled' })).toMatchObject({ enabled: false, code: 'DELEGATION_NOT_ENABLED', reason: 'MAINNET_ONLY_PRODUCT' });
    expect(readDelegationConfig({ FLOFI_DELEGATION: 'enabled', FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS', VERCEL: '1' })).toMatchObject({ enabled: false });
    expect(readDelegationConfig({ FLOFI_DELEGATION: 'enabled', FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS', FLOFI_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' })).toMatchObject({ enabled: true });
  });
});
