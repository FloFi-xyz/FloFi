// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (review DEV-BP-1, DEV-BP-2, DEV-BP-4): the Developer API and a Batch Payment. A production key's approvals
 * offer only the owner's own steps, so a batch (which runs only as one atomic owner-wallet authorization) is never approvable there: the strategy, its
 * validation and the capability rows say exactly what `createApproval` answers, and that answer is a 422 CAPABILITY_NOT_SUPPORTED, never a 500. A batch
 * preview is SIMULATION_REQUIRES_OWNER_BROWSER (as MCP), never "one step at a time". In-memory stores and a MOCKED runtime only: no network, no database.
 */
import { describe, expect, it } from 'vitest';
import { composeWorkflow } from '../engine/strategy-engine';
import { PlatformRefusal, type EngineRuntime, type HandoffStore } from '../platform/index.ts';
import { developerConfig, recordingRuntime } from './developer.test-harness.ts';
import { classify, DeveloperError } from './errors.ts';
import { limitsOf } from './limits.ts';
import { createApproval, createStrategy, listCapabilities, simulateStoredStrategy, validateStoredStrategy, type DeveloperContext } from './service.ts';
import type { DeveloperStore, StrategyRecord } from './store.ts';

const BASE = 'eip155:8453';
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), C = '0x' + 'c3'.repeat(20);
const BATCH = { action: 'batch_payment', network: 'base', asset: 'USDC', recipients: [{ recipient: A, amount: '25' }, { recipient: B, amount: '50' }, { recipient: C, amount: '75' }] };
const TRANSFER = { action: 'transfer', network: 'base', asset: 'USDC', amount: '5', recipient: A };
const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const FLOWS = ['base-mainnet-transfer', 'arbitrum-mainnet-transfer', 'ethereum-mainnet-transfer', 'robinhood-mainnet-transfer', 'solana-transfer'] as const;
/**
 * A live mainnet deployment WITH workflow runs and user-funded groups on Base (KAN-20: and on Solana mainnet, so a Solana batch is refused by the
 * production rule itself, never by a missing chain): a production key still never approves a batch.
 */
const liveRuntime = (): EngineRuntime => ({ ...recordingRuntime({ modes: Object.fromEntries(FLOWS.map(f => [f, 'live'])) as never }),
  info: async () => ({ executionEnabled: true }),
  sequences: async () => ({ enabled: true, delegation: null, userFunded: { enabled: true, code: null, chains: [BASE, SOLANA], bundlerChains: [], solanaNonceAccounts: false, bridgeRoutes: [] } }) } as unknown as EngineRuntime);
/** KAN-20: the owner's acceptance example, three Solana wallets (seed-derived, on curve; never paid), exactly as written. */
const SOL_A = '2CERLkG39Jq8zc8FaVkmHjkpsptwQVFMwzvWQgdtmCzb', SOL_B = 'C4o8DvwfiPWCQPPH4AfDLBtG7vbCixVKYdwj1S4pDrty', SOL_C = '8WcnkMD1aZFGDppfnerV37Fob9W1ij3yHkCL3LWgVKiG';
const SOLANA_BATCH = { action: 'batch_payment', network: 'solana', asset: 'SOL',
  recipients: [{ recipient: SOL_A, amount: '0.01' }, { recipient: SOL_B, amount: '0.02' }, { recipient: SOL_C, amount: '0.03' }] };
