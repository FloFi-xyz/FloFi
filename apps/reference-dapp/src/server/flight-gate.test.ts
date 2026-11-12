// SPDX-License-Identifier: AGPL-3.0-only
/**
 * P0 hotfix (Flight transition): the product gate's answer for a request it does not let in. A refusal of the person leaves for /board (an
 * HTTP redirect for a document, a full-page hand-off for a Server Action or client-router fetch); a failure to check access is never shown
 * as a refusal.
 */
import { describe, expect, it } from 'vitest';
import { flightGateOutcome, flightGateResponse, flightRequestKind, fullNavigation } from './flight-gate';

const headers = (values: Record<string, string>) => new Headers(values);

describe('Flight gate classification', () => {
  it('treats every decision about the person as a refusal', () => {
    for (const code of ['BETA_SIGN_IN_REQUIRED', 'BETA_ACCESS_CLOSED', 'BETA_ACCESS_DENIED', 'BETA_ACCESS_REVOKED', 'BETA_NOT_OPEN', 'BETA_WALLET_REQUIRED',
      'BETA_WALLET_NOT_LINKED', 'BETA_SESSION_REQUIRED', 'BETA_SOMETHING_NEW'])
      expect(flightGateOutcome(new Error(code)), code).toBe('REFUSED');
  });
  it('never presents a failure to check access as a refusal', () => {
    for (const code of ['BETA_UNAVAILABLE', 'BETA_ACCESS_UNAVAILABLE', 'BETA_CONFIGURATION_INVALID'])
      expect(flightGateOutcome(new Error(code)), code).toBe('UNAVAILABLE');
    // Anything that is not a BETA_* decision (requireFlightAccess wraps them, but a thrown value is never trusted as a refusal).
    for (const error of [new Error('connect ECONNREFUSED 127.0.0.1:5432'), new Error('beta_access_denied'), new Error('BETA_ACCESS_DENIED '), 'BETA_ACCESS_DENIED', null, undefined, {}])
      expect(flightGateOutcome(error), String(error)).toBe('UNAVAILABLE');
  });
  it('recognises a Server Action, a client-router fetch and a document request', () => {
    expect(flightRequestKind(headers({ 'next-action': '7f00', 'sec-fetch-mode': 'cors' }))).toBe('ACTION');
    expect(flightRequestKind(headers({ 'next-action': '' }))).toBe('ACTION');
    expect(flightRequestKind(headers({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }))).toBe('FETCH');
    expect(flightRequestKind(headers({ 'sec-fetch-mode': 'same-origin' }))).toBe('FETCH');
    expect(flightRequestKind(headers({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }))).toBe('DOCUMENT');
    // A framed product page is a navigation too.
    expect(flightRequestKind(headers({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }))).toBe('DOCUMENT');
    // No Fetch Metadata (an older browser, a non-browser client): today's HTTP redirect.
    expect(flightRequestKind(headers({}))).toBe('DOCUMENT');
  });
  it('redirects a document, hands any other request off with a full navigation, and shows Try again when access could not be checked', () => {
    expect(fullNavigation('DOCUMENT')).toBe('REDIRECT');
    expect(fullNavigation('ACTION')).toBe('HANDOFF');
    expect(fullNavigation('FETCH')).toBe('HANDOFF');
    expect(flightGateResponse('REFUSED', 'DOCUMENT')).toBe('REDIRECT');
    expect(flightGateResponse('REFUSED', 'ACTION')).toBe('HANDOFF');
    expect(flightGateResponse('REFUSED', 'FETCH')).toBe('HANDOFF');
    for (const kind of ['DOCUMENT', 'ACTION', 'FETCH'] as const) expect(flightGateResponse('UNAVAILABLE', kind)).toBe('RETRY');
  });
});
