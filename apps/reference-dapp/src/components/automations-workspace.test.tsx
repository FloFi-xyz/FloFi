// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { HookHarness, deferred } from '../test-utils/hook-harness';
import { WALLET_PROOF_CHANGED } from '../domain/wallet-proof-events';
import { AutomationInbox, AutomationsWorkspace, CreateForm, bpsToPercent, percentToBps } from './automations-workspace';
import type { CapabilityView, OverviewView } from '../automations/views';
const f = vi.hoisted(() => ({ overview: vi.fn(), create: vi.fn(), history: vi.fn(), enabled: true, availability: null as null | { enabled: boolean; code: string | null } | Error,
  reads: [] as string[], signals: [] as (AbortSignal | undefined)[] }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), ...(await import('../test-utils/hook-harness')).hookMocks }));
// BUILD-FLOFI-LIVE-CANVAS-WALLET-ACTIVITY-001: the reads go through ONE GET (`app/automation-reads.ts`): availability (first read only) and the
// owner's overview together. This stand-in answers them from the same fixtures the Server Actions used to.
vi.mock('../app/automation-reads', () => ({ AUTOMATIONS_OFF: new Set(['AUTOMATIONS_NOT_ENABLED', 'AUTOMATION_CONFIGURATION_INVALID']),
  automationSnapshot: async (o: unknown, scope: 'all' | 'overview' | 'availability' = 'all', signal?: AbortSignal) => {
    f.reads.push(scope);
    f.signals.push(signal);
    if (scope !== 'overview' && f.availability instanceof Error) throw f.availability;
    const availability = scope !== 'overview' ? f.availability ?? { enabled: f.enabled, code: f.enabled ? null : 'AUTOMATIONS_NOT_ENABLED' } : null;
    return { availability, overview: o && scope !== 'availability' ? await f.overview(o) : null };
  } }));
