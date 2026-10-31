#!/usr/bin/env python3
"""Bind direct Cloud Build uploads to the complete intended worktree, without GitHub."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tomllib

from agent_guard import CLAUDE_FILES, CLAUDE_FRONTMATTER, CLAUDE_SETTINGS, CLAUDE_SETTINGS_CONTENT, DOMAINS, parse_claude_agent
from governance_lite import secret_errors

MANIFEST = 'cloudbuild-source-manifest.json'
PROJECT_CODEX_CONFIG = '.codex/config.toml'
PROJECT_CODEX_AGENTS = frozenset(f'.codex/agents/{domain}.toml' for domain in DOMAINS)
PROJECT_CODEX_FILES = PROJECT_CODEX_AGENTS | {PROJECT_CODEX_CONFIG}


def digest_files(files):
    return hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def inspect_file(root, relative):
    path = PurePosixPath(relative)
    if path.is_absolute() or '..' in path.parts or str(path) != relative or any(
            part in {'.git', '.aws', '.agents', '.vercel', 'node_modules', '.next', 'test-results'} for part in path.parts):
        raise ValueError('Unsafe source path: ' + relative)
    if '.codex' in path.parts and relative not in PROJECT_CODEX_FILES:
        raise ValueError('Unsafe source path: ' + relative)
    if '.claude' in path.parts and relative not in CLAUDE_FILES:
        raise ValueError('Unsafe source path: ' + relative)
    if path.name.startswith('.env') and path.name != '.env.example':
        raise ValueError('Environment file refused: ' + relative)
    if path.name in {'credentials.db', 'application_default_credentials.json', 'id_rsa', 'id_ed25519'}:
        raise ValueError('Credential file refused: ' + relative)
    target = root / relative
    if target.is_symlink() or not target.is_file() or any((root / parent).is_symlink() for parent in path.parents):
        raise ValueError('Missing/nonregular source: ' + relative)
    data = target.read_bytes()
    if relative in PROJECT_CODEX_FILES:
        # Only repository engineering definitions may enter an upload. User
        # config, credentials, MCP endpoints and local agent overrides stay out.
        try:
            definition = tomllib.loads(data.decode())
        except (UnicodeDecodeError, tomllib.TOMLDecodeError):
            raise ValueError('Invalid project Codex definition: ' + relative) from None
        if relative == PROJECT_CODEX_CONFIG:
            if definition != {'agents': {'max_concurrent_threads_per_session': 3}}:
                raise ValueError('Only bounded project agent config is allowed: ' + relative)
        elif (set(definition) != {'name', 'description', 'developer_instructions'}
              or definition.get('name') != path.stem
              or any(not isinstance(definition.get(key), str) or not definition[key].strip()
                     for key in ('name', 'description', 'developer_instructions'))):
            raise ValueError('Invalid project agent definition: ' + relative)
    if relative in CLAUDE_FILES and relative.endswith(('.json', '.md')):
        # Same rule for Claude Code: generated read-only agents and the exact
        # hook settings only; no env, API key helper, MCP servers or permissions.
        try:
            text = data.decode()
            if relative == CLAUDE_SETTINGS:
                valid = json.loads(text) == CLAUDE_SETTINGS_CONTENT
            else:
                fields, _ = parse_claude_agent(text)
                valid = fields['name'] == path.stem and all(fields[k] == v for k, v in CLAUDE_FRONTMATTER.items())
        except (UnicodeDecodeError, ValueError):
            valid = False
        if not valid:
            raise ValueError('Invalid project Claude definition: ' + relative)
    if b'\0' not in data:
        try:
            errors = secret_errors(relative, data.decode())
        except UnicodeDecodeError:
            errors = []
        if errors:
            raise ValueError('\n'.join(errors))
    return {'path': relative, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
            'executable': bool(target.stat().st_mode & 0o111)}


def verify_manifest(root, manifest, expected):
    files = manifest['files']
    if not re.fullmatch('[0-9a-f]{64}', expected) or digest_files(files) != expected or manifest['snapshotSha256'] != expected:
        raise ValueError('SOURCE_SNAPSHOT_IDENTITY_MISMATCH')
    paths = [row['path'] for row in files]
    if paths != sorted(set(paths)) or MANIFEST in paths:
        raise ValueError('SOURCE_SNAPSHOT_PATH_INVENTORY_INVALID')
    actual = sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file() and '.git' not in p.relative_to(root).parts
                    and str(p.relative_to(root)) != MANIFEST)
    if actual != paths:
        raise ValueError('SOURCE_SNAPSHOT_FILE_INVENTORY_MISMATCH')
    for row in files:
        if inspect_file(root, row['path']) != row:
            raise ValueError('SOURCE_SNAPSHOT_BYTES_MISMATCH: ' + row['path'])
    if not set(manifest['changedPaths']).issubset(paths):
        raise ValueError('SOURCE_SNAPSHOT_CHANGED_PATHS_INVALID')
    for relative in manifest['changedPaths']:
        data = (root / relative).read_bytes()
        if b'\0' in data:
            continue
        try:
            lines = data.decode().splitlines()
        except UnicodeDecodeError:
            continue
        if any(line.rstrip(' \t') != line or re.match(r'^ +\t', line) for line in lines):
            raise ValueError('SOURCE_SNAPSHOT_WHITESPACE: ' + relative)
    print(f'Uploaded source verified: {len(files)} files, {sum(r["bytes"] for r in files)} bytes, SHA-256 {expected}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['create', 'verify'])
    parser.add_argument('--root', type=Path, default=Path.cwd())
    parser.add_argument('--initialize-git', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    if args.operation == 'create':
        def git(*items):
            return subprocess.check_output(['git', *items], cwd=root).decode().splitlines()
        paths = sorted(set(git('ls-files', '--cached', '--others', '--exclude-standard')) - {MANIFEST})
        files = [inspect_file(root, path) for path in paths]
        changed = sorted((set(git('diff', '--name-only', 'HEAD')) | set(git('ls-files', '--others', '--exclude-standard'))) - {MANIFEST})
        manifest = {'kind': 'flofi-worktree-source-v1', 'baseHead': git('rev-parse', 'HEAD')[0],
                    'sourceBranch': git('branch', '--show-current')[0], 'changedPaths': changed,
                    'files': files, 'snapshotSha256': digest_files(files)}
        (root / MANIFEST).write_text(json.dumps(manifest, indent=2) + '\n')
        print(manifest['snapshotSha256'])
        return
    manifest = json.loads((root / MANIFEST).read_text())
    verify_manifest(root, manifest, os.environ.get('FLOFI_SOURCE_SNAPSHOT_SHA256', ''))
    if args.initialize_git:
        # Ephemeral metadata only, used by the unchanged governance scanner.
        # This commit identifies the archive, not a remotely published revision.
        subprocess.run(['git', 'init', '-q', '-b', manifest['sourceBranch']], cwd=root, check=True)
        subprocess.run(['git', 'add', '--force', '--all'], cwd=root, check=True)
        subprocess.run(['git', '-c', 'user.name=FloFi source certification', '-c', 'user.email=ci@example.invalid',
                        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Uploaded snapshot ' + manifest['snapshotSha256']], cwd=root, check=True)
        print('Ephemeral archive metadata initialized; no remote checkout or push.', flush=True)


if __name__ == '__main__':
    main()
