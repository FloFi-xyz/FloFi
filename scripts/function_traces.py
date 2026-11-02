#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Serverless function package gate for the production build (BUILD-FLOFI-VERCEL-STORAGE-001).

Vercel packages every Next.js server route as a function from its build trace (`.next/server/**/*.nft.json`) plus the Next
server runtime trace, and keeps those packages for every retained deployment. One dynamic filesystem call once made the
tracer ship the whole app directory (89 MB of e2e evidence, sources, public assets) in 58 functions, 159 MB each. This gate
runs right after `pnpm build` and fails when:

- a traced file is test or build evidence that never runs in a function (visual evidence, Playwright snapshots or configs,
  TypeScript build info, Next's build cache, test reports);
- an app route lacks one of the committed runtime fixtures that `next.config.ts` (RUNTIME_FIXTURES) ships with every route;
- a function (route trace + Next server runtime, each file counted once) exceeds the size budget.

It reads only the build output. It does not measure Vercel's billed storage; it bounds what each deployment adds.
"""

import argparse
import fnmatch
import json
from pathlib import Path
import re
import sys

# A function above this is a packaging regression to explain in review (measured 48.6 MB for the largest after this build;
# 159.4 MB before). Raise it only with the measured reason.
BUDGET_MB = 64
FORBIDDEN = ('e2e/visual-evidence/*', '*-snapshots/*', '*/test-results/*', 'test-results/*', 'playwright-report/*', '*.nft.json',
             'tsconfig.tsbuildinfo', 'playwright*.config.ts', 'vitest.config.ts', 'next.config.ts', '.next/cache/*')
SERVER_TRACES = ('next-server.js.nft.json',)
FIXTURES = re.compile(r"RUNTIME_FIXTURES\s*=\s*Object\.freeze\(\[([^\]]*)\]\)")


def runtime_fixtures(app):
    """The fixture list from next.config.ts, the one place it is declared."""
    match = FIXTURES.search((app / 'next.config.ts').read_text())
    if not match:
        raise SystemExit('next.config.ts: RUNTIME_FIXTURES not found')
    fixtures = re.findall(r"'\./([^']+)'", match.group(1))
    if not fixtures:
        raise SystemExit('next.config.ts: RUNTIME_FIXTURES is empty')
    return fixtures


def traced(trace):
    """Absolute files of one trace, plus the traced entry itself."""
    base = trace.parent
    files = {(base / name).resolve() for name in json.loads(trace.read_text()).get('files', [])}
    entry = trace.with_name(trace.name[:-len('.nft.json')])
    if entry.is_file():
        files.add(entry.resolve())
    return files


def check(app, budget_mb=BUDGET_MB):
    app = app.resolve()
    server = app / '.next' / 'server'
    routes = sorted(server.rglob('*.nft.json')) if server.is_dir() else []
    if not routes:
        return [f'{app}/.next/server has no function traces: run the production build first'], {}
    shared = set()
    for name in SERVER_TRACES:
        path = app / '.next' / name
        if not path.is_file():
            return [f'{path} missing: run the production build first'], {}
        shared |= traced(path)
    fixtures = runtime_fixtures(app)
    errors, functions, forbidden, sizes = [], {}, {}, {}

    def size(path):
        if path not in sizes:
            sizes[path] = path.stat().st_size if path.is_file() else 0
        return sizes[path]

    for trace in routes:
        name = trace.relative_to(app / '.next').as_posix()
        files = traced(trace)
        relative = {path.relative_to(app).as_posix() for path in files if path.is_relative_to(app)}
        for path in sorted(relative):
            if any(fnmatch.fnmatch(path, pattern) for pattern in FORBIDDEN) or '/.next/cache/' in f'/{path}':
                forbidden.setdefault(path, []).append(name)
        if name.startswith('server/app/'):
            errors.extend(f'{name}: runtime fixture {fixture} is not shipped (next.config.ts outputFileTracingIncludes)'
                          for fixture in fixtures if fixture not in relative)
        functions[name] = sum(size(path) for path in files | shared)
    for path, names in sorted(forbidden.items()):
        errors.append(f'{path}: test or build artifact traced into {len(names)} function(s), e.g. {names[0]}')
    largest = max(functions.values())
    if largest > budget_mb * 1e6:
        over = sorted((n for n, s in functions.items() if s > budget_mb * 1e6), key=functions.get, reverse=True)
        errors.append(f'{len(over)} function(s) exceed the {budget_mb} MB budget; largest {over[0]} at {functions[over[0]] / 1e6:.1f} MB')
    summary = {'functions': len(functions), 'largest_mb': round(largest / 1e6, 1),
               'sum_mb': round(sum(functions.values()) / 1e6, 1), 'budget_mb': budget_mb, 'runtime_fixtures': fixtures}
    return errors, summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('app', type=Path, help='the Next.js app directory, e.g. apps/reference-dapp')
    parser.add_argument('--budget-mb', type=float, default=BUDGET_MB)
    args = parser.parse_args(argv)
    errors, summary = check(args.app, args.budget_mb)
    for error in errors:
        print('FUNCTION PACKAGE:', error, file=sys.stderr)
    if summary:
        print('Function packages: {functions} traced functions, largest {largest_mb} MB (budget {budget_mb} MB), '
              '{sum_mb} MB summed before deduplication'.format(**summary))
    print('FUNCTION PACKAGES:', 'FAIL' if errors else 'PASS')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
