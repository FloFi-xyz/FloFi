// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-FLIGHT-LAUNCH-001 unit tests (no database, no network): access secrets, the campaign rules added on 9 Nov 2026, the seven
 * email templates in English and Portuguese, and the Resend client's classification of every provider answer (a mocked fetch: this proves
 * the client's behavior, not delivery by Resend).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { addressHash, codeFor, codeHash, linkTokenFor, LINK_TOKEN, normalizeCode, readUnsubscribeToken, sameHex, tokenIdFor, unsubscribeTokenFor } from './access';
import { cardPublicIdFrom, carriesInvites, decideAccess, FLIGHT_BOARDING_OPENS_AT, FLIGHT_CREATORS_OPEN_AT, FLIGHT_DEFAULT_CALENDAR, flightCalendarFrom } from './campaign';
import { classifyResend, createResendClient } from './email/resend';
import { renderEmail, TEMPLATE_CATEGORY, TEMPLATE_DEVIATIONS, TEMPLATE_VERSIONS, type CardView, type EmailContext, type TemplateInput } from './email/templates';
import { emailLimitsFrom } from './email/outbox';

// Per-run random values: no secret-like literal is committed.
const SECRET = randomBytes(32).toString('base64url'), OTHER = randomBytes(32).toString('base64url');
const KEY = `re_${randomBytes(12).toString('hex')}`;
const EMAIL_ID = 'fem_0123456789abcdef0123456789abcdef';

describe('access secrets', () => {
  it('derives the same link and code for the same email (a re-render after a crash is identical), different ones for another email', () => {
    expect(linkTokenFor(SECRET, EMAIL_ID)).toBe(linkTokenFor(SECRET, EMAIL_ID));
    expect(codeFor(SECRET, EMAIL_ID)).toBe(codeFor(SECRET, EMAIL_ID));
    expect(LINK_TOKEN.test(linkTokenFor(SECRET, EMAIL_ID))).toBe(true);
    expect(codeFor(SECRET, EMAIL_ID)).toMatch(/^\d{6}$/);
    const other = 'fem_ffffffffffffffffffffffffffffffff';
    expect(linkTokenFor(SECRET, other)).not.toBe(linkTokenFor(SECRET, EMAIL_ID));
    expect(linkTokenFor(OTHER, EMAIL_ID)).not.toBe(linkTokenFor(SECRET, EMAIL_ID));
    expect(tokenIdFor(SECRET, EMAIL_ID)).toMatch(/^fat_[0-9a-f]{32}$/);
  });
  it('keys the stored code digest to its token, so a stolen table does not reveal codes; compares in constant time', () => {
    const tokenId = tokenIdFor(SECRET, EMAIL_ID), code = codeFor(SECRET, EMAIL_ID);
    expect(codeHash(SECRET, tokenId, code)).not.toBe(codeHash(SECRET, 'fat_00000000000000000000000000000000', code));
    expect(sameHex(codeHash(SECRET, tokenId, code), codeHash(SECRET, tokenId, code))).toBe(true);
    expect(sameHex(codeHash(SECRET, tokenId, code), codeHash(SECRET, tokenId, '000000'))).toBe(code === '000000');
    expect(sameHex('', '')).toBe(false);
    expect(normalizeCode(' 123 456 ')).toBe('123456');
    expect(normalizeCode('12345')).toBeNull();
    expect(normalizeCode('12a456')).toBeNull();
  });
  it('signs unsubscribe links per email: a forged or altered one is refused', () => {
    const token = unsubscribeTokenFor(SECRET, EMAIL_ID);
    expect(readUnsubscribeToken(SECRET, token)).toBe(EMAIL_ID);
    expect(readUnsubscribeToken(SECRET, token.replace(/.$/, c => c === 'A' ? 'B' : 'A'))).toBeNull();
    expect(readUnsubscribeToken(SECRET, `fem_ffffffffffffffffffffffffffffffff.${token.split('.')[1]}`)).toBeNull();
    expect(readUnsubscribeToken(OTHER, token)).toBeNull();
    expect(readUnsubscribeToken(SECRET, 42)).toBeNull();
    expect(addressHash(' Ana@Email.com ')).toBe(addressHash('ana@email.com'));
  });
});

