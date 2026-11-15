// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A schedule change by replacement, on a disposable loopback PostgreSQL. A rule's definition is immutable (AUTOMATION_RULE_IMMUTABLE), so
 * `replace` creates a new rule — the old definition with only the schedule changed, the same bound action, limits, expiry and
 * CONFIRM_EACH_TIME mode — and archives the old one in ONE transaction: owner-scoped, compare-and-set on the old version, exact at the
 * 25-rule cap, refused for delegated rules, and the old rule's open proposals withdrawn.
 */
import { createLogger, createPostgresWorkQueue } from '@defi-workflow-engine/cloud-runtime';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { automationHarness, ethDip, OWNER_A, OWNER_B, weeklyDca, type Harness } from './automation.test-harness.ts';
import { dispatchAutomations } from './dispatch.ts';
import { runAutomationOperation } from './operations.ts';
import { newAutomationId } from './runtime.ts';
import { MAX_RULES_PER_OWNER } from './store.ts';

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
beforeEach(async () => { await t.db.query('TRUNCATE automation_notifications, automation_evaluations, automation_occurrences, automation_rules, work_items, saved_workflows, mcp_handoffs, mcp_rate_limits CASCADE'); });

const silent = createLogger({ service: 'test', sink: () => undefined });
const dispatch = (h: Harness) => dispatchAutomations(h.rt(), createPostgresWorkQueue({ db: t.db, ownerId: 'w', tenantId: 'default' }), silent, 'w');
const FRIDAY = { schedule: { frequency: 'WEEKLY', weekday: 5, time: '09:30' } } as const;
const row = (ruleId: string) => t.db.query(`SELECT state, version, kind, execution_mode, authorization_id, display_name, timezone, definition, action_strategy, action_workflow_hash,
  engine_version, source_workflow_id, source_workflow_hash, source_workflow_version, expires_at, next_evaluation_at FROM automation_rules WHERE rule_id = $1`, [ruleId]).then(r => r.rows[0]!);
const history = (ruleId: string) => t.db.query<{ outcome: string; detail: Record<string, unknown> | null }>(
  'SELECT outcome, detail FROM automation_evaluations WHERE rule_id = $1 ORDER BY evaluation_id', [ruleId]).then(r => r.rows);
