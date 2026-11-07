// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { HookHarness, deferred } from '../test-utils/hook-harness';
import { AutomationsWorkspace, CreateForm } from './automations-workspace';
import type { CapabilityView, OverviewView } from '../automations/views';
const f = vi.hoisted(() => ({ overview: vi.fn(), create: vi.fn(), history: vi.fn() }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
vi.mock('../app/automation-action', () => ({ automationOverview: f.overview, createAutomation: f.create, automationHistory: f.history, automationsAvailability: async () => ({ enabled: true }),
  changeAutomationState: vi.fn(), createTelegramLinkCode: vi.fn(), dismissAutomationOccurrence: vi.fn(), openAutomationOccurrence: vi.fn(), prepareWatchProposal: vi.fn(), rebindAutomation: vi.fn(), unlinkTelegram: vi.fn() }));
vi.mock('../app/workflow-action', () => ({ listWorkflows: async () => ({ ok: true, value: { items: [] } }) }));
vi.mock('./wallet-proof', () => ({ WalletProof: () => null }));
vi.mock('./canvas-automation', () => ({ CanvasAutomation: () => null }));
vi.mock('./delegated-automations', () => ({ useDelegation: () => ({ refresh: vi.fn(), overview: null }), AuthorizationReview: () => null, DelegatedAuthorizations: () => null, DelegatedCreate: () => null, DELEGATION_ERROR_TEXT: { EXECUTOR_FUNDED_GAS_RETIRED: 'Automatic execution is retired.' } }));
vi.mock('../i18n/locale', () => ({ useLocale: () => ({ language: 'EN', t: (value: string, ...args: unknown[]) => value.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)])) }) }));
const owner = { namespace: 'eip155' as const, address: '0x' + 'a'.repeat(40) }, other = { ...owner, address: '0x' + 'b'.repeat(40) };
const capabilities: CapabilityView = { priceSource: 'chainlink', priceEvidence: 'PUBLIC_READ_ONLY', observable: ['ETH'], unavailable: [], routes: [{ asset: 'ETH', network: 'base', networkLabel: 'Base', base: 'WETH', quote: 'USDC', executable: true, reason: null, fundsClass: 'REAL_FUNDS' }] };
const overview: OverviewView = { capabilities, rules: [], pending: [], recent: [], telegram: { available: false, linked: null } };
type Props = Record<string, unknown> & { children?: ReactNode };
type Element = ReactElement<Props>;
function nodes(value: ReactNode): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  return [value as Element, ...nodes((value as Element).props.children)];
}
function textOf(value: ReactNode): string { return Array.isArray(value) ? value.map(textOf).join('') : isValidElement(value) ? textOf((value as Element).props.children) : value == null ? '' : String(value); }
function find(tree: ReactNode, match: (e: Element) => boolean) { const target = nodes(tree).find(match); expect(target).toBeDefined(); return target!.props; }
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let host: HookHarness;
beforeEach(() => { host = new HookHarness(); vi.clearAllMocks(); vi.stubGlobal('requestAnimationFrame', (work: () => void) => work()); vi.stubGlobal('window', { location: { search: '' }, addEventListener: vi.fn(), removeEventListener: vi.fn() }); f.overview.mockResolvedValue({ ok: true, value: overview }); f.create.mockResolvedValue({ ok: true, value: { ruleId: 'persisted-rule' } }); });
afterEach(() => { host.unmount(); vi.unstubAllGlobals(); });
const work = (wallet = owner) => host.render(() => AutomationsWorkspace({ owner: wallet }));
const form = (initial: Parameters<typeof CreateForm>[0]['initial'] = { name: 'Weekly ETH', amount: '10' }, caps = capabilities) => host.render(() => CreateForm({ owner, capabilities: caps, busy: false, run: async task => (await task()).ok, initial }));
const submit = async (tree: ReactNode) => { await (find(tree, e => e.type === 'form').onSubmit as (event: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} }); };
const change = (tree: ReactNode, label: string, value: string) => (find(tree, e => e.props['aria-label'] === label).onChange as (e: unknown) => void)({ currentTarget: { value } });

