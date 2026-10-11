// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-BASE-001 loopback harness (127.0.0.1:8562) for the Base authoring browser suite: it serves FloFi's own Base token-list fixture
 * (packages/action-registry/test/fixtures: token-list format, Base assets read from chain; the GPL-3.0 Uniswap list itself is never
 * committed) at the path the MOCKED mode reads, so the Canvas search runs over a validated Base catalog with no public network.
 * `POST /__harness/token-list` switches it between `ok`, `unavailable` (HTTP 503) and `slow` (answers after 1.5 s). There is no chain and
 * no send path here: nothing can be quoted, signed or broadcast through it.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const LIST = readFileSync(new URL('../../../packages/action-registry/test/fixtures/base-token-list-fixture.json', import.meta.url), 'utf8');
let mode: 'ok' | 'unavailable' | 'slow' = 'ok', reads = 0;
createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1:8562');
  if (request.method === 'POST' && url.pathname === '/__harness/token-list') {
    let body = '';
    for await (const chunk of request) body += chunk;
    const next = (JSON.parse(body || '{}') as { mode?: unknown }).mode;
    if (next !== 'ok' && next !== 'unavailable' && next !== 'slow') { response.writeHead(400).end(); return; }
    mode = next; reads = 0;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/__harness/token-list') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ mode, reads }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/token-list') {
    reads += 1;
    if (mode === 'unavailable') { response.writeHead(503, { 'content-type': 'text/plain' }).end('MOCKED token list unavailable'); return; }
    if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 1_500));
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(LIST) }).end(LIST);
    return;
  }
  response.writeHead(200, { 'content-type': 'text/plain' }).end('MOCKED Base token-list harness');
}).listen(8562, '127.0.0.1');
