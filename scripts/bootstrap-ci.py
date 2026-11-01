#!/usr/bin/env python3
"""Bootstrap the approved Node and pnpm toolchain using only Python's standard library.

The registry fetch below is shared with scripts/dependency_security.py (dependency security policy).
"""

import base64
import gzip
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import platform
import re
import shlex
import subprocess
import ssl
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from ci_archive_cache import verified_archive

NODE_VERSION = "24.21.0"
PNPM_VERSION = "11.22.0"
NODE_ARCHIVE = f"node-v{NODE_VERSION}-linux-x64.tar.xz"
NODE_URL = f"https://nodejs.org/dist/v{NODE_VERSION}/{NODE_ARCHIVE}"
NODE_SUMS_URL = f"https://nodejs.org/dist/v{NODE_VERSION}/SHASUMS256.txt"
NODE_SHA256 = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"
PNPM_URL = f"https://registry.npmjs.org/pnpm/-/pnpm-{PNPM_VERSION}.tgz"
PNPM_SHA512 = "H/hwxMYTPf2I+yr8Rt0T1H8JyXlLQ4xv20fKmMrzvBY4HuC+k6CRuOOCTPAfiJ9G19niCRD7C+GrD7W6qA3WIQ=="


DOWNLOAD_ATTEMPTS = 3
DOWNLOAD_TIMEOUT = 90
DOWNLOAD_BUDGET = 300
RETRYABLE_HTTP_STATUS = {408, 429, 500, 502, 503, 504}


def fetch(url, *, compressed=False, stage="registry metadata", quiet=False):
    # Log only a controlled stage and sanitized hostname, never URL credentials,
    # paths, query strings or exception messages returned by an upstream server.
    # quiet omits the first-attempt line (hundreds of registry documents); retries and failures are always logged.
    host = re.sub(r"[^a-zA-Z0-9.-]", "_", urllib.parse.urlsplit(url).hostname or "unknown")
    label = f"Download stage={stage} host={host}"
    request = urllib.request.Request(url, headers={"Accept-Encoding": "gzip"} if compressed else {})
    deadline = time.monotonic() + DOWNLOAD_BUDGET
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError(f"{label}: download time budget exhausted") from None
        if not quiet or attempt > 1:
            print(f"{label} attempt={attempt}/{DOWNLOAD_ATTEMPTS}", flush=True)
        try:
            with urllib.request.urlopen(request, timeout=min(DOWNLOAD_TIMEOUT, remaining)) as response:
                if response.status != 200:
                    raise urllib.error.HTTPError(url, response.status, "Download unavailable", {}, None)
                # read1 performs at most one underlying read, so a slow trickle
                # cannot indefinitely hide the elapsed budget inside read(). A
                # blocking operation also retains its finite socket timeout.
                data = bytearray()
                while True:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Download time budget exhausted")
                    chunk = response.read1(1024 * 1024)
                    if not chunk:
                        break
                    data.extend(chunk)
                length = response.headers.get("Content-Length")
                if length is not None and len(data) != int(length):
                    raise http.client.IncompleteRead(b"")
                encoding = response.headers.get("Content-Encoding", "identity")
                if encoding == "gzip":
                    return gzip.decompress(data)
                if encoding != "identity":
                    raise RuntimeError("Unsupported registry content encoding")
                return bytes(data)
        except urllib.error.HTTPError as exc:
            exc.close()
            if exc.code not in RETRYABLE_HTTP_STATUS:
                raise RuntimeError(f"{label} attempt={attempt}: HTTP {exc.code}; not retryable") from None
            reason = f"HTTP {exc.code}"
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, ssl.SSLError):
                raise RuntimeError(f"{label} attempt={attempt}: TLS verification/transport failure") from None
            reason = "connection failure"
        except (TimeoutError, ConnectionError, http.client.IncompleteRead,
                http.client.RemoteDisconnected, ssl.SSLEOFError, EOFError) as exc:
            reason = type(exc).__name__
        # Do not carry failed response bytes into another attempt or archive.
        data = None
        delay = 2 ** attempt
        if attempt == DOWNLOAD_ATTEMPTS or time.monotonic() + delay >= deadline:
            raise RuntimeError(f"{label}: failed after {attempt} attempt(s) ({reason}); retries exhausted") from None
        print(f"{label} attempt={attempt}/{DOWNLOAD_ATTEMPTS} failed={reason}; retry_in={delay}s", flush=True)
        time.sleep(delay)


def extract(data, destination):
    # Python's data filter blocks absolute/traversal paths and unsafe links.
    # No compatibility fallback to unrestricted extraction is permitted.
    if not hasattr(tarfile, "data_filter"):
        raise RuntimeError("Python tarfile.data_filter is required")
    destination.mkdir(parents=True, exist_ok=False)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
        archive.extractall(destination, filter="data")


