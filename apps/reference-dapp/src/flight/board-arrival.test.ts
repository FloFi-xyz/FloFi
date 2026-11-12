// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (Flight transition): the arrival on /board after sign-in. The server sends only a person the product already admits straight to
 * /app (read-only), the board opens on its checking state when it will check, and the check's answer maps to the board's own outcomes.
 */
import { describe, expect, it } from 'vitest';
import { boardArrival, boardArrivalCandidate, boardArrivalChecks, boardOutcome, decideBoardArrival, type BoardArrivalFacts } from './board-arrival';

const admitted: BoardArrivalFacts = { arrival: 'BOARD', mode: 'beta', phase: 'BOARDING', signedIn: true, accessPending: false, access: 'eligible' };

describe('board arrival', () => {
  it('reads /board’s own return marks; an invite wins, as on the client', () => {
    expect(boardArrival({ board: '1' })).toBe('BOARD');
    expect(boardArrival({ invite: '1' })).toBe('INVITE');
    expect(boardArrival({ board: '1', invite: '1' })).toBe('INVITE');
    expect(boardArrival({ board: '' })).toBe('BOARD');
    expect(boardArrival({})).toBeNull();
    expect(boardArrival({ source: 'card', ref: 'x' })).toBeNull();
  });
  it('opens on the checking state only for an arrival the board checks', () => {
    expect(boardArrivalChecks('BOARD', 'BOARDING')).toBe(true);
    for (const phase of ['FINAL_CALL', 'GATE_CLOSED', null] as const) expect(boardArrivalChecks('BOARD', phase)).toBe(false);
    expect(boardArrivalChecks('INVITE', 'BOARDING')).toBe(false);
    expect(boardArrivalChecks(null, 'BOARDING')).toBe(false);
  });
  it('sends to /app only an eligible, signed-in arrival in closed beta that the product gate already admits', () => {
    expect(boardArrivalCandidate(admitted)).toBe(true);
    expect(decideBoardArrival({ ...admitted, productAccess: true })).toBe('APP');
    expect(decideBoardArrival({ ...admitted, arrival: 'INVITE', productAccess: true })).toBe('APP');
    // The product gate decides: a candidate it refuses stays on the board (and its own check runs there).
    expect(decideBoardArrival({ ...admitted, productAccess: false })).toBe('BOARD');
  });
  it('keeps everyone else on the board, so "Board now" writes what it must (grant, wallet links, claim, pending link) explicitly', () => {
    const refused: [string, Partial<BoardArrivalFacts>][] = [
      ['no return mark', { arrival: null }],
      // Open rollout: "Board now" also claims the verified entry and records the result; a page view never does.
      ['open rollout', { mode: 'open' }], ['closed gate', { mode: 'closed' }],
      ['before boarding', { phase: 'GATE_CLOSED' }], ['final call', { phase: 'FINAL_CALL' }], ['no campaign state', { phase: null }],
      ['signed out', { signedIn: false }],
      // A link or code proved a list address before sign-in: only the explicit Board now binds it.
      ['pending access link', { accessPending: true }],
      ['a pass to show', { access: 'boarded' }], ['group still closed', { access: 'batch_closed' }], ['not on the list', { access: 'not_listed' }],
      ['not yet', { access: 'not_yet' }], ['no campaign answer', { access: null }],
    ];
    for (const [name, change] of refused) {
      expect(boardArrivalCandidate({ ...admitted, ...change }), name).toBe(false);
      expect(decideBoardArrival({ ...admitted, ...change, productAccess: true }), name).toBe('BOARD');
    }
  });
});

describe('the board check’s answer', () => {
  const eligible = { kind: 'eligible', origin: 'LIST' } as const, notListed = { kind: 'not_listed' } as const;
  const closed = { kind: 'batch_closed', batch: 2, opensAt: 1 } as const, boarded = { kind: 'boarded', passId: 'pass_1' } as const;
  it('asks to sign in first', () => {
    expect(boardOutcome({ ok: false, code: 'FLIGHT_SIGN_IN_REQUIRED' })).toEqual({ kind: 'SIGN_IN' });
  });
  it('opens /app only for an eligible answer', () => {
    expect(boardOutcome({ ok: true, flight: { access: eligible } })).toEqual({ kind: 'APP', notice: null });
    expect(boardOutcome({ ok: true, flight: { access: eligible }, access: 'CLAIMED_ELSEWHERE' })).toEqual({ kind: 'APP', notice: 'ACCESS_CLAIMED_ELSEWHERE' });
    // A refusal never opens /app, even when it carries an eligible campaign state (the product grant was refused).
    expect(boardOutcome({ ok: false, code: 'BETA_WALLET_REQUIRED', flight: { access: eligible } })).toEqual({ kind: 'REFUSED', code: 'BETA_WALLET_REQUIRED' });
  });
  it('keeps the person on the board with their own state, their pass or the refusal', () => {
    expect(boardOutcome({ ok: true, flight: { access: boarded } })).toEqual({ kind: 'PASS', notice: null });
    expect(boardOutcome({ ok: true, flight: { access: notListed }, access: 'ACCOUNT_HAS_OTHER_ENTRY' }))
      .toEqual({ kind: 'PERSONAL', access: notListed, notice: 'ACCESS_ACCOUNT_HAS_OTHER_ENTRY' });
    expect(boardOutcome({ ok: false, code: 'BETA_ACCESS_DENIED', flight: { access: notListed } })).toEqual({ kind: 'PERSONAL', access: notListed, notice: null });
    expect(boardOutcome({ ok: false, code: 'BETA_ACCESS_DENIED', flight: { access: closed } })).toEqual({ kind: 'PERSONAL', access: closed, notice: null });
    expect(boardOutcome({ ok: false, code: 'FLIGHT_UNAVAILABLE' })).toEqual({ kind: 'REFUSED', code: 'FLIGHT_UNAVAILABLE' });
    expect(boardOutcome({ ok: true })).toEqual({ kind: 'NONE' });
    expect(boardOutcome({ ok: true, flight: null })).toEqual({ kind: 'NONE' });
    expect(boardOutcome({ ok: true, flight: {} })).toEqual({ kind: 'NONE' });
  });
});
