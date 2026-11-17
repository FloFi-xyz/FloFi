# SPDX-License-Identifier: AGPL-3.0-only
"""BUILD-FLOFI-VERCEL-STORAGE-001: the serverless function package gate (scripts/function_traces.py)."""

import fnmatch
import importlib.util
import io
import json
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import re
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('function_traces', ROOT / 'scripts' / 'function_traces.py')
traces = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(traces)
FIXTURES = ['e2e/copilot/replay.json', 'e2e/copilot/replay-v2.json', 'e2e/observations/base-recorded-observations.json']


class App:
    """A minimal app directory with a Next.js build output: route traces list files relative to the trace."""

    def __init__(self, root):
        self.app = Path(root) / 'apps' / 'web'
        (self.app / '.next' / 'server' / 'app').mkdir(parents=True)
        fixtures = ', '.join(f"'./{name}'" for name in FIXTURES)
        (self.app / 'next.config.ts').write_text(f'export const RUNTIME_FIXTURES = Object.freeze([{fixtures}]);\n')
        for name in FIXTURES:
            self.file(name, 100)
        self.file('node_modules/next/server.js', 1000)
        self.trace('.next/next-server.js.nft.json', ['node_modules/next/server.js'])

    def file(self, name, size):
        path = self.app / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'x' * size)
        return path

    def trace(self, name, files):
        path = self.app / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'version': 1, 'files': [Path(*(['..'] * (len(Path(name).parts) - 1)), f).as_posix() for f in files]}))
        return path

    def route(self, name, files=(), size=10, sources=('../../../node_modules/.pnpm/react@19.3.0/node_modules/react/index.js',)):
        self.file(f'.next/server/app/{name}.js', size)
        # Turbopack writes one source map per server bundle; its sources are relative to the map's directory.
        (self.app / f'.next/server/app/{name}.js.map').write_text(json.dumps({'version': 3, 'sources': list(sources), 'mappings': ''}))
        return self.trace(f'.next/server/app/{name}.js.nft.json', [*FIXTURES, *files])

    def check(self, budget_mb=traces.BUDGET_MB, contained=()):
        return traces.check(self.app, budget_mb, contained)


