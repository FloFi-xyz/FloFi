// SPDX-License-Identifier: AGPL-3.0-only
/**
 * get_automation_status over the real gateway with a fake read port (no PostgreSQL, no network): read-only, owner-scoped AS each wallet the
 * principal may read (an OAuth account's proven links with their namespace, or a static credential's granted EVM wallets), not-found and
 * not-owned indistinguishable, INCOMPLETE on any failed owner read, STATUS_UNKNOWN on the request's deadline. The deployment port forwards to
 * the Railway API only as a verified owner (a stubbed transport stands in for the API).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { explainRuleStatus, ruleSummary } from '../automations/explain';
import type { HistoryEntryView, OccurrenceView, OverviewView, RuleHistoryView, RuleView } from '../automations/views';
import { deploymentAutomationReader, type AutomationReadPort } from './automations';
import type { McpWalletOwner } from './config';
import { createRequestBudget } from './deadline';
import { credential, gatewayEnv, session } from './gateway.test-harness';
import { credentialDigest, newCredential } from './oauth/crypto';
import { readOAuthConfig, type McpScope, type OAuthConfig } from './oauth/config';
import { oauthEnv } from './oauth/oauth-test-harness';
import type { McpState } from './oauth/state';

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), S = 'So11111111111111111111111111111111111111112';
const id = (c: string) => 'aut_' + c.repeat(26);
const ACTION: NonNullable<RuleView['action']> = { network: 'base', networkLabel: 'Base', inputAsset: 'USDC', outputAsset: 'WETH', amount: '50', slippageBps: 50, side: 'BUY',
  fundsClass: 'REAL_FUNDS' };
const rule = (patch: Partial<RuleView> = {}): RuleView => ({ ruleId: id('a'), name: 'Weekly ETH', kind: 'SCHEDULED_DCA', state: 'ACTIVE', executionMode: 'CONFIRM_EACH_TIME',
  authorizationId: null, version: 1, timezone: 'Europe/Lisbon', schedule: { frequency: 'WEEKLY', weekday: 1, time: '09:00' }, condition: null, watch: null,
  limits: { maxAmountPerExecution: '50', maxAmountPerPeriod: null, maxOccurrencesPerPeriod: null, cooldownMinutes: 0, maxSlippageBps: 100 }, action: ACTION, source: null,
  nextEvaluationAt: '2026-11-16T09:00:00.000Z', lastEvaluationAt: '2026-11-09T09:00:00.000Z', lastOutcome: 'TRIGGERED', lastObservation: null, armed: null, attention: null,
  expiresAt: null, createdAt: '2026-11-01T10:00:00.000Z', pending: 1, ...patch });
// A proposal whose approval exists: its link and runs are records the port returns, never part of the tool's answer.
const occurrence = (ruleId: string): OccurrenceView => ({ occurrenceId: 'occ_' + 'a'.repeat(26), ruleId, ruleName: 'Weekly ETH', kind: 'SCHEDULE', state: 'APPROVAL_CREATED',
  dueAt: '2026-11-09T09:00:00.000Z', expiresAt: '2026-11-10T09:00:00.000Z', action: ACTION, observations: [], outcome: null, decidedAt: null,
  approval: { status: 'PENDING', runs: [], runsComplete: true }, notifications: [{ channel: 'TELEGRAM', status: 'SENT', code: null }] });
const entries: HistoryEntryView[] = [{ at: '2026-11-09T09:00:00.000Z', outcome: 'TRIGGERED', occurrenceId: 'occ_' + 'a'.repeat(26), observation: null,
  detail: { approvalUrl: 'https://flofi.test/approve#apr_' + 'a'.repeat(26), linkSecret: 'flofi_hs_' + 'x'.repeat(40) } }];
const CAPABILITIES: OverviewView['capabilities'] = { priceSource: 'off', priceEvidence: null, observable: [], routes: [], unavailable: [] };

/** A fake Automations store: rules per owner (`namespace:address`); every read records the owner it was made as and the principals it was given. */
function store(byOwner: Record<string, readonly RuleView[]>, fail: Record<string, string | 'THROW' | 'HANG'> = {}) {
  const calls: { method: string; owner: string; principals: string[]; ruleId?: string }[] = [];
  const key = (o: McpWalletOwner) => `${o.namespace}:${o.address}`;
  const failed = async (o: McpWalletOwner) => {
    const f = fail[key(o)];
    if (f === 'THROW') throw new Error('boom');
    if (f === 'HANG') return new Promise<never>(() => undefined);
    return f ? { ok: false as const, code: f } : null;
  };
  const port: AutomationReadPort = {
    overview: async (owner, principals) => {
      calls.push({ method: 'overview', owner: key(owner), principals: principals.map(key) });
      if (!principals.some(p => key(p) === key(owner))) return { ok: false, code: 'WALLET_SESSION_REQUIRED' };
      const failure = await failed(owner);
      if (failure) return failure;
      return { ok: true, value: { rules: byOwner[key(owner)] ?? [], pending: [], recent: [], capabilities: CAPABILITIES, telegram: { available: false, linked: null } } };
    },
    history: async (owner, ruleId, principals) => {
      calls.push({ method: 'history', owner: key(owner), principals: principals.map(key), ruleId });
      if (!principals.some(p => key(p) === key(owner))) return { ok: false, code: 'WALLET_SESSION_REQUIRED' };
      const failure = await failed(owner);
      if (failure) return failure;
      const found = (byOwner[key(owner)] ?? []).find(r => r.ruleId === ruleId);
      return found ? { ok: true, value: { rule: found, entries, occurrences: [occurrence(found.ruleId)] } satisfies RuleHistoryView } : { ok: false, code: 'AUTOMATION_NOT_FOUND' };
    },
  };
  return { port, calls };
}
const rulesOf = (output: Record<string, unknown>) => output.rules as { ruleId: string; owner: McpWalletOwner; summary: string; explanation: string }[];

