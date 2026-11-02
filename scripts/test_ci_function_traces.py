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

    def route(self, name, files=(), size=10):
        self.file(f'.next/server/app/{name}.js', size)
        return self.trace(f'.next/server/app/{name}.js.nft.json', [*FIXTURES, *files])

    def check(self, budget_mb=traces.BUDGET_MB):
        return traces.check(self.app, budget_mb)


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
