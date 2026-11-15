// SPDX-License-Identifier: AGPL-3.0-only
// BUILD-FLOFI-MAINNET-PRODUCT-001: "Automate this workflow" on a legacy test-network Canvas workflow is refused in the public product, never
// prefilled onto a mainnet route; engineering certification keeps reading it. Pure reads: nothing is created.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWorkflow } from '../domain/copilot-test-fixtures';
import { TEST_NETWORK_NOT_AVAILABLE } from '../domain/network-scope';
import type { WorkflowOwner } from '../domain/saved-workflow';
import { automationOperation } from '../server/automation-operation';
import { canvasAutomationSteps, replaceAutomationSchedule } from './automation-action';

vi.mock('../server/session-principal', () => ({ currentWalletPrincipals: async () => [{ namespace: 'eip155', address: '0x1111111111111111111111111111111111111111' }] }));
// The operation boundary (owner re-verification, runtime) has its own tests (`server/automation-operation.test.ts`); here only what the action forwards.
vi.mock('../server/automation-operation', () => ({ automationOperation: vi.fn(async () => ({ ok: true, value: 'replaced' })), automationAvailability: vi.fn() }));
const OWNER: WorkflowOwner = { namespace: 'eip155', address: '0x1111111111111111111111111111111111111111' };
afterEach(() => vi.unstubAllEnvs());

const TESTNET = buildWorkflow(['swap 50 USDC to WETH on Base Sepolia slippage 50 bps']);
const MAINNET = buildWorkflow(['swap 50 USDC to WETH on Base slippage 50 bps']);

describe('Automate this workflow in the Mainnet-only product', () => {
  it('refuses a test-network Canvas workflow on a hosted deployment, whatever the opt-in', async () => {
    vi.stubEnv('VERCEL', '1');
    expect(await canvasAutomationSteps(TESTNET)).toEqual({ ok: false, code: TEST_NETWORK_NOT_AVAILABLE });
    const mainnet = await canvasAutomationSteps(MAINNET);
    expect(mainnet.ok).toBe(true);
  });
  it('keeps reading it for engineering certification', async () => {
    const steps = await canvasAutomationSteps(TESTNET);
    expect(steps).toMatchObject({ ok: true, value: { ok: true, steps: [{ route: { network: 'base-sepolia' } }] } });
  });
});

describe('replaceAutomationSchedule (server action)', () => {
  it('forwards exactly the id, version and schedule to the owner-verifying operation boundary', async () => {
    vi.mocked(automationOperation).mockClear();
    expect(await replaceAutomationSchedule(OWNER, 'aut_old', 2, { frequency: 'WEEKLY', weekday: 5, time: '09:30', extra: 'dropped' } as never)).toEqual({ ok: true, value: 'replaced' });
    expect(vi.mocked(automationOperation).mock.calls).toEqual([['replace', ['aut_old', 2, { schedule: { frequency: 'WEEKLY', weekday: 5, time: '09:30' } }], OWNER]]);
  });
  it.each([
    ['a non-string id', [42, 1, { frequency: 'DAILY', weekday: null, time: '07:00' }]],
    ['an unsafe version', ['aut_old', 1.5, { frequency: 'DAILY', weekday: null, time: '07:00' }]],
    ['no schedule', ['aut_old', 1, null]],
    ['an unknown frequency', ['aut_old', 1, { frequency: 'MONTHLY', weekday: null, time: '07:00' }]],
    ['a fractional weekday', ['aut_old', 1, { frequency: 'WEEKLY', weekday: 1.5, time: '07:00' }]],
    ['a non-string time', ['aut_old', 1, { frequency: 'DAILY', weekday: null, time: 700 }]],
  ])('refuses %s without calling the operation', async (_, args) => {
    vi.mocked(automationOperation).mockClear();
    expect(await replaceAutomationSchedule(OWNER, ...(args as unknown as [string, number, never]))).toEqual({ ok: false, code: 'AUTOMATION_INPUT_INVALID' });
    expect(automationOperation).not.toHaveBeenCalled();
  });
});
