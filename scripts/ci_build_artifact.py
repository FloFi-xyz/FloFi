#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""One production build per CircleCI workflow, handed to the browser jobs (BUILD-FLOFI-CI-ARCHITECTURE-002).

`pack` (certification-build, after `pnpm build` and the function-trace gate) writes $RUNNER_TEMP/flofi-build/build.tar with the build
outputs — every workspace package's `dist/` and `apps/<app>/.next` without `.next/cache` (the compiler cache, never read at run time) —
and manifest.json binding it to this revision, this lockfile and the tar's SHA-256.

`unpack WORKSPACE` (each browser job, after its own checkout and frozen install of the same lockfile) refuses, before writing anything,
an artifact of another revision or lockfile, a digest mismatch, an output that already exists, and any member outside those output
roots, absolute or with `..`, a device or hard link, a member below a link of the archive, or a link pointing anywhere but the
checkout's node_modules/; the members are then extracted, from the same open file that was hashed, with the tarfile `data` filter. The artifact never crosses workflows: CircleCI workspaces belong to one workflow (one pipeline, one revision; a "rerun failed
jobs" workflow keeps the same revision), and no cache is involved.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import sys
import tarfile

ROOT = Path(__file__).resolve().parents[1]
KIND, VERSION = 'flofi-build-artifact', 1
OUTPUT_ROOTS = (re.compile(r'packages/[A-Za-z0-9._-]+/dist'), re.compile(r'apps/[A-Za-z0-9._-]+/\.next'))
EXCLUDED = re.compile(r'apps/[A-Za-z0-9._-]+/\.next/cache(?:/.*)?')


def revision():
    for variable in ('FLOFI_CI_REVISION', 'CIRCLE_SHA1', 'GITHUB_SHA'):
        if re.fullmatch(r'[0-9a-f]{40}', os.environ.get(variable, '')):
            return os.environ[variable]
    try:
        value = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        value = ''
    return value if re.fullmatch(r'[0-9a-f]{40}', value) else 'UNKNOWN'


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def output_roots(root):
    found = [path for pattern in ('packages/*/dist', 'apps/*/.next') for path in sorted(root.glob(pattern)) if path.is_dir()]
    return [path.relative_to(root).as_posix() for path in found]


def allowed(name):
    """A member path inside one output root (the root itself included), never inside .next/cache."""
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or not path.parts:
        return False
    text = path.as_posix()
    if EXCLUDED.fullmatch(text):
        return False
    return any(pattern.fullmatch(text) or any(pattern.fullmatch(PurePosixPath(*path.parts[:index]).as_posix())
                                              for index in range(1, len(path.parts))) for pattern in OUTPUT_ROOTS)


def canonical(name):
    """pack() writes only canonical relative names: no `.`/`..` segment, no doubled or trailing slash."""
    return bool(name) and name == posixpath.normpath(name) and not name.startswith('/') and not any(
        part in {'.', '..', ''} for part in name.split('/'))


def refusals(members, roots):
    """Every member must be a file, directory or link inside one declared output root. Nothing may be written through a link of the
    archive (no member below a link member), and a link may only point, lexically, into the checkout's node_modules/ (the
    `.next/node_modules` package links Next.js writes); the tarfile data filter is a second, independent check."""
    links = {member.name for member in members if member.issym()}
    bad = []
    for member in members:
        name = member.name
        if not canonical(name):  # `./`, `//`, a trailing `/` or a `.`/`..` segment would dodge the link and root checks below
            bad.append(f'{name}: not a canonical path')
            continue
        parents = [PurePosixPath(*PurePosixPath(name).parts[:index]).as_posix() for index in range(1, len(PurePosixPath(name).parts))]
        if not allowed(name) or not any(name == root or name.startswith(root + '/') for root in roots):
            bad.append(f'{name}: outside the build outputs')
        elif not (member.isfile() or member.isdir() or member.issym()):
            bad.append(f'{name}: unsupported member type')
        elif any(parent in links for parent in parents):
            bad.append(f'{name}: below a link of the archive')
        elif member.issym():
            target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
            if posixpath.isabs(member.linkname) or not target.startswith('node_modules/') or '..' in PurePosixPath(target).parts:
                bad.append(f'{name}: link target {member.linkname} is not inside node_modules/')
    return bad


