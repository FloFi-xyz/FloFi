// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-MCP-002 regression: no FloFi-owned model is ever called. The consumer's own assistant (Claude, ChatGPT) interprets
 * language; FloFi's MCP gateway, OAuth server, approval handoff, in-chat panel and /approve page only compute. No source of those
 * surfaces imports a model SDK, reaches a model API, reads a model API key or reaches the FloFi Copilot; and the whole OAuth +
 * MCP journey works with every model key unset.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MODEL = /from ['"](openai|@anthropic-ai\/[a-z-]+|@ai-sdk\/[a-z-]+|@google\/generative-ai)['"]|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|copilot-service|copilot-action|OPENAI_API_KEY|ANTHROPIC_API_KEY/i;
const ROOTS = ['src/mcp', 'src/engine', 'src/app/api/mcp', 'src/app/oauth', 'src/app/.well-known', 'src/app/approve', 'src/app/approve-action.ts', 'src/app/connections',
  'src/components/approval-handoff.tsx'];
function files(path: string): string[] {
  let stat; try { stat = statSync(path); } catch { return []; }
  if (stat.isFile()) return /\.(ts|tsx|mjs|html)$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  return readdirSync(path).flatMap(name => files(join(path, name)));
}

/** Runtime imports only (`import type` / `export type` carry no code), static and dynamic — the walker of `automations/boundaries.test.ts`. */
const importsOf = (file: string) => {
  const text = readFileSync(file, 'utf8');
  return [...[...text.matchAll(/^(?:import|export)\b[^;]*?\sfrom\s+'([^']+)';/gms)].filter(m => !/^(?:import|export)\s+type\b/.test(m[0])),
    ...text.matchAll(/^import\s+'([^']+)';/gm), ...text.matchAll(/\bimport\(\s*'([^']+)'\s*\)/g)].map(m => m[1]!);
};
function resolveFile(file: string, specifier: string): string | null {
  const base = resolve(dirname(file), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}
function closure(entry: string): string[] {
  const reached = new Set<string>(), queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('.')) continue;
      const next = resolveFile(file, specifier);
      if (next && /\.(?:ts|tsx)$/.test(next)) queue.push(next);
    }
  }
  return [...reached];
}
const code = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('BUILD-MCP-002: no FloFi LLM cost', () => {
  it('no MCP, OAuth, handoff, panel or approval source references a model client, API or key', () => {
    const scanned = ROOTS.flatMap(root => files(join(__dirname, '..', '..', '..', root)));
    expect(scanned.length).toBeGreaterThan(20);
    for (const file of scanned) expect(readFileSync(file, 'utf8'), file).not.toMatch(MODEL);
  });

  // The scan above reads the MCP sources themselves; a module they import (the concept catalog, the platform guide, the shared automation copy, the
  // Automations read path) could still pull a model client in. Everything the MCP route can load at run time is checked too, transitively.
  it('nothing the MCP route can load — transitively, dynamic imports included — reaches a model client, a model key or the Copilot service', () => {
    const app = join(__dirname, '..', '..', '..'), rel = (file: string) => relative(app, file).replace(/\\/g, '/');
    const reached = [...new Set(['src/app/api/mcp/route.ts', 'src/mcp/gateway.ts', 'src/mcp/tools.ts', 'src/mcp/automations.ts', 'src/platform/explain.ts']
      .flatMap(entry => closure(join(app, entry))))];
    const names = reached.map(rel);
    // The education and automation tools' shared modules are part of it (so this guard covers them).
    expect(names).toEqual(expect.arrayContaining(['src/domain/intelligence/concepts.ts', 'src/domain/intelligence/platform-guide.ts', 'src/automations/explain.ts',
      'src/server/automation-operation.ts', 'src/platform/explain.ts']));
    expect(names.length).toBeGreaterThan(200);
    expect(names.filter(name => /copilot-(?:service|action|providers)|^src\/learning\//.test(name))).toEqual([]);
    for (const file of reached) expect(code(file), rel(file)).not.toMatch(MODEL);
  });
});
