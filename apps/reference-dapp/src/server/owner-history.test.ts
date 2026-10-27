// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
import { ownerHistoryOperation } from './owner-history';
import { WORKFLOW_OWNER_HEADER } from '../domain/saved-workflow';
const owner = { namespace: 'eip155' as const, address: '0x' + '11'.repeat(20) };
const env = { API_BASE_URL: 'https://api.invalid' };
it('never forwards deletion without the expected verified wallet session', async () => {
  const transport = vi.fn();
  expect(await ownerHistoryOperation(owner.address, 'change', 'EXECUTION_RUN', 'run-1', 'DELETE', { env, transport, principals: async () => [] }))
    .toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
  expect(await ownerHistoryOperation('0x' + '22'.repeat(20), 'change', 'EXECUTION_RUN', 'run-1', 'DELETE', { env, transport, principals: async () => [owner] }))
    .toEqual({ ok: false, code: 'RUN_NOT_FOUND' });
  expect(transport).not.toHaveBeenCalled();
});
it.each([{ ok: true }, { ok: true, disposition: 'VISIBLE' }, { ok: true, disposition: 'ARCHIVED' }, { ok: false, code: 'UNEXPECTED' }, null])('does not confirm an unverified deletion reply: %j', async reply => {
  const transport = vi.fn(async () => new Response(JSON.stringify(reply)));
  expect(await ownerHistoryOperation(owner.address, 'change', 'EXECUTION_RUN', 'run-1', 'DELETE', { env, transport, principals: async () => [owner] }))
    .toEqual({ ok: false, code: 'HISTORY_INVALID' });
});
it('does not confirm success in an HTTP error response', async () => {
  const transport = vi.fn(async () => new Response(JSON.stringify({ ok: true, disposition: 'DELETED' }), { status: 500 }));
  expect(await ownerHistoryOperation(owner.address, 'change', 'EXECUTION_RUN', 'run-1', 'DELETE', { env, transport, principals: async () => [owner] }))
    .toEqual({ ok: false, code: 'HISTORY_INVALID' });
});
it('forwards only the server-verified owner and closed operation, never a body ownership claim', async () => {
  const transport = vi.fn(async () => new Response(JSON.stringify({ ok: true, disposition: 'DELETED' })));
  expect(await ownerHistoryOperation(owner.address, 'change', 'EXECUTION_RUN', 'run-1', 'DELETE', { env, transport, principals: async () => [owner] }))
    .toEqual({ ok: true, disposition: 'DELETED' });
  const request = transport.mock.calls[0] as unknown as [URL, RequestInit];
  expect(request[0].pathname).toBe('/v1/owner-history/change');
  expect(request[1].headers).toMatchObject({ [WORKFLOW_OWNER_HEADER]: `eip155:${owner.address}` });
  expect(JSON.parse(request[1].body as string)).toEqual({ args: ['EXECUTION_RUN','run-1','DELETE'] });
});