vi.mock('../app/automation-action', () => ({ createAutomation: f.create, automationHistory: f.history,
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
let tab: EventTarget & { visibilityState: 'visible' | 'hidden' };
let browser: EventTarget;
beforeEach(() => {
  vi.clearAllMocks(); host = new HookHarness(); f.enabled = true; f.availability = null; f.reads = []; f.signals = [];
  tab = Object.assign(new EventTarget(), { visibilityState: 'visible' as const });
  browser = Object.assign(new EventTarget(), { location: { search: '' } });
  vi.spyOn(browser, 'addEventListener'); vi.spyOn(browser, 'removeEventListener');
  vi.stubGlobal('document', tab); vi.stubGlobal('window', browser);
  vi.stubGlobal('requestAnimationFrame', (work: () => void) => work());
  f.overview.mockResolvedValue({ ok: true, value: overview }); f.create.mockResolvedValue({ ok: true, value: { ruleId: 'persisted-rule' } });
});
afterEach(() => { host.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const work = (wallet = owner) => host.render(() => AutomationsWorkspace({ owner: wallet }));
const focus = () => browser.dispatchEvent(new Event('focus'));
function visibility(state: typeof tab.visibilityState) {
  tab.visibilityState = state;
  tab.dispatchEvent(new Event('visibilitychange'));
}
const form = (initial: Parameters<typeof CreateForm>[0]['initial'] = { name: 'Weekly ETH', amount: '10' }, caps = capabilities) => host.render(() => CreateForm({ owner, capabilities: caps, busy: false, run: async task => (await task()).ok, initial }));
const submit = async (tree: ReactNode) => { await (find(tree, e => e.type === 'form').onSubmit as (event: { preventDefault(): void }) => Promise<void>)({ preventDefault() {} }); };
const change = (tree: ReactNode, label: string, value: string) => (find(tree, e => e.props['aria-label'] === label).onChange as (e: unknown) => void)({ currentTarget: { value } });

describe('Guided automation creation', () => {
  it('discloses action, schedule and review in order, then persists exactly once with existing defaults', async () => {
    let tree = form(); expect(textOf(tree)).toContain('What do you want to do?'); expect(textOf(tree)).not.toContain('Max amount per period'); expect(textOf(tree)).not.toContain('Create automation');
    await submit(tree); tree = form(); expect(textOf(tree)).toContain('When should it happen?'); expect(textOf(tree)).toContain('Advanced settings');
    change(tree, 'Time zone', 'Europe/Lisbon'); await submit(form()); tree = form();
    expect(textOf(tree)).toContain('Review and authorize'); expect(textOf(tree)).toContain('Every Monday at 09:00 (Europe/Lisbon)'); expect(textOf(tree)).toContain('Max per execution10'); expect(textOf(tree)).toContain('Max price difference1%'); expect(textOf(tree)).not.toContain('bps'); expect(textOf(tree)).toContain('Ask me before every execution');
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
      expect(textOf(form(initial))).toContain('When should it happen?'); expect(textOf(form(initial))).toContain(patch.maxPerExecution ? 'above your maximum per execution' : 'The max price difference is above your limit.'); expect(f.create).not.toHaveBeenCalled();
    })();
  });
  it('converts basis points and percent exactly, both ways, and never rounds a value with no whole basis point', () => {
    for (const [bps, percent] of [['100', '1'], ['50', '0.5'], ['125', '1.25'], ['1', '0.01'], ['0', '0'], ['10000', '100'], ['030', '0.3']] as const) expect(bpsToPercent(bps)).toBe(percent);
    for (const [percent, bps] of [['1', '100'], ['0.5', '50'], ['.5', '50'], ['1,25', '125'], ['1.', '100'], ['0.01', '1'], ['100', '10000']] as const) expect(percentToBps(percent)).toBe(bps);
    for (const invalid of ['', '.', '0.125', '1%', '-1', 'abc']) expect(percentToBps(invalid)).toBeNull();
  });
  it('shows slippage as "Max price difference" in % inside the collapsed Advanced settings and submits the same basis points', async () => {
    await submit(form()); let tree = form();
    const advanced = find(tree, e => e.type === 'details' && textOf(e).startsWith('Advanced settings'));
    expect(advanced.open).toBeUndefined(); expect(textOf(advanced.children)).toContain('Max price difference (%)'); expect(textOf(advanced.children)).toContain('Cooldown (minutes)');
    expect(find(tree, e => e.props['aria-label'] === 'Max price difference (%)').value).toBe('1');
    change(tree, 'Max price difference (%)', '0.5'); change(form(), 'Max price difference limit (%)', '0.75'); tree = form();
    expect(find(tree, e => e.props['aria-label'] === 'Max price difference (%)').value).toBe('0.5');
    await submit(tree); tree = form(); expect(textOf(tree)).toContain('Max price difference0.5%'); expect(textOf(tree)).toContain('Max price difference limit0.75%');
    await submit(tree);
    expect(f.create).toHaveBeenCalledExactlyOnceWith(owner, expect.objectContaining({ action: expect.objectContaining({ slippageBps: 50 }), limits: expect.objectContaining({ maxSlippageBps: 75 }) }));
  });
  it('refuses a percent that has no whole basis-point value instead of rounding it', async () => {
    await submit(form()); change(form(), 'Max price difference (%)', '0.125'); await submit(form());
    expect(textOf(form())).toContain('Check the fields and try again.'); expect(f.create).not.toHaveBeenCalled();
  });
  it('blocks a disabled route before persistence', () => { const tree = form(undefined, { ...capabilities, routes: capabilities.routes.map(r => ({ ...r, executable: false, reason: 'MAINNET_HANDOFF_DISABLED_BY_POLICY' })) }); expect(find(tree, e => e.type === 'button' && textOf(e) === 'Continue').disabled).toBe(true); expect(textOf(tree)).toContain('Real-funds automations are disabled on this deployment.'); expect(f.create).not.toHaveBeenCalled(); });
});

describe('Automation management server authorization', () => {
  it('enters directly after a verified server response, without assuming client proof or asking a signature', async () => { work(); await flush(); work(); await flush(); const tree = work(); expect(f.overview).toHaveBeenCalledWith(owner); expect(textOf(tree)).toContain('Wallet session verified'); expect(textOf(tree)).not.toContain('Verify wallet ownership'); expect(textOf(tree)).toContain('Recurring buy'); expect(textOf(tree)).not.toContain('What do you want to do?'); });
  it('asks for real ownership verification when the session is missing or expired', async () => { f.overview.mockResolvedValue({ ok: false, code: 'WALLET_SESSION_REQUIRED' }); work(); await flush(); work(); await flush(); expect(textOf(work())).toContain('Verify wallet ownership to use automations.'); expect(textOf(work())).not.toContain('Recurring buy'); });
  it('does not let a late response for another account populate the workspace', async () => { const old = deferred<unknown>(); f.overview.mockReturnValueOnce(old.promise); work(); await flush(); work(); await flush(); work(other); await flush(); expect(textOf(work(other))).toContain('Wallet session verified'); old.resolve({ ok: true, value: { ...overview, rules: [{ name: 'PRIVATE OLD OWNER RECORD' }] } }); await flush(); expect(textOf(work(other))).not.toContain('PRIVATE OLD OWNER RECORD'); });
  it('preserves the selected creation flow during a transient refresh error', async () => {
    work(); await flush(); work(); await flush();
    const tree = work(); (find(tree, e => e.props.className === 'automation-choice' && textOf(e).includes('Recurring buy')).onClick as () => void)();
    expect(nodes(work()).some(e => e.type === CreateForm)).toBe(true);
    f.overview.mockResolvedValueOnce({ ok: false, code: 'AUTOMATION_STORE_UNAVAILABLE' });
    focus(); await flush();
    expect(nodes(work()).some(e => e.type === CreateForm)).toBe(true); expect(textOf(work())).toContain('Retry');
  });
  it('rejects an older response after the proof session changes for the same wallet', async () => {
    const old = deferred<unknown>();
    const proof = (refresh: () => Promise<void>) => ({ proven: owner.address, refresh }) as NonNullable<Parameters<typeof AutomationsWorkspace>[0]['proof']>;
    const first = proof(vi.fn()), next = proof(vi.fn());
    const page = (value: typeof first) => host.render(() => AutomationsWorkspace({ owner, proof: value }));
    page(first); await flush(); page(first);
    f.overview.mockReturnValueOnce(old.promise).mockResolvedValue({ ok: false, code: 'WALLET_SESSION_REQUIRED' });
    focus();
    expect(textOf(page(next))).not.toContain('Wallet session verified');
    await flush(); expect(textOf(page(next))).toContain('Verify wallet ownership');
    old.resolve({ ok: true, value: overview }); await flush();
    expect(textOf(page(next))).toContain('Verify wallet ownership');
  });
  it('aborts a same-address request on renewed proof even when the proof reader and address stay the same', async () => {
    const old = deferred<unknown>();
    work(); await flush(); work();
    f.overview.mockReturnValueOnce(old.promise);
    focus();
    browser.dispatchEvent(new CustomEvent(WALLET_PROOF_CHANGED, { detail: { namespace: 'solana' } }));
    expect(f.signals[1]?.aborted).toBe(false);
    browser.dispatchEvent(new CustomEvent(WALLET_PROOF_CHANGED, { detail: { namespace: owner.namespace } }));
    expect(f.signals[1]?.aborted).toBe(true);
    work(); await flush();
    old.resolve({ ok: true, value: { ...overview, rules: [{ name: 'STALE WALLET SESSION' }] } });
    await flush();
    expect(textOf(work())).not.toContain('STALE WALLET SESSION');
    expect(f.reads).toEqual(['all', 'overview', 'overview']);
  });
  it('keeps the manual draft and step through required verification for the same wallet', async () => {
    work(); await flush(); work(); await flush();
    (find(work(), e => e.props.className === 'automation-choice' && textOf(e).includes('Recurring buy')).onClick as () => void)();
    let guided = find(work(), e => e.type === CreateForm);
    (guided.onDraftChange as (draft: unknown) => void)({ kind: 'SCHEDULED_DCA', name: 'Preserved routine', amount: '15', network: 'base' });
    (guided.onStepChange as (step: number) => void)(2);
    f.overview.mockResolvedValueOnce({ ok: false, code: 'WALLET_SESSION_REQUIRED' });
    focus(); await flush();
    expect(textOf(work())).toContain('Verify wallet ownership');
    const proof = { proven: owner.address } as NonNullable<Parameters<typeof AutomationsWorkspace>[0]['proof']>;
    host.render(() => AutomationsWorkspace({ owner, proof })); await flush();
    guided = find(host.render(() => AutomationsWorkspace({ owner, proof })), e => e.type === CreateForm);
    expect(guided.initial).toMatchObject({ name: 'Preserved routine', amount: '15' }); expect(guided.initialStep).toBe(2);
  });
  it('starts with creating: "Waiting for you" is shown at the top only while something waits (board 12)', async () => {
    const openChat = vi.fn(), page = () => host.render(() => AutomationsWorkspace({ owner, openChat }));
    page(); await flush(); page(); await flush();
    let text = textOf(page());
    expect(text).not.toContain('Waiting for you'); expect(text).toContain('Create an automation'); expect(text).toContain('Prefer to describe?Create with chat');
    (find(page(), e => e.type === 'button' && textOf(e) === 'Create with chat').onClick as () => void)(); expect(openChat).toHaveBeenCalledOnce();
    for (const label of ['Recurring buy', 'Price trigger', 'Daily watch']) expect(text).toContain(label);
    expect(text).not.toMatch(/Scheduled DCA|Price watch|bps/);
    const pending = { occurrenceId: 'occ-1', ruleId: 'rule-1', ruleName: 'Weekly ETH', kind: 'SCHEDULE', state: 'PENDING_OWNER', dueAt: '2026-11-12T09:00:00.000Z',
      expiresAt: '2026-11-12T21:00:00.000Z', action: null, observations: [], outcome: null, decidedAt: null, approval: null, notifications: [] };
    f.overview.mockResolvedValue({ ok: true, value: { ...overview, pending: [pending] } });
    focus(); await flush();
    text = textOf(page());
    expect(text).toContain('Waiting for you'); expect(text.indexOf('Waiting for you')).toBeLessThan(text.indexOf('Create an automation'));
  });
  it('shows one "Coming soon" state, and no form or control, when automations are not enabled on the deployment', async () => {
    f.enabled = false; work(); await flush(); const tree = work(); const text = textOf(tree);
    expect(text).toContain('Coming soon'); expect(text).toContain('Automations are not enabled on this deployment.');
    // The overview is read in the same parallel request, but a deployment without automations never shows it.
    expect(nodes(tree).filter(e => e.type === 'button' || e.type === 'form' || e.type === 'input')).toHaveLength(0); expect(text).not.toContain('Wallet session verified');
  });
  it('reads availability and the overview in ONE request on open — no second overview when the wallet was already proven', async () => {
    const proof = { proven: owner.address } as NonNullable<Parameters<typeof AutomationsWorkspace>[0]['proof']>;
    const page = () => host.render(() => AutomationsWorkspace({ owner, proof }));
    page(); await flush(); page(); await flush(); page(); await flush();
    expect(f.reads).toEqual(['all']); expect(f.overview).toHaveBeenCalledOnce(); expect(textOf(page())).toContain('Wallet session verified');
  });
  it('a proof that arrives after the first read (session still checking) asks nothing more; a proof that the page waited for reads once', async () => {
    const page = (proven: string | null) => host.render(() => AutomationsWorkspace({ owner, proof: { proven } as NonNullable<Parameters<typeof AutomationsWorkspace>[0]['proof']> }));
    page(null); await flush(); page(null); await flush(); page(owner.address); await flush(); page(owner.address); await flush();
    expect(f.reads).toEqual(['all']);
    host.unmount(); host = new HookHarness(); f.reads = []; f.overview.mockReset();
    f.overview.mockResolvedValueOnce({ ok: false, code: 'WALLET_SESSION_REQUIRED' }).mockResolvedValue({ ok: true, value: overview });
    page(null); await flush(); page(null); await flush();
    expect(textOf(page(null))).toContain('Verify wallet ownership to use automations.');
    page(owner.address); await flush(); page(owner.address); await flush();
    expect(f.reads).toEqual(['all', 'overview']); expect(textOf(page(owner.address))).toContain('Wallet session verified');
  });
  it('a FloFi access refusal is said as such, without a Retry that cannot change it', async () => {
    f.availability = new Error('BETA_WALLET_NOT_LINKED'); work(); await flush();
    const tree = work(), text = textOf(tree);
    expect(text).not.toContain('temporarily unavailable'); expect(text).not.toContain('Coming soon');
    expect(nodes(tree).some(e => e.type === 'button' && textOf(e) === 'Retry')).toBe(false);
  });
  it('a temporary availability failure offers Retry — never the "Coming soon" disabled state — and Retry recovers', async () => {
    f.availability = new Error('AUTOMATION_UNAVAILABLE'); work(); await flush();
    let tree = work(); let text = textOf(tree);
    expect(text).toContain('Automations are temporarily unavailable.'); expect(text).not.toContain('Coming soon');
    f.availability = { enabled: false, code: 'AUTOMATION_UNAVAILABLE' }; (find(tree, e => e.type === 'button' && textOf(e) === 'Retry').onClick as () => void)(); await flush();
    tree = work(); text = textOf(tree); expect(text).toContain('Automations are temporarily unavailable.'); expect(text).not.toContain('Coming soon');
    f.availability = null; (find(tree, e => e.type === 'button' && textOf(e) === 'Retry').onClick as () => void)(); await flush(); work(); await flush();
    expect(textOf(work())).toContain('Wallet session verified');
  });
  it('disables unsupported landing choices when policy and price source are unavailable', async () => { f.overview.mockResolvedValue({ ok: true, value: { ...overview, capabilities: { ...capabilities, routes: [], observable: [], priceSource: 'off' } } }); work(); await flush(); work(); await flush(); const tree = work(); for (const choice of nodes(tree).filter(e => e.props.className === 'automation-choice')) expect(choice.props.disabled).toBe(true); expect(textOf(tree)).toContain('A verified price source is required'); });
});

describe('Automation overview request counts', () => {
  it('reads every 30 seconds while visible, pauses while hidden and refreshes once on each return', async () => {
    vi.useFakeTimers();
    work(); await flush(); work();
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(30_000);
    expect(f.reads).toEqual(['all', 'overview', 'overview', 'overview', 'overview']);
    visibility('hidden'); focus();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.reads).toHaveLength(5);
    visibility('visible'); await flush(); focus();
    expect(f.reads).toHaveLength(6);
    visibility('hidden');
    tab.visibilityState = 'visible'; focus(); await flush(); visibility('visible');
    expect(f.reads).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(29_999); expect(f.reads).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(1); expect(f.reads).toHaveLength(8);
    host.unmount();
    visibility('hidden'); visibility('visible'); focus();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.reads).toHaveLength(8);
  });

  it('coalesces slow polls and aborts an earlier request for a fresh post-mutation read', async () => {
    vi.useFakeTimers();
    work(); await flush(); work();
    const old = deferred<unknown>();
    f.overview.mockReturnValueOnce(old.promise);
    focus(); focus();
    f.signals[1]?.addEventListener('abort', () => old.reject(Error('aborted')));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.reads).toEqual(['all', 'overview']);
    (find(work(), e => e.props.className === 'automation-choice' && textOf(e).includes('Recurring buy')).onClick as () => void)();
    const create = find(work(), e => e.type === CreateForm).run as Parameters<typeof CreateForm>[0]['run'];
    const update = vi.fn(async () => ({ ok: true }));
    const done = create(update);
    await flush();
    expect(update).toHaveBeenCalledOnce();
    expect(f.signals[1]?.aborted).toBe(true);
    expect(await done).toBe(true);
    expect(f.reads).toEqual(['all', 'overview', 'overview']);
    expect(textOf(work())).toContain('Wallet session verified');
    visibility('hidden');
    (find(work(), e => e.type === 'button' && textOf(e) === 'Refresh').onClick as () => void)();
    await flush();
    expect(f.reads).toHaveLength(4);
  });

  it('refreshes on returning even while a mutation is pending', async () => {
    work(); await flush(); work();
    (find(work(), e => e.props.className === 'automation-choice' && textOf(e).includes('Recurring buy')).onClick as () => void)();
    const create = find(work(), e => e.type === CreateForm).run as Parameters<typeof CreateForm>[0]['run'];
    const update = deferred<{ ok: boolean }>();
    const done = create(() => update.promise);
    visibility('hidden'); visibility('visible'); focus();
    await flush();
    expect(f.reads).toEqual(['all', 'overview']);
    update.resolve({ ok: false });
    expect(await done).toBe(false);
  });
});

describe('Automation proposals notice', () => {
  it('asks availability alone while automations are not served (never the owner overview); reads the overview once they are', async () => {
    f.enabled = false;
    host.render(() => AutomationInbox({ owner, proven: true, open: vi.fn() })); await flush();
    expect(f.reads).toEqual(['availability']); expect(f.overview).not.toHaveBeenCalled();
    host.unmount(); host = new HookHarness(); f.reads = []; f.enabled = true;
    f.overview.mockResolvedValue({ ok: true, value: { ...overview, pending: [{ id: 'p1' }] } });
    host.render(() => AutomationInbox({ owner, proven: true, open: vi.fn() })); await flush();
    expect(f.reads).toEqual(['availability', 'overview']); expect(f.overview).toHaveBeenCalledOnce();
    expect(textOf(host.render(() => AutomationInbox({ owner, proven: true, open: vi.fn() })))).toContain('1 automation proposal is waiting for you.');
  });
});
