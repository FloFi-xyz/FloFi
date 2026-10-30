// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-002: execution plans and the four handoff facts (supported by code, enabled by deployment, enabled by policy,
 * demonstrated evidence). Mainnet is refused by POLICY only: the same composition, plan and schema proceed when an isolated
 * policy lists the network, REAL_FUNDS survives, and evidence is reported but never a gate.
 */
import { describe, expect, it } from 'vitest';
import { PREVIEW_METHODS } from '../../backend/preview.ts';
import { FLOWS, type FlowName } from '../../backend/flows.ts';
import { composeStrategy, type Composition } from '../engine/strategy-engine';
import { STRATEGY_EXAMPLES } from '../engine/strategy-examples';
import type { StrategySpec } from '../engine/strategy-spec';
import { evaluateGates, executionPlan, FLOWS_WITH_EXECUTION_SWITCH, policyGate, readHandoffPolicy, type HandoffPolicy } from './execution.ts';
import { PENDING_AGENT_CAPABILITIES } from '../domain/agent-rollout';
import type { McpRuntime } from './runtime.ts';
import type { ExecutionStorage } from '@defi-workflow-engine/reference-executor';

const compose = (spec: unknown): Composition => { const c = composeStrategy(spec); if (!c.ok) throw new Error(c.code); return c; };
const example = (id: string) => STRATEGY_EXAMPLES.find(e => e.id === id)!.strategy;
const DEFAULT = readHandoffPolicy({});
/** Audit A9: the preserved implementation evaluated as if the owner had approved its agent rollout (no deployment can set this). */
const rolledOut = (policy: HandoffPolicy): HandoffPolicy => policy.ok ? { ...policy, agentRollout: PENDING_AGENT_CAPABILITIES } : policy;
function runtime(modes: Partial<Record<FlowName, 'live' | 'harness' | 'off'>>, switches: Partial<Record<FlowName, boolean>> = {}, kind: McpRuntime['kind'] = 'embedded'): McpRuntime {
  const never = async (): Promise<never> => { throw new Error('NOT_IN_THIS_TEST'); };
  return { kind, mode: async flow => modes[flow] ?? 'off', info: async flow => flow in switches ? { executionEnabled: switches[flow]! } : null,
    preview: never, run: never, journal: never, evidence: never };
}

