// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHttpServer, createLogger } from '../src/index.js';

describe('P0 catalog reliability: the HTTP boundary tells a handler when its caller is gone', () => {
  it('aborts the request signal on a client disconnect, and never after a completed response', async () => {
    let disconnected: Promise<boolean> = Promise.resolve(false), finishedSignal: AbortSignal | undefined;
    const server = createHttpServer({ logger: createLogger({ service: 'test', sink: () => undefined }), authToken: null, routes: [
      { method: 'POST', name: 'slow', pattern: /^\/slow$/, handler: async request => {
        disconnected = new Promise(resolve => {
          request.signal?.addEventListener('abort', () => resolve(true), { once: true });
          setTimeout(() => resolve(false), 2_000);
        });
        await disconnected;
        return { status: 200, body: { ok: true } };
      } },
      { method: 'POST', name: 'fast', pattern: /^\/fast$/, handler: async request => { finishedSignal = request.signal; return { status: 200, body: { ok: true } }; } },
    ] });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const fast = await fetch(`${base}/fast`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(await fast.json()).toEqual({ ok: true });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(finishedSignal?.aborted).toBe(false);
      const caller = new AbortController();
      const pending = fetch(`${base}/slow`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: caller.signal }).catch(() => null);
      await new Promise(resolve => setTimeout(resolve, 100));
      caller.abort();
      await pending;
      expect(await disconnected).toBe(true);
    } finally { server.close(); }
  });
});
