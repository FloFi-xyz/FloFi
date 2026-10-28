// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookHarness, deferred } from '../test-utils/hook-harness';
import { reviewFixture, reviewNow } from '../test-utils/review-fixture';
import { useExecutionControls, type ExecutionControlsState } from './execution-controls';

vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
let host: HookHarness, props: ExecutionControlsState;
const read = () => host.render(() => useExecutionControls(props));
beforeEach(() => {
  host = new HookHarness(); vi.useFakeTimers(); vi.setSystemTime(reviewNow);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
  vi.stubGlobal('document', new EventTarget());
  props = { ...reviewFixture(), execution: { ready: true, started: false, start: vi.fn(), prompt: null, expiresAt: null } };
  props.authorization.accepted = true;
});
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('shared Canvas execution controls', () => {
  it('ends a lost read response after the observation deadline, preserves recovery and never broadcasts', async () => {
    props.progress = { started: true, restored: true, local: false, steps: [], active: null, completed: 0,
      label: 'Recovered', message: '', state: 'uncertain', runKey: 'recorded', fingerprint: 'recorded', busy: false };
    const first = deferred<void>(), second = deferred<void>();
    props.recovery = { action: 'observe', checking: false, recordOnly: false, operationId: null,
      label: 'Recovered', message: '', contextIssue: null, check: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise) };
    read().checkStatus(); expect(read().verifying).toBe(true);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(read().verifying).toBe(false); expect(read().checkFailed).toBe(true);
    read().checkStatus(); expect(read().verifying).toBe(true);
    first.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(read().verifying).toBe(true);
    second.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(read().verifying).toBe(false); expect(props.execution.start).not.toHaveBeenCalled();
  });
  it('retains the submission lock across clicks and stage rerenders until recorded state changes', () => {
    const pending = deferred<void>(); props.execution.start = vi.fn(() => pending.promise);
    read().request(false); read().request(false);
    props = { ...props }; read().request(false);
    expect(props.execution.start).toHaveBeenCalledTimes(1); expect(read().requesting).toBe(true);
    Object.assign(props.source.state, { busy: true }); read();
    Object.assign(props.source.state, { busy: false }); expect(read().requesting).toBe(false);
  });
  it('rechecks expiry at the click boundary without asking the wallet', () => {
    const controls = read(); vi.setSystemTime(reviewNow + 120001); controls.request(false);
    expect(props.execution.start).not.toHaveBeenCalled();
  });
  it('unlocks a rejected request without automatically retrying it', async () => {
    props.execution.start = vi.fn(async () => { throw Error('WALLET_REFUSED'); });
    read().request(false); await Promise.resolve(); await Promise.resolve();
    expect(read().requestFailed).toBe(true); expect(read().requesting).toBe(false);
    expect(props.execution.start).toHaveBeenCalledTimes(1);
  });
  it('finishes a synchronous observation check and never submits a financial request', async () => {
    props.progress = { started: true, restored: true, local: false, steps: [], active: null, completed: 0,
      label: 'Recovered', message: '', state: 'uncertain', runKey: 'recorded', fingerprint: 'recorded', busy: false };
    props.recovery = { action: 'observe', checking: false, recordOnly: false, operationId: null,
      label: 'Recovered', message: '', contextIssue: null, check: vi.fn() };
    read().checkStatus(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(read().verifying).toBe(false); expect(props.recovery.check).toHaveBeenCalledTimes(1);
    expect(props.execution.start).not.toHaveBeenCalled();
  });
});
/** BUILD-SOLANA-TRANSFER-UX-001: Authorize in wallet = accept the current Review, then the first wallet request; nothing else ever chains. */
describe('Authorize in wallet', () => {
  const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  beforeEach(() => { props.authorization.accepted = false; });
  it('accepts the Review, then requests the reviewed wallet confirmation exactly once and reports the start', async () => {
    const after = vi.fn();
    props.authorization.approve = vi.fn(async () => { props.authorization = { ...props.authorization, accepted: true }; });
    read().authorize(after); read().authorize(after);
    expect(props.authorization.approve).toHaveBeenCalledTimes(1); expect(read().authorizing).toBe(true);
    expect(props.execution.start).not.toHaveBeenCalled();
    await flush(); props = { ...props }; read();
    expect(props.execution.start).toHaveBeenCalledTimes(1); expect(after).toHaveBeenCalledTimes(1);
    expect(read().authorizing).toBe(false); expect(read().requesting).toBe(true);
  });
  it('requests nothing when the Review is refused', async () => {
    props.authorization.approve = vi.fn(async () => { Object.assign(props.source.state, { error: 'REVIEW_REFUSED' }); });
    read().authorize(); await flush(); props = { ...props }; read();
    expect(props.execution.start).not.toHaveBeenCalled(); expect(read().authorizing).toBe(false); expect(read().requestFailed).toBe(true);
  });
  it('never carries the click over to a newer simulation that replaced the authority', async () => {
    props.authorization.approve = vi.fn(async () => { props.authorization = { ...props.authorization, key: 'newer-review', accepted: true }; });
    read().authorize(); await flush(); props = { ...props }; read();
    expect(props.execution.start).not.toHaveBeenCalled(); expect(read().authorizing).toBe(false);
  });
  it('requests nothing when the accepted authority cannot start (execution unavailable)', async () => {
    props.execution.ready = false;
    props.authorization.approve = vi.fn(async () => { props.authorization = { ...props.authorization, accepted: true }; });
    read().authorize(); await flush(); props = { ...props }; read();
    expect(props.execution.start).not.toHaveBeenCalled(); expect(read().authorizing).toBe(false); expect(read().requestFailed).toBe(false);
  });
  it('rechecks freshness at the click and approves nothing after expiry', () => {
    props.authorization.approve = vi.fn();
    const controls = read(); vi.setSystemTime(reviewNow + 120001); controls.authorize();
    expect(props.authorization.approve).not.toHaveBeenCalled(); expect(props.execution.start).not.toHaveBeenCalled();
  });
  it('with the Review already accepted, is the wallet request alone', () => {
    props.authorization.accepted = true; props.authorization.approve = vi.fn();
    read().authorize();
    expect(props.authorization.approve).not.toHaveBeenCalled(); expect(props.execution.start).toHaveBeenCalledTimes(1);
  });
  it.each(['wallet', 'network', 'proposal gate', 'expiry'] as const)('does not request a signature when %s changes while approval is pending', async change => {
    const approval = deferred<void>();
    props.authorization.approve = vi.fn(() => approval.promise);
    read().authorize();
    props.authorization = { ...props.authorization, accepted: true };
    if (change === 'wallet') props.wallet = { ...props.wallet, account: '0x' + '2'.repeat(40), changed: true };
    if (change === 'network') props.wallet = { ...props.wallet, chain: 'eip155:1', changed: true };
    if (change === 'proposal gate') props.invalidWorkflow = true;
    if (change === 'expiry') vi.setSystemTime(reviewNow + 120001);
    approval.resolve(); await flush(); read();
    expect(props.execution.start).not.toHaveBeenCalled(); expect(read().authorizing).toBe(false);
  });
});
