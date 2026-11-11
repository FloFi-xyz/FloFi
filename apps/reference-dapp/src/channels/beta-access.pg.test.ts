// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Closed-beta Telegram authoring against disposable loopback PostgreSQL. Reuses automation_notification_targets as conversation↔wallet
 * binding proof, then re-checks Flight requireWallet. Fixtures only — no provider, signature, mainnet, email or real funds.
 */
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../../packages/cloud-runtime/test/pg-harness.ts';
import { automationKeys } from '../automations/config.ts';
import { createLinkCode, LINK_CODE_TTL_MS, LINK_TTL_MS } from '../automations/subscriptions.ts';
import { createBetaAccessStore } from '../flight/beta-access.ts';
import { FLIGHT_DEFAULT_CALENDAR } from '../flight/campaign.ts';
import { channelKeys, open, sealContext } from './core/crypto.ts';
import { parseState } from './core/conversation.ts';
import { recordingRuntime } from './core/engine.test-harness.ts';
import { handleChannelDispatch } from './dispatch-http.ts';
import { telegramUserDigest } from './telegram/config.ts';
import { botApi, TELEGRAM_OTHER_USER, TELEGRAM_USER, telegramEnv, telegramRequest, textUpdate } from './telegram/fixtures.test-harness.ts';
import { handleTelegramWebhook } from './telegram/handler.ts';

const CAL = FLIGHT_DEFAULT_CALENDAR, OPEN = CAL.boardingOpensAt, hex = (n: number) => randomBytes(n).toString('hex');
const iso = (ms: number) => new Date(ms).toISOString();
const OWNER = { namespace: 'eip155' as const, address: `0x${'a1'.repeat(20)}` };
const OTHER = { namespace: 'eip155' as const, address: `0x${'b2'.repeat(20)}` };
const STRATEGY = `supply 5 USDC to Aave on Base Sepolia beneficiary 0x${'1'.repeat(40)}`;
const ALLOWED = [TELEGRAM_USER, TELEGRAM_OTHER_USER].map(id => telegramUserDigest(String(id))).join(',');
const SECRET = 'automation-secret-'.padEnd(48, 'x');

let t: TestDatabase;
beforeAll(async () => { t = await createTestDatabase(); });
afterAll(async () => { await t?.drop(); });
beforeEach(async () => {
  await t.db.query(`TRUNCATE automation_notifications, automation_evaluations, automation_occurrences, automation_rules, automation_link_codes,
    automation_notification_targets, channel_outbox, channel_events, channel_audit, channel_conversations, mcp_handoffs, mcp_rate_limits,
    flight_beta_wallets, flight_beta_grants, flight_access_claims, flight_list_entries, flight_invites, flight_passes, flight_batches,
    flofi_account_identities, flofi_account_wallets, flofi_account_sessions, flofi_accounts CASCADE`);
});

async function account(address = OWNER.address) {
  const accountId = `acct_${hex(16)}`, sessionId = hex(16);
  await t.db.query('INSERT INTO flofi_accounts (tenant_id, account_id) VALUES (\'default\', $1)', [accountId]);
  await t.db.query(`INSERT INTO flofi_account_sessions (tenant_id, account_id, session_id, method, authenticated_at, expires_at)
    VALUES ('default', $1, $2, 'EIP155', $3, $4)`, [accountId, sessionId, iso(OPEN - 60_000), iso(OPEN + 86_400_000)]);
  await t.db.query(`INSERT INTO flofi_account_wallets (tenant_id, account_id, ecosystem, address, origin, provider, provider_name, export, label)
    VALUES ('default', $1, 'EVM', $2, 'EXTERNAL', 'fixture', 'Fixture wallet', 'NONE', 'Fixture wallet')`, [accountId, address]);
  return { accountId, sessionId, principal: { namespace: 'eip155' as const, address } };
}

async function grantFlight(accountId: string, address = OWNER.address) {
  const entryId = `fle_${hex(16)}`;
  await t.db.query(`INSERT INTO flight_list_entries (tenant_id, entry_id, email, language, flight, notice, joined_at)
    VALUES ('default', $1, $2, 'EN', 'FIRST', '2026-11-09', $3)`, [entryId, `${hex(6)}@example.test`, iso(CAL.listClosesAt - 60_000)]);
  await t.db.query('INSERT INTO flight_access_claims (tenant_id, entry_id, account_id) VALUES (\'default\', $1, $2)', [entryId, accountId]);
  const gate = createBetaAccessStore({ db: t.db, tenantId: 'default' }, CAL);
  expect(await gate.grant(accountId, OPEN)).toEqual({ ok: true, accountId });
  expect(await gate.requireWallet({ namespace: 'eip155', address }, OPEN)).toEqual({ ok: true, accountId });
  return gate;
}

