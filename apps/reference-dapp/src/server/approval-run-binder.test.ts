// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 (KAN-25): the approval run binder reads nothing (no cookie, no database) for a call that cannot
 * be an approval's run, trusts only the request's verified wallet session, never throws into a simulation, and runs beside the Flight
 * observer so that neither can affect the other.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { templateWorkflow } from '../domain/initial-workflow';
import { UNBOUND_AT_SIMULATION_FLOWS } from '../admin/analytics/channels.ts';
import { bindApprovalRunOfRequest, bindSimulatedRun, type RunBinderDeps } from './approval-run-binder.ts';
import { notifySimulation, observeSimulations, type SimulationCall } from './simulation-observer.ts';

const OWNER = '0x' + 'ab'.repeat(20), SOLANA = 'FhoWjKCL624Pf7nNzfUXD23Egz8QUP8ZqQtP2aNssZmb';
const workflow = { ...templateWorkflow(), workflowId: 'wf-unit', revision: 1 };
const call = (over: Partial<SimulationCall> = {}): SimulationCall => ({ flow: 'base-swap', method: 'simulate', args: [workflow, OWNER], value: { id: 'run-1' }, ...over });
function deps(wallet: string | null) {
  const host = vi.fn(async () => ({ db: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never, tenantId: 'default' }));
  const verifiedWallet = vi.fn(async () => wallet);
  return { host, verifiedWallet, deps: { now: new Date('2026-11-20T10:00:00Z'), host, verifiedWallet } satisfies RunBinderDeps };
}
afterEach(() => { observeSimulations(null); vi.restoreAllMocks(); });

