// SPDX-License-Identifier: AGPL-3.0-only
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createHttpServer, createLogger } from '../src/index.js';

/** The raw status line and body of one request sent exactly as written (no client normalizes the request-target). */
const raw = (port: number, target: string, method = 'GET') => new Promise<{ status: string; body: string }>((resolve, reject) => {
  const socket = connect(port, '127.0.0.1', () => socket.write(`${method} ${target} HTTP/1.1\r\nHost: api\r\nConnection: close\r\n\r\n`));
  let data = '';
  socket.on('data', chunk => { data += String(chunk); });
  socket.on('close', () => resolve({ status: data.split('\r\n')[0] ?? '', body: data.slice(data.indexOf('\r\n\r\n') + 4) }));
  socket.on('error', reject);
});

describe('BUILD-INFRA-API-FAILOVER-CERT-001: a request-target the URL parser refuses never takes the process down', () => {
  it('answers 400 REQUEST_INVALID before authentication and keeps serving', async () => {
    const server = createHttpServer({ logger: createLogger({ service: 'test', sink: () => undefined }), authToken: 'request-target-token-'.padEnd(40, 'x'),
      routes: [{ method: 'GET', name: 'private', pattern: /^\/private$/, handler: async () => ({ status: 200, body: { ok: true } }) }] });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // Each of these used to throw from `new URL` inside the request listener: an uncaught exception that ends the process.
      for (const target of ['//', '///', '//a:99999/', 'http://']) {
        expect(await raw(port, target)).toEqual({ status: 'HTTP/1.1 400 Bad Request', body: JSON.stringify({ ok: false, code: 'REQUEST_INVALID' }) });
      }
      // Every target the parser accepts is handled exactly as before: absolute form (a proxy's), `*`, odd query strings; auth still applies.
      const unauthorized = { status: 'HTTP/1.1 401 Unauthorized', body: JSON.stringify({ ok: false, code: 'UNAUTHORIZED' }) };
      expect((await raw(port, '/healthz')).status).toBe('HTTP/1.1 200 OK');
      expect((await raw(port, 'http://api/healthz')).status).toBe('HTTP/1.1 200 OK');
      expect(await raw(port, '/private')).toEqual(unauthorized);
      expect(await raw(port, 'http://api/private')).toEqual(unauthorized);
      expect(await raw(port, '/private?x=%zz')).toEqual(unauthorized);
      expect(await raw(port, '*', 'OPTIONS')).toEqual(unauthorized);
    } finally { server.close(); }
  });
});
