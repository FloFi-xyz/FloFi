"""Archive identity must reject tampering, omissions and untracked additions."""
import importlib.util
import json
import subprocess
import tempfile
import tomllib
from pathlib import Path
import unittest

import agent_guard

spec = importlib.util.spec_from_file_location('source_snapshot', Path(__file__).with_name('gcp-source-snapshot.py'))
snapshot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot)


class SourceSnapshot(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'implementation.ts').write_text('export const value = 1;\n')
        files = [snapshot.inspect_file(self.root, 'implementation.ts')]
        self.digest = snapshot.digest_files(files)
        self.manifest = {'files': files, 'snapshotSha256': self.digest, 'changedPaths': ['implementation.ts']}

    def test_exact_archive_passes(self):
        snapshot.verify_manifest(self.root, self.manifest, self.digest)

    def test_changed_bytes_fail(self):
        (self.root / 'implementation.ts').write_text('export const value = 2;\n')
        with self.assertRaisesRegex(ValueError, 'BYTES_MISMATCH'):
            snapshot.verify_manifest(self.root, self.manifest, self.digest)

    def test_extra_and_missing_files_fail(self):
        (self.root / 'untracked.ts').write_text('extra\n')
        with self.assertRaisesRegex(ValueError, 'INVENTORY_MISMATCH'):
            snapshot.verify_manifest(self.root, self.manifest, self.digest)
        (self.root / 'untracked.ts').unlink()
        (self.root / 'implementation.ts').unlink()
        with self.assertRaisesRegex(ValueError, 'INVENTORY_MISMATCH'):
            snapshot.verify_manifest(self.root, self.manifest, self.digest)

    def test_wrong_identity_and_secret_paths_fail(self):
        with self.assertRaisesRegex(ValueError, 'IDENTITY_MISMATCH'):
            snapshot.verify_manifest(self.root, self.manifest, '0' * 64)
        (self.root / '.env.local').write_text('not uploaded\n')
        with self.assertRaisesRegex(ValueError, 'Environment file refused'):
            snapshot.inspect_file(self.root, '.env.local')

    def write(self, relative, body):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)

    def test_all_repository_project_agents_and_bounded_config_survive_snapshot_verification(self):
        self.write(snapshot.PROJECT_CODEX_CONFIG, '[agents]\nmax_concurrent_threads_per_session = 3\n')
        for relative in snapshot.PROJECT_CODEX_AGENTS:
            domain = Path(relative).stem
            self.write(relative, f'name = "{domain}"\ndescription = "Engineering review"\ndeveloper_instructions = "Read-only review"\n')
        paths = sorted(snapshot.PROJECT_CODEX_FILES | {'implementation.ts'})
        files = [snapshot.inspect_file(self.root, relative) for relative in paths]
        digest = snapshot.digest_files(files)
        manifest = {'files': files, 'snapshotSha256': digest, 'changedPaths': paths}
        snapshot.verify_manifest(self.root, manifest, digest)
        # Agent instructions participate in the byte identity just like source.
        agent = sorted(snapshot.PROJECT_CODEX_AGENTS)[0]
        with (self.root / agent).open('a') as stream:
            stream.write('# modified after recording the snapshot identity\n')
        with self.assertRaisesRegex(ValueError, 'BYTES_MISMATCH'):
            snapshot.verify_manifest(self.root, manifest, digest)

    def test_codex_credentials_local_state_and_unknown_agent_paths_are_refused(self):
        for relative in ['.codex/auth.json', '.codex/credentials.json', '.codex/config.local.toml',
                         '.codex/sessions/rollout.jsonl', '.codex/agents/local.toml',
                         '.codex/agents/flofi-mcp-channels.toml', '.codex/agents/flofi-swap/auth.json',
                         'apps/reference-dapp/.codex/config.toml']:
            with self.subTest(path=relative):
                self.write(relative, 'local state must not upload\n')
                with self.assertRaisesRegex(ValueError, 'Unsafe source path'):
                    snapshot.inspect_file(self.root, relative)

    def test_project_config_cannot_carry_user_settings_or_credentials(self):
        for body in ['model = "local-choice"\n', '[agents]\nmax_concurrent_threads_per_session = 19\n',
                     '[agents]\nmax_concurrent_threads_per_session = 3\n[mcp_servers.local]\nurl = "https://example.invalid"\n',
                     'api_key = "EXAMPLE_PLACEHOLDER_VALUE"\n', '[invalid']:
            with self.subTest(body=body):
                self.write(snapshot.PROJECT_CODEX_CONFIG, body)
                with self.assertRaises(ValueError):
                    snapshot.inspect_file(self.root, snapshot.PROJECT_CODEX_CONFIG)

    def test_project_agent_schema_and_identity_are_restricted(self):
        relative = '.codex/agents/flofi-swap.toml'
        valid = 'name = "flofi-swap"\ndescription = "Review"\ndeveloper_instructions = "Read only"\n'
        for body in [valid.replace('flofi-swap', 'local'), valid + 'model = "local-choice"\n',
                     valid.replace('"Read only"', '""'), '[invalid']:
            self.write(relative, body)
            with self.assertRaises(ValueError):
                snapshot.inspect_file(self.root, relative)

    def test_project_codex_files_and_parent_directories_cannot_be_symlinks(self):
        self.write('outside/config.toml', '[agents]\nmax_concurrent_threads_per_session = 3\n')
        (self.root / '.codex').symlink_to(self.root / 'outside', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'Missing/nonregular source'):
            snapshot.inspect_file(self.root, snapshot.PROJECT_CODEX_CONFIG)
        (self.root / '.codex').unlink()
        (self.root / '.codex').mkdir()
        (self.root / snapshot.PROJECT_CODEX_CONFIG).symlink_to(self.root / 'outside/config.toml')
        with self.assertRaisesRegex(ValueError, 'Missing/nonregular source'):
            snapshot.inspect_file(self.root, snapshot.PROJECT_CODEX_CONFIG)

    def write_claude_project(self):
        self.write(snapshot.CLAUDE_SETTINGS, json.dumps(snapshot.CLAUDE_SETTINGS_CONTENT, indent=2) + '\n')
        self.write('.claude/hooks/flofi_agent_hooks.py', '# hook\n')
        for domain in snapshot.DOMAINS:
            codex = tomllib.loads(f'name = "{domain}"\ndescription = "Review"\n'
                                  f'developer_instructions = """\nShared.\nSpecialty: {domain}.\n"""\n')
            self.write(f'.claude/agents/{domain}.md', agent_guard.claude_agent_text(codex))

    def test_project_claude_agents_settings_and_hook_survive_snapshot_verification(self):
        self.write_claude_project()
        paths = sorted(snapshot.CLAUDE_FILES | {'implementation.ts'})
        files = [snapshot.inspect_file(self.root, relative) for relative in paths]
        digest = snapshot.digest_files(files)
        snapshot.verify_manifest(self.root, {'files': files, 'snapshotSha256': digest, 'changedPaths': paths}, digest)

    def test_claude_local_state_and_unknown_claude_paths_are_refused(self):
        for relative in ['.claude/settings.local.json', '.claude/flofi-agent-runs/session.jsonl',
                         '.claude/agents/local.md', '.claude/agents/flofi-mcp-channels.md', '.claude/hooks/local.py',
                         '.claude/agents/review/flofi-swap.md', '.claude/CLAUDE.md', 'apps/reference-dapp/.claude/settings.json']:
            with self.subTest(path=relative):
                self.write(relative, 'local state must not upload\n')
                with self.assertRaisesRegex(ValueError, 'Unsafe source path'):
                    snapshot.inspect_file(self.root, relative)

    def test_claude_settings_and_agents_cannot_carry_credentials_or_broader_tools(self):
        self.write_claude_project()
        agent = '.claude/agents/flofi-swap.md'
        original = (self.root / agent).read_text()
        for relative, body in [
            (snapshot.CLAUDE_SETTINGS, json.dumps({**snapshot.CLAUDE_SETTINGS_CONTENT, 'env': {'ANTHROPIC_API_KEY': 'x'}})),
            (snapshot.CLAUDE_SETTINGS, json.dumps({**snapshot.CLAUDE_SETTINGS_CONTENT, 'apiKeyHelper': './key.sh'})),
            (snapshot.CLAUDE_SETTINGS, '{broken'),
            (agent, original.replace('tools: Read, Grep, Glob, Bash', 'tools: Read, Bash, Edit')),
            (agent, original.replace('name: flofi-swap', 'name: flofi-mcp')),
            (agent, '---\nname: flofi-swap\n'),
        ]:
            with self.subTest(path=relative, body=body[:50]):
                self.write(relative, body)
                with self.assertRaisesRegex(ValueError, 'Invalid project Claude definition'):
                    snapshot.inspect_file(self.root, relative)
                self.write_claude_project()

    def test_upload_ignore_rules_include_only_the_exact_project_claude_files(self):
        ignore = Path(__file__).resolve().parents[1] / '.gcloudignore'
        self.write('.gitignore', ignore.read_text())
        subprocess.run(['git', 'init', '-q'], cwd=self.root, check=True, capture_output=True)
        refused = {'.claude/settings.local.json', '.claude/flofi-agent-runs/s.jsonl', '.claude/agents/local.md',
                   '.claude/agents/review/flofi-swap.md', '.claude/hooks/local.py', '.claude/worktrees/x/a.ts',
                   'apps/example/.claude/settings.json'}
        paths = sorted(snapshot.CLAUDE_FILES | refused)
        for relative in paths:
            self.write(relative, 'path-filter fixture\n')
        result = subprocess.run(['git', 'check-ignore', '--no-index', '--stdin'], cwd=self.root,
                                input='\n'.join(paths) + '\n', text=True, capture_output=True, check=True)
        self.assertEqual(set(result.stdout.splitlines()), refused)
        permitted = {line.removeprefix('!/') for line in ignore.read_text().splitlines() if line.startswith('!/.claude/agents/flofi-')}
        self.assertEqual(permitted, agent_guard.CLAUDE_AGENTS)

    def test_upload_ignore_rules_include_only_the_exact_project_codex_files(self):
        ignore = Path(__file__).resolve().parents[1] / '.gcloudignore'
        # gcloudignore uses Git's rule syntax. Its include directive is a comment
        # here; .gitignore has no project Codex exceptions or additional permits.
        self.write('.gitignore', ignore.read_text())
        subprocess.run(['git', 'init', '-q'], cwd=self.root, check=True, capture_output=True)
        refused = {'.codex/auth.json', '.codex/config.local.toml', '.codex/credentials.json',
                   '.codex/agents/local.toml', '.codex/agents/flofi-swap/private.json',
                   '.codex/sessions/rollout.jsonl', 'apps/example/.codex/config.toml'}
        paths = sorted(snapshot.PROJECT_CODEX_FILES | refused)
        for relative in paths:
            self.write(relative, 'path-filter fixture\n')
        result = subprocess.run(['git', 'check-ignore', '--no-index', '--stdin'], cwd=self.root,
                                input='\n'.join(paths) + '\n', text=True, capture_output=True, check=True)
        self.assertEqual(set(result.stdout.splitlines()), refused)
        rules = ignore.read_text().splitlines()
        permitted_agents = {line.removeprefix('!/') for line in rules if line.startswith('!/.codex/agents/flofi-')}
        self.assertEqual(permitted_agents, snapshot.PROJECT_CODEX_AGENTS)


if __name__ == '__main__':
    unittest.main()