const alice = { principal: 'dev-alice', token: credential(), wallets: [A] }, carol = { principal: 'dev-carol', token: credential() };
const env = gatewayEnv([alice, carol]);
const OWNED = { [`eip155:${A}`]: [rule()], [`eip155:${B}`]: [rule({ ruleId: id('b'), name: 'Bob only' })] };

describe('get_automation_status with a static developer credential (operator-granted EVM wallets)', () => {
  it('reads every rule AS the granted wallet only, with FloFi\'s summary, state, next evaluation, last outcome and explanation', async () => {
    const { port, calls } = store(OWNED);
    const result = await session({ env, token: alice.token, automations: port }).callTool('get_automation_status', {});
    expect(result.isError, result.text.slice(0, 300)).toBe(false);
    expect(result.output).toMatchObject({ ok: true, status: 'COMPLETE', complete: true, failedReads: [], accessBasis: 'OPERATOR_GRANTED_WALLET', readOnly: true,
      authority: expect.stringMatching(/^NONE/), management: expect.stringMatching(/only by its owner in the FloFi app/) });
    expect(rulesOf(result.output)).toEqual([expect.objectContaining({ ruleId: id('a'), owner: { namespace: 'eip155', address: A }, state: 'ACTIVE', stateLabel: 'Active',
      kindLabel: 'Recurring buy', executionMode: 'CONFIRM_EACH_TIME', nextEvaluationAt: '2026-11-16T09:00:00.000Z', lastOutcome: 'TRIGGERED',
      lastOutcomeLabel: 'Triggered — proposal created', pendingProposals: 1, summary: ruleSummary(rule(), 'EN'), explanation: explainRuleStatus(rule(), null, null, 'EN').text })]);
    // Overview did not read the rule's own history: the explanation says so instead of guessing.
    expect(rulesOf(result.output)[0]!.explanation).toMatch(/did not read this automation’s evaluation history/);
    expect(calls).toEqual([{ method: 'overview', owner: `eip155:${A}`, principals: [`eip155:${A}`] }]);
    expect(result.text).not.toContain('Bob only');
  });

  it('one rule: its recorded history explains it; another owner\'s rule and an unknown id are the same AUTOMATION_NOT_FOUND', async () => {
    const { port, calls } = store(OWNED);
    const c = session({ env, token: alice.token, automations: port });
    const own = await c.callTool('get_automation_status', { ruleId: id('a'), language: 'PT' });
    expect(own.output).toMatchObject({ ok: true, status: 'COMPLETE', language: 'PT', rules: [{ ruleId: id('a'), summary: ruleSummary(rule(), 'PT'),
      explanation: explainRuleStatus(rule(), entries, [occurrence(id('a'))], 'PT').text }] });
    // Approval links, link secrets and notification internals in the records never reach the answer.
    expect(own.text).not.toMatch(/approve#|apr_|flofi_hs_|approvalUrl|linkSecret|TELEGRAM/);
    const [other, unknown] = [await c.callTool('get_automation_status', { ruleId: id('b') }), await c.callTool('get_automation_status', { ruleId: id('c') })];
    expect(other).toMatchObject({ isError: true, output: { ok: false, code: 'AUTOMATION_NOT_FOUND' } });
    expect(other.output).toEqual(unknown.output);
    expect(other.text).not.toContain('Bob only');
    // Every read was made as the granted wallet, never as the owner of the rule that was asked for.
    expect(new Set(calls.map(call => call.owner))).toEqual(new Set([`eip155:${A}`]));
  });

  it('a credential with no granted wallet reads nothing: MCP_WALLET_LINK_REQUIRED; a malformed rule id is refused by the schema', async () => {
    const { port, calls } = store(OWNED);
    expect((await session({ env, token: carol.token, automations: port }).callTool('get_automation_status', {})).output)
      .toMatchObject({ ok: false, code: 'MCP_WALLET_LINK_REQUIRED', accessBasis: 'OPERATOR_GRANTED_WALLET' });
    for (const ruleId of ['aut_short', id('A'), `${id('a')}x`, 'occ_' + 'a'.repeat(26)])
      expect((await session({ env, token: alice.token, automations: port }).callTool('get_automation_status', { ruleId })).isError, ruleId).toBe(true);
    expect(calls).toEqual([]);
  });

  it('a deployment without automations says so (every owner answered AUTOMATIONS_NOT_ENABLED)', async () => {
    const { port } = store(OWNED, { [`eip155:${A}`]: 'AUTOMATIONS_NOT_ENABLED' });
    expect((await session({ env, token: alice.token, automations: port }).callTool('get_automation_status', {})).output).toMatchObject({ ok: false, code: 'AUTOMATIONS_NOT_ENABLED' });
  });
});

describe('get_automation_status with an OAuth account (its proven, revocable wallet links)', () => {
  const oauth = { FLOFI_MCP: 'enabled', ...oauthEnv() };
  const config = readOAuthConfig(oauth) as OAuthConfig;
  const accounts = { X: 'mcpacct_' + 'x'.repeat(26), Y: 'mcpacct_' + 'y'.repeat(26), Z: 'mcpacct_' + 'z'.repeat(26) };
  const tokens = { X: newCredential('access'), Y: newCredential('access'), Z: newCredential('access') };
  const links: Record<string, { namespace: 'eip155' | 'solana'; address: string }[]> = { [accounts.X]: [{ namespace: 'eip155', address: A }, { namespace: 'solana', address: S }],
    [accounts.Y]: [{ namespace: 'eip155', address: B }], [accounts.Z]: [] };
  const state = (scopes: readonly McpScope[] = ['flofi.strategy', 'flofi.runs']) => ({
    oauth: { authenticate: async (digest: Buffer) => {
      const who = (Object.keys(tokens) as (keyof typeof tokens)[]).find(k => credentialDigest(config.keys.token, tokens[k]).equals(digest));
      return who ? { accountId: accounts[who], grantId: 'grt_' + who.toLowerCase().repeat(26), clientId: 'https://claude.ai/client', clientName: 'Claude', scopes,
        resource: config.resource, familyId: 'fam_' + 'a'.repeat(26), expiresAt: new Date(Date.now() + 3_600_000) } : null;
    }, allow: async () => true },
    links: { active: vi.fn(async (account: string) => (links[account] ?? []).map((l, i) => ({ linkId: `lnk_${i}`, ...l, createdAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) }))) },
    handoffs: {}, workflowRuns: {},
  } as unknown as McpState);
  const SOLANA_RULE = rule({ ruleId: id('s'), name: 'SOL watch', kind: 'DAILY_WATCH', action: null, watch: { assets: ['SOL'] } });
  const byOwner = { ...OWNED, [`solana:${S}`]: [SOLANA_RULE] };

  it('reads as each linked wallet with its namespace (EVM and Solana), with exactly the linked wallets as principals', async () => {
    const { port, calls } = store(byOwner);
    const result = await session({ env: oauth, token: tokens.X, state: state(), automations: port }).callTool('get_automation_status', {});
    expect(result.output).toMatchObject({ ok: true, status: 'COMPLETE', accessBasis: 'ACCOUNT_LINKED_WALLET' });
    expect(rulesOf(result.output).map(r => [r.ruleId, r.owner])).toEqual([[id('a'), { namespace: 'eip155', address: A }], [id('s'), { namespace: 'solana', address: S }]]);
    expect(calls).toEqual([{ method: 'overview', owner: `eip155:${A}`, principals: [`eip155:${A}`, `solana:${S}`] },
      { method: 'overview', owner: `solana:${S}`, principals: [`eip155:${A}`, `solana:${S}`] }]);
    expect(result.text).not.toContain('Bob only');
  });

  it('account Y (wallet B) never sees account X\'s rules, by overview or by id; an account without links gets MCP_WALLET_LINK_REQUIRED', async () => {
    const { port, calls } = store(byOwner);
    const y = session({ env: oauth, token: tokens.Y, state: state(), automations: port });
    expect(rulesOf((await y.callTool('get_automation_status', {})).output).map(r => r.ruleId)).toEqual([id('b')]);
    for (const ruleId of [id('a'), id('s')]) expect((await y.callTool('get_automation_status', { ruleId })).output).toEqual({ ok: false, code: 'AUTOMATION_NOT_FOUND' });
    expect(new Set(calls.map(call => call.owner))).toEqual(new Set([`eip155:${B}`]));
    const none = await session({ env: oauth, token: tokens.Z, state: state(), automations: port }).callTool('get_automation_status', {});
    expect(none.output).toMatchObject({ ok: false, code: 'MCP_WALLET_LINK_REQUIRED', accessBasis: 'ACCOUNT_LINKED_WALLET', next: expect.stringMatching(/\/connections/) });
    expect(calls).toHaveLength(3);
  });

  it('a failed owner read makes the answer INCOMPLETE — the other wallet\'s rules stay, the failure is named, never an empty "no automations"', async () => {
    for (const failure of ['AUTOMATION_UNAVAILABLE', 'THROW'] as const) {
      const { port } = store(byOwner, { [`solana:${S}`]: failure });
      const result = await session({ env: oauth, token: tokens.X, state: state(), automations: port }).callTool('get_automation_status', {});
      expect(result.output, failure).toMatchObject({ ok: true, status: 'INCOMPLETE', complete: false,
        failedReads: [{ owner: { namespace: 'solana', address: S }, code: 'AUTOMATION_UNAVAILABLE' }], note: expect.stringMatching(/UNKNOWN \(not "none"\)/) });
      expect(rulesOf(result.output).map(r => r.ruleId), failure).toEqual([id('a')]);
    }
    // Every read failed: still INCOMPLETE with no rules, never a complete empty list.
    const { port } = store(byOwner, { [`eip155:${A}`]: 'CLOUD_API_UNAVAILABLE', [`solana:${S}`]: 'CLOUD_API_UNAVAILABLE' });
    const all = await session({ env: oauth, token: tokens.X, state: state(), automations: port }).callTool('get_automation_status', {});
    expect(all.output).toMatchObject({ ok: true, status: 'INCOMPLETE', complete: false, rules: [] });
    // One rule that no readable wallet has, while another wallet failed, is INCOMPLETE — not AUTOMATION_NOT_FOUND.
    const partial = store(byOwner, { [`solana:${S}`]: 'AUTOMATION_UNAVAILABLE' });
    const missing = await session({ env: oauth, token: tokens.X, state: state(), automations: partial.port }).callTool('get_automation_status', { ruleId: id('s') });
    expect(missing.output).toMatchObject({ ok: true, status: 'INCOMPLETE', rules: [] });
    // A rule that was found is complete whatever another wallet's read did.
    const found = await session({ env: oauth, token: tokens.X, state: state(), automations: partial.port }).callTool('get_automation_status', { ruleId: id('a') });
    expect(found.output).toMatchObject({ ok: true, status: 'COMPLETE', rules: [{ ruleId: id('a') }] });
  });

  it('a read still running at the request deadline is STATUS_UNKNOWN (retry the status), never an empty list', async () => {
    const { port } = store(byOwner, { [`solana:${S}`]: 'HANG' });
    const result = await session({ env: oauth, token: tokens.X, state: state(), automations: port, budgetMs: 2_000, marginMs: 1_000 }).callTool('get_automation_status', {});
    expect(result).toMatchObject({ isError: true, output: { ok: false, code: 'MCP_REQUEST_TIMEOUT', outcome: 'STATUS_UNKNOWN', next: ['get_automation_status'] } });
  });

  it('needs flofi.runs: without it the call is a 403 step-up and no wallet link or automation is read', async () => {
    const { port, calls } = store(byOwner), only = state(['flofi.strategy']);
    const response = await session({ env: oauth, token: tokens.X, state: only, automations: port })
      .post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_automation_status', arguments: {} } });
    expect(response.status).toBe(403);
    expect(response.text).toBe(JSON.stringify({ ok: false, code: 'MCP_INSUFFICIENT_SCOPE' }));
    expect(response.headers.get('www-authenticate')).toMatch(/error="insufficient_scope".*scope="flofi\.strategy flofi\.runs"/);
    expect(only.links.active).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('the deployment port: the Automations BFF read path, as a verified owner only', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const REMOTE = { API_BASE_URL: 'https://api.flofi.example/', API_AUTH_TOKEN: 'api-token' };
  const evm: McpWalletOwner = { namespace: 'eip155', address: A }, solana: McpWalletOwner = { namespace: 'solana', address: S };

  it.each([evm, solana])('forwards overview and history for %j to the API with the owner header, bounded by the request budget', async owner => {
    const fetch = vi.fn(async () => Response.json({ ok: true, value: { rules: [] } }));
    vi.stubGlobal('fetch', fetch);
    const budget = createRequestBudget({ totalMs: 30_000 });
    try {
      const reader = deploymentAutomationReader(REMOTE, budget);
      expect(await reader.overview(owner, [evm, solana])).toEqual({ ok: true, value: { rules: [] } });
      await reader.history(owner, id('a'), [evm, solana]);
    } finally { budget.dispose(); }
    const [[overviewUrl, overview], [historyUrl, history]] = fetch.mock.calls as unknown as [[URL, RequestInit], [URL, RequestInit]];
    expect([overviewUrl.href, historyUrl.href]).toEqual(['https://api.flofi.example/v1/automations/overview', 'https://api.flofi.example/v1/automations/history']);
    expect(overview.headers).toMatchObject({ 'x-flofi-workflow-owner': `${owner.namespace}:${owner.address}` });
    expect(overview.headers).not.toHaveProperty('idempotency-key');
    expect(JSON.parse(String(history.body))).toEqual({ args: [id('a')] });
    expect(overview.signal).toBeInstanceOf(AbortSignal);
  });

  it('never forwards an owner that is not among the principal\'s wallets (no transport call)', async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true, value: { rules: [] } }));
    vi.stubGlobal('fetch', fetch);
    const reader = deploymentAutomationReader(REMOTE);
    expect(await reader.overview(evm, [solana])).toEqual({ ok: false, code: 'WALLET_SESSION_REQUIRED' });
    expect(await reader.history({ namespace: 'eip155', address: B }, id('a'), [evm])).toEqual({ ok: false, code: 'WALLET_SESSION_REQUIRED' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
