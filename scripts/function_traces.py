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
- a function (route trace + Next server runtime, each file counted once) exceeds the size budget;
- (DEC-0058) a release whose advisory the dependency policy contains as development/CI-only ships in the build: in a
  function trace (runtime-loaded), in a server source map (bundled), or behind a `.next/node_modules` link. What cannot be
  proven clean fails too: a server bundle without a source map (other than Next's data manifests), an unreadable or
  index-only map, maps that name no third-party module at all, a path to a watched package whose release cannot be
  identified, or a workspace package built with anything but `tsc` (a bundler could inline a dependency unseen). The
  containment must be re-proved by every production build, or certification stops.

It reads only the build output. It does not measure Vercel's billed storage; it bounds what each deployment adds.
"""

import argparse
import fnmatch
import json
from pathlib import Path
import re
import sys
import urllib.parse

# A function above this is a packaging regression to explain in review (measured 48.6 MB for the largest after this build;
# 159.4 MB before). Raise it only with the measured reason.
BUDGET_MB = 64
FORBIDDEN = ('e2e/visual-evidence/*', '*-snapshots/*', '*/test-results/*', 'test-results/*', 'playwright-report/*', '*.nft.json',
             'tsconfig.tsbuildinfo', 'playwright*.config.ts', 'vitest.config.ts', 'next.config.ts', '.next/cache/*')
SERVER_TRACES = ('next-server.js.nft.json',)
FIXTURES = re.compile(r"RUNTIME_FIXTURES\s*=\s*Object\.freeze\(\[([^\]]*)\]\)")
POLICY = Path(__file__).resolve().parents[1] / 'docs' / 'security' / 'dependency-policy.json'
# Next's server data manifests (`globalThis.__RSC_MANIFEST = ...`, `self.__NEXT_FONT_MANIFEST = ...`) carry no bundled module.
MANIFEST_DATA = re.compile(r'(?:globalThis|self)\.__[A-Z][A-Z_]*\s*=')


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


def contained_releases(policy=POLICY):
    """Releases whose advisories docs/security/dependency-policy.json contains as development/CI-only (DEC-0058)."""
    entries = json.loads(Path(policy).read_text()).get('contained_advisories') or []
    return sorted({entry['identity'] for entry in entries if isinstance(entry, dict) and isinstance(entry.get('identity'), str)})


_SEMVER = r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?'


def _release_at(text, name, position):
    """The version of package `name` whose `/node_modules/<name>/` segment starts at `position` in a path: from the pnpm store
    folder when it names the release exactly (`<name, / as +>@<version>` then `_`, `(` or nothing), else from that package's
    package.json on disk; None when neither proves it (a shortened store folder, a link not on disk, a hoisted copy)."""
    store = re.search(r'/node_modules/\.pnpm/([^/]+)$', text[:position])
    if store:
        exact = re.fullmatch(re.escape(name.replace('/', '+')) + '@(' + _SEMVER + r')(?:[_(].*)?', store.group(1))
        if exact:
            return exact.group(1)
    manifest = Path(text[:position] + f'/node_modules/{name}/package.json')
    try:
        if manifest.is_absolute() and manifest.is_file():
            document = json.loads(manifest.read_text())
            if document.get('name') == name and isinstance(document.get('version'), str):
                return document['version']
    except (OSError, ValueError):
        pass
    return None


def artifact_exposure(app, traced_files, contained):
    """([error], {release: [where]}, maps checked): where the build ships a contained release, and what cannot be proven."""
    if not contained:
        return [], {}, 0
    wanted = {}
    for identity in contained:
        name, _, version = identity.rpartition('@')
        wanted.setdefault(name, set()).add(version)
    errors, found, maps, store_sources = [], {}, 0, 0

    def mark(text, where, unprovable):
        """Record every contained release the path names; report a watched package whose release cannot be proven."""
        for name, versions in wanted.items():
            marker = f'/node_modules/{name}/'
            position = text.find(marker)
            while position != -1:
                version = _release_at(text, name, position)
                if version in versions:
                    found.setdefault(f'{name}@{version}', []).append(where)
                elif version is None and unprovable:
                    errors.append(f'{where}: {text} reaches {name} but its release cannot be proven (shortened store folder or '
                                  'unresolvable link), so it cannot be proven to be another release')
                position = text.find(marker, position + 1)

    # Workspace packages reach the app as tsc output, whose imports Next resolves and maps. A bundler could inline a
    # dependency into dist/ where no source map names it, so any other build tool makes the absence unprovable.
    for manifest in sorted((app.parents[1] / 'packages').glob('*/package.json')):
        try:
            build = str((json.loads(manifest.read_text()).get('scripts') or {}).get('build', ''))
        except ValueError:
            build = '<unreadable package.json>'
        if build and not re.fullmatch(r'tsc(?:\s+(?:-p|--project|-b|--build)\s+[\w./-]+)?', build.strip()):
            errors.append(f'{manifest.parent.name}: built with "{build}", which may inline dependencies into dist/ unseen by source '
                          'maps, so contained releases cannot be proven absent (build workspace packages with tsc)')
    for path in sorted(traced_files):
        mark(path.as_posix(), 'function trace ' + path.name, unprovable=True)
    links = app / '.next' / 'node_modules'
    if links.is_dir():
        for link in sorted(links.rglob('*')):
            if link.is_symlink():
                mark(link.resolve().as_posix() + '/', '.next/node_modules link ' + link.name, unprovable=True)
    for bundle in sorted((app / '.next' / 'server').rglob('*.js')):
        name = bundle.relative_to(app).as_posix()
        source_map = bundle.with_name(bundle.name + '.map')
        if not source_map.is_file():
            if not (bundle.name.endswith('manifest.js') and MANIFEST_DATA.match(bundle.read_text(errors='replace')[:200])):
                errors.append(f'{name}: server bundle without a source map, so contained releases cannot be proven absent from it')
            continue
        try:
            document = json.loads(source_map.read_text())
            sources = list(document.get('sources') or [])
            for section in document.get('sections') or []:
                if 'map' not in section:
                    raise ValueError('index map section without an inline map')
                sources += (section.get('map') or {}).get('sources') or []
        except (ValueError, AttributeError, TypeError):
            errors.append(f'{name}.map: unreadable source map, so contained releases cannot be proven absent from {name}')
            continue
        maps += 1
        base = source_map.parent / str(document.get('sourceRoot') or '')
        for source in sources:
            text = urllib.parse.unquote(str(source))
            store_sources += '/node_modules/.pnpm/' in '/' + text
            local = None if re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', text) else (base / text)
            resolved = local.resolve() if local is not None and local.exists() else None
            # The resolved real path decides when it exists (it carries the store folder or a package.json); otherwise the
            # text must name the release itself.
            mark(resolved.as_posix() if resolved else '/' + text.lstrip('/'), f'bundled into {name}', unprovable=True)
    if maps and not store_sources:
        errors.append('no server source map names a module from the pnpm store, so the maps cannot show which third-party releases '
                      'are bundled and contained releases cannot be proven absent')
    for identity, places in sorted(found.items()):
        errors.append(f'{identity}: its advisory is contained only as development/CI-only (docs/security/dependency-policy.json '
                      f'contained_advisories), but the production build ships it ({len(places)} place(s), e.g. {places[0]}); '
                      'update it or remove it from production code')
    return errors, found, maps


def check(app, budget_mb=BUDGET_MB, contained=()):
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
    every_traced = set(shared)

    def size(path):
        if path not in sizes:
            sizes[path] = path.stat().st_size if path.is_file() else 0
        return sizes[path]

    for trace in routes:
        name = trace.relative_to(app / '.next').as_posix()
        files = traced(trace)
        every_traced |= files
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
    exposure_errors, _, maps = artifact_exposure(app, every_traced, contained)
    errors.extend(exposure_errors)
    summary = {'functions': len(functions), 'largest_mb': round(largest / 1e6, 1),
               'sum_mb': round(sum(functions.values()) / 1e6, 1), 'budget_mb': budget_mb, 'runtime_fixtures': fixtures,
               'contained': list(contained), 'source_maps': maps, 'traced_files': len(every_traced)}
    return errors, summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('app', type=Path, help='the Next.js app directory, e.g. apps/reference-dapp')
    parser.add_argument('--budget-mb', type=float, default=BUDGET_MB)
    parser.add_argument('--policy', type=Path, default=POLICY, help='dependency policy with the contained advisories')
    args = parser.parse_args(argv)
    errors, summary = check(args.app, args.budget_mb, contained_releases(args.policy))
    for error in errors:
        print('FUNCTION PACKAGE:', error, file=sys.stderr)
    if summary:
        print('Function packages: {functions} traced functions, largest {largest_mb} MB (budget {budget_mb} MB), '
              '{sum_mb} MB summed before deduplication'.format(**summary))
        if summary['contained']:
            print('Contained development/CI-only releases (DEC-0058) checked against {traced_files} traced files and {source_maps} '
                  'server source maps: {names}'.format(names=', '.join(summary['contained']), **summary))
    print('FUNCTION PACKAGES:', 'FAIL' if errors else 'PASS')
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
