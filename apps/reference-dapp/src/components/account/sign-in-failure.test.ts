// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { accountMessage } from './account-messages';
import { currentSignInPage, signInCallFailure, SIGN_IN_PAGE_OUTDATED } from './sign-in-failure';

describe('HOTFIX-FLOFI-PRODUCTION-RECOVERY-001: a sign-in page from an earlier deployment', () => {
  it("names Next.js's unrecognized Server Action (the previous deployment's id) instead of the generic failure", async () => {
    // The real error class Next.js throws when the server answers x-nextjs-action-not-found.
    const { UnrecognizedActionError } = await import('next/dist/client/components/unrecognized-action-error');
    expect(signInCallFailure(new UnrecognizedActionError('Server Action "60e2f0de" was not found on the server.'))).toBe(SIGN_IN_PAGE_OUTDATED);
    // Any other failure of the call keeps the generic code.
    expect(signInCallFailure(new TypeError('Failed to fetch'))).toBe('PRIVY_SIGN_IN_FAILED');
    expect(signInCallFailure(undefined)).toBe('PRIVY_SIGN_IN_FAILED');
  });
  it('reloads the current deployment’s sign-in page, keeping a safe destination, and says nothing was signed in', () => {
    expect(currentSignInPage('/app/workflows')).toBe('/login?error=SIGN_IN_PAGE_OUTDATED&returnTo=%2Fapp%2Fworkflows');
    expect(accountMessage(SIGN_IN_PAGE_OUTDATED)).toBe('FloFi was updated while you were signing in. Nothing was signed in. Sign in again.');
  });
});