describe('Guided automation creation', () => {
  it('discloses action, schedule and review in order, then persists exactly once with existing defaults', async () => {
    let tree = form(); expect(textOf(tree)).toContain('What do you want to do?'); expect(textOf(tree)).not.toContain('Max amount per period'); expect(textOf(tree)).not.toContain('Create automation');
    await submit(tree); tree = form(); expect(textOf(tree)).toContain('When should it happen?'); expect(textOf(tree)).toContain('Advanced settings');
    change(tree, 'Time zone', 'Europe/Lisbon'); await submit(form()); tree = form();
    expect(textOf(tree)).toContain('Review and authorize'); expect(textOf(tree)).toContain('Every Monday at 09:00 (Europe/Lisbon)'); expect(textOf(tree)).toContain('Max per execution10'); expect(textOf(tree)).toContain('Slippage (bps)100'); expect(textOf(tree)).toContain('Ask me before every execution');
    await submit(tree); expect(f.create).toHaveBeenCalledExactlyOnceWith(owner, expect.objectContaining({ kind: 'SCHEDULED_DCA', action: { kind: 'ROUTE', asset: 'ETH', side: 'BUY', network: 'base', amount: '10', slippageBps: 100 }, limits: expect.objectContaining({ maxAmountPerExecution: '10', cooldownMinutes: 0 }), schedule: { frequency: 'WEEKLY', weekday: 1, time: '09:00', timezone: 'Europe/Lisbon' } }));
  });
  it('rejects invalid amounts using the domain validator, preserving entered data', async () => { await submit(form({ name: 'Bad amount', amount: '-1' })); await submit(form()); expect(textOf(form())).toContain('Check the fields and try again.'); expect(f.create).not.toHaveBeenCalled(); });
  it('creates a notify-only price trigger without claiming execution', async () => {
    const initial = { kind: 'PRICE_TRIGGER' as const, name: 'ETH dip', source: 'NONE' as const, threshold: '3000' };
    await submit(form(initial)); await submit(form(initial)); expect(textOf(form(initial))).toContain('Notify me only'); await submit(form(initial));
    expect(f.create).toHaveBeenCalledWith(owner, expect.objectContaining({ kind: 'PRICE_TRIGGER', action: null, condition: { asset: 'ETH', type: 'PRICE_BELOW', threshold: '3000', checkEveryMinutes: 15 } }));
  });
  it('creates a supported price watch and blocks a deployment with no feed', async () => {
    const initial = { kind: 'DAILY_WATCH' as const, name: 'ETH update' };
    await submit(form(initial)); await submit(form(initial)); await submit(form(initial)); expect(f.create).toHaveBeenCalledWith(owner, expect.objectContaining({ kind: 'DAILY_WATCH', watch: { assets: ['ETH'] } }));
  });
  it.each([{ maxPerExecution: '1' }, { maxSlippage: '50' }])('checks binding limits before exposing the final Create action: %o', patch => {
    return (async () => {
      const initial = { name: 'Bounded', amount: '10', ...patch }; await submit(form(initial)); await submit(form(initial));
      expect(textOf(form(initial))).toContain('When should it happen?'); expect(textOf(form(initial))).toContain(patch.maxPerExecution ? 'above your maximum per execution' : 'above your maximum slippage'); expect(f.create).not.toHaveBeenCalled();
    })();
  });
  it('blocks a disabled route before persistence', () => { const tree = form(undefined, { ...capabilities, routes: capabilities.routes.map(r => ({ ...r, executable: false, reason: 'MAINNET_HANDOFF_DISABLED_BY_POLICY' })) }); expect(find(tree, e => e.type === 'button' && textOf(e) === 'Continue').disabled).toBe(true); expect(textOf(tree)).toContain('Real-funds automations are disabled on this deployment.'); expect(f.create).not.toHaveBeenCalled(); });
});

