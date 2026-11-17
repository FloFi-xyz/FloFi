// SPDX-License-Identifier: AGPL-3.0-only
import { Agent, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createHttpServer, createLogger } from '../src/index.js';

type Answer = { status: number; connection: string | undefined; body: unknown };
const call = (port: number, agent: Agent | false, method: 'GET' | 'POST', path: string) => new Promise<Answer>((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path, agent, headers: method === 'POST' ? { 'content-type': 'application/json' } : {} }, res => {
    let data = ''; res.on('data', chunk => { data += String(chunk); });
    res.on('end', () => resolve({ status: res.statusCode ?? 0, connection: res.headers.connection, body: JSON.parse(data) as unknown }));
  });
  req.on('error', error => reject(new Error((error as { code?: string }).code ?? 'REQUEST_FAILED')));
  req.end(method === 'POST' ? '{}' : undefined);
});

describe('BUILD-INFRA-API-FAILOVER-CERT-001: a draining HTTP server finishes its work and takes no new work', () => {
  it('after close(): in-flight answers close their kept-alive connection, readiness reports false, new connections are refused, close completes', async () => {
    let release!: () => void, holdReadiness = false, releaseReadiness!: () => void, slowArrived!: () => void, probeArrived!: () => void;
    const work = new Promise<void>(resolve => { release = resolve; }), readiness = new Promise<void>(resolve => { releaseReadiness = resolve; });
    const arrived = Promise.all([new Promise<void>(resolve => { slowArrived = resolve; }), new Promise<void>(resolve => { probeArrived = resolve; })]);
    const server = createHttpServer({ logger: createLogger({ service: 'test', sink: () => undefined }), authToken: null,
      ready: async () => { if (holdReadiness) { probeArrived(); await readiness; } return true; },
      routes: [{ method: 'POST', name: 'slow', pattern: /^\/slow$/, handler: async () => { slowArrived(); await work; return { status: 200, body: { ok: true } }; } }] });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port, agent = new Agent({ keepAlive: true }); // as a reverse proxy pools its connections
    try {
      expect(await call(port, agent, 'GET', '/readyz')).toEqual({ status: 200, connection: 'keep-alive', body: { ok: true } });
      // A request and a readiness probe are in flight when the drain starts.
      holdReadiness = true;
      const slow = call(port, agent, 'POST', '/slow'), probe = call(port, agent, 'GET', '/readyz');
      await arrived;                                                       // both are inside the server, not merely sent
      let closed = false;
      server.close(() => { closed = true; });
      await expect(call(port, false, 'GET', '/healthz')).rejects.toThrow('ECONNREFUSED');
      release(); releaseReadiness();
      expect(await slow).toEqual({ status: 200, connection: 'close', body: { ok: true } });
      expect(await probe).toEqual({ status: 503, connection: 'close', body: { ok: false } });
      // No connection is left open, so the server closes now — not when the client's kept-alive sockets would time out.
      for (const deadline = Date.now() + 2_000; !closed && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 20));
      expect(closed).toBe(true);
    } finally { agent.destroy(); server.close(); }
  });

  it('drained() waits for a handler whose caller already left, after the server itself has closed', async () => {
    let release!: () => void, finished = false, started!: () => void;
    const work = new Promise<void>(resolve => { release = resolve; }), running = new Promise<void>(resolve => { started = resolve; });
    const server = createHttpServer({ logger: createLogger({ service: 'test', sink: () => undefined }), authToken: null,
      routes: [{ method: 'POST', name: 'mutation', pattern: /^\/mutation$/, handler: async () => {
        started(); await work; finished = true; return { status: 200, body: { ok: true } };
      } }] });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // The caller (a BFF whose own deadline passed) disconnects; the mutation keeps running on the server.
      const caller = request({ host: '127.0.0.1', port, method: 'POST', path: '/mutation', agent: false, headers: { 'content-type': 'application/json' } });
      caller.on('error', () => undefined);
      caller.end('{}');
      await running;
      caller.destroy();
      await new Promise(resolve => setTimeout(resolve, 50));
      await new Promise<void>(resolve => server.close(() => resolve()));   // no connection is left: the server closes at once
      let isDrained = false;
      const drained = server.drained().then(() => { isDrained = true; });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect([finished, isDrained, server.activeHandlers()]).toEqual([false, false, 1]);
      release();
      await drained;
      expect([finished, server.activeHandlers()]).toEqual([true, 0]);
      expect(await server.drained()).toBeUndefined();                      // idle: resolves immediately
    } finally { release(); if (server.listening) server.close(); }
  });
});
