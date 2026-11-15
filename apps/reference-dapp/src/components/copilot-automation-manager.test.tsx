// SPDX-License-Identifier: AGPL-3.0-only
/** BUILD-FLOFI-UNIFIED-COPILOT-001: the chat's view of saved automations reads through the owner-verified actions and changes only on Confirm. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { HookHarness } from '../test-utils/hook-harness';
import { CopilotAutomationManager } from './copilot-automation-manager';
import type { RuleView } from '../automations/views';
import type { WorkflowOwner } from '../domain/saved-workflow';

const f = vi.hoisted(() => ({ overview: vi.fn(), history: vi.fn(), change: vi.fn(), replace: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
vi.mock('../app/automation-action', () => ({ automationOverview: f.overview, automationHistory: f.history, changeAutomationState: f.change, replaceAutomationSchedule: f.replace }));
vi.mock('../i18n/locale', () => ({ useLocale: () => ({ language: 'EN', t: (value: string, ...args: unknown[]) => value.replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)])) }) }));
vi.mock('./wallet-proof', () => ({ WalletProof: () => 'VERIFY_WALLET' }));

const wallet: WorkflowOwner = { namespace: 'eip155', address: '0x' + 'a'.repeat(40) };
const rule = (id: string, state: RuleView['state'], weekday = 5): RuleView => ({ ruleId: id, name: `DCA ${id}`, kind: 'SCHEDULED_DCA', state, executionMode: 'CONFIRM_EACH_TIME',
  authorizationId: null, version: 3, timezone: 'America/Sao_Paulo', schedule: { frequency: 'WEEKLY', weekday, time: '10:00' }, condition: null, watch: null,
  limits: { maxAmountPerExecution: '20', maxAmountPerPeriod: null, maxOccurrencesPerPeriod: null, cooldownMinutes: 0, maxSlippageBps: 100 },
  action: { network: 'base', networkLabel: 'Base', inputAsset: 'USDC', outputAsset: 'ETH', amount: '20', slippageBps: 100, side: 'BUY', fundsClass: 'REAL_FUNDS' },
  source: null, nextEvaluationAt: null, lastEvaluationAt: null, lastOutcome: null, lastObservation: null, armed: null, attention: null, expiresAt: null,
  createdAt: '2026-11-01T00:00:00.000Z', pending: 0 });
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
const button = (tree: ReactNode, label: string) => nodes(tree).find(node => node.type === 'button' && textOf(node) === label);
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let host: HookHarness;
beforeEach(() => { host = new HookHarness(); vi.resetAllMocks(); });
afterEach(() => host.unmount());
const show = (operation: Parameters<typeof CopilotAutomationManager>[0]['operation'], request: string, owner: WorkflowOwner | null = wallet) =>
  host.render(() => CopilotAutomationManager({ operation, request, owner, proof: { proven: null } as never, dismiss: vi.fn() }));

describe('CopilotAutomationManager', () => {
  it('lists the owner\'s active automations from FloFi\'s own records, with no change offered', async () => {
    f.overview.mockResolvedValue({ ok: true, value: { rules: [rule('a', 'ACTIVE'), rule('b', 'PAUSED'), rule('c', 'ARCHIVED')] } });
    show('LIST', 'Quais automações eu tenho ativas?');
    await flush();
    const tree = show('LIST', 'Quais automações eu tenho ativas?'), text = textOf(tree);
    expect(f.overview).toHaveBeenCalledWith(wallet);
    expect(text).toContain('DCA a');
    expect(text).not.toContain('DCA b');
    expect(button(tree, 'Pause')).toBeUndefined();
    expect(f.change).not.toHaveBeenCalled();
  });
  it('pauses the one active automation only after Confirm, with the version the server returned', async () => {
    f.overview.mockResolvedValue({ ok: true, value: { rules: [rule('a', 'ACTIVE'), rule('b', 'PAUSED')] } });
    f.change.mockResolvedValue({ ok: true, value: rule('a', 'PAUSED') });
    show('PAUSE', 'Pausa essa automação');
    await flush();
    const tree = show('PAUSE', 'Pausa essa automação');
    expect(textOf(tree)).toContain('Nothing changes until you confirm');
    expect(f.change).not.toHaveBeenCalled();
    await button(tree, 'Pause')!.props.onClick!();
    await flush();
    expect(f.change).toHaveBeenCalledWith(wallet, 'a', 3, 'PAUSE');
  });
  it('replaces the schedule only on Confirm, from the day the user wrote, keeping the time', async () => {
    f.overview.mockResolvedValue({ ok: true, value: { rules: [rule('a', 'ACTIVE', 5)] } });
    f.replace.mockResolvedValue({ ok: true, value: { created: rule('n', 'ACTIVE', 1), archived: rule('a', 'ARCHIVED', 5) } });
    show('RESCHEDULE', 'Muda para segunda');
    await flush();
    const tree = show('RESCHEDULE', 'Muda para segunda');
    expect(textOf(tree)).toMatch(/From .* to .*archives this one in the same step/);
    await button(tree, 'Change schedule')!.props.onClick!();
    await flush();
    expect(f.replace).toHaveBeenCalledWith(wallet, 'a', 3, { frequency: 'WEEKLY', weekday: 1, time: '10:00' });
  });
  it('asks for wallet proof instead of reading when the session is not proven, and needs a connected wallet', async () => {
    f.overview.mockResolvedValue({ ok: false, code: 'WALLET_SESSION_REQUIRED' });
    show('LIST', 'minhas automações');
    await flush();
    expect(nodes(show('LIST', 'minhas automações')).some(node => typeof node.type === 'function')).toBe(true);
    host.unmount(); host = new HookHarness();
    show('LIST', 'minhas automações', null);
    await flush();
    expect(textOf(show('LIST', 'minhas automações', null))).toContain('Connect a wallet from the header to use automations.');
    expect(f.overview).toHaveBeenCalledTimes(1);
  });
});
