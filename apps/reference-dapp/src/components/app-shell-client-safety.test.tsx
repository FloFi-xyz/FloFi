// SPDX-License-Identifier: AGPL-3.0-only
/**
 * BUILD-FLOFI-BATCH-PAYMENT-AND-MCP-HARDENING-001 (WS02 review F1): `app-shell.tsx` is a client component, so nothing it imports may reach a server-only
 * module. `editor/workflow-strategy.ts` value-imports `automations/binding.ts`, which value-imports `platform/index.ts` (database, crypto, environment):
 * the Editor reads a Batch Payment's run steps through the client-safe `domain/batch-run-record.ts` instead. These checks read the sources only (a
 * static import walk that follows every import that is not `import type` / `export type`, and stops at a 'use server' action module, which the bundler
 * replaces with a reference); nothing is built or run.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// An import / export clause holds no quote, semicolon, `=` or parenthesis, so a match never runs on from one statement into a later one.
const IMPORT = /(?:^|[;\n}])\s*(?:import|export)\s+(type\s+)?(?:[^;'"=()]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
/** Every module specifier a source imports or re-exports; `typeOnly` too when asked (erased, but still named). */
function specifiers(source: string, typeOnly = false): string[] {
  return [...source.matchAll(IMPORT)].filter(m => typeOnly || !m[1]).map(m => m[2] ?? m[3]!).filter(Boolean);
}
function resolveModule(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  return [base, base + '.ts', base + '.tsx', `${base}/index.ts`, `${base}/index.tsx`].find(c => /\.tsx?$/.test(c) && existsSync(c) && statSync(c).isFile()) ?? null;
}
const USE_SERVER = /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*['"]use server['"]/;
/** The app modules (relative to src/) and the package / builtin specifiers a module reaches through value imports. */
function reach(entry: string): { readonly modules: ReadonlySet<string>; readonly bare: ReadonlySet<string> } {
  const seen = new Set<string>(), bare = new Set<string>(), queue = [resolve(src, entry)];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    if (file !== resolve(src, entry) && USE_SERVER.test(source)) continue;
    for (const spec of specifiers(source)) {
      if (!spec.startsWith('.')) { bare.add(spec); continue; }
      const next = resolveModule(file, spec);
      if (next) queue.push(next);
    }
  }
  return { modules: new Set([...seen].map(file => relative(src, file))), bare };
}
const SERVER_ONLY_BARE = /^(?:node:.*|pg|pg-.*|fs|crypto|path|os|net|tls|child_process|server-only)$/;

describe('F1: the Editor shell stays client-safe', () => {
  it('app-shell.tsx imports no editor/workflow-strategy, automations/ or platform/ module (not even a type)', () => {
    const imports = specifiers(readFileSync(resolve(src, 'components/app-shell.tsx'), 'utf8'), true);
    expect(imports).toContain('../domain/batch-run-record');
    expect(imports.filter(spec => /(?:^|\/)editor\/workflow-strategy|^\.\.\/automations\/|^\.\.\/platform\//.test(spec))).toEqual([]);
  });

  it('domain/batch-run-record.ts reaches no platform/, server/, automations/, editor/, app/ or engine module, and no Node builtin or pg', () => {
    const { modules, bare } = reach('domain/batch-run-record.ts');
    expect(modules.size).toBeGreaterThan(1);
    expect([...modules].filter(file => /^(?:platform|server|automations|editor|app|engine)\//.test(file))).toEqual([]);
    expect([...bare].filter(spec => SERVER_ONLY_BARE.test(spec))).toEqual([]);
    // Only workspace packages the shell already imports itself.
    expect([...bare].filter(spec => !spec.startsWith('@defi-workflow-engine/'))).toEqual([]);
  });

  it('the shell\'s whole client import graph never reaches editor/workflow-strategy, automations/binding or platform/index', () => {
    const { modules, bare } = reach('components/app-shell.tsx');
    expect(modules.has('domain/batch-run-record.ts')).toBe(true);
    expect(modules.has('components/editor-workflow-run.tsx')).toBe(true);
    expect([...modules].filter(file => ['editor/workflow-strategy.ts', 'automations/binding.ts', 'platform/index.ts'].includes(file))).toEqual([]);
    expect([...bare].filter(spec => /^(?:pg|pg-.*|server-only)$/.test(spec))).toEqual([]);
  });
});
