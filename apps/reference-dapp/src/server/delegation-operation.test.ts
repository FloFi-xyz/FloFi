// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-UNIVERSAL-SINGLE-AUTH-MAINNET-001: the remote (Railway API) delegation operations as the web tier sees them. A request whose answer
 * is lost (timeout, dropped connection) may still have been applied by the API, so it is reported as an unknown outcome, never as a failure;
 * the API's own refusals keep their codes.
 */
import { describe, expect, it } from 'vitest';
import { delegationOperation } from './delegation-operation.ts';

const OWNER = { namespace: 'eip155' as const, address: '0x' + 'ab'.repeat(20) };
const env = { API_BASE_URL: 'https://api.flofi.test', API_AUTH_TOKEN: 'test-only-bearer' };
const sessions = async () => [{ ...OWNER, issuedAt: Date.now() }];
const run = (transport: typeof fetch) => delegationOperation('workflowRunWalletSign', ['wfr_' + 'a'.repeat(26), 1, []], OWNER, { env, sessions, transport });

describe('remote delegation operations (web tier → API)', () => {
  it('a timed-out or dropped request is an unknown outcome, not a failure', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    expect(await run(async () => { throw timeout; })).toEqual({ ok: false, code: 'DELEGATION_OUTCOME_UNKNOWN' });
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(await run(async () => { throw aborted; })).toEqual({ ok: false, code: 'DELEGATION_OUTCOME_UNKNOWN' });
    expect(await run(async () => { throw new TypeError('fetch failed'); })).toEqual({ ok: false, code: 'DELEGATION_OUTCOME_UNKNOWN' });
  });
  it('keeps the API\'s answers: a value, a closed refusal code; an unreadable answer is unknown only for a sign', async () => {
    const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    expect(await run(answer(200, { ok: true, value: { authorizationId: 'dau_x' } }))).toEqual({ ok: true, value: { authorizationId: 'dau_x' } });
    expect(await run(answer(409, { ok: false, code: 'AUTHORIZATION_ACTIVE' }))).toEqual({ ok: false, code: 'AUTHORIZATION_ACTIVE' });
    expect(await run(answer(404, {}))).toEqual({ ok: false, code: 'DELEGATION_NOT_ENABLED' });
    expect(await run(answer(400, { nope: true }))).toEqual({ ok: false, code: 'DELEGATION_UNAVAILABLE' });
    // A sign whose answer cannot be read (gateway error page, a body cut off) may already be applied: unknown. Other operations stay unavailable.
    expect(await run(answer(502, { nope: true }))).toEqual({ ok: false, code: 'DELEGATION_OUTCOME_UNKNOWN' });
    expect(await run(async () => new Response('{"ok":tr', { status: 200 }))).toEqual({ ok: false, code: 'DELEGATION_OUTCOME_UNKNOWN' });
    const overview = (transport: typeof fetch) => delegationOperation('overview', [], OWNER, { env, sessions, transport });
    expect(await overview(answer(502, { nope: true }))).toEqual({ ok: false, code: 'DELEGATION_UNAVAILABLE' });
  });
});