function deployment(overrides: Record<string, string | undefined> = {}) {
  const token = randomBytes(32).toString('hex');
  const f = telegramEnv({
    FLOFI_AUTOMATIONS: 'enabled', FLOFI_AUTOMATION_SECRET: SECRET,
    FLOFI_CHANNEL_DISPATCH_TOKEN_SHA256: createHash('sha256').update(token).digest('hex'),
    FLOFI_BETA_ACCESS: 'beta', FLOFI_FLIGHT_BOARDING_OPENS_AT: iso(OPEN), FLOFI_FLIGHT_LIST_CLOSES_AT: iso(CAL.listClosesAt),
    FLOFI_TELEGRAM_ACCESS_MODE: 'allowlist', FLOFI_TELEGRAM_ALLOWED_USERS: ALLOWED, ...overrides,
  });
  const api = botApi(), calls: string[] = [], runtime = recordingRuntime(calls), host = { db: t.db, tenantId: 'default' };
  let clock = OPEN;
  const now = () => new Date(clock);
  const update = (text: string, user = TELEGRAM_USER) => textUpdate(text, { user, date: Math.floor(clock / 1000) });
  const say = (text: string, user = TELEGRAM_USER) => handleTelegramWebhook(telegramRequest(update(text, user), f.webhookSecret), {
    env: f.env, host, runtime, fetch: api.fetch, interpreter: null, now, visuals: null, sleep: async () => undefined });
  const enqueue = (text: string) => handleTelegramWebhook(telegramRequest(update(text), f.webhookSecret), {
    env: f.env, host, runtime, fetch: api.fetch, interpreter: null, schedule: () => undefined, visuals: null, now });
  const dispatch = () => handleChannelDispatch(
    new Request('http://127.0.0.1:3100/api/channels/dispatch', { method: 'POST', headers: { authorization: `Bearer ${token}` } }),
    { env: f.env, host, runtime, seams: { telegramFetch: api.fetch }, interpreter: null, visuals: null, now });
  return { f, api, calls, host, say, enqueue, dispatch, now, set(ms: number) { clock = ms; } };
}

async function sealedState(env: Record<string, string | undefined>) {
  const row = (await t.db.query<{ conversation_id: string; state_ciphertext: Buffer | null }>(
    `SELECT conversation_id, state_ciphertext FROM channel_conversations`)).rows[0];
  if (!row?.state_ciphertext) return { conversationId: row?.conversation_id ?? null, state: null };
  const keys = channelKeys(env.FLOFI_CHANNEL_SECRET!);
  const json = open(keys.seal, row.state_ciphertext, sealContext('default', 'channel_conversations', row.conversation_id, 'state'));
  return { conversationId: row.conversation_id, state: parseState(json, 'EN') };
}