describe('Automation management server authorization', () => {
  it('enters directly after a verified server response, without assuming client proof or asking a signature', async () => { work(); await flush(); work(); await flush(); const tree = work(); expect(f.overview).toHaveBeenCalledWith(owner); expect(textOf(tree)).toContain('Wallet session verified'); expect(textOf(tree)).not.toContain('Verify wallet ownership'); expect(textOf(tree)).toContain('Recurring buy'); expect(textOf(tree)).not.toContain('What do you want to do?'); });
  it('asks for real ownership verification when the session is missing or expired', async () => { f.overview.mockResolvedValue({ ok: false, code: 'WALLET_SESSION_REQUIRED' }); work(); await flush(); work(); await flush(); expect(textOf(work())).toContain('Verify wallet ownership to use automations.'); expect(textOf(work())).not.toContain('Recurring buy'); });
  it('does not let a late response for another account populate the workspace', async () => { const old = deferred<unknown>(); f.overview.mockReturnValueOnce(old.promise); work(); await flush(); work(); await flush(); work(other); await flush(); expect(textOf(work(other))).toContain('Wallet session verified'); old.resolve({ ok: true, value: { ...overview, rules: [{ name: 'PRIVATE OLD OWNER RECORD' }] } }); await flush(); expect(textOf(work(other))).not.toContain('PRIVATE OLD OWNER RECORD'); });
  it('preserves the selected creation flow during a transient refresh error', async () => {
    const listeners = vi.mocked(window.addEventListener); work(); await flush(); work(); await flush();
    const tree = work(); (find(tree, e => e.props.className === 'automation-choice' && textOf(e).includes('Recurring buy')).onClick as () => void)();
    expect(nodes(work()).some(e => e.type === CreateForm)).toBe(true);
    f.overview.mockResolvedValueOnce({ ok: false, code: 'AUTOMATION_STORE_UNAVAILABLE' });
    const focus = listeners.mock.calls.find(([type]) => type === 'focus')?.[1] as () => void; focus(); await flush();
    expect(nodes(work()).some(e => e.type === CreateForm)).toBe(true); expect(textOf(work())).toContain('Retry');
  });
  it('rejects an older same-wallet success after a newer failed ownership check', async () => {
    work(); await flush(); work(); await flush(); const old = deferred<unknown>();
    f.overview.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ok: false, code: 'WALLET_SESSION_REQUIRED' });
    const focus = vi.mocked(window.addEventListener).mock.calls.find(([type]) => type === 'focus')?.[1] as () => void;
    focus(); focus(); await flush(); expect(textOf(work())).toContain('Verify wallet ownership');
    old.resolve({ ok: true, value: overview }); await flush(); expect(textOf(work())).toContain('Verify wallet ownership');
  });
  it('keeps the manual draft and step through required verification for the same wallet', async () => {
    work(); await flush(); work(); await flush();
    (find(work(), e => e.props.className === 'automation-choice' && textOf(e).includes('Recurring buy')).onClick as () => void)();
    let guided = find(work(), e => e.type === CreateForm);
    (guided.onDraftChange as (draft: unknown) => void)({ kind: 'SCHEDULED_DCA', name: 'Preserved routine', amount: '15', network: 'base' });
    (guided.onStepChange as (step: number) => void)(2);
    f.overview.mockResolvedValueOnce({ ok: false, code: 'WALLET_SESSION_REQUIRED' });
    const focus = vi.mocked(window.addEventListener).mock.calls.find(([type]) => type === 'focus')?.[1] as () => void; focus(); await flush();
    expect(textOf(work())).toContain('Verify wallet ownership');
    const proof = { proven: owner.address } as NonNullable<Parameters<typeof AutomationsWorkspace>[0]['proof']>;
    host.render(() => AutomationsWorkspace({ owner, proof })); await flush();
    guided = find(host.render(() => AutomationsWorkspace({ owner, proof })), e => e.type === CreateForm);
    expect(guided.initial).toMatchObject({ name: 'Preserved routine', amount: '15' }); expect(guided.initialStep).toBe(2);
  });
  it('disables unsupported landing choices when policy and price source are unavailable', async () => { f.overview.mockResolvedValue({ ok: true, value: { ...overview, capabilities: { ...capabilities, routes: [], observable: [], priceSource: 'off' } } }); work(); await flush(); work(); await flush(); const tree = work(); for (const choice of nodes(tree).filter(e => e.props.className === 'automation-choice')) expect(choice.props.disabled).toBe(true); expect(textOf(tree)).toContain('A verified price source is required'); });
});