describe('campaign rules of 9 Nov 2026', () => {
  it('gives invites only to a Founding seat earned straight from the beta list', () => {
    expect(carriesInvites({ foundingSeat: 1, origin: 'LIST' })).toBe(true);
    expect(carriesInvites({ foundingSeat: 1, origin: 'INVITE' })).toBe(false);
    expect(carriesInvites({ foundingSeat: 1, origin: 'CREATOR' })).toBe(false);
    expect(carriesInvites({ foundingSeat: null, origin: 'LIST' })).toBe(false);
  });
  it('opens a TEST flight for invited creators on 11 Nov 14:00–18:00 BRT only; nobody else boards before 12 Nov 9:00', () => {
    const test = { passId: null, invite: 'CREATOR' as const, entry: null };
    expect(decideAccess({ ...test, now: FLIGHT_CREATORS_OPEN_AT - 1 }).kind).toBe('not_yet');
    expect(decideAccess({ ...test, now: FLIGHT_CREATORS_OPEN_AT })).toEqual({ kind: 'test_flight', endsAt: FLIGHT_CREATORS_OPEN_AT + 4 * 3_600_000 });
    expect(decideAccess({ ...test, now: FLIGHT_CREATORS_OPEN_AT + 4 * 3_600_000 }).kind).toBe('not_yet');
    expect(decideAccess({ ...test, invite: 'FOUNDING', now: FLIGHT_CREATORS_OPEN_AT + 1 }).kind).toBe('not_yet');
    expect(decideAccess({ passId: null, invite: null, entry: { flight: 'FIRST', batch: null, opensAt: null }, now: FLIGHT_CREATORS_OPEN_AT + 1 }).kind).toBe('not_yet');
    expect(decideAccess({ ...test, now: FLIGHT_BOARDING_OPENS_AT })).toEqual({ kind: 'eligible', origin: 'CREATOR' });
  });
  it('reads the creators’ opening and Email 2 time from the environment, refusing a value after boarding', () => {
    expect(flightCalendarFrom({ FLOFI_FLIGHT_CREATORS_OPEN_AT: '2026-11-11T15:00:00-03:00' }).calendar?.creatorsOpenAt).toBe(Date.parse('2026-11-11T18:00:00Z'));
    expect(flightCalendarFrom({ FLOFI_FLIGHT_EVE_EMAIL_AT: '2026-11-13T20:00:00-03:00' })).toEqual({ calendar: null, invalid: ['FLOFI_FLIGHT_EVE_EMAIL_AT'] });
    expect(flightCalendarFrom({ FLOFI_FLIGHT_CREATORS_OPEN_AT: 'tomorrow' })).toEqual({ calendar: null, invalid: ['FLOFI_FLIGHT_CREATORS_OPEN_AT'] });
  });
  it('makes card ids random base32, never sequential', () => {
    const id = cardPublicIdFrom(new Uint8Array(12).fill(7));
    expect(id).toMatch(/^[a-z2-7]{12}$/);
    expect(() => cardPublicIdFrom(new Uint8Array(4))).toThrow('FLIGHT_CARD_ENTROPY');
  });
  it('reads the email limits, defaulting to the free plan (100 a day, 3,000 a month), refusing nonsense', () => {
    expect(emailLimitsFrom({})).toEqual({ daily: 100, monthly: 3000, externalDailyReserve: 0, externalMonthlyReserve: 0 });
    expect(emailLimitsFrom({ FLOFI_EMAIL_DAILY_LIMIT: '90', FLOFI_EMAIL_EXTERNAL_DAILY_RESERVE: '5' })).toMatchObject({ daily: 90, externalDailyReserve: 5 });
    expect(() => emailLimitsFrom({ FLOFI_EMAIL_DAILY_LIMIT: '-1' })).toThrow('FLIGHT_EMAIL_LIMIT_INVALID');
    expect(() => emailLimitsFrom({ FLOFI_EMAIL_MONTHLY_LIMIT: 'lots' })).toThrow('FLIGHT_EMAIL_LIMIT_INVALID');
  });
});

