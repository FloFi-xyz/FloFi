#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Compile and test an exact Studio adapter archive in separate Linux sandboxes."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import resource
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE_LIMIT = 4 * 1024 * 1024
EXPANDED_LIMIT = 16 * 1024 * 1024
INPUT_LIMIT = 128 * 1024
HARNESS = """import { readFileSync } from 'node:fs';
import { check } from '/artifact/adapter.mjs';

const input = JSON.parse(readFileSync('/checks/input.json', 'utf8'));
const result = await check(input);
process.stdout.write(JSON.stringify(result));
"""


def read_bounded(path, limit):
    with path.open("rb") as file:
        data = file.read(limit + 1)
    if not data or len(data) > limit:
        raise ValueError("INPUT_SIZE_INVALID")
    return data


def sha(data):
    return hashlib.sha256(data).hexdigest()


def adapter_source(archive):
    source = None
    # Bound decompression before tarfile parses any PAX metadata or member bodies.
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(archive)) as packed:
            expanded = packed.read(EXPANDED_LIMIT + 1)
    except (OSError, EOFError) as error:
        raise ValueError("ARCHIVE_INVALID") from error
    if len(expanded) > EXPANDED_LIMIT:
        raise ValueError("ARCHIVE_LIMIT")
    try:
        tar = tarfile.open(fileobj=io.BytesIO(expanded), mode="r:")
    except tarfile.TarError as error:
        raise ValueError("ARCHIVE_INVALID") from error
    with tar:
        for index, entry in enumerate(tar):
            parts = PurePosixPath(entry.name).parts
            if index >= 500:
                raise ValueError("ARCHIVE_LIMIT")
            if len(parts) == 3 and parts[1:] == ("src", "adapter.mts"):
                if source is not None or not entry.isfile() or not 0 < entry.size <= INPUT_LIMIT or parts[0] in ("/", ".."):
                    raise ValueError("ADAPTER_SOURCE_INVALID")
                file = tar.extractfile(entry)
                if file is None:
                    raise ValueError("ADAPTER_SOURCE_INVALID")
                source = file.read(INPUT_LIMIT + 1)
    if source is None:
        raise ValueError("ADAPTER_SOURCE_NOT_FOUND")
    return source