describe('BUILD-FLOFI-ADMIN-ANALYTICS-AND-SOLANA-BATCH-001 approval run binder', () => {
  it('reads no session and no database for a call that cannot be an approval run', async () => {
    // The Admin keeps unbound runs of these flows UNKNOWN because this binder never binds them.
    expect([...UNBOUND_AT_SIMULATION_FLOWS]).toEqual(['pix-payment']);
    for (const over of [{ method: 'review' }, { method: 'quote' }, ...[...UNBOUND_AT_SIMULATION_FLOWS].map(flow => ({ flow })), { flow: 'Base-Swap' }, { args: [{ request: 1 }, OWNER] },
      { args: [workflow, 'not-an-owner'] }, { args: [workflow] }, { value: null }, { value: { id: '' } },
      // A bare quote is not a run: `prepare` names a run only once the owner's own preflight is in it.
      { method: 'prepare', value: { quote: { executionId: 'run-1' } } }] satisfies Partial<SimulationCall>[]) {
      const d = deps(OWNER);
      expect(await bindSimulatedRun(call(over), d.deps), JSON.stringify(over)).toBe('NOT_APPLICABLE');
      expect(d.verifiedWallet).not.toHaveBeenCalled();
      expect(d.host).not.toHaveBeenCalled();
    }
  });

  it('requires the verified session of the owner the call names, of that namespace', async () => {
    const none = deps(null);
    expect(await bindSimulatedRun(call(), none.deps)).toBe('NO_SESSION');
    expect(none.host).not.toHaveBeenCalled();
    const other = deps('0x' + 'cd'.repeat(20));
    expect(await bindSimulatedRun(call(), other.deps)).toBe('NO_SESSION');
    expect(other.host).not.toHaveBeenCalled();
    // EVM addresses compare case-insensitively; a Solana address exactly, against the Solana session.
    const evm = deps(OWNER);
    expect(await bindSimulatedRun(call({ args: [workflow, OWNER.toUpperCase().replace('0X', '0x')] }), evm.deps)).toBe('NO_MATCH');
    expect(evm.verifiedWallet).toHaveBeenCalledWith('eip155');
    const solana = deps(SOLANA);
    expect(await bindSimulatedRun(call({ flow: 'jupiter-swap', args: [workflow, SOLANA] }), solana.deps)).toBe('NO_MATCH');
    expect(solana.verifiedWallet).toHaveBeenCalledWith('solana');
    expect(await bindSimulatedRun(call({ flow: 'jupiter-swap', args: [workflow, '2z8yrtjJc4y3HyF7CE6LXP4KmC2SJV1RKEQtmUtoYZnC'] }), deps(SOLANA).deps)).toBe('NO_SESSION');
    // The `prepare` of a catalog swap names its run once the owner's preflight is in it.
    expect(await bindSimulatedRun(call({ method: 'prepare', value: { quote: { executionId: 'run-2', ownerReview: {} } } }), deps(OWNER).deps)).toBe('NO_MATCH');
  });

  it('never throws into the simulation, and logs only fixed codes', async () => {
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(line => { lines.push(String(line)); return true; });
    // No Next.js request scope here: no session can be read, so nothing is verified, bound or logged.
    await expect(bindApprovalRunOfRequest(call(), {})).resolves.toBeUndefined();
    await expect(bindApprovalRunOfRequest(call({ method: 'review' }), {})).resolves.toBeUndefined();
    expect(lines).toEqual([]);
    // With the owner's verified session: an unreachable database, a failing query, and a binding.
    vi.resetModules();
    vi.doMock('./session-principal.ts', () => ({ currentWalletSession: async () => ({ account: OWNER }), currentSolanaSession: async () => null }));
    const query = vi.fn(), host = vi.fn(async () => ({ db: { query }, tenantId: 'default' }));
    vi.doMock('./platform-state-host.ts', () => ({ platformStateHost: host }));
    const { bindApprovalRunOfRequest: bind } = await import('./approval-run-binder.ts');
    host.mockRejectedValueOnce(new Error('DATABASE_URL_REQUIRED'));
    await expect(bind(call(), {})).resolves.toBeUndefined();
    query.mockRejectedValueOnce(new Error('connection reset by peer at 10.0.0.1'));
    await expect(bind(call(), {})).resolves.toBeUndefined();
    query.mockResolvedValueOnce({ rows: [{ handoff_id: 'apr_' + 'a'.repeat(26), bound: 0 }], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await expect(bind(call(), {})).resolves.toBeUndefined();
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE mcp_handoffs SET run_ids'), ['default', 'apr_' + 'a'.repeat(26), ['run-1']]);
    const outcomes = lines.map(line => JSON.parse(line) as { event: string; outcome: string });
    expect(outcomes.map(line => [line.event, line.outcome])).toEqual([['approval.run_binding', 'unavailable'], ['approval.run_binding', 'failed'],
      ['approval.run_binding', 'bound']]);
    expect(lines.join('')).not.toMatch(/run-1|0xab|wf-unit|base-swap|apr_|10\.0\.0\.1|DATABASE_URL/);
    vi.doUnmock('./session-principal.ts'); vi.doUnmock('./platform-state-host.ts');
  });

  it('runs beside the Flight observer: one failing or hanging never stops the other or the simulation', async () => {
    vi.resetModules();
    type Observer = (call: SimulationCall, env: unknown) => Promise<void>;
    const flight = vi.fn<Observer>(async () => { throw new Error('flight failed'); }), binder = vi.fn<Observer>(async () => undefined);
    vi.doMock('../flight/simulation-evidence', () => ({ recordFlightSimulation: flight }));
    vi.doMock('../server/approval-run-binder', () => ({ bindApprovalRunOfRequest: binder }));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await import('../app/cloud-flow');
    const observed = call(), env = { FLOFI_TEST: '1' };
    await expect(notifySimulation(observed, env)).resolves.toBeUndefined();
    expect(flight).toHaveBeenCalledWith(observed, env);
    expect(binder).toHaveBeenCalledWith(observed, env);
    flight.mockImplementation(async () => undefined); binder.mockImplementation(async () => { throw new Error('binder failed'); });
    await expect(notifySimulation(observed, env)).resolves.toBeUndefined();
    expect(flight).toHaveBeenCalledTimes(2);
    // A hanging binder holds the simulation for at most the observer bound, and the Flight record still runs.
    vi.useFakeTimers();
    try {
      binder.mockImplementation(() => new Promise<void>(() => {}));
      const pending = notifySimulation(observed, env);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toBeUndefined();
      expect(flight).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});