def checked_output(command):
    result = subprocess.check_output(command, text=True).strip()
    print(result, flush=True)
    return result


def main():
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise RuntimeError("The approved toolchain requires Linux x64")
    checked_output(["git", "--version"])
    checked_output(["python3", "--version"])
    print("Toolchain target: linux x64; Corepack is not used", flush=True)
    package = json.loads(Path("package.json").read_text())
    if package["packageManager"] != f"pnpm@{PNPM_VERSION}":
        raise RuntimeError("Root packageManager differs from approved version")
    if Path(".node-version").read_text().strip() != NODE_VERSION:
        raise RuntimeError(".node-version differs from approved version")
    print("packageManager:", package["packageManager"], flush=True)
    sums = fetch(NODE_SUMS_URL, stage="Node checksum manifest").decode("ascii").splitlines()
    entries = [line.split() for line in sums if line.split()[-1:] == [NODE_ARCHIVE]]
    if entries != [[NODE_SHA256, NODE_ARCHIVE]]:
        raise RuntimeError("Official Node checksum entry differs from approved digest")
    base = Path(os.environ.get("RUNNER_TEMP", tempfile.gettempdir()))
    def download_node(output):
        output.write(fetch(NODE_URL, stage="Node archive"))
    with verified_archive(NODE_ARCHIVE, base, download_node, NODE_SHA256) as archive:
        node_bytes = archive.read_bytes()
    node_digest = hashlib.sha256(node_bytes).hexdigest()
    print("Node SHA-256 expected:", NODE_SHA256, flush=True)
    print("Node SHA-256 actual:  ", node_digest, flush=True)
    if node_digest != NODE_SHA256:
        raise RuntimeError("Node archive checksum mismatch")
    def download_pnpm(output):
        output.write(fetch(PNPM_URL, stage="pnpm archive"))
    with verified_archive(f"pnpm-{PNPM_VERSION}.tgz", base, download_pnpm,
                          base64.b64decode(PNPM_SHA512).hex(), algorithm="sha512") as archive:
        pnpm_bytes = archive.read_bytes()
    pnpm_digest = base64.b64encode(hashlib.sha512(pnpm_bytes).digest()).decode()
    print("pnpm SRI expected: sha512-" + PNPM_SHA512, flush=True)
    print("pnpm SRI actual:   sha512-" + pnpm_digest, flush=True)
    if pnpm_digest != PNPM_SHA512:
        raise RuntimeError("pnpm archive integrity mismatch")
    target = Path(tempfile.mkdtemp(prefix="build-001-toolchain-", dir=base))
    extract(node_bytes, target / "node")
    extract(pnpm_bytes, target / "pnpm")
    node = target / "node" / f"node-v{NODE_VERSION}-linux-x64" / "bin" / "node"
    pnpm = target / "pnpm" / "package" / "bin" / "pnpm.mjs"
    if not pnpm.is_file():
        raise RuntimeError("Approved pnpm bin/pnpm.mjs is missing")
    if checked_output([str(node), "--version"]) != "v" + NODE_VERSION:
        raise RuntimeError("Node version mismatch")
    if checked_output([str(node), "-p", "process.platform+' '+process.arch"]) != "linux x64":
        raise RuntimeError("Node runtime architecture mismatch")
    if checked_output([str(node), str(pnpm), "--version"]) != PNPM_VERSION:
        raise RuntimeError("pnpm version mismatch")
    bindir = target / "bin"
    bindir.mkdir()
    (bindir / "node").symlink_to(node)
    shim = bindir / "pnpm"
    shim.write_text("#!/bin/sh\nexec " + shlex.quote(str(node)) + " " +
                    shlex.quote(str(pnpm)) + ' "$@"\n')
    shim.chmod(0o755)
    # Only this verified bin directory is prepended. No runner Node fallback.
    if "GITHUB_PATH" in os.environ:
        with open(os.environ["GITHUB_PATH"], "a", encoding="utf-8") as stream:
            stream.write(str(bindir) + "\n")
    if "GITHUB_ENV" in os.environ:
        with open(os.environ["GITHUB_ENV"], "a", encoding="utf-8") as stream:
            stream.write("BUILD001_TOOLCHAIN_BIN=" + str(bindir) + "\n")
    print("BUILD001_TOOLCHAIN_BIN=" + str(bindir), flush=True)


if __name__ == "__main__":
    import sys
    if sys.argv[1:]:
        # Dependency verification moved to scripts/dependency_security.py (BUILD-FLOFI-CI-ARCHITECTURE-001).
        raise SystemExit("Usage: bootstrap-ci.py (dependency security: python3 scripts/dependency_security.py verify)")
    main()