describe('the seven emails', () => {
  const ctx = (language: 'EN' | 'PT'): EmailContext => ({ language, recipient: 'ana@flofi-test.dev', origin: 'https://flofi.xyz', calendar: FLIGHT_DEFAULT_CALENDAR,
    unsubscribeUrl: 'https://flofi.xyz/board/unsubscribe?t=x' });
  const card = (founding: boolean): CardView => ({ founding, seat: founding ? '#042' : '214E', handle: 'ana<script>', from: 'ETH', to: 'BASE', stepCount: 2, networkCount: 2,
    departedAt: '2026-11-12T12:30:00Z', publicUrl: 'https://flofi.xyz/card/abcdefghijkl', imageUrl: 'https://flofi.xyz/card/abcdefghijkl/image',
    downloadUrl: 'https://flofi.xyz/card/abcdefghijkl/image?download=1' });
  const access = { accessUrl: 'https://flofi.xyz/board/access#t=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', code: '482913', codeMinutes: 4320, linkHours: 72,
    foundingOpen: true, group: 3 } as const;
  const inputs: TemplateInput[] = [{ template: 'LIST_CONFIRMATION' }, { template: 'EVE' }, { template: 'GROUP_BOARDING', ...access },
    { template: 'ACCESS_REQUESTED', ...access, codeMinutes: 15 }, { template: 'CARD_FOUNDING', card: card(true), invites: ['FLF-7Q2K-9XMB', 'FLF-ABCD-EFGH', 'FLF-JKMN-PQRS'],
      invitesUrl: 'https://flofi.xyz/board#invites' }, { template: 'CARD_PASSENGER', card: card(false) }, { template: 'NEXT_FLIGHT' },
    { template: 'CREATOR_INVITE', code: 'FLF-7Q2K-9XMB', briefUrl: 'https://claude.ai/artifact/Ed64YTYtYmUWVgnT8NEZD5' }];

  it('renders every template in both languages with the approved subject, the risk footer, privacy and unsubscribe, and no count of people', () => {
    const subjects: Record<string, [string, string]> = {
      LIST_CONFIRMATION: ['You’re on the FloFi beta list ✈️', 'Você está na lista beta da FloFi ✈️'], EVE: ['Boarding starts tomorrow, 9:00 BRT ✈️', 'O embarque começa amanhã, às 9h ✈️'],
      GROUP_BOARDING: ['Your group is boarding ✈️', 'Seu grupo está embarcando ✈️'], ACCESS_REQUESTED: ['Your group is boarding ✈️', 'Seu grupo está embarcando ✈️'],
      CARD_FOUNDING: ['You’re Founding Member #042 ✈️', 'Você é o Founding Member #042 ✈️'], CARD_PASSENGER: ['Your Flight FloFi boarding card ✈️', 'Seu cartão de embarque do Flight FloFi ✈️'],
      NEXT_FLIGHT: ['You’re on the list for the next flight ✈️', 'Você está na lista do próximo voo ✈️'], CREATOR_INVITE: ['You’re invited to Flight FloFi ✈️', 'Você foi convidado para o Flight FloFi ✈️'],
    };
    for (const input of inputs) for (const [index, language] of (['EN', 'PT'] as const).entries()) {
      const email = renderEmail(input, ctx(language));
      expect(email.subject).toBe(subjects[input.template]![index]);
      for (const part of [email.html, email.text]) {
        expect(part).toContain(language === 'EN' ? 'DeFi involves risk' : 'DeFi envolve riscos');
        expect(part).toContain('https://flofi.xyz/board/unsubscribe?t=x');
        expect(part).toContain('/privacy');
        // No public aggregate counts and none of the withdrawn promises.
        expect(part).not.toMatch(/\d[\d.,]*\s*(ON THE LIST|BOARDED|NA LISTA|EMBARCARAM)|seats left|assentos (founding )?restantes|\b\d+\s*(OF|DE)\s*100\b|\b\d{1,3}\s*\/\s*100\b|reopen tomorrow|small limit/i);
      }
      expect(email.html).not.toContain('<script>');
      expect(email.html.length).toBeLessThan(100_000);
    }
  });
  it('puts the access link, the six-digit code and the group in Email 3, the Founding block only while seats are open', () => {
    const open = renderEmail({ template: 'GROUP_BOARDING', ...access }, ctx('EN'));
    expect(open.html).toContain('href="https://flofi.xyz/board/access#t=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"');
    expect(open.text).toContain('482913');
    expect(open.text).toContain('Group: 3');
    expect(open.text).toContain('72 hours');
    expect(open.text).toContain('Founding Members');
    const closed = renderEmail({ template: 'GROUP_BOARDING', ...access, foundingOpen: false, group: null }, ctx('EN'));
    expect(closed.text).not.toContain('Founding Members');
    expect(closed.text).not.toContain('Group:');
    expect(renderEmail({ template: 'ACCESS_REQUESTED', ...access, codeMinutes: 15 }, ctx('PT')).text).toContain('15 minutos');
    expect(() => renderEmail({ template: 'GROUP_BOARDING', ...access, accessUrl: 'https://evil.example/board/access#t=x' }, ctx('EN'))).toThrow('EMAIL_TEMPLATE_INPUT_INVALID');
    expect(() => renderEmail({ template: 'GROUP_BOARDING', ...access, code: '12' }, ctx('EN'))).toThrow('EMAIL_TEMPLATE_INPUT_INVALID');
  });
  it('dates Email 1, 2 and 6 from the calendar in Brasília time, never from the browser or a written date', () => {
    expect(renderEmail({ template: 'LIST_CONFIRMATION' }, ctx('EN')).text).toContain('Thursday, Nov 12, at 9:00 BRT');
    expect(renderEmail({ template: 'EVE' }, ctx('PT')).text).toContain('quinta-feira, 12/11, às 9h');
    const moved = { ...ctx('EN'), calendar: { ...FLIGHT_DEFAULT_CALENDAR, boardingOpensAt: Date.parse('2026-11-19T12:30:00Z') } };
    expect(renderEmail({ template: 'EVE' }, moved).subject).toBe('Boarding starts tomorrow, 9:30 BRT ✈️');
    const creator = renderEmail({ template: 'CREATOR_INVITE', code: 'FLF-7Q2K-9XMB', briefUrl: 'https://claude.ai/artifact/Ed64YTYtYmUWVgnT8NEZD5' }, ctx('EN'));
    expect(creator.text).toContain('Wednesday, 14:00 to 18:00 BRT');
    expect(creator.text).toContain('FLF-7Q2K-9XMB');
    expect(creator.text).toContain('marked TEST');
  });
  it('shows the card’s real seat, route and image in 4a/4b, the three invites only in 4a, and escapes the handle', () => {
    const founding = renderEmail(inputs[4]!, ctx('EN')), passenger = renderEmail(inputs[5]!, ctx('EN'));
    expect(founding.html).toContain('https://flofi.xyz/card/abcdefghijkl/image');
    expect(founding.html).toContain('@ana&lt;script&gt;');
    expect(founding.text).toContain('FLF-7Q2K-9XMB');
    expect(passenger.text).not.toContain('FLF-');
    expect(passenger.text).not.toMatch(/invite/i);
    expect(passenger.html).toContain('SEAT 214E · 2 STEPS · NOV 12 · YOU APPROVE');
    expect(founding.html).toContain(encodeURIComponent('https://flofi.xyz/card/abcdefghijkl'));
  });
  it('versions every template and lists every wording change for the team', () => {
    expect(Object.keys(TEMPLATE_VERSIONS).sort()).toEqual(Object.keys(TEMPLATE_CATEGORY).sort());
    expect(TEMPLATE_CATEGORY.ACCESS_REQUESTED).toBe('ESSENTIAL');
    expect(Object.entries(TEMPLATE_CATEGORY).filter(([, category]) => category === 'ESSENTIAL')).toHaveLength(1);
    expect(TEMPLATE_DEVIATIONS.length).toBeGreaterThan(0);
  });
});