function memoryStore(): DeveloperStore {
  const strategies = new Map<string, StrategyRecord>();
  return { createStrategy: async (record, now) => { const stored = { ...record, createdAt: now }; strategies.set(record.strategyId, stored); return stored; },
    strategy: async (scope, id) => { const r = strategies.get(id); return r && r.projectId === scope.projectId && r.environment === scope.environment ? r : null; } } as DeveloperStore;
}
const untouched = new Proxy({}, { get: (_target, key) => key === 'purge' ? async () => 0 : () => { throw new Error('HANDOFF_STORE_TOUCHED'); } }) as unknown as HandoffStore;
function context(environment: 'production' | 'sandbox' = 'production'): DeveloperContext {
  const projectId = 'prj_' + 'a'.repeat(26), scope = { projectId, environment } as const;
  return { config: developerConfig(), tenantId: 'default', principal: { projectId, projectName: 'Live App', environment, keyId: 'key_' + 'b'.repeat(26),
    scopes: ['strategies', 'approvals', 'executions', 'webhooks'], plan: 'free' }, scope, store: memoryStore(), handoffs: untouched, runtime: liveRuntime(),
    limits: limitsOf('free'), allow: async () => true, now: new Date() };
}
async function refusalOf(work: () => Promise<unknown>): Promise<DeveloperError> {
  try { await work(); } catch (error) { if (error instanceof DeveloperError) return error; throw error; }
  throw new Error('NOT_REFUSED');
}

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 review DEV-BP-1: batch refusals are a capability, never an internal error', () => {
  it('classifies both atomic-execution refusals as 422 CAPABILITY_NOT_SUPPORTED with their reason', () => {
    for (const code of ['BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE', 'BATCH_PAYMENT_REQUIRES_ATOMIC_EXECUTION']) {
      const error = classify(new PlatformRefusal(code, { reason: 'USER_FUNDED_NOT_ENABLED' }));
      expect([error.code, error.status, error.reason], code).toEqual(['CAPABILITY_NOT_SUPPORTED', 422, code]);
    }
  });
});

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 review DEV-BP-2: reported approvability matches createApproval for a production key', () => {
  it('a production Batch Payment strategy reports itself not approvable, with the exact reason createApproval then refuses with', async () => {
    const ctx = context();
    const strategy = await createStrategy(ctx, { strategy: BATCH });
    const engine = composeWorkflow(BATCH);
    expect(engine.ok && engine.workflowHash).toBe(strategy.workflowHash);
    expect(strategy.availability).toMatchObject({ approvable: false, reason: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE' });
    const validated = await validateStoredStrategy(ctx, strategy.id);
    expect(validated.availability).toEqual(strategy.availability);
    const refused = await refusalOf(() => createApproval(ctx, { strategyId: strategy.id, workflowHash: strategy.workflowHash }));
    expect([refused.code, refused.status, refused.reason]).toEqual(['CAPABILITY_NOT_SUPPORTED', 422, strategy.availability.reason]);
  });

  it('every production batch capability row says approve is unavailable for that reason; other rows are unchanged by the rule', async () => {
    const ctx = context();
    const rows = (await listCapabilities(ctx, { action: 'batch_payment' })).data;
    // KAN-20: Solana is a Batch Payment network too; the production rule refuses its row exactly as every EVM row.
    expect(rows.map(r => r.network).sort()).toEqual(['arbitrum-one', 'base', 'ethereum', 'robinhood', 'solana']);
    for (const row of rows) expect(row.operations.approve, row.network).toEqual({ available: false, reason: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE' });
    // A single transfer on the same live deployment is still reported approvable (the rule applies to Batch Payments only).
    const transfer = await createStrategy(ctx, { strategy: TRANSFER });
    expect(transfer.availability).toMatchObject({ approvable: true, reason: null });
    const [base] = (await listCapabilities(ctx, { action: 'transfer', network: 'base' })).data;
    expect(base!.operations.approve).toEqual({ available: true, reason: null });
  });
});

/**
 * KAN-20 (WS02 surfaces 9.2 item 12, owner decision 3): the PR #260 production restriction is unchanged and namespace-agnostic. A Solana Batch Payment
 * on a production key is refused exactly as an EVM one, even on a deployment with Solana user-funded groups enabled; the handoff store is never
 * touched (`untouched` throws on any call).
 */
describe('KAN-20: a Solana Batch Payment and a production Developer API key', () => {
  it('reports itself not approvable, and createApproval refuses it with 422 CAPABILITY_NOT_SUPPORTED for that reason', async () => {
    const ctx = context();
    const strategy = await createStrategy(ctx, { strategy: SOLANA_BATCH });
    const engine = composeWorkflow(SOLANA_BATCH);
    expect(engine.ok && engine.workflowHash).toBe(strategy.workflowHash);
    // The recipients are stored exactly as written (never lower-cased).
    expect(JSON.stringify(strategy)).toContain(SOL_A);
    expect(strategy.availability).toMatchObject({ approvable: false, reason: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE' });
    const validated = await validateStoredStrategy(ctx, strategy.id);
    expect(validated.availability).toEqual(strategy.availability);
    const refused = await refusalOf(() => createApproval(ctx, { strategyId: strategy.id, workflowHash: strategy.workflowHash }));
    expect([refused.code, refused.status, refused.reason]).toEqual(['CAPABILITY_NOT_SUPPORTED', 422, 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE']);
  });
  it('its capability row is not approvable for that reason, while a single Solana transfer row keeps its own answer', async () => {
    const ctx = context();
    const rows = (await listCapabilities(ctx, { network: 'solana', action: 'batch_payment' })).data;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.operations.approve).toEqual({ available: false, reason: 'BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE' });
    const [transfer] = (await listCapabilities(ctx, { network: 'solana', action: 'transfer' })).data;
    expect(transfer!.operations.approve.reason).not.toBe('BATCH_PAYMENT_ATOMIC_EXECUTION_UNAVAILABLE');
  });
  it('its preview needs the owner\'s browser, as every Batch Payment', async () => {
    const ctx = context();
    const strategy = await createStrategy(ctx, { strategy: SOLANA_BATCH });
    const refused = await refusalOf(() => simulateStoredStrategy(ctx, strategy.id, {}));
    expect([refused.code, refused.status, refused.reason]).toEqual(['CAPABILITY_NOT_SUPPORTED', 422, 'SIMULATION_REQUIRES_OWNER_BROWSER']);
  });
});

describe('BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 review DEV-BP-4: a Batch Payment preview needs the owner\'s browser', () => {
  it('POST /strategies/{id}/simulate of a batch is CAPABILITY_NOT_SUPPORTED / SIMULATION_REQUIRES_OWNER_BROWSER, never SIMULATE_ONE_STEP_AT_A_TIME', async () => {
    const ctx = context();
    const strategy = await createStrategy(ctx, { strategy: BATCH });
    const refused = await refusalOf(() => simulateStoredStrategy(ctx, strategy.id, {}));
    expect([refused.code, refused.status, refused.reason]).toEqual(['CAPABILITY_NOT_SUPPORTED', 422, 'SIMULATION_REQUIRES_OWNER_BROWSER']);
  });
});