describe('Telegram Flight beta via automation link + requireWallet', () => {
  it('lets unlinked users HELP/STOP/link while refusing private authoring without a handoff or persisted draft', async () => {
    const d = deployment();
    expect((await d.say('help')).status).toBe(200);
    expect(d.api.texts().join('\n')).toMatch(/Privacy: https:\/\/flofi\.test\/privacy/);
    await d.say(STRATEGY);
    expect(d.api.texts().at(-1)).toMatch(/not linked to a FloFi Flight wallet/i);
    expect((await t.db.query('SELECT 1 FROM mcp_handoffs')).rowCount).toBe(0);
    const denied = await sealedState(d.f.env);
    expect(denied.state?.pending ?? null).toBeNull();
    expect(denied.state?.steps ?? []).toEqual([]);
    // A later link+grant must not revive a pre-grant draft via LINK.
    const person = await account();
    await grantFlight(person.accountId);
    const { code } = await createLinkCode(t.db, 'default', automationKeys(SECRET), OWNER, new Date(OPEN));
    await d.say(`automations ${code}`);
    await d.say('link');
    expect((await t.db.query('SELECT 1 FROM mcp_handoffs')).rowCount).toBe(0);
    expect(d.api.texts().at(-1)).toMatch(/no pending strategy/i);
    await d.say('stop');
    expect(d.api.texts().at(-1)).toMatch(/will not receive more messages/i);
    expect((await t.db.query('SELECT 1 FROM automation_notification_targets')).rowCount).toBe(0);
  });

  it('links with a legitimate one-time code, refuses expired and reused codes, and never logs the secret', async () => {
    const d = deployment(), person = await account();
    await grantFlight(person.accountId);
    const { code } = await createLinkCode(t.db, 'default', automationKeys(SECRET), OWNER, new Date(OPEN));
    const logs: string[] = [];
    const sink = { info: (e: string, x?: unknown) => logs.push(JSON.stringify([e, x])), warn: (e: string, x?: unknown) => logs.push(JSON.stringify([e, x])) };
    await handleTelegramWebhook(telegramRequest(textUpdate(`automations ${code}`, { date: Math.floor(OPEN / 1000) }), d.f.webhookSecret), {
      env: d.f.env, host: d.host, runtime: recordingRuntime([]), fetch: d.api.fetch, interpreter: null, now: d.now, visuals: null, logger: sink,
      sleep: async () => undefined,
    });
    expect(d.api.texts().at(-1)).toMatch(/automation notifications for 0xa1a1/i);
    expect(logs.join('\n')).not.toContain(code);
    await d.say(`automations ${code}`);
    expect(d.api.texts().at(-1)).toMatch(/not valid/i);
    const expired = await createLinkCode(t.db, 'default', automationKeys(SECRET), OWNER, new Date(OPEN));
    d.set(OPEN + LINK_CODE_TTL_MS + 1_000);
    await d.say(`automations ${expired.code}`);
    expect(d.api.texts().at(-1)).toMatch(/not valid/i);
  });

  it('authorizes private authoring only with a live link and active Flight grant; open mode stays unchanged', async () => {
    const linked = deployment();
    const person = await account();
    await grantFlight(person.accountId);
    const { code } = await createLinkCode(t.db, 'default', automationKeys(SECRET), OWNER, new Date(OPEN));
    await linked.say(`automations ${code}`);
    await linked.say(STRATEGY);
    expect((await t.db.query('SELECT 1 FROM mcp_handoffs')).rowCount).toBe(1);
    expect(linked.api.texts().join('\n')).toMatch(/Nothing is authorized yet|Strategy ready|Authorize/i);

    await t.db.query('TRUNCATE mcp_handoffs, channel_outbox, channel_events, channel_audit, channel_conversations, automation_notification_targets, automation_link_codes CASCADE');
    const open = deployment({ FLOFI_BETA_ACCESS: 'open' });
    await open.say(STRATEGY);
    expect((await t.db.query('SELECT 1 FROM mcp_handoffs')).rowCount).toBe(1);
  });

  it('refuses expired links, wallets without grants, revoked grants and other Telegram users', async () => {
    const d = deployment();
    const person = await account();
    const gate = await grantFlight(person.accountId);
    const { code } = await createLinkCode(t.db, 'default', automationKeys(SECRET), OWNER, new Date(OPEN));
    await d.say(`automations ${code}`);

    // Advance past the link TTL instead of writing an illegal expires_at < linked_at row.
    d.set(OPEN + LINK_TTL_MS + 1_000);
    await d.say(STRATEGY);
    expect(d.api.texts().at(-1)).toMatch(/not linked/i);
    expect((await t.db.query('SELECT 1 FROM mcp_handoffs')).rowCount).toBe(0);

    d.set(OPEN);
    await t.db.query(`UPDATE automation_notification_targets SET expires_at = $1`, [iso(OPEN + LINK_TTL_MS)]);
    expect(await gate.revoke(person.accountId, OPEN)).toBe(true);
    await d.say(STRATEGY);
    expect(d.api.texts().at(-1)).toMatch(/Flight access .* not active/i);
    expect((await t.db.query('SELECT 1 FROM mcp_handoffs')).rowCount).toBe(0);

    await t.db.query('TRUNCATE automation_notification_targets, automation_link_codes CASCADE');
    await account(OTHER.address);
    const fresh = await createLinkCode(t.db, 'default', automationKeys(SECRET), OTHER, new Date(OPEN));
    await d.say(`automations ${fresh.code}`);
    await d.say(STRATEGY);
    expect(d.api.texts().at(-1)).toMatch(/Flight access .* not active/i);

    await t.db.query(`TRUNCATE automation_notification_targets, automation_link_codes, mcp_handoffs, channel_events, channel_outbox, channel_audit,
      channel_conversations, flight_beta_wallets, flight_beta_grants, flight_access_claims, flight_list_entries,
      flofi_account_identities, flofi_account_wallets, flofi_account_sessions, flofi_accounts CASCADE`);
    d.set(OPEN);
    const ownerAgain = await account();
    await grantFlight(ownerAgain.accountId);
    const ownerCode = await createLinkCode(t.db, 'default', automationKeys(SECRET), OWNER, new Date(OPEN));
    await d.say(`automations ${ownerCode.code}`, TELEGRAM_USER);
    await d.say(STRATEGY, TELEGRAM_OTHER_USER);
    expect(d.api.texts().at(-1)).toMatch(/not linked/i);
    expect((await t.db.query('SELECT 1 FROM mcp_handoffs')).rowCount).toBe(0);
  });

  it('rechecks access for queued turns after revocation and preserves STATUS/STOP without new handoffs', async () => {
    const d = deployment({ FLOFI_BETA_ACCESS: 'open' });
    const person = await account();
    const gate = await grantFlight(person.accountId);
    const { code } = await createLinkCode(t.db, 'default', automationKeys(SECRET), OWNER, new Date(OPEN));
    await d.say('/start');
    await d.say(`automations ${code}`);
    expect((await d.enqueue(STRATEGY)).status).toBe(200);
    expect((await t.db.query(`SELECT 1 FROM channel_events WHERE status='PENDING'`)).rowCount).toBe(1);
    d.f.env.FLOFI_BETA_ACCESS = 'beta';
    expect(await gate.revoke(person.accountId, OPEN)).toBe(true);
    expect((await d.dispatch()).status).toBe(200);
    expect((await t.db.query('SELECT 1 FROM mcp_handoffs')).rowCount).toBe(0);
    expect((await t.db.query(`SELECT outcome FROM channel_events WHERE outcome IS NOT NULL`)).rows.map(r => r.outcome))
      .toEqual(expect.arrayContaining(['BETA_CHANNEL_ACCESS_DENIED']));
    await d.say('status');
    expect(d.api.texts().at(-1)).toMatch(/no proposal|Proposal|FloFi|status|waiting/i);
    await d.say('stop');
    expect(d.api.texts().at(-1)).toMatch(/will not receive more messages/i);
  });

  it('never treats confirmation messages as financial authorization', async () => {
    const d = deployment();
    const person = await account();
    await grantFlight(person.accountId);
    const { code } = await createLinkCode(t.db, 'default', automationKeys(SECRET), OWNER, new Date(OPEN));
    await d.say(`automations ${code}`);
    await d.say(STRATEGY);
    const handoffs = (await t.db.query('SELECT 1 FROM mcp_handoffs')).rowCount;
    await d.say('yes');
    await d.say('confirm');
    await d.say('execute');
    expect(d.api.texts().join('\n')).toMatch(/Nothing can be authorized here/i);
    expect((await t.db.query('SELECT 1 FROM mcp_handoffs')).rowCount).toBe(handoffs);
  });

  it('keeps CANCEL after revoke and clears the automation link on STOP', async () => {
    const d = deployment();
    const person = await account();
    const gate = await grantFlight(person.accountId);
    const { code } = await createLinkCode(t.db, 'default', automationKeys(SECRET), OWNER, new Date(OPEN));
    await d.say(`automations ${code}`);
    await d.say(STRATEGY);
    expect((await t.db.query('SELECT 1 FROM mcp_handoffs')).rowCount).toBe(1);
    expect(await gate.revoke(person.accountId, OPEN)).toBe(true);
    await d.say('cancel');
    expect(d.api.texts().at(-1)).toMatch(/Cancelled|no pending|não há|Cancelado/i);
    await d.say('stop');
    expect((await t.db.query('SELECT 1 FROM automation_notification_targets')).rowCount).toBe(0);
    expect(d.api.texts().at(-1)).toMatch(/will not receive more messages/i);
  });
});