def pack(root, directory):
    roots = output_roots(root)
    if not any(name.endswith('/.next') for name in roots) or not any(name.endswith('/dist') for name in roots):
        raise SystemExit('Build artifact: no production build outputs (run pnpm build first)')
    current = revision()
    if current == 'UNKNOWN':
        raise SystemExit('Build artifact: the revision is unknown')
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / 'build.tar'
    members = 0

    def keep(info):
        nonlocal members
        if not allowed(info.name):
            return None
        if info.islnk():  # browser jobs accept files, directories and links only: fail here, where the cause is
            raise SystemExit(f'Build artifact: {info.name} is a hard link to {info.linkname}; the build outputs must not contain hard links')
        info.uid = info.gid = 0
        info.uname = info.gname = ''
        members += 1
        return info

    with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as tar:
        for name in roots:
            tar.add(root / name, arcname=name, recursive=True, filter=keep)
    manifest = {'kind': KIND, 'version': VERSION, 'revision': current, 'lockfile_sha256': sha256(root / 'pnpm-lock.yaml'),
                'roots': roots, 'members': members, 'bytes': archive.stat().st_size, 'sha256': sha256(archive)}
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f"Build artifact: {members} entries, {manifest['bytes'] / 1048576:.1f} MiB, sha256 {manifest['sha256']} for revision {current} "
          f"({', '.join(roots)})", flush=True)
    return 0


def unpack(root, workspace):
    directory = workspace / 'flofi-build'
    try:
        manifest = json.loads((directory / 'manifest.json').read_text())
    except (OSError, ValueError) as error:
        raise SystemExit(f'Build artifact: no readable manifest in {directory} ({type(error).__name__})')
    current = revision()
    errors = []
    if manifest.get('kind') != KIND or manifest.get('version') != VERSION:
        errors.append('unknown artifact kind or version')
    if current == 'UNKNOWN' or manifest.get('revision') != current:
        errors.append(f"artifact revision {manifest.get('revision')!r} is not this revision {current!r}")
    if manifest.get('lockfile_sha256') != sha256(root / 'pnpm-lock.yaml'):
        errors.append('artifact was built from another pnpm-lock.yaml')
    archive = directory / 'build.tar'
    if not archive.is_file() or archive.is_symlink():
        errors.append('artifact archive is missing')
    roots = manifest.get('roots') if isinstance(manifest.get('roots'), list) else []
    if not roots or not all(isinstance(name, str) and canonical(name) and any(pattern.fullmatch(name) for pattern in OUTPUT_ROOTS)
                            for name in roots):
        errors.append('artifact roots are not build outputs')
    errors += [f'{name} already exists in the checkout' for name in roots if isinstance(name, str) and (root / name).exists()]
    if not hasattr(tarfile, 'data_filter'):
        errors.append('this Python has no tarfile data filter')
    if errors:
        print('Build artifact: REFUSED', *('  ' + error for error in errors), sep='\n', file=sys.stderr, flush=True)
        return 1
    # One open file for the digest and the extraction (no path swap between them; nothing else writes in the job).
    with open(archive, 'rb') as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1 << 20), b''):
            digest.update(block)
        if digest.hexdigest() != manifest.get('sha256'):
            print('Build artifact: REFUSED\n  artifact digest does not match its manifest', file=sys.stderr, flush=True)
            return 1
        stream.seek(0)
        with tarfile.open(fileobj=stream, mode='r:') as tar:
            members = tar.getmembers()
            bad = refusals(members, roots)
            if bad or len(members) != manifest.get('members'):
                print('Build artifact: REFUSED', *('  ' + error for error in bad or ['member count differs from the manifest']), sep='\n',
                      file=sys.stderr, flush=True)
                return 1
            tar.extractall(root, members=members, filter='data')
    print(f"Build artifact: verified sha256 {manifest['sha256']} for revision {current}; extracted {len(members)} entries "
          f"({', '.join(roots)})", flush=True)
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='operation', required=True)
    packing = sub.add_parser('pack')
    packing.add_argument('--output', type=Path, default=None)
    unpacking = sub.add_parser('unpack')
    unpacking.add_argument('workspace', type=Path)
    arguments = parser.parse_args()
    if arguments.operation == 'pack':
        output = arguments.output or Path(os.environ.get('RUNNER_TEMP', '/tmp')) / 'flofi-build'
        sys.exit(pack(ROOT, output))
    sys.exit(unpack(ROOT, arguments.workspace))
