// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-RH-002 loopback harness (127.0.0.1:8561) for the Robinhood Chain authoring browser suite: it serves the committed read-only
 * capture of the official Stock Token registry (packages/action-registry/test/fixtures) at the path the MOCKED mode reads, so the
 * Canvas catalog search runs against all 194 official assets with no public network. `POST /__harness/registry` switches it between
 * `ok`, `unavailable` (HTTP 503) and `slow` (answers after 1.5 s) to exercise the loading and unavailable states. There is no chain and
 * no send path here: nothing can be quoted, signed or broadcast through it.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const REGISTRY = readFileSync(new URL('../../../packages/action-registry/test/fixtures/robinhood-rhj-assets-2026-10-11.json', import.meta.url), 'utf8');
let mode: 'ok' | 'unavailable' | 'slow' = 'ok', reads = 0;
createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:8561');
  if (request.method === 'POST' && url.pathname === '/__harness/registry') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const next = (JSON.parse(body || '{}') as { mode?: unknown }).mode;
    if (next !== 'ok' && next !== 'unavailable' && next !== 'slow') { response.writeHead(400).end(); return; }
    mode = next; reads = 0;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/__harness/registry') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode, reads }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/rhj/assets') {
    reads += 1;
    if (mode === 'unavailable') { response.writeHead(503, { 'content-type': 'text/plain' }).end('MOCKED registry unavailable'); return; }
    if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 1_500));
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(REGISTRY) }).end(REGISTRY);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/plain' }).end('MOCKED Robinhood Chain registry harness');
}).listen(8561, '127.0.0.1');