def limits():
    resource.setrlimit(resource.RLIMIT_CPU, (7, 9))
    resource.setrlimit(resource.RLIMIT_FSIZE, (INPUT_LIMIT, INPUT_LIMIT))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def sandbox(bindings, args, output):
    node = shutil.which("node")
    bubblewrap = shutil.which("bwrap")
    if not node or not bubblewrap:
        raise ValueError("PINNED_NODE_AND_BUBBLEWRAP_REQUIRED")
    command = [bubblewrap, "--unshare-all", "--die-with-parent", "--new-session", "--clearenv",
               "--ro-bind", "/usr/lib", "/usr/lib", "--ro-bind", "/usr/lib64", "/usr/lib64", "--symlink", "usr/lib", "/lib",
               "--symlink", "usr/lib64", "/lib64", "--ro-bind", str(Path(node).resolve()), "/node",
               "--dev", "/dev", "--tmpfs", "/tmp", "--cap-drop", "ALL"]
    for writable, source, target in bindings:
        command.extend(["--bind" if writable else "--ro-bind", str(source), target])
    with output.open("wb") as stdout:
        subprocess.run([*command, "--", "/node", "--max-old-space-size=128", *args], stdin=subprocess.DEVNULL,
                       stdout=stdout, stderr=subprocess.STDOUT, timeout=15, check=True, preexec_fn=limits)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, help="Canonical SDK-normalized version 2 manifest JSON")
    parser.add_argument("archive", type=Path, help="Archive bytes pinned by the submitted source SHA-256")
    parser.add_argument("fixtures", type=Path, help="Independent test cases with input and expected results")
    args = parser.parse_args()
    manifest = json.loads(read_bounded(args.manifest, INPUT_LIMIT))
    adapter = manifest["adapter"]
    if manifest["schemaVersion"] != 2 or adapter["kind"] != "external" or adapter["sdkVersion"] != 1:
        raise ValueError("EXTERNAL_ADAPTER_REQUIRED")
    if not re.fullmatch(r"[0-9a-f]{40}", adapter["commit"]):
        raise ValueError("ADAPTER_COMMIT_INVALID")
    archive = read_bounded(args.archive, ARCHIVE_LIMIT)
    source_sha = sha(archive)
    if source_sha != adapter["sourceSha256"]:
        raise ValueError("ADAPTER_SOURCE_DIGEST_MISMATCH")
    fixtures = read_bounded(args.fixtures, INPUT_LIMIT)
    cases = json.loads(fixtures)
    if not isinstance(cases, list) or not 2 <= len(cases) <= 32 or any(
        case["input"]["chainRef"] != manifest.get("chainRef") or case["input"]["mode"] not in ("verify", "test")
        for case in cases
    ) or not all(any(case["input"]["mode"] == mode and case["expected"]["ok"] is True for case in cases)
                 for mode in ("verify", "test")):
        raise ValueError("ADAPTER_FIXTURE_IDENTITY_INVALID")

    node_version = subprocess.check_output(["node", "--version"], text=True).strip()
    sdk = ROOT / "packages/developer-sdk"
    tsc = (ROOT / "node_modules/typescript").resolve(strict=True)
    compiler_version = json.loads((tsc / "package.json").read_text())["version"]
    repo_toolchain = json.loads((ROOT / "package.json").read_text())
    if node_version != "v" + repo_toolchain["engines"]["node"] or compiler_version != repo_toolchain["devDependencies"]["typescript"]:
        raise ValueError("ADAPTER_TOOLCHAIN_MISMATCH")
    with tempfile.TemporaryDirectory(prefix="flofi-studio-adapter-") as temporary:
        root = Path(temporary)
        source, artifact, checks, sdk_mount = (root / name for name in ("source", "artifact", "checks", "sdk"))
        for directory in (source, artifact, checks, sdk_mount):
            directory.mkdir()
        (source / "adapter.mts").write_bytes(adapter_source(archive))
        (checks / "check.mjs").write_text(HARNESS)
        (source / "node_modules/@defi-workflow-engine/developer-sdk").mkdir(parents=True)
        shutil.copyfile(sdk / "package.json", sdk_mount / "package.json")
        shutil.copytree(sdk / "dist", sdk_mount / "dist")
        sdk_sha = sha(b"".join(path.read_bytes() for path in sorted(sdk_mount.rglob("*.d.ts"))))
        logs = root / "stage.log"
        try:
            sandbox([(False, source, "/src"), (False, tsc, "/compiler"), (True, artifact, "/artifact"),
                     (False, sdk_mount, "/src/node_modules/@defi-workflow-engine/developer-sdk")],
                    ["/compiler/lib/tsc.js", "--strict", "--noEmitOnError", "--skipLibCheck", "--module", "nodenext",
                     "--target", "es2024", "--outDir", "/artifact", "/src/adapter.mts"], logs)
            artifact_sha = sha(read_bounded(artifact / "adapter.mjs", INPUT_LIMIT))
            for case in cases:
                (checks / "input.json").write_text(json.dumps(case["input"]))
                sandbox([(False, artifact, "/artifact"), (False, checks, "/checks")],
                        ["--permission", "--allow-fs-read=/artifact", "--allow-fs-read=/checks", "/checks/check.mjs"], logs)
                if json.loads(read_bounded(logs, INPUT_LIMIT)) != case["expected"]:
                    raise ValueError("ADAPTER_FIXTURE_MISMATCH")
        except (subprocess.SubprocessError, OSError) as error:
            detail = logs.read_bytes()[:4096].decode(errors="replace") if logs.is_file() else ""
            raise ValueError(f"ISOLATED_ADAPTER_CHECK_FAILED: {detail!r}") from error

    # This is reproducible build evidence for operator review. Production does not accept an unsigned report.
    canonical_manifest = json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode()
    print(json.dumps({"status": "CHECKS_PASSED", "commit": adapter["commit"], "manifestSha256": sha(canonical_manifest),
                      "sourceSha256": source_sha, "artifactSha256": artifact_sha, "fixturesSha256": sha(fixtures),
                      "harnessSha256": sha(HARNESS.encode()), "sdkSha256": sdk_sha,
                      "node": node_version, "typescript": compiler_version, "cases": len(cases)}, sort_keys=True))


if __name__ == "__main__":
    main()