describe('Resend client (mocked fetch: client behavior only, not delivery)', () => {
  it('classifies every answer: sent, rate limited, quota, configuration, rejection, idempotency conflicts and server errors', () => {
    expect(classifyResend(200, { id: 'abc-123' }, null)).toEqual({ kind: 'SENT', providerId: 'abc-123' });
    expect(classifyResend(200, {}, null)).toEqual({ kind: 'SENT', providerId: 'accepted-without-id' });
    expect(classifyResend(429, { name: 'rate_limit_exceeded' }, '3')).toEqual({ kind: 'RETRY', code: 'PROVIDER_RATE_LIMITED', retryAfterMs: 3000 });
    expect(classifyResend(429, { name: 'daily_quota_exceeded' }, null)).toEqual({ kind: 'QUOTA', code: 'PROVIDER_QUOTA_DAILY' });
    expect(classifyResend(429, { name: 'monthly_quota_exceeded' }, null)).toEqual({ kind: 'QUOTA', code: 'PROVIDER_QUOTA_MONTHLY' });
    expect(classifyResend(401, { name: 'validation_error' }, null).kind).toBe('CONFIG');
    expect(classifyResend(403, { name: 'validation_error' }, null).kind).toBe('CONFIG');
    expect(classifyResend(422, { name: 'missing_required_field' }, null).kind).toBe('REJECTED');
    expect(classifyResend(409, { name: 'concurrent_idempotent_requests' }, null).kind).toBe('UNKNOWN');
    expect(classifyResend(409, { name: 'invalid_idempotent_request' }, null)).toEqual({ kind: 'CONFLICT', code: 'PROVIDER_IDEMPOTENCY_BODY_CHANGED' });
    expect(classifyResend(500, null, null).kind).toBe('UNKNOWN');
    expect(classifyResend(503, null, null)).toEqual({ kind: 'UNKNOWN', code: 'PROVIDER_UNAVAILABLE' });
  });
  it('sends one request with the idempotency key, never the key in the body; a timeout is UNKNOWN, never "not sent"', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect((init.headers as Record<string, string>)['idempotency-key']).toBe(EMAIL_ID);
      expect(body).toMatchObject({ from: 'FloFi <hello@flofi.xyz>', to: ['ana@flofi-test.dev'], reply_to: 'flofi.xyz@gmail.com' });
      expect(JSON.stringify(body)).not.toContain(KEY);
      return new Response(JSON.stringify({ id: 'resend-1' }), { status: 200 });
    });
    const client = createResendClient({ apiKey: KEY, from: 'FloFi <hello@flofi.xyz>', replyTo: 'flofi.xyz@gmail.com', fetch: fetch as unknown as typeof globalThis.fetch });
    expect(await client.send({ idempotencyKey: EMAIL_ID, to: 'ana@flofi-test.dev', subject: 's', html: '<p>h</p>', text: 't' })).toEqual({ kind: 'SENT', providerId: 'resend-1' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const slow = createResendClient({ apiKey: KEY, from: 'FloFi <hello@flofi.xyz>', replyTo: 'x@y.z', timeoutMs: 5,
      fetch: ((_: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof globalThis.fetch });
    expect(await slow.send({ idempotencyKey: EMAIL_ID, to: 'a@b.cd', subject: 's', html: 'h', text: 't' })).toEqual({ kind: 'UNKNOWN', code: 'PROVIDER_TIMEOUT' });
    const down = createResendClient({ apiKey: KEY, from: 'FloFi <hello@flofi.xyz>', replyTo: 'x@y.z',
      fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof globalThis.fetch });
    expect(await down.send({ idempotencyKey: EMAIL_ID, to: 'a@b.cd', subject: 's', html: 'h', text: 't' })).toEqual({ kind: 'UNKNOWN', code: 'PROVIDER_NETWORK' });
  });
  it('reports the sending domain verified only when Resend says so', async () => {
    const answer = (body: unknown, status = 200) => createResendClient({ apiKey: KEY, from: 'FloFi <hello@flofi.xyz>', replyTo: 'x@y.z',
      fetch: (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof globalThis.fetch });
    expect(await answer({ data: [{ name: 'flofi.xyz', status: 'verified' }] }).domainStatus('flofi.xyz')).toBe('VERIFIED');
    expect(await answer({ data: [{ name: 'flofi.xyz', status: 'pending' }] }).domainStatus('flofi.xyz')).toBe('NOT_VERIFIED');
    expect(await answer({ data: [] }).domainStatus('flofi.xyz')).toBe('NOT_VERIFIED');
    expect(await answer({ name: 'restricted_api_key' }, 401).domainStatus('flofi.xyz')).toBe('UNKNOWN');
  });
});
