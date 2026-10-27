// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { reportUniversalFailure } from './failure';
import { bridgeFailureMessage } from '../../domain/bridge-failure';
it('correlates safe technical codes without logging secrets, payloads or exception stacks', () => {
  const entries: Record<string, string>[] = [];
  const cause = new Error('UNIVERSAL_SIMULATION_UNAVAILABLE', { cause: new Error('https://rpc.example/?api_key=secret Bearer password') });
  const result = reportUniversalFailure(cause, 'simulate', fields => entries.push(fields));
  expect(result).toMatchObject({ ok: false, code: 'UNIVERSAL_SIMULATION_UNAVAILABLE', correlationId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  expect(entries[0]).toMatchObject({ code: result.code, correlationId: result.correlationId, causeCode: 'UNCLASSIFIED' });
  expect(JSON.stringify(entries)).not.toMatch(/secret|password|rpc\.example|stack/);
  expect(reportUniversalFailure(new Error('Bearer secret'), 'simulate', () => undefined).code).toBe('UNIVERSAL_SERVICE_UNAVAILABLE');
  for (const code of ['RELAY_AMOUNT_TOO_LOW', 'RELAY_INSUFFICIENT_LIQUIDITY', 'RELAY_HTTP_503', 'RELAY_NO_ROUTE', 'UNIVERSAL_SIMULATION_APPROVAL_REVERTED']) expect(bridgeFailureMessage(code)).toBeTruthy();
  expect(new Set(['RELAY_AMOUNT_TOO_LOW', 'RELAY_INSUFFICIENT_LIQUIDITY', 'RELAY_HTTP_503', 'RELAY_NO_ROUTE'].map(bridgeFailureMessage)).size).toBe(4);
});