const live = (owner = OWNER_A) => t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM automation_rules WHERE owner_account = $1 AND state <> 'ARCHIVED'`, [owner.address])
  .then(r => r.rows[0]!.n);
const refusal = async (work: Promise<unknown>) => { try { await work; return 'NO_REFUSAL'; } catch (e) { return e instanceof Error ? e.message : String(e); } };

describe('replace: a schedule change creates the new rule and archives the old one atomically', () => {
  it('keeps everything but the schedule: action (by value), limits, expiry, name, zone and CONFIRM_EACH_TIME', async () => {
    const h = automationHarness(t.db), expiresAt = '2027-06-01T00:00:00.000Z';
    const old = await h.service().create(OWNER_A, weeklyDca({ expiresAt, limits: { maxAmountPerExecution: '50', maxAmountPerPeriod: { amount: '200', period: 'MONTH' },
      maxOccurrencesPerPeriod: { count: 4, period: 'MONTH' }, cooldownMinutes: 60, maxSlippageBps: 100 } }));
    const before = await row(old.ruleId);
    const { created, archived } = await h.service().replace(OWNER_A, old.ruleId, old.version, FRIDAY);
    expect(archived).toMatchObject({ ruleId: old.ruleId, state: 'ARCHIVED', version: 2, nextEvaluationAt: null });
    expect(created).toMatchObject({ state: 'ACTIVE', version: 1, kind: 'SCHEDULED_DCA', executionMode: 'CONFIRM_EACH_TIME', name: 'Weekly ETH', timezone: 'Europe/Lisbon',
      schedule: { frequency: 'WEEKLY', weekday: 5, time: '09:30' }, limits: old.limits, action: old.action, expiresAt,
      // Friday 2026-10-09 09:30 Europe/Lisbon (WEST) is the next slot after the harness clock (Thursday 2026-10-08 10:00Z).
      nextEvaluationAt: '2026-10-09T08:30:00.000Z' });
    expect(created.ruleId).not.toBe(old.ruleId);
    const after = await row(created.ruleId);
    // The stored definition is the old one with only the schedule changed; the binding columns are identical.
    expect(after.definition).toEqual({ ...before.definition as object, schedule: { frequency: 'WEEKLY', weekday: 5, time: '09:30', timezone: 'Europe/Lisbon' } });
    for (const column of ['kind', 'execution_mode', 'authorization_id', 'display_name', 'timezone', 'action_strategy', 'action_workflow_hash', 'engine_version', 'source_workflow_id',
      'source_workflow_hash', 'source_workflow_version', 'expires_at']) expect(after[column], column).toEqual(before[column]);
    expect((await row(old.ruleId)).definition).toEqual(before.definition);
    // Each history records the link.
    expect((await history(old.ruleId)).map(e => e.outcome)).toEqual(['AUTOMATION_CREATED', 'AUTOMATION_REPLACED']);
    expect((await history(old.ruleId))[1]!.detail).toEqual({ replacedBy: created.ruleId });
    expect(await history(created.ruleId)).toEqual([{ outcome: 'AUTOMATION_CREATED', detail: null }, { outcome: 'AUTOMATION_REPLACEMENT', detail: { replaces: old.ruleId } }]);
    expect(h.lines.some(l => l.includes('"event":"automation.replaced"') && !l.includes(OWNER_A.address))).toBe(true);
    // The replaced rule is terminal: a second replace of it is refused.
    expect(await refusal(h.service().replace(OWNER_A, old.ruleId, 2, FRIDAY))).toBe('AUTOMATION_ARCHIVED');
  });

  it('runs through the closed operation contract and replaces a daily watch and a paused rule (which stays paused)', async () => {
    const h = automationHarness(t.db);
    const watch = await h.service().create(OWNER_A, { version: 1, kind: 'DAILY_WATCH', name: 'Morning round', schedule: { frequency: 'DAILY', weekday: null, time: '08:00',
      timezone: 'UTC' }, watch: { assets: ['ETH', 'BTC'] }, expiresAt: null });
    const replaced = await runAutomationOperation(h.service(), OWNER_A, 'replace', [watch.ruleId, 1, { schedule: { frequency: 'DAILY', weekday: null, time: '07:15' } }]) as
      { created: { kind: string; watch: unknown; schedule: unknown; state: string } };
    expect(replaced.created).toMatchObject({ kind: 'DAILY_WATCH', watch: { assets: ['ETH', 'BTC'] }, schedule: { frequency: 'DAILY', weekday: null, time: '07:15' }, state: 'ACTIVE' });
    const dca = await h.service().create(OWNER_A, weeklyDca());
    const paused = await h.service().setState(OWNER_A, dca.ruleId, 1, 'PAUSE');
    const { created } = await h.service().replace(OWNER_A, dca.ruleId, paused.version, FRIDAY);
    expect(created).toMatchObject({ state: 'PAUSED', nextEvaluationAt: null, schedule: { weekday: 5 } });
    // Resuming the replacement computes its next evaluation from now, on the new schedule.
    expect(await h.service().setState(OWNER_A, created.ruleId, created.version, 'RESUME')).toMatchObject({ state: 'ACTIVE', nextEvaluationAt: '2026-10-09T08:30:00.000Z' });
  });

  it('never lets wallet B replace (or see) wallet A’s automation, even with its id', async () => {
    const h = automationHarness(t.db), a = await h.service().create(OWNER_A, weeklyDca());
    expect(await refusal(h.service().replace(OWNER_B, a.ruleId, a.version, FRIDAY))).toBe('AUTOMATION_NOT_FOUND');
    expect(await live(OWNER_B)).toBe(0);
    expect(await row(a.ruleId)).toMatchObject({ state: 'ACTIVE', version: '1' });
    expect((await h.service().overview(OWNER_A)).rules.map(r => r.ruleId)).toEqual([a.ruleId]);
  });

  it('is a compare-and-set on the old rule: a stale version and a concurrent replace lose cleanly, leaving exactly one replacement', async () => {
    const h = automationHarness(t.db), a = await h.service().create(OWNER_A, weeklyDca());
    const paused = await h.service().setState(OWNER_A, a.ruleId, 1, 'PAUSE');
    expect(await refusal(h.service().replace(OWNER_A, a.ruleId, 1, FRIDAY))).toBe('AUTOMATION_VERSION_CONFLICT');
    const racing = await Promise.allSettled([h.service(t.open(2)).replace(OWNER_A, a.ruleId, paused.version, FRIDAY),
      h.service(t.open(2)).replace(OWNER_A, a.ruleId, paused.version, { schedule: { frequency: 'DAILY', weekday: null, time: '06:00' } })]);
    expect(racing.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(racing.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.message)).toEqual(['AUTOMATION_VERSION_CONFLICT']);
    expect(await live()).toBe(1);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM automation_rules`)).rows[0]!.n).toBe(2);
  });

  it('works at the 25-rule cap, because the old rule leaves in the same transaction; the cap itself stays exact', async () => {
    const h = automationHarness(t.db), rules = [];
    for (let i = 0; i < MAX_RULES_PER_OWNER; i++) rules.push(await h.service().create(OWNER_A, weeklyDca({ name: `DCA ${i}` })));
    expect(await refusal(h.service().create(OWNER_A, weeklyDca({ name: 'one too many' })))).toBe('AUTOMATION_RULE_LIMIT');
    const { created } = await h.service().replace(OWNER_A, rules[3]!.ruleId, 1, FRIDAY);
    expect(created.name).toBe('DCA 3');
    expect(await live()).toBe(MAX_RULES_PER_OWNER);
    expect(await refusal(h.service().create(OWNER_A, weeklyDca({ name: 'still too many' })))).toBe('AUTOMATION_RULE_LIMIT');
    // A rule that is not live (archived) cannot be "replaced" into a 26th live rule.
    const archived = await h.service().setState(OWNER_A, rules[4]!.ruleId, 1, 'ARCHIVE');
    await h.service().create(OWNER_A, weeklyDca({ name: 'refill' }));
    expect(await refusal(h.service().replace(OWNER_A, rules[4]!.ruleId, archived.version, FRIDAY))).toBe('AUTOMATION_ARCHIVED');
    expect(await live()).toBe(MAX_RULES_PER_OWNER);
  });

  it('rolls the new rule back when archiving the old one is refused inside the transaction', async () => {
    const h = automationHarness(t.db), a = await h.service().create(OWNER_A, weeklyDca()), now = h.now();
    const rule = { ruleId: newAutomationId('aut'), owner: OWNER_A, name: 'x', kind: 'SCHEDULED_DCA' as const, definition: (await h.store.getRule(OWNER_A, a.ruleId))!.definition,
      binding: (await h.store.getRule(OWNER_A, a.ruleId))!.binding, timezone: 'Europe/Lisbon', expiresAt: null, nextEvaluationAt: now, scheduleCursor: now };
    expect(await refusal(h.store.createRule(rule, now, MAX_RULES_PER_OWNER + 1, async (tx, inserted) => {
      await h.store.archiveReplaced(tx, OWNER_A, a.ruleId, 7, inserted, now, MAX_RULES_PER_OWNER);
    }))).toBe('AUTOMATION_VERSION_CONFLICT');
    expect(await h.store.getRule(OWNER_A, rule.ruleId)).toBeNull();
    expect(await row(a.ruleId)).toMatchObject({ state: 'ACTIVE', version: '1' });
  });

  it('refuses delegated rules, price triggers, rules waiting for a rebind, an unchanged or invalid schedule — creating nothing', async () => {
    const h = automationHarness(t.db), now = h.now();
    const base = (await h.store.getRule(OWNER_A, (await h.service().create(OWNER_A, weeklyDca({ name: 'template' }))).ruleId))!;
    const delegated = await h.store.createRule({ ruleId: newAutomationId('aut'), owner: OWNER_A, name: 'Delegated', kind: 'SCHEDULED_DCA', definition: base.definition,
      binding: base.binding, timezone: base.timezone, expiresAt: new Date('2027-01-01T00:00:00Z'), nextEvaluationAt: now, scheduleCursor: now,
      delegated: { authorizationId: 'dau_' + 'a'.repeat(26) } }, now, MAX_RULES_PER_OWNER);
    expect(await refusal(h.service().replace(OWNER_A, delegated.ruleId, delegated.version, FRIDAY))).toBe('DELEGATED_REAUTHORIZATION_REQUIRED');
    const dip = await h.service().create(OWNER_A, ethDip());
    expect(await refusal(h.service().replace(OWNER_A, dip.ruleId, dip.version, FRIDAY))).toBe('AUTOMATION_REPLACE_UNSUPPORTED');
    const dca = await h.service().create(OWNER_A, weeklyDca());
    expect(await refusal(h.service().replace(OWNER_A, dca.ruleId, 1, { schedule: { frequency: 'WEEKLY', weekday: 1, time: '09:00' } }))).toBe('AUTOMATION_SCHEDULE_UNCHANGED');
    expect(await refusal(h.service().replace(OWNER_A, dca.ruleId, 1, { schedule: { frequency: 'DAILY', weekday: 3, time: '09:00' } }))).toBe('AUTOMATION_SCHEDULE_INVALID');
    expect(await refusal(runAutomationOperation(h.service(), OWNER_A, 'replace', [dca.ruleId, 1, { schedule: { ...FRIDAY.schedule, timezone: 'UTC' } }]))).toBe('AUTOMATION_INPUT_INVALID');
    await t.db.query(`UPDATE automation_rules SET attention = 'WORKFLOW_CHANGED' WHERE rule_id = $1`, [dca.ruleId]);
    expect(await refusal(h.service().replace(OWNER_A, dca.ruleId, 1, FRIDAY))).toBe('AUTOMATION_WORKFLOW_CHANGED');
    expect(await live()).toBe(4);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM automation_rules`)).rows[0]!.n).toBe(4);
  });

  it('withdraws the old rule’s open proposal and revokes its approval link', async () => {
    const h = automationHarness(t.db), a = await h.service().create(OWNER_A, weeklyDca());
    h.set('2026-10-12T08:00:30Z');
    await dispatch(h);
    const [pending] = (await h.service().overview(OWNER_A)).pending;
    await h.service().open(OWNER_A, pending!.occurrenceId);
    const { created } = await h.service().replace(OWNER_A, a.ruleId, a.version, FRIDAY);
    expect((await t.db.query(`SELECT state, outcome FROM automation_occurrences WHERE occurrence_id = $1`, [pending!.occurrenceId])).rows[0])
      .toEqual({ state: 'EXPIRED', outcome: 'AUTOMATION_REPLACED' });
    expect((await t.db.query(`SELECT status FROM mcp_handoffs`)).rows.map(r => r.status)).toEqual(['REVOKED']);
    const overview = await h.service().overview(OWNER_A);
    expect(overview.pending).toEqual([]);
    expect(overview.rules.map(r => [r.ruleId, r.state])).toEqual(expect.arrayContaining([[a.ruleId, 'ARCHIVED'], [created.ruleId, 'ACTIVE']]));
  });
});
