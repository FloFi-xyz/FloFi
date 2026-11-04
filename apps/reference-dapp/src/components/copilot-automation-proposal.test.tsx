// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { deferred, HookHarness } from '../test-utils/hook-harness';
import { CopilotAutomationProposal } from './copilot-automation-proposal';
import type { AutomationInput } from '../automations/definition';
import type { WorkflowOwner } from '../domain/saved-workflow';
import type { CapabilityView } from '../automations/views';

const f = vi.hoisted(() => ({ overview: vi.fn(), create: vi.fn(), delegation: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks, useId: () => 'mode' }));
vi.mock('../app/automation-action', () => ({ automationOverview: f.overview, createAutomation: f.create }));
vi.mock('../i18n/locale', () => ({ useLocale: () => ({ t: (value: string, ...args: unknown[]) => value.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)])) }) }));
vi.mock('./wallet-proof', () => ({ WalletProof: () => null }));
vi.mock('./delegated-automations', () => ({ DELEGATION_ERROR_TEXT: {}, DelegatedLimitsFlow: () => null,
  useDelegationEnabled: () => true, useDelegation: f.delegation, useDelegationRunner: () => ({ busy: false, messages: null, run: vi.fn() }) }));

const wallet: WorkflowOwner = { namespace: 'eip155', address: '0x' + 'a'.repeat(40) };
const input: AutomationInput = { version: 1, kind: 'SCHEDULED_DCA', name: 'Weekly ETH',
  schedule: { frequency: 'WEEKLY', weekday: 1, time: '09:00', timezone: 'Europe/Lisbon' },
  action: { kind: 'ROUTE', asset: 'ETH', side: 'BUY', network: 'base', amount: '10', slippageBps: 50 },
  limits: { maxAmountPerExecution: '10', maxAmountPerPeriod: { amount: '40', period: 'MONTH' },
    maxOccurrencesPerPeriod: { count: 4, period: 'MONTH' }, cooldownMinutes: 60, maxSlippageBps: 50 }, expiresAt: '2027-01-01T00:00:00Z' };
const capabilities: CapabilityView = { priceSource: 'chainlink', priceEvidence: 'PUBLIC_READ_ONLY', observable: ['ETH'], unavailable: [],
  routes: [{ asset: 'ETH', network: 'base', networkLabel: 'Base', quote: 'USDC', base: 'WETH', executable: true, reason: null, fundsClass: 'REAL_FUNDS' }] };
type Element = ReactElement<{ children?: ReactNode; disabled?: boolean; onClick?: () => Promise<void> | void }>;
function nodes(value: ReactNode): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  return [value as Element, ...nodes((value as Element).props.children)];
}
function textOf(value: ReactNode): string {
  if (Array.isArray(value)) return value.map(textOf).join('');
  return isValidElement(value) ? textOf((value as Element).props.children) : value == null ? '' : String(value);
}
const button = (tree: ReactNode) => nodes(tree).find(node => node.type === 'button' && textOf(node) === 'Create automation')!;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
let host: HookHarness;
beforeEach(() => {
  host = new HookHarness(); vi.resetAllMocks(); f.overview.mockResolvedValue({ ok: true, value: { capabilities } });
  f.create.mockResolvedValue({ ok: true, value: { ruleId: 'persisted-rule' } }); f.delegation.mockReturnValue({ overview: null });
});
afterEach(() => host.unmount());
const read = (owner: WorkflowOwner = wallet, proof?: Parameters<typeof CopilotAutomationProposal>[0]['proof']) =>
  host.render(() => CopilotAutomationProposal({ input, owner, ...(proof ? { proof } : {}), dismiss: vi.fn() }));

describe('Chat automation uses the real owner-scoped management boundary', () => {
  it('checks the server session without prompting or signing and submits the unchanged reviewed manifest', async () => {
    expect(button(read()).props.disabled).toBe(true); await flush();
    const tree = read(); expect(button(tree).props.disabled).toBe(false); expect(f.overview).toHaveBeenCalledExactlyOnceWith(wallet);
    // Account management permission is not promoted to the independent delegated signing proof.
    expect(f.delegation).toHaveBeenLastCalledWith(null, false);
    expect(textOf(tree)).toContain('Every Monday at 09:00 (Europe/Lisbon)');
    for (const constraint of ['40 / month', '4 / month', 'Cooldown (minutes)60', 'Max slippage (bps)50', '2027-01-01T00:00:00Z']) expect(textOf(tree)).toContain(constraint);
    await button(tree).props.onClick?.(); await flush();
    expect(f.create).toHaveBeenCalledExactlyOnceWith(wallet, input); expect(textOf(read())).toContain('Automation created. FloFi will ask you before every execution.');
  });
  it('requires proof when the server refuses the selected identity, then retries after proof', async () => {
    f.overview.mockResolvedValueOnce({ ok: false, code: 'WALLET_SESSION_REQUIRED' }); read(); await flush();
    const proof = { proven: null } as unknown as Parameters<typeof CopilotAutomationProposal>[0]['proof'];
    expect(button(read(wallet, proof)).props.disabled).toBe(true); expect(f.create).not.toHaveBeenCalled();
    read(wallet, { ...proof!, proven: wallet.address }); await flush(); expect(button(read(wallet, { ...proof!, proven: wallet.address })).props.disabled).toBe(false);
  });
  it('refuses a session that expires during submit without claiming persistence or losing the draft', async () => {
    read(); await flush(); f.create.mockResolvedValueOnce({ ok: false, code: 'WALLET_SESSION_REQUIRED' });
    await button(read()).props.onClick?.(); await flush();
    const tree = read(); expect(button(tree).props.disabled).toBe(true); expect(textOf(tree)).not.toContain('Automation created.');
    expect(textOf(tree)).toContain('Every Monday at 09:00'); expect(input.action).toMatchObject({ amount: '10' });
  });
  it('ignores a late response for a different wallet and leaves unavailable price capabilities blocked', async () => {
    const old = deferred<{ ok: true; value: { capabilities: CapabilityView } }>(); f.overview.mockReturnValueOnce(old.promise);
    read();
    const other: WorkflowOwner = { ...wallet, address: '0x' + 'b'.repeat(40) };
    f.overview.mockResolvedValue({ ok: false, code: 'WALLET_SESSION_REQUIRED' }); read(other); await flush();
    old.resolve({ ok: true, value: { capabilities } }); await flush(); expect(button(read(other)).props.disabled).toBe(true);
    expect(f.create).not.toHaveBeenCalled();
  });
  it('never creates a monitoring rule when its deployment has no observable price feed', async () => {
    const watch: AutomationInput = { version: 1, kind: 'DAILY_WATCH', name: 'ETH watch', schedule: input.schedule, watch: { assets: ['ETH'] }, expiresAt: null };
    f.overview.mockResolvedValue({ ok: true, value: { capabilities: { ...capabilities, priceSource: 'off', observable: [] } } });
    const render = () => host.render(() => CopilotAutomationProposal({ input: watch, owner: wallet, dismiss: vi.fn() }));
    render(); await flush(); const tree = render(); expect(button(tree).props.disabled).toBe(true);
    expect(textOf(tree)).toContain('FloFi cannot observe this asset’s price on this deployment.'); expect(f.create).not.toHaveBeenCalled();
  });
});
