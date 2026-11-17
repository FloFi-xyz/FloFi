// SPDX-License-Identifier: AGPL-3.0-only
/** Authentication UX & Login Regression Fix (item 6): what "Continue to my account" does with the server's answer. */
import { describe, expect, it } from 'vitest';
import { BOARDED_SIGN_IN, CONTINUE_REAUTH, CONTINUE_RETURN, continueStep } from './account-continue';
import { safeReturnPath } from '../accounts/account-session';

const refused = (code: string) => ({ ok: false as const, code });

describe('Continue to my account', () => {
  it('continues to the boarded account’s sign-in only when the server started the move, and only to that sign-in', () => {
    expect(continueStep({ ok: true, value: { next: '/login?move=1' } }, false)).toEqual({ kind: 'NAVIGATE', to: '/login?move=1' });
    expect(continueStep({ ok: true, value: { next: 'https://elsewhere.example/login' } }, false)).toEqual({ kind: 'RETRY' });
  });
  it('asks to confirm identity only when the sign-in is not recent, and never twice in a row (no authentication loop)', () => {
    expect(continueStep(refused('ACCOUNT_REAUTHENTICATION_REQUIRED'), false)).toEqual({ kind: 'NAVIGATE', to: CONTINUE_REAUTH });
    expect(continueStep(refused('ACCOUNT_REAUTHENTICATION_REQUIRED'), true)).toEqual({ kind: 'REAUTH_AGAIN' });
    // The confirmation returns to /board (an allowed return path), which continues once.
    expect(CONTINUE_REAUTH).toBe('/login?reauth=1&returnTo=%2Fboard%3Fcontinue%3D1');
    expect(safeReturnPath(CONTINUE_RETURN)).toBe(CONTINUE_RETURN);
    expect(safeReturnPath('/board?board=1')).toBe('/board?board=1');
    expect(BOARDED_SIGN_IN).toBe('/login?returnTo=%2Fboard%3Fboard%3D1');
  });
  it('keeps an account that holds anything of its own separate (nothing is closed, merged or moved)', () => {
    for (const code of ['ACCOUNT_MOVE_BLOCKED_WALLETS', 'ACCOUNT_MOVE_BLOCKED_BETA_ACCESS', 'ACCOUNT_MOVE_BLOCKED_BOARDING_PASS', 'ACCOUNT_MOVE_HAS_WALLET',
      'ACCOUNT_MOVE_WALLET_SIGN_IN', 'ACCOUNT_MOVE_PRIVY_HAS_MFA', 'ACCOUNT_MOVE_PRIVY_METHOD_UNSUPPORTED', 'ACCOUNT_MOVE_PRIVY_HELD', 'PRIVY_ACCOUNT_NOT_LINKED',
      'PRIVY_USER_NOT_FOUND'])
      expect(continueStep(refused(code), false), code).toEqual({ kind: 'SEPARATE' });
  });
  it('sends a person whose session ended to sign in again instead of a "try again" that cannot succeed', () => {
    expect(continueStep(refused('ACCOUNT_SESSION_REQUIRED'), false)).toEqual({ kind: 'NAVIGATE', to: BOARDED_SIGN_IN });
    expect(continueStep(refused('ACCOUNT_SESSION_REQUIRED'), true)).toEqual({ kind: 'NAVIGATE', to: BOARDED_SIGN_IN });
  });
  it('treats outages and anything unknown as "nothing changed, try again"', () => {
    for (const code of ['ACCOUNT_MOVE_PRIVY_PENDING', 'ACCOUNT_MOVE_PRIVY_UNREADABLE', 'ACCOUNT_MOVE_FAILED', 'SOMETHING_NEW'])
      expect(continueStep(refused(code), true), code).toEqual({ kind: 'RETRY' });
  });
});