class FunctionPackageGate(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.web = App(self.directory.name)

    def test_a_lean_build_passes_and_reports_its_size(self):
        self.web.route('page')
        self.web.route('api/mcp/route')
        errors, summary = self.web.check()
        self.assertEqual(errors, [])
        self.assertEqual(summary['functions'], 2)
        self.assertEqual(summary['runtime_fixtures'], FIXTURES)
        self.assertLess(summary['largest_mb'], 0.01)

    def test_whole_project_trace_fails_on_its_signature_files(self):
        """The regression this build fixed: an unscoped fs call traced e2e evidence, snapshots, configs and build info."""
        for name in ('e2e/visual-evidence/landing/frame.png', 'e2e/swap.spec.ts-snapshots/a.png', 'tsconfig.tsbuildinfo',
                     'playwright.config.ts', 'playwright.motion.config.ts', 'next.config.ts', 'test-results/junit/a.xml',
                     'playwright-report/index.html', '.next/cache/fetch/a'):
            with self.subTest(name=name):
                if name != 'next.config.ts':
                    self.web.file(name, 10)
                self.web.route('page', [name])
                errors, _ = self.web.check()
                self.assertTrue(any(error.startswith(name + ':') for error in errors), errors)

    def test_missing_runtime_fixture_fails(self):
        """Copilot replay and recorded Base observations must stay readable on every app route (FLOFI_COPILOT=replay)."""
        trace = self.web.route('page')
        data = json.loads(trace.read_text())
        data['files'] = [f for f in data['files'] if not f.endswith('replay-v2.json')]
        trace.write_text(json.dumps(data))
        errors, _ = self.web.check()
        self.assertEqual(errors, ['server/app/page.js.nft.json: runtime fixture e2e/copilot/replay-v2.json is not shipped '
                                  '(next.config.ts outputFileTracingIncludes)'])

    def test_function_over_budget_fails(self):
        self.web.file('node_modules/big/index.js', 2_000_000)
        self.web.route('page', ['node_modules/big/index.js'])
        self.web.route('small')
        errors, summary = self.web.check(budget_mb=1)
        self.assertEqual(len(errors), 1)
        self.assertRegex(errors[0], r'^1 function\(s\) exceed the 1 MB budget; largest server/app/page\.js\.nft\.json at 2\.0 MB$')
        self.assertEqual(summary['largest_mb'], 2.0)

    def test_shared_runtime_counts_once_per_function(self):
        """The Next server runtime is part of every function; a file in both traces is counted once."""
        self.web.file('node_modules/next/server.js', 300_000)
        self.web.route('page', ['node_modules/next/server.js'])
        _, summary = self.web.check()
        self.assertEqual(summary['sum_mb'], 0.3)

    def test_missing_build_output_fails_closed(self):
        empty = App(Path(self.directory.name) / 'other')
        errors, summary = empty.check()
        self.assertEqual(summary, {})
        self.assertIn('run the production build first', errors[0])
        empty.route('page')
        (empty.app / '.next' / 'next-server.js.nft.json').unlink()
        errors, _ = empty.check()
        self.assertIn('next-server.js.nft.json missing', errors[0])

    def test_fixture_list_comes_from_next_config(self):
        (self.web.app / 'next.config.ts').write_text('export const OTHER = 1;\n')
        self.web.route('page')
        with self.assertRaisesRegex(SystemExit, 'RUNTIME_FIXTURES not found'):
            self.web.check()

    def test_cli_exit_codes(self):
        self.web.route('page')
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(traces.main([str(self.web.app)]), 0)
        self.assertIn('FUNCTION PACKAGES: PASS', out.getvalue())
        self.web.file('tsconfig.tsbuildinfo', 10)
        self.web.route('page', ['tsconfig.tsbuildinfo'])
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(traces.main([str(self.web.app)]), 1)
        self.assertIn('FUNCTION PACKAGES: FAIL', out.getvalue())
        self.assertIn('tsconfig.tsbuildinfo: test or build artifact traced into 1 function(s)', err.getvalue())


class ContainedReleaseGate(unittest.TestCase):
    """DEC-0058: a release whose advisory is contained as development/CI-only must never ship in the production build."""

    RELEASE = 'picomatch@4.0.7'
    STORE = 'node_modules/.pnpm/picomatch@4.0.7/node_modules/picomatch'

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.web = App(self.directory.name)

    def errors(self, contained=(RELEASE,)):
        errors, _ = self.web.check(contained=contained)
        return errors

    def test_clean_build_proves_absence_and_reports_what_it_checked(self):
        self.web.route('page', sources=['../../../node_modules/.pnpm/zod@4.6.6/node_modules/zod/index.js', '../../../src/page.tsx'])
        errors, summary = self.web.check(contained=[self.RELEASE])
        self.assertEqual(errors, [])
        self.assertEqual((summary['contained'], summary['source_maps']), ([self.RELEASE], 1))

    def test_traced_release_fails(self):
        self.web.file(f'{self.STORE}/index.js', 10)
        self.web.route('page', files=[f'{self.STORE}/index.js'])
        errors = self.errors()
        self.assertEqual(len(errors), 1)
        self.assertIn('picomatch@4.0.7: its advisory is contained only as development/CI-only', errors[0])
        self.assertIn('function trace', errors[0])

    def test_bundled_release_fails_by_store_path_scope_and_peer_suffix(self):
        for source, release in ((f'../../../{self.STORE}/lib/parse.js', self.RELEASE),
                                ('../../../node_modules/.pnpm/picomatch@4.0.7_x@1.0.0/node_modules/picomatch/index.js', self.RELEASE),
                                ('../../../node_modules/.pnpm/%40scope%2Bglob%401.2.3/node_modules/%40scope%2Fglob/i.js', '@scope/glob@1.2.3')):
            with self.subTest(source=source):
                web = App(Path(self.directory.name) / source.replace('/', '_').replace('%', '')[-40:])
                web.route('page', sources=[source])
                errors, _ = web.check(contained=[release])
                self.assertTrue(any('bundled into .next/server/app/page.js' in e for e in errors), errors)

    def test_other_releases_and_peer_names_do_not_match(self):
        self.web.route('page', sources=['../../../node_modules/.pnpm/picomatch@4.0.70/node_modules/picomatch/index.js',
                                        '../../../node_modules/.pnpm/picomatch@2.3.1/node_modules/picomatch/index.js',
                                        '../../../node_modules/.pnpm/fdir@6.5.0_picomatch@4.0.7/node_modules/fdir/dist/index.js'])
        self.assertEqual(self.errors(), [])

    def test_symlinked_location_is_resolved_and_an_unresolvable_one_fails_closed(self):
        real = self.web.file(f'{self.STORE}/index.js', 10).parent
        link = self.web.app / 'node_modules/.pnpm/fdir@6.5.0_picomatch@4.0.7/node_modules/picomatch'
        link.parent.mkdir(parents=True)
        link.symlink_to(real, target_is_directory=True)
        self.web.route('page', sources=['../../../node_modules/.pnpm/fdir@6.5.0_picomatch@4.0.7/node_modules/picomatch/index.js'])
        self.assertTrue(any('bundled into' in e for e in self.errors()))
        other = App(Path(self.directory.name) / 'unresolved')
        other.route('page', sources=['../../../node_modules/.pnpm/tinyglobby@0.2.17/node_modules/picomatch/index.js'])
        errors, _ = other.check(contained=[self.RELEASE])
        self.assertTrue(any('cannot be proven to be another release' in e for e in errors), errors)

    def test_shortened_store_folder_is_decided_by_the_package_manifest_or_fails_closed(self):
        folder = 'node_modules/.pnpm/picomatch@4.0.7_' + 'x' * 40 + '_0123456789abcdef'[:6]
        shortened = 'node_modules/.pnpm/picomatc_4f2a9c'  # pnpm shortens long store folders to a prefix and a hash
        self.web.route('page', sources=[f'../../../{shortened}/node_modules/picomatch/index.js'])
        self.assertTrue(any('its release cannot be proven' in e for e in self.errors()))
        other = App(Path(self.directory.name) / 'with-manifest')
        package = other.file(f'{shortened}/node_modules/picomatch/index.js', 10).parent
        (package / 'package.json').write_text(json.dumps({'name': 'picomatch', 'version': '4.0.7'}))
        other.route('page', sources=[f'../../../{shortened}/node_modules/picomatch/index.js'])
        errors, _ = other.check(contained=[self.RELEASE])
        self.assertTrue(any(e.startswith('picomatch@4.0.7: its advisory is contained') for e in errors), errors)
        (package / 'package.json').write_text(json.dumps({'name': 'picomatch', 'version': '2.3.1'}))
        self.assertEqual(other.check(contained=[self.RELEASE])[0], [])
        self.assertTrue(folder)

    def test_index_maps_and_maps_without_third_party_modules_fail_closed(self):
        self.web.route('page')
        (self.web.app / '.next/server/app/page.js.map').write_text(json.dumps(
            {'version': 3, 'sections': [{'offset': {'line': 0, 'column': 0}, 'url': 'page.part.js.map'}]}))
        self.assertTrue(any('unreadable source map' in e for e in self.errors()))
        bare = App(Path(self.directory.name) / 'bare')
        bare.route('page', sources=['../../../src/page.tsx'])
        errors, _ = bare.check(contained=[self.RELEASE])
        self.assertTrue(any('no server source map names a module from the pnpm store' in e for e in errors), errors)

    def test_bundle_without_source_map_fails_closed_except_next_data_manifests(self):
        self.web.route('page')
        self.web.file('.next/server/chunks/vendor.js', 10)
        (self.web.app / '.next/server/app/page_client-reference-manifest.js').write_text('globalThis.__RSC_MANIFEST = {};\n')
        (self.web.app / '.next/server/next-font-manifest.js').write_text('self.__NEXT_FONT_MANIFEST="{}"\n')
        (self.web.app / '.next/server/fake-manifest.js').write_text('module.exports = require("picomatch");\n')
        errors = self.errors()
        self.assertEqual(sorted(e.split(':')[0] for e in errors), ['.next/server/chunks/vendor.js', '.next/server/fake-manifest.js'])
        self.assertTrue(all('without a source map' in e for e in errors))
        # Nothing contained: nothing to prove, so the gate behaves as before.
        self.assertEqual(self.web.check()[0], [])

    def test_unreadable_source_map_fails_closed(self):
        self.web.route('page')
        (self.web.app / '.next/server/app/page.js.map').write_text('{not json')
        self.assertTrue(any('unreadable source map' in e for e in self.errors()))

    def test_next_external_link_to_the_release_fails(self):
        self.web.route('page')
        real = self.web.file(f'{self.STORE}/index.js', 10).parent
        (self.web.app / '.next/node_modules').mkdir()
        (self.web.app / '.next/node_modules/picomatch-0123456789abcdef').symlink_to(real, target_is_directory=True)
        self.assertTrue(any('.next/node_modules link' in e for e in self.errors()))

    def test_workspace_package_bundlers_make_absence_unprovable(self):
        self.web.route('page')
        packages = Path(self.directory.name) / 'packages'
        for name, build in (('compiled', 'tsc -p tsconfig.json'), ('plain', 'tsc'), ('bundled', 'tsup src/index.ts --dts')):
            (packages / name).mkdir(parents=True)
            (packages / name / 'package.json').write_text(json.dumps({'name': name, 'scripts': {'build': build}}))
        errors = self.errors()
        self.assertEqual(len(errors), 1)
        self.assertIn('bundled: built with "tsup src/index.ts --dts"', errors[0])
        self.assertEqual(self.web.check()[0], [])
        # The repository's packages all build with tsc today.
        for manifest in sorted((ROOT / 'packages').glob('*/package.json')):
            self.assertRegex(json.loads(manifest.read_text())['scripts']['build'], r'^tsc -p tsconfig\.json$', manifest)

    def test_cli_reads_the_contained_releases_from_the_policy(self):
        self.web.route('page')
        policy = Path(self.directory.name) / 'policy.json'
        policy.write_text(json.dumps({'contained_advisories': [{'advisory': 'GHSA-aaaa-bbbb-cccc', 'identity': self.RELEASE}]}))
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(traces.main([str(self.web.app), '--policy', str(policy)]), 0)
        self.assertIn('Contained development/CI-only releases (DEC-0058) checked against', out.getvalue())
        self.web.file('.next/server/chunks/vendor.js', 10)
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as err:
            self.assertEqual(traces.main([str(self.web.app), '--policy', str(policy)]), 1)
        self.assertIn('without a source map', err.getvalue())
        self.assertEqual(traces.contained_releases(), sorted({e['identity'] for e in json.loads(traces.POLICY.read_text())['contained_advisories']}))


class RepositoryConfiguration(unittest.TestCase):
    """The real next.config.ts: fixtures shipped everywhere, excludes never touch a fixture, the gate runs after every build."""

    def test_next_config_ships_fixtures_and_excludes_only_unread_paths(self):
        config = (ROOT / 'apps' / 'reference-dapp' / 'next.config.ts').read_text()
        fixtures = traces.runtime_fixtures(ROOT / 'apps' / 'reference-dapp')
        self.assertEqual(fixtures, FIXTURES)
        for name in fixtures:
            self.assertTrue((ROOT / 'apps' / 'reference-dapp' / name).is_file(), name)
        self.assertIn("outputFileTracingIncludes: { '/**': [...RUNTIME_FIXTURES] }", config)
        self.assertIn("outputFileTracingExcludes: { '/**': [...TRACE_EXCLUDES] }", config)
        excludes = re.findall(r"'\./([^']+)'", re.search(r'TRACE_EXCLUDES = Object\.freeze\(\[([^\]]*)\]\)', config).group(1))
        self.assertTrue(excludes)
        # Next matches excludes with picomatch `contains: true` on absolute paths, i.e. a pattern may match a path prefix
        # (`e2e/**/*.ts` also removes `e2e/x.spec.ts-snapshots/`). fnmatch on `pattern*` (its `*` crosses `/`) over-approximates that.
        def removes(pattern, name):
            return fnmatch.fnmatch(name, pattern) or fnmatch.fnmatch(name, pattern + '*')
        for pattern in excludes:
            for name in fixtures:
                self.assertFalse(removes(pattern, name), f'{pattern} would remove {name}')
        # The signature files that reveal a whole-project trace are never excluded, so the gate still sees one.
        for name in ('tsconfig.tsbuildinfo', 'playwright.config.ts', 'next.config.ts'):
            self.assertFalse(any(removes(pattern, name) for pattern in excludes), name)

    def test_gate_runs_after_every_production_build(self):
        command = 'python3 scripts/function_traces.py apps/reference-dapp'
        for path in ('.circleci/config.yml', '.github/workflows/contracts.yml', 'scripts/gcp-ci-full.sh'):
            with self.subTest(path=path):
                lines = [line.strip() for line in (ROOT / path).read_text().splitlines()]
                self.assertEqual(lines.count(command), 1)
                self.assertEqual(lines[lines.index(command) - 1], 'pnpm build')

    def test_migration_loader_is_not_traced(self):
        source = (ROOT / 'packages' / 'cloud-runtime' / 'src' / 'migrations.ts').read_text()
        self.assertIn('readdir(/*turbopackIgnore: true*/ directory)', source)
        self.assertIn('readFile(/*turbopackIgnore: true*/ `${directory}/${file}`', source)


if __name__ == '__main__':
    unittest.main()