describe('BUILD-MCP-002 handoff policy', () => {
  it('public deployments offer all registered mainnets without a network whitelist and never permit test funds', () => {
    const policy = readHandoffPolicy({ VERCEL: '1', FLOFI_NETWORK_SCOPE: 'ENGINEERING_TESTNETS', FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base' });
    expect(policy).toMatchObject({ ok: true, testFunds: false });
    expect(policy.ok && policy.mainnetNetworks).toEqual(['base', 'arbitrum-one', 'ethereum', 'solana', 'robinhood']);
    expect(readHandoffPolicy({ FLOFI_NETWORK_SCOPE: undefined })).toEqual(policy);
  });
  it('defaults to test funds on and every mainnet off', () => {
    expect(DEFAULT).toEqual({ ok: true, testFunds: true, mainnetNetworks: [] });
    expect(readHandoffPolicy({ FLOFI_MCP_HANDOFF_TEST_FUNDS: 'disabled', FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'solana, base,base' }))
      .toEqual({ ok: true, testFunds: false, mainnetNetworks: ['solana', 'base'] });
  });
  it('fails closed on anything malformed, including a testnet listed as a mainnet', () => {
    for (const env of [{ FLOFI_MCP_HANDOFF_TEST_FUNDS: 'yes' }, { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base-sepolia' }, { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'solana-devnet' },
      { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'ethereum-sepolia' }, { FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'all' }])
      expect(readHandoffPolicy(env), JSON.stringify(env)).toEqual({ ok: false, code: 'MCP_HANDOFF_POLICY_INVALID' });
  });
  it('accepts Ethereum only when explicitly listed in the mainnet handoff policy', () => {
    expect(readHandoffPolicy({ FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'ethereum' }))
      .toEqual({ ok: true, testFunds: true, mainnetNetworks: ['ethereum'] });
  });
});

describe('BUILD-MCP-002 execution plans', () => {
  it('maps every supported strategy to an existing flow, the lending composition to its executor, and nothing nearby', () => {
    const plans = Object.fromEntries(STRATEGY_EXAMPLES.map(e => [e.id, executionPlan(compose(e.strategy))]));
    // BUILD-BASE-001 (intentional change): the Base swap (reference pair included) is the Base catalog-network swap flow.
    expect(plans['swap-base']).toMatchObject({ kind: 'SINGLE_FLOW', flow: 'base-swap', reason: null, fundsClass: 'REAL_FUNDS' });
    expect(plans['lending-composition-base-sepolia']).toMatchObject({ kind: 'COMPOSITE_FLOW', flow: 'lending-composition', fundsClass: 'TEST_FUNDS',
      steps: [{ index: 0, action: 'supply', nodeIds: ['lending-supply'] }, { index: 1, action: 'borrow', nodeIds: ['lending-borrow'] }, { index: 2, action: 'swap', nodeIds: ['lending-swap'] }] });
    expect(plans['bridge-base-arbitrum-one']).toMatchObject({ kind: 'SINGLE_FLOW', flow: 'crosschain-router', networks: ['base', 'arbitrum-one'], networkEnvironment: 'MAINNET',
      fundsClass: 'REAL_FUNDS', steps: [{ index: 0, action: 'bridge', network: 'base', destinationNetwork: 'arbitrum-one', nodeIds: ['node-002'] }] });
    expect(plans['add-liquidity-solana-devnet']).toMatchObject({ kind: 'SINGLE_FLOW', flow: 'orca-liquidity', networkEnvironment: 'PUBLIC_TESTNET', fundsClass: 'TEST_FUNDS' });
    for (const [id, plan] of Object.entries(plans)) {
      if (plan.kind === 'SINGLE_FLOW') expect(plan.steps, id).toHaveLength(1);
      // Steps never include the editor's authoring-only template node.
      expect(plan.steps.flatMap(s => s.nodeIds), id).not.toContain('node-001');
    }
  });
  it.each([
    ['supply-ethereum', 'ethereum-aave'], ['borrow-ethereum', 'ethereum-aave'], ['repay-ethereum', 'ethereum-aave'], ['withdraw-ethereum', 'ethereum-aave'],
    ['swap-ethereum', 'ethereum-swap'], ['transfer-ethereum', 'ethereum-mainnet-transfer'], ['add-liquidity-ethereum', 'ethereum-liquidity'],
    ['bridge-ethereum-base', 'crosschain-router-ethereum-to-base'], ['bridge-base-ethereum', 'crosschain-router-base-to-ethereum'],
    ['bridge-ethereum-arbitrum', 'crosschain-router-ethereum-to-arbitrum'], ['bridge-arbitrum-ethereum', 'crosschain-router-arbitrum-to-ethereum'],
    ['bridge-ethereum-robinhood', 'crosschain-router-ethereum-to-robinhood'], ['bridge-robinhood-ethereum', 'crosschain-router-robinhood-to-ethereum'],
  ] as const)('%s selects its chain-bound flow and keeps deployment/policy authorization independent', async (id, flow) => {
    const composition = compose(example(id));
    expect(executionPlan(composition)).toMatchObject({ kind: 'SINGLE_FLOW', flow, fundsClass: 'REAL_FUNDS' });
    if (flow !== 'ethereum-mainnet-transfer') expect(PREVIEW_METHODS[flow]).toBe(flow === 'ethereum-swap' ? 'prepare' : 'simulate');
    const policy = readHandoffPolicy({ FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'ethereum,base,arbitrum-one,robinhood' });
    const enabledRuntime = runtime({ [flow]: 'live' }, { [flow]: true });
    const enabled = await evaluateGates(composition, enabledRuntime, policy);
    expect(enabled).toMatchObject({ supportedByCode: { execute: true }, enabledByDeployment: { enabled: true }, enabledByPolicy: { enabled: true } });
    expect((await evaluateGates(composition, enabledRuntime, DEFAULT)).enabledByPolicy.enabled).toBe(false);
    expect((await evaluateGates(composition, runtime({}), policy)).enabledByDeployment.enabled).toBe(false);
    if (FLOWS_WITH_EXECUTION_SWITCH.includes(flow)) {
      expect((await evaluateGates(composition, runtime({ [flow]: 'live' }, { [flow]: false }), policy)).enabledByDeployment)
        .toMatchObject({ enabled: false, reason: 'OWNER_EXECUTION_NOT_ENABLED_IN_DEPLOYMENT' });
    }
  });
  it('keeps the list of flows with an owner-execution switch equal to the flow registry', () => {
    const withInfo = (Object.keys(FLOWS) as FlowName[]).filter(flow => Object.hasOwn(FLOWS[flow].methods, 'info'));
    expect([...FLOWS_WITH_EXECUTION_SWITCH].sort()).toEqual(withInfo.sort());
  });
});

describe('BUILD-MCP-002 handoff gates', () => {
  const testnetBridge = compose(example('bridge-base-sepolia-arbitrum-sepolia')), solanaSwap = compose(example('swap-solana'));
  const mainnetBridge = compose(example('bridge-base-arbitrum-one'));

  it.each([
    [{ GRYLOO_ROBINHOOD_TESTNET: 'live' }, 'robinhood-testnet'],
    [{ GRYLOO_ETHEREUM_SEPOLIA_TRANSFER: 'live' }, 'ethereum-sepolia'],
  ] as const)('the shared testnet transfer flow enables only its configured network (%j)', async (env, enabledNetwork) => {
    const flow = FLOWS['robinhood-transfer'], never = async (): Promise<never> => { throw new Error('NO_RPC_OR_STORAGE'); };
    const storage = { log: {}, leases: {} } as ExecutionStorage;
    const service = flow.create(storage, { rpc: never, mode: 'live', env });
    const info = await service.call('info', []) as { executionEnabled: boolean; networks: string[] };
    expect(info.networks).toEqual([enabledNetwork]);
    const deployment = { ...runtime({ 'robinhood-transfer': 'live' }), info: async () => info };
    for (const network of ['robinhood-testnet', 'ethereum-sepolia']) {
      const gates = await evaluateGates(compose(example(`transfer-${network}`)), deployment, rolledOut(DEFAULT));
      expect(gates.supportedByCode.execute).toBe(true);
      expect(gates.enabledByDeployment.enabled).toBe(network === enabledNetwork);
      expect(gates.handoff).toEqual(network === enabledNetwork ? { allowed: true, reason: null }
        : { allowed: false, reason: 'NETWORK_NOT_ENABLED_IN_DEPLOYMENT' });
    }
    // Without the owner's rollout approval the enabled network is still refused to every agent surface.
    const unreleased = await evaluateGates(compose(example(`transfer-${enabledNetwork}`)), deployment, DEFAULT);
    expect(unreleased.enabledByDeployment.enabled).toBe(true);
    expect(unreleased.enabledByPolicy).toMatchObject({ enabled: false, reason: 'AGENT_ROLLOUT_NOT_APPROVED' });
    expect(unreleased.handoff).toEqual({ allowed: false, reason: 'AGENT_ROLLOUT_NOT_APPROVED' });
    const blocked = await evaluateGates(compose(example(`transfer-${enabledNetwork}`)), deployment,
      rolledOut(readHandoffPolicy({ FLOFI_MCP_HANDOFF_TEST_FUNDS: 'disabled' })));
    expect(blocked.handoff).toEqual({ allowed: false, reason: 'TEST_FUNDS_HANDOFF_DISABLED_BY_POLICY' });
    expect(blocked.demonstratedEvidence).toBe(enabledNetwork === 'ethereum-sepolia' ? 'NONE_DEMONSTRATED' : 'TESTNET_EXECUTED');
  });

  it('refuses a testnet transfer when an older runtime cannot report its per-network enablement', async () => {
    const gates = await evaluateGates(compose(example('transfer-ethereum-sepolia')),
      runtime({ 'robinhood-transfer': 'live' }, { 'robinhood-transfer': true }), DEFAULT);
    expect(gates.handoff).toEqual({ allowed: false, reason: 'EXECUTION_NETWORK_UNKNOWN' });
  });

  it('keeps inherited Orca Mainnet authoring while requiring runtime, deployment and policy independently', async () => {
    const orca = compose(example('add-liquidity-solana')), flow = 'orca-liquidity-mainnet';
    const listed = readHandoffPolicy({ FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'solana' }), policy = rolledOut(listed);
    for (const [deployment, handoffPolicy, reason] of [
      [runtime({}, {}, 'local'), policy, 'MCP_CLOUD_RUNTIME_REQUIRED'],
      [runtime({}), policy, 'FLOW_NOT_ENABLED_IN_DEPLOYMENT'],
      [runtime({ [flow]: 'live' }), policy, 'EXECUTION_SWITCH_UNKNOWN'],
      [runtime({ [flow]: 'live' }, { [flow]: false }), policy, 'OWNER_EXECUTION_NOT_ENABLED_IN_DEPLOYMENT'],
      [runtime({ [flow]: 'live' }, { [flow]: true }), rolledOut(DEFAULT), 'MAINNET_HANDOFF_DISABLED_BY_POLICY'],
      [runtime({ [flow]: 'live' }, { [flow]: true }), policy, null],
      // The owner approved the inherited Orca path for the public conversational product. Runtime and signing gates still apply.
      [runtime({ [flow]: 'live' }, { [flow]: true }), listed, null],
    ] as const) {
      const gates = await evaluateGates(orca, deployment, handoffPolicy);
      expect(gates.supportedByCode).toMatchObject({ execute: true, flow });
      expect(gates.handoff).toEqual({ allowed: reason === null, reason });
      expect(gates.plan.fundsClass).toBe('REAL_FUNDS');
      expect(gates.demonstratedEvidence).toBe('NONE_DEMONSTRATED');
    }
  });

  it('allows a public testnet path enabled by the deployment under the default policy', async () => {
    const gates = await evaluateGates(testnetBridge, runtime({ 'crosschain-router-testnet': 'live' }, { 'crosschain-router-testnet': true }), DEFAULT);
    expect(gates).toMatchObject({ supportedByCode: { execute: true, plan: 'SINGLE_FLOW', flow: 'crosschain-router-testnet', reason: null },
      enabledByDeployment: { enabled: true, mode: 'live', executionSwitch: true, mockedHarness: false, reason: null },
      enabledByPolicy: { enabled: true, fundsClass: 'TEST_FUNDS', reason: null }, handoff: { allowed: true, reason: null } });
  });

  it('refuses mainnet by policy while still reporting that code supports it and the deployment enables it', async () => {
    const gates = await evaluateGates(solanaSwap, runtime({ 'jupiter-swap': 'live' }, { 'jupiter-swap': true }), DEFAULT);
    expect(gates).toMatchObject({ supportedByCode: { execute: true, flow: 'jupiter-swap' }, enabledByDeployment: { enabled: true },
      enabledByPolicy: { enabled: false, fundsClass: 'REAL_FUNDS', networks: ['solana'], reason: 'MAINNET_HANDOFF_DISABLED_BY_POLICY' },
      demonstratedEvidence: 'NONE_DEMONSTRATED', handoff: { allowed: false, reason: 'MAINNET_HANDOFF_DISABLED_BY_POLICY' } });
  });

  it('an isolated policy enabling the network lets the same composition proceed, REAL_FUNDS intact, evidence not a gate', async () => {
    const policy = readHandoffPolicy({ FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'solana' });
    const gates = await evaluateGates(solanaSwap, runtime({ 'jupiter-swap': 'live' }, { 'jupiter-swap': true }), policy);
    expect(gates).toMatchObject({ handoff: { allowed: true }, enabledByPolicy: { fundsClass: 'REAL_FUNDS' }, demonstratedEvidence: 'NONE_DEMONSTRATED',
      plan: { networkEnvironment: 'MAINNET', fundsClass: 'REAL_FUNDS' } });
    // Every mainnet the workflow touches must be listed: a Base → Arbitrum One bridge needs both.
    const router = runtime({ 'crosschain-router': 'live' }, { 'crosschain-router': true });
    expect((await evaluateGates(mainnetBridge, router, readHandoffPolicy({ FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base' }))).handoff)
      .toEqual({ allowed: false, reason: 'MAINNET_HANDOFF_DISABLED_BY_POLICY' });
    expect((await evaluateGates(mainnetBridge, router, readHandoffPolicy({ FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base,arbitrum-one' }))).handoff)
      .toEqual({ allowed: true, reason: null });
  });

  it('reports each deployment reason: flow off, owner execution switched off, switch unknown, local runtime', async () => {
    const reason = async (r: McpRuntime, c = solanaSwap, p: HandoffPolicy = readHandoffPolicy({ FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'solana' })) =>
      (await evaluateGates(c, r, p)).enabledByDeployment.reason;
    expect(await reason(runtime({}))).toBe('FLOW_NOT_ENABLED_IN_DEPLOYMENT');
    expect(await reason(runtime({ 'jupiter-swap': 'live' }, { 'jupiter-swap': false }))).toBe('OWNER_EXECUTION_NOT_ENABLED_IN_DEPLOYMENT');
    expect(await reason(runtime({ 'jupiter-swap': 'live' }))).toBe('EXECUTION_SWITCH_UNKNOWN');
    expect(await reason(runtime({ 'jupiter-swap': 'live' }, { 'jupiter-swap': true }, 'local'))).toBe('MCP_CLOUD_RUNTIME_REQUIRED');
    expect(await reason(runtime({ 'jupiter-swap': 'live' }, { 'jupiter-swap': true }, 'unconfigured'))).toBe('CLOUD_RUNTIME_NOT_CONFIGURED');
    // A flow without a separate switch is governed by its mode alone; the MOCKED harness is reported as such.
    const supply = compose(example('supply-base-sepolia'));
    expect((await evaluateGates(supply, runtime({ 'aave-supply': 'harness' }), DEFAULT)).enabledByDeployment)
      .toMatchObject({ enabled: true, mode: 'harness', executionSwitch: null, mockedHarness: true, reason: null });
  });

  it('refuses what no existing flow executes with the owner\'s wallet, whatever the deployment or policy says', async () => {
    // BUILD-BASE-001: the Base swap now has a flow; another flow's enablement or a permissive policy still never enables it.
    const swapBase = compose(example('swap-base'));
    expect((await evaluateGates(swapBase, runtime({ 'base-sepolia-swap': 'live' }), readHandoffPolicy({ FLOFI_MCP_HANDOFF_MAINNET_NETWORKS: 'base' }))).handoff)
      .toEqual({ allowed: false, reason: 'FLOW_NOT_ENABLED_IN_DEPLOYMENT' });
  });

  it('test funds can be switched off by policy, and an invalid policy refuses everything', () => {
    const plan = executionPlan(testnetBridge);
    expect(policyGate(plan, readHandoffPolicy({ FLOFI_MCP_HANDOFF_TEST_FUNDS: 'disabled' })).reason).toBe('TEST_FUNDS_HANDOFF_DISABLED_BY_POLICY');
    expect(policyGate(plan, readHandoffPolicy({ FLOFI_MCP_HANDOFF_TEST_FUNDS: 'maybe' })).reason).toBe('MCP_HANDOFF_POLICY_INVALID');
  });

  it('every example yields the four facts without touching any flow but mode and info', async () => {
    for (const { id, strategy } of STRATEGY_EXAMPLES) {
      const gates = await evaluateGates(compose(strategy as StrategySpec), runtime({}), DEFAULT);
      expect(Object.keys(gates).sort(), id).toEqual(['demonstratedEvidence', 'enabledByDeployment', 'enabledByPolicy', 'handoff', 'plan', 'supportedByCode']);
    }
  });
});
