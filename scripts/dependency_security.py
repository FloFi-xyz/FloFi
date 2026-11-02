#!/usr/bin/env python3
"""Automatic, risk-based dependency security verification for FloFi (BUILD-FLOFI-CI-ARCHITECTURE-001).

pnpm-lock.yaml is the resolved graph and docs/security/dependency-policy.json is the one policy. Every locked registry
package is evaluated on its own evidence and receives one decision:

  PASS             every mandatory control passed and no high-risk indicator is unresolved; nothing to approve.
  REVIEW_REQUIRED  an evidence-backed concern automation cannot settle (a license needing legal reading, a newly
                   introduced install script, a provenance regression with a new publisher, a likely typosquat...).
                   Resolved only by one exception record in the policy, never by waiting.
  BLOCK            a mandatory control failed (integrity, registry signature, advisory, prohibited license, source
                   substitution, malicious indicator, policy bypass). No exception can resolve it.

There is no release-age gate, no package count, no graph hash and no per-package allowlist: counts are computed from
the lockfile, and publication time is only a risk signal. Evidence (JSON) records every package, its checks and the
decision, bound to the policy version and the CI revision. Exit status: 0 PASS, 2 REVIEW_REQUIRED, 3 BLOCK,
1 when the evidence itself could not be produced (fail closed).
"""

import argparse
import concurrent.futures
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = "docs/security/dependency-policy.json"
EVIDENCE_NAME = "flofi-dependency-evidence.json"
EVIDENCE_KIND = "flofi-dependency-security-evidence"
EVIDENCE_SCHEMA = 1

PASS, REVIEW, BLOCK = "PASS", "REVIEW_REQUIRED", "BLOCK"
RANK = {PASS: 0, REVIEW: 1, BLOCK: 2}
EXIT = {PASS: 0, REVIEW: 2, BLOCK: 3}

# Mandatory controls: a finding with one of these codes is BLOCK and no policy exception may resolve it.
BLOCK_CODES = frozenset({
    "dependency-confusion", "graph-substitution", "integrity-mismatch", "integrity-missing", "license-prohibited", "malicious-indicator",
    "metadata-inconsistent", "non-exact-direct-specifier", "policy-bypass", "registry-signature-invalid",
    "source-substitution", "vulnerability", "workspace-constraint",
})
# Exceptional, evidence-backed concerns: REVIEW_REQUIRED until one exception record in the policy resolves them.
REVIEW_CODES = frozenset({
    "alias-substitution", "install-script-introduced", "license-missing", "license-review", "provenance-regression",
    "registry-signature-missing", "suspicious-capabilities", "typosquat-suspect",
})
SEVERITIES = ("info", "low", "moderate", "high", "critical")
REMEDIATION = {
    "dependency-confusion": "Internal names must be workspace links; remove the registry package that claims an internal scope or name.",
    "graph-substitution": "The lockfile edge is not what the parent's published manifest (and the workspace overrides) request. Regenerate pnpm-lock.yaml with pnpm from the official registry; never edit resolutions by hand.",
    "integrity-mismatch": "The lockfile integrity differs from the registry's signed integrity. Regenerate the lockfile from the official registry and investigate tampering.",
    "integrity-missing": "Every registry package needs a sha512 integrity in pnpm-lock.yaml.",
    "license-prohibited": "Remove or replace the dependency; prohibited licenses cannot be excepted.",
    "malicious-indicator": "Remove the dependency and investigate: the registry marks it as removed for security or it shows a download-and-execute install hook.",
    "metadata-inconsistent": "The registry no longer serves this exact release (unpublished or removed). Move to a published release.",
    "non-exact-direct-specifier": "Pin direct registry dependencies to an exact version (save-exact).",
    "policy-bypass": "A mandatory dependency control was disabled. Restore it; mandatory controls cannot be excepted.",
    "registry-signature-invalid": "The npm registry signature does not verify for this name@version:integrity. Treat as tampering.",
    "source-substitution": "Resolve only from https://registry.npmjs.org/ or workspace links; no tarball, git, file or custom-registry sources.",
    "vulnerability": "Upgrade to a patched release (pnpm audit lists it). Advisories cannot be excepted.",
    "workspace-constraint": "A workspace package violates a policy constraint (see detail).",
    "alias-substitution": "An npm: alias substitutes another package. Remove it or record a reviewed exception.",
    "install-script-introduced": "Inspect the install hook in the tarball. If legitimate, record one exception (identity + integrity). CI never runs lifecycle scripts.",
    "license-missing": "Read the archive's LICENSE file. If acceptable, record one exception (identity + integrity).",
    "license-review": "This license needs a legal reading. If acceptable for this use, record one exception (package + exact license + parents).",
    "provenance-regression": "The previous release carried npm provenance and this one does not, from a different publisher. Confirm the release with the maintainer before recording an exception.",
    "registry-signature-missing": "No signature by a pinned npm registry key. If npm rotated its key, add the new public key to the policy.",
    "suspicious-capabilities": "A newly published or changed package combines credential access with network or subprocess use. Inspect the reported files.",
    "typosquat-suspect": "The name is one edit from a protected package and the package is not established. Confirm it is the intended dependency.",
}

# Content signals for the bounded capability scan. They describe, they do not prove: decisions only use them together
# with a stateless registry trigger (new release line, install hook, publisher change, provenance drop).
CAPABILITY_PATTERNS = {
    "network": re.compile(r"""require\(\s*['"](?:node:)?(?:https?|net|tls|dgram|http2)['"]\s*\)|from\s+['"](?:node:)?(?:https?|net|tls|dgram|http2)['"]|\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b"""),
    "subprocess": re.compile(r"""['"](?:node:)?child_process['"]|\bexecSync\s*\(|\bspawnSync\s*\("""),
    "dynamic-code": re.compile(r"""\beval\s*\(|\bnew\s+Function\s*\("""),
    "environment": re.compile(r"""\bprocess\.env\b"""),
    # Specific credential stores and whole-environment serialization only. Enumerating process.env (debug's DEBUG_* options,
    # framework env prefixes) is routine and matched 8 benign packages of the real graph; this pattern matches 1 (vite).
    "credential-access": re.compile(r"""(?:\.npmrc\b|\bNPM_TOKEN\b|\bNODE_AUTH_TOKEN\b|\bGITHUB_TOKEN\b|\bGH_TOKEN\b|\bAWS_SECRET_ACCESS_KEY\b|\.aws/credentials|\.ssh/id_(?:rsa|ed25519)|\.config/gcloud|JSON\.stringify\(\s*process\.env\s*\))"""),
}
DOWNLOAD_EXECUTE = re.compile(r"(?:curl|wget)\b[^\n|;]*\|\s*(?:ba|z)?sh\b|node\s+-e\s+.*(?:base64|atob|eval)", re.I)
MALWARE_NOTICE = re.compile(r"\b(?:malware|malicious|compromised|backdoor|hijacked)\b", re.I)


class EvidenceError(RuntimeError):
    """The evidence could not be produced or verified; certification must not pass."""


# ---------------------------------------------------------------------------------------------------------------------
# YAML subset (what pnpm writes for pnpm-lock.yaml v9 and pnpm-workspace.yaml), standard library only.
# ---------------------------------------------------------------------------------------------------------------------

def _strip_comment(line):
    quote = None
    for index, char in enumerate(line):
        if quote:
            if char == quote:
                quote = None
        elif char in "'\"" and (index == 0 or line[index - 1] in " :[{,-"):
            quote = char
        elif char == "#" and (index == 0 or line[index - 1] in " \t"):
            return line[:index].rstrip()
    return line.rstrip()


_UNSAFE_PLAIN = ("!", "&", "*", "%", "@", "`", "|", ">")


def _scalar(text):
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] == "'":
        return text[1:-1].replace("''", "'")
    if len(text) >= 2 and text[0] == text[-1] == '"':
        return json.loads(text)
    if text.startswith(_UNSAFE_PLAIN[:4]):
        # Tags, anchors, aliases and directives change what other YAML readers (pnpm) see: fail closed.
        raise ValueError("YAML tags, anchors and aliases are not supported: " + text[:40])
    if text in ("true", "false"):
        return text == "true"
    if text in ("null", "~", ""):
        return None
    if re.fullmatch(r"-?\d+", text):
        return int(text)
    return text


def _flow(text):
    """Parse one-line flow collections: {a: b, c: [d, e]}."""
    position = 0

    def skip():
        nonlocal position
        while position < len(text) and text[position] == " ":
            position += 1

    def token(stops):
        nonlocal position
        skip()
        if position < len(text) and text[position] in "'\"":
            quote, start = text[position], position
            position += 1
            while position < len(text):
                if text[position] == quote:
                    if quote == "'" and position + 1 < len(text) and text[position + 1] == "'":
                        position += 2
                        continue
                    break
                position += 2 if quote == '"' and text[position] == "\\" else 1
            position += 1
            return _scalar(text[start:position])
        if position < len(text) and text[position] in "[{":
            return value()
        start = position
        while position < len(text) and text[position] not in stops and not (
                text[position] == ":" and (position + 1 == len(text) or text[position + 1] == " ")):
            position += 1
        return _scalar(text[start:position])

    def value():
        nonlocal position
        skip()
        opener = text[position]
        closer = "}" if opener == "{" else "]"
        position += 1
        result = {} if opener == "{" else []
        while True:
            skip()
            if position >= len(text):
                raise ValueError("Unterminated flow collection")
            if text[position] == closer:
                position += 1
                return result
            if opener == "{":
                key = token(",}")
                skip()
                if position >= len(text) or text[position] != ":":
                    raise ValueError("Flow mapping without ':'")
                position += 1
                result[str(key)] = token(",}")
            else:
                result.append(token(",]"))
            skip()
            if position < len(text) and text[position] == ",":
                position += 1

    result = value()
    skip()
    if position != len(text):
        raise ValueError("Trailing text after flow collection")
    return result


def _split_key(content):
    if content[0] in "'\"":
        quote, index = content[0], 1
        while index < len(content):
            if content[index] == quote:
                if quote == "'" and index + 1 < len(content) and content[index + 1] == "'":
                    index += 2
                    continue
                break
            index += 2 if quote == '"' and content[index] == "\\" else 1
        key, rest = _scalar(content[:index + 1]), content[index + 1:]
        if not rest.startswith(":"):
            raise ValueError("Quoted key without ':'")
        return str(key), rest[1:].strip()
    match = re.match(r"^(.*?):(?: (.*))?$", content)
    if not match:
        raise ValueError("Mapping entry without ':': " + content[:60])
    key = match.group(1).strip()
    if not key or key.startswith(_UNSAFE_PLAIN + ("{", "[", "?", "<<")) or key == "<<":
        raise ValueError("Unsupported YAML key syntax: " + key[:40])
    return key, (match.group(2) or "").strip()


def parse_yaml(text):
    """The YAML subset pnpm writes (block mappings and sequences, one-line flow collections, quoted scalars, block
    scalars). Anything that could make another YAML reader see different data (tags, anchors, aliases, merge keys,
    directives, several documents, a BOM, tabs) raises ValueError: callers fail closed."""
    if text.startswith("\ufeff"):
        raise ValueError("Byte-order mark is not supported")
    raw_lines = text.split("\n")
    lines = []
    for number, raw in enumerate(raw_lines):
        if "\t" in raw[:len(raw) - len(raw.lstrip())]:
            raise ValueError("Tab indentation is not supported")
        line = _strip_comment(raw)
        if line.strip():
            content = line.strip()
            if line[0] != " " and (content in ("---", "...") or content.startswith(("%", "--- "))):
                raise ValueError("YAML directives and document markers are not supported")
            lines.append((len(line) - len(line.lstrip(" ")), content, number))
    position = 0

    def block_scalar(indicator, parent_indent, start_line):
        """Literal (|) and folded (>) scalars with optional chomping (-/+) and explicit indentation."""
        nonlocal position
        match = re.fullmatch(r"([|>])([1-9])?([+-])?|([|>])([+-])([1-9])", indicator)
        if not match:
            raise ValueError("Unsupported block scalar header: " + indicator)
        style = match.group(1) or match.group(4)
        explicit = match.group(2) or match.group(6)
        chomp = match.group(3) or match.group(5) or ""
        body, end = [], start_line + 1
        while end < len(raw_lines):
            raw = raw_lines[end]
            if raw.strip() and len(raw) - len(raw.lstrip(" ")) <= parent_indent:
                break
            body.append(raw)
            end += 1
        while position < len(lines) and lines[position][2] < end:
            position += 1
        content = [line for line in body if line.strip()]
        indent = parent_indent + int(explicit) if explicit else (min(len(l) - len(l.lstrip(" ")) for l in content) if content else 0)
        texts = [line[indent:] if line.strip() else "" for line in body]
        while texts and texts[-1] == "" and chomp != "+":
            texts.pop()
        if style == "|":
            value_text = "\n".join(texts)
        else:
            value_text, previous_blank = "", False
            for line in texts:
                if not line:
                    value_text += "\n"
                    previous_blank = True
                else:
                    value_text += ("" if not value_text or previous_blank or value_text.endswith("\n") else " ") + line
                    previous_blank = False
        return value_text if chomp == "-" or not texts else value_text + "\n"

    def value(rest, parent_indent, line_number):
        if rest.startswith(("{", "[")):
            return _flow(rest)
        if rest.startswith(("|", ">")):
            return block_scalar(rest, parent_indent, line_number)
        return _scalar(rest)

    def block(indent):
        nonlocal position
        if lines[position][1].startswith("- ") or lines[position][1] == "-":
            items = []
            while position < len(lines) and lines[position][0] == indent and (
                    lines[position][1].startswith("- ") or lines[position][1] == "-"):
                item, number = lines[position][1][1:].strip(), lines[position][2]
                position += 1
                if item:
                    if re.match(r"^(?:'[^']*'|\"[^\"]*\"|[^\s'\"{\[][^:]*):(?: |$)", item):
                        raise ValueError("Mappings inside sequence items are not supported")
                    items.append(value(item, indent, number))
                elif position < len(lines) and lines[position][0] > indent:
                    items.append(block(lines[position][0]))
                else:
                    items.append(None)
            return items
        mapping = {}
        while position < len(lines) and lines[position][0] == indent and not lines[position][1].startswith("- "):
            key, rest = _split_key(lines[position][1])
            number = lines[position][2]
            position += 1
            if key in mapping:
                raise ValueError("Duplicate key: " + key)
            if rest:
                mapping[key] = value(rest, indent, number)
            elif position < len(lines) and (lines[position][0] > indent or (
                    lines[position][0] == indent and lines[position][1].startswith("- "))):
                mapping[key] = block(lines[position][0])
            else:
                mapping[key] = None
        return mapping

    if not lines:
        return {}
    if lines[0][0] != 0:
        raise ValueError("The document must start at column 0")
    result = block(0)
    if position != len(lines):
        raise ValueError("Unexpected indentation at line content: " + lines[position][1][:60])
    return result


# ---------------------------------------------------------------------------------------------------------------------
# The resolved graph
# ---------------------------------------------------------------------------------------------------------------------

def split_identity(identity):
    name, _, version = identity.rpartition("@")
    if not name or not version:
        raise ValueError("Not a name@version identity: " + identity)
    return name, version


def base_identity(key):
    """'next@16.4.1(react@19.3.0)' -> 'next@16.4.1'."""
    head = key.split("(", 1)[0]
    split_identity(head)
    return head


def dependency_identity(name, reference):
    """A snapshot/importer dependency reference to the package identity it resolves to (None for links)."""
    reference = str(reference)
    if reference.startswith(("link:", "file:")):
        return None
    head = reference.split("(", 1)[0]
    if "@" in head.lstrip("@"):
        return head  # an alias resolves to another package: other@1.2.3
    return f"{name}@{head}"


class Graph:
    """Everything derived from pnpm-lock.yaml; no other inventory exists."""

    def __init__(self, text, sha256=None):
        if isinstance(text, bytes):
            sha256, text = sha256 or hashlib.sha256(text).hexdigest(), text.decode("utf-8")
        self.text = text
        self.sha256 = sha256 or hashlib.sha256(text.encode()).hexdigest()
        data = parse_yaml(text)
        if not isinstance(data, dict):
            raise EvidenceError("pnpm-lock.yaml is not a mapping")
        self.version = str(data.get("lockfileVersion"))
        self.settings = data.get("settings") or {}
        self.overrides = data.get("overrides") or {}
        self.importers = data.get("importers") or {}
        self.packages = data.get("packages") or {}
        self.snapshots = data.get("snapshots") or {}
        self.patched = data.get("patchedDependencies") or {}
        self.parents = {}
        self.children = {}
        self.optional = {}
        self.local_references = []  # link:/file: references inside the registry graph (never legitimate there)
        for key, body in self.snapshots.items():
            identity = base_identity(key)
            body = body or {}
            for group in ("dependencies", "optionalDependencies"):
                for name, reference in (body.get(group) or {}).items():
                    if str(reference).startswith(("link:", "file:")):
                        self.local_references.append(f"{identity} -> {name}: {reference}")
            self.optional[identity] = self.optional.get(identity, True) and body.get("optional") is True
            for group in ("dependencies", "optionalDependencies"):
                for name, reference in (body.get(group) or {}).items():
                    child = dependency_identity(name, reference)
                    if child:
                        self.parents.setdefault(child, set()).add(split_identity(identity)[0])
                        self.children.setdefault(identity, set()).add(child)
        self.direct = {}
        for path, importer in self.importers.items():
            for group in ("dependencies", "devDependencies", "optionalDependencies"):
                for name, entry in ((importer or {}).get(group) or {}).items():
                    entry = entry or {}
                    self.direct.setdefault(path, {})[name] = {"group": group, "specifier": entry.get("specifier"),
                                                             "version": entry.get("version")}
                    child = dependency_identity(name, entry.get("version", ""))
                    if child:
                        self.parents.setdefault(child, set()).add("<importer:" + path + ">")
                        self.optional[child] = False

    def identities(self):
        return sorted(self.packages)

    def integrity(self, identity):
        resolution = (self.packages.get(identity) or {}).get("resolution") or {}
        return resolution.get("integrity") if isinstance(resolution, dict) else None


def load_text(root, path):
    file = Path(root) / path
    return file.read_text() if file.is_file() else None


def workspace_manifests(root, workspace):
    """Workspace importer path -> manifest, from pnpm-workspace.yaml's package globs (plus the root)."""
    root = Path(root)
    result = {".": json.loads((root / "package.json").read_text())}
    for pattern in (workspace or {}).get("packages") or []:
        for manifest in sorted(root.glob(str(pattern).rstrip("/") + "/package.json")):
            if "node_modules" not in manifest.parts:
                result[manifest.parent.relative_to(root).as_posix()] = json.loads(manifest.read_text())
    return result


# ---------------------------------------------------------------------------------------------------------------------
# npm semver ranges (node-semver semantics without includePrerelease), to check lockfile edges against published manifests
# ---------------------------------------------------------------------------------------------------------------------

_SEMVER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")
_PARTIAL = re.compile(r"^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$")


def parse_semver(text):
    match = _SEMVER.match(str(text).strip())
    if not match:
        return None
    pre = tuple(int(p) if p.isdigit() else p for p in match.group(4).split(".")) if match.group(4) else ()
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)), pre)


def _compare(a, b):
    if a[:3] != b[:3]:
        return -1 if a[:3] < b[:3] else 1
    if a[3] == b[3]:
        return 0
    if not a[3] or not b[3]:
        return 1 if not a[3] else -1
    for x, y in zip(a[3], b[3]):
        if x == y:
            continue
        if isinstance(x, int) != isinstance(y, int):
            return -1 if isinstance(x, int) else 1
        return -1 if x < y else 1
    return (len(a[3]) > len(b[3])) - (len(a[3]) < len(b[3]))


def _comparators(token):
    """One range token -> [(operator, version)] (versions as parse_semver tuples)."""
    match = re.match(r"^(\^|~>?|>=|<=|>|<|=)?(.*)$", token)
    operator, rest = match.group(1) or "", match.group(2)
    if rest in ("", "*", "x", "X"):
        return [] if operator in ("", "=", "^", "~", "~>", ">=", "<=") else None if operator in ("<", ">") else []
    partial = _PARTIAL.match(rest)
    if not partial:
        raise ValueError("Unparseable range token: " + token)
    parts = [None if p is None or p in "xX*" else int(p) for p in partial.group(1, 2, 3)]
    pre = tuple(int(p) if p.isdigit() else p for p in partial.group(4).split(".")) if partial.group(4) else ()
    major, minor, patch = parts
    if major is None:
        return []
    zero = (0,)
    if operator in ("", "="):
        if minor is None:
            return [(">=", (major, 0, 0, ())), ("<", (major + 1, 0, 0, zero))]
        if patch is None:
            return [(">=", (major, minor, 0, ())), ("<", (major, minor + 1, 0, zero))]
        return [("=", (major, minor, patch, pre))]
    if operator in ("~", "~>"):
        if minor is None:
            return [(">=", (major, 0, 0, ())), ("<", (major + 1, 0, 0, zero))]
        return [(">=", (major, minor, patch or 0, pre)), ("<", (major, minor + 1, 0, zero))]
    if operator == "^":
        low = (major, minor or 0, patch or 0, pre)
        if major > 0 or minor is None:
            return [(">=", low), ("<", (major + 1, 0, 0, zero))]
        if minor > 0 or patch is None:
            return [(">=", low), ("<", (0, minor + 1, 0, zero))]
        return [(">=", low), ("<", (0, 0, patch + 1, zero))]
    if minor is None or patch is None:  # partial with a comparison operator
        if operator == ">":
            return [(">=", (major + 1, 0, 0, ())) if minor is None else (">=", (major, minor + 1, 0, ()))]
        if operator == "<=":
            return [("<", (major + 1, 0, 0, zero)) if minor is None else ("<", (major, minor + 1, 0, zero))]
        if operator == "<":
            return [("<", (major, minor or 0, 0, zero))]
        return [(">=", (major, minor or 0, 0, ()))]
    return [(operator, (major, minor, patch, pre))]


def range_sets(spec):
    """'>=1.2 <2 || ^3.0.0' -> list of comparator sets; raises ValueError for anything that is not a semver range."""
    sets = []
    for part in str(spec).split("||"):
        part = re.sub(r"(<=|>=|<|>|=|~>?|\^)\s+", r"\1", part.strip())
        hyphen = re.fullmatch(r"(\S+)\s+-\s+(\S+)", part)
        if hyphen:
            low, high = _comparators(">=" + hyphen.group(1)), _comparators("<=" + hyphen.group(2))
            sets.append((low or []) + (high or []))
            continue
        comparators = []
        for token in part.split():
            result = _comparators(token)
            if result is None:  # <* / >* match nothing
                comparators = None
                break
            comparators += result
        if comparators is not None:
            sets.append(comparators)
    return sets


def satisfies(version, spec):
    parsed = parse_semver(version)
    if parsed is None:
        raise ValueError("Not a semver version: " + str(version))
    tests = {"=": lambda c: c == 0, ">": lambda c: c > 0, ">=": lambda c: c >= 0, "<": lambda c: c < 0, "<=": lambda c: c <= 0}
    for comparators in range_sets(spec):
        if not all(tests[op](_compare(parsed, bound)) for op, bound in comparators):
            continue
        if parsed[3] and not any(bound[3] and bound[:3] == parsed[:3] for _, bound in comparators):
            continue  # a prerelease only satisfies a range that names a prerelease of the same version
        return True
    return False


# ---------------------------------------------------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------------------------------------------------

_EXACT_NAME = re.compile(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$")
_EXACT_VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
_SRI = re.compile(r"^sha512-[A-Za-z0-9+/]{86}==$")
_MANDATORY_PROHIBITED = ("AGPL-3.0-only", "GPL-3.0-only", "GPL-2.0-only", "SSPL-1.0", "UNLICENSED")
_COPYLEFT = re.compile(r"^(?:A?GPL|LGPL|MPL|EPL|EUPL|CDDL|SSPL|OSL|CC-BY|BUSL|Elastic)", re.I)


def policy_errors(policy):
    """Invariants that keep the policy from weakening itself. Checked by governance_lite and before every run."""
    errors = []
    if not isinstance(policy, dict):
        return ["Dependency policy is not a JSON object"]
    if policy.get("policy") != "flofi-dependency-security" or not isinstance(policy.get("version"), str):
        errors.append("Dependency policy identity/version missing")
    registry = policy.get("registry") or {}
    if (registry.get("url") != "https://registry.npmjs.org/" or registry.get("tarball_host") != "registry.npmjs.org"
            or registry.get("integrity_algorithm") != "sha512"):
        errors.append("Dependency policy must resolve only from https://registry.npmjs.org/ with sha512 integrity")
    if (policy.get("release_age") or {}).get("minimum_minutes") != 0:
        errors.append("Dependency policy must not introduce a release-age restriction (minimum_minutes must be 0)")
    signatures = policy.get("registry_signatures") or {}
    keys = signatures.get("keys")
    if signatures.get("required") is not True or not isinstance(keys, list) or not keys or not all(
            isinstance(k, dict) and isinstance(k.get("keyid"), str) and k["keyid"].startswith("SHA256:")
            and isinstance(k.get("key"), str) and len(k["key"]) >= 80 for k in keys):
        errors.append("Dependency policy must require npm registry signatures with pinned keys")
    if (policy.get("vulnerabilities") or {}).get("block_at_or_above") != "low":
        errors.append("Dependency policy must block advisories at or above low severity (pnpm audit --audit-level low)")
    licenses = policy.get("licenses") or {}
    allowed = licenses.get("allowed")
    if not isinstance(allowed, list) or not allowed or any(not isinstance(i, str) or _COPYLEFT.match(i) for i in allowed):
        errors.append("Dependency policy allowed licenses must be permissive identifiers only")
    prohibited = licenses.get("prohibited") or []
    if any(item not in prohibited for item in _MANDATORY_PROHIBITED) or set(prohibited) & set(allowed or []):
        errors.append("Dependency policy must keep GPL/AGPL/SSPL/UNLICENSED prohibited")
    if not {"GPL-", "AGPL-"} <= set(licenses.get("prohibited_prefixes") or []):
        errors.append("Dependency policy must keep the GPL-/AGPL- prohibited prefixes")
    supply = policy.get("supply_chain") or {}
    if set(supply.get("install_script_hooks") or []) != {"preinstall", "install", "postinstall"}:
        errors.append("Dependency policy must inspect preinstall/install/postinstall hooks")
    if "@defi-workflow-engine/" not in (supply.get("reserved_scopes") or []):
        errors.append("Dependency policy must reserve the internal @defi-workflow-engine/ scope")
    typosquat = supply.get("typosquat") or {}
    if (typosquat.get("max_distance") not in (1, 2) or not typosquat.get("protected_names")
            or not isinstance(typosquat.get("min_name_length"), int) or not 1 <= typosquat["min_name_length"] <= 6
            or not isinstance(typosquat.get("established_min_versions"), int) or not 2 <= typosquat["established_min_versions"] <= 1000
            or not isinstance(typosquat.get("established_min_age_days"), int) or not 30 <= typosquat["established_min_age_days"] <= 3650):
        errors.append("Dependency policy typosquat detection must stay enabled with meaningful thresholds")
    scan = supply.get("capability_scan") or {}
    if (not {".js", ".cjs", ".mjs"} <= set(scan.get("extensions") or []) or not isinstance(scan.get("max_file_bytes"), int)
            or scan["max_file_bytes"] < 1 << 20 or not isinstance(scan.get("max_package_bytes"), int) or scan["max_package_bytes"] < 8 << 20):
        errors.append("Dependency policy capability scan must cover JavaScript files with meaningful size bounds")
    if not isinstance(supply.get("recent_publication_hours"), int) or supply["recent_publication_hours"] < 0:
        errors.append("Dependency policy recent_publication_hours must be a non-negative integer (a signal, never a gate)")
    if (policy.get("direct_dependencies") or {}).get("exact_versions") is not True:
        errors.append("Dependency policy must keep exact direct dependency versions")
    seen = set()
    for entry in policy.get("exceptions") or []:
        errors.extend(exception_errors(entry, seen))
    if not isinstance(policy.get("exceptions", []), list):
        errors.append("Dependency policy exceptions must be a list")
    return errors


def exception_errors(entry, seen=None):
    label = entry.get("id") if isinstance(entry, dict) else None
    if not isinstance(entry, dict) or not isinstance(label, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,63}", label):
        return ["Dependency exception needs a lowercase id"]
    errors = []
    if seen is not None:
        if label in seen:
            errors.append(f"Duplicate dependency exception id: {label}")
        seen.add(label)
    allowed_fields = {"id", "resolves", "packages", "identity", "license", "integrity", "parents", "optional",
                      "platform_restricted", "reason", "approved_by", "approved_at", "record"}
    if set(entry) - allowed_fields:
        errors.append(f"Dependency exception {label}: unknown fields {sorted(set(entry) - allowed_fields)}")
    resolves = entry.get("resolves")
    if not isinstance(resolves, list) or not resolves:
        errors.append(f"Dependency exception {label}: resolves must name finding codes")
        resolves = []
    for code in resolves:
        if code in BLOCK_CODES:
            errors.append(f"Dependency exception {label}: {code} is a mandatory control and cannot be excepted")
        elif code not in REVIEW_CODES:
            errors.append(f"Dependency exception {label}: unknown finding code {code}")
    packages, identity = entry.get("packages"), entry.get("identity")
    if (packages is None) == (identity is None):
        errors.append(f"Dependency exception {label}: use exactly one of packages (names) or identity (name@version)")
    if packages is not None and (not isinstance(packages, list) or not packages
                                 or not all(isinstance(n, str) and _EXACT_NAME.fullmatch(n) for n in packages)):
        errors.append(f"Dependency exception {label}: packages must be exact names (no globs or ranges)")
    if identity is not None:
        try:
            name, version = split_identity(identity)
            exact = _EXACT_NAME.fullmatch(name) and _EXACT_VERSION.fullmatch(version)
        except (ValueError, AttributeError):
            exact = False
        if not exact:
            errors.append(f"Dependency exception {label}: identity must be an exact name@version")
        if not isinstance(entry.get("integrity"), str) or not _SRI.fullmatch(entry["integrity"]):
            errors.append(f"Dependency exception {label}: an identity exception is bound to its sha512 integrity")
    if packages is not None:
        # Name-scoped exceptions answer a license question only, bound to the exact license expression.
        if set(resolves) - {"license-review"}:
            errors.append(f"Dependency exception {label}: only license-review may be name-scoped; use identity + integrity")
        if not isinstance(entry.get("license"), str) or not entry["license"].strip():
            errors.append(f"Dependency exception {label}: a license exception names the exact license expression")
    if "integrity" in entry and (not isinstance(entry["integrity"], str) or not _SRI.fullmatch(entry["integrity"])):
        errors.append(f"Dependency exception {label}: integrity must be sha512 SRI")
    if "parents" in entry and (not isinstance(entry["parents"], list) or not entry["parents"]
                               or not all(isinstance(p, str) and _EXACT_NAME.fullmatch(p) for p in entry["parents"])):
        errors.append(f"Dependency exception {label}: parents must be exact package names")
    for flag in ("optional", "platform_restricted"):
        if flag in entry and entry[flag] is not True:
            errors.append(f"Dependency exception {label}: {flag} may only be true")
    if entry.get("approved_by") != "Owner":
        errors.append(f"Dependency exception {label}: approved_by must be Owner")
    if not isinstance(entry.get("approved_at"), str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", entry["approved_at"]):
        errors.append(f"Dependency exception {label}: approved_at must be a date")
    if not isinstance(entry.get("reason"), str) or len(entry["reason"].strip()) < 30:
        errors.append(f"Dependency exception {label}: reason must explain the exception")
    if not isinstance(entry.get("record"), str) or not entry["record"].startswith("docs/"):
        errors.append(f"Dependency exception {label}: record must reference the review document")
    return errors


def load_policy(root):
    path = Path(root) / POLICY_PATH
    if not path.is_file():
        raise EvidenceError("Dependency policy missing: " + POLICY_PATH)
    raw = path.read_bytes()  # the evidence binds these exact bytes (scripts/sbom_verify.py hashes the same bytes)
    try:
        policy = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise EvidenceError("Dependency policy is not valid JSON") from None
    errors = policy_errors(policy)
    if errors:
        raise EvidenceError("Dependency policy invalid:\n  " + "\n  ".join(errors))
    return policy, hashlib.sha256(raw).hexdigest()


# ---------------------------------------------------------------------------------------------------------------------
# Licenses (SPDX expressions)
# ---------------------------------------------------------------------------------------------------------------------

# Non-SPDX spellings of the prohibited families (GPL, GPLv3, AGPL-3.0+, "GNU GPL", SSPL, BUSL); LGPL stays a review license.
_PROHIBITED_FAMILY = re.compile(r"^(?:GNU[ -]?)?(?:A?GPL|SSPL|BUSL)(?:$|[-v\d. +])", re.I)


def license_category(identifier, licenses):
    if identifier in licenses["allowed"]:
        return "allowed"
    if (identifier in licenses["prohibited"] or any(identifier.startswith(p) for p in licenses.get("prohibited_prefixes", []))
            or _PROHIBITED_FAMILY.match(identifier)):
        return "prohibited"
    return "review"


def evaluate_license(value, licenses):
    """(category, detail): allowed | review | prohibited | missing."""
    if value is None:
        return "missing", "registry metadata declares no license"
    if not isinstance(value, str) or not value.strip():
        return "review", "non-SPDX license metadata"
    text = value.strip()
    if text.upper().startswith("SEE LICENSE IN") or text.startswith("LicenseRef-"):
        return "review", "custom license text: " + text
    tokens = re.findall(r"\(|\)|[^\s()]+", text)
    order = {"allowed": 0, "review": 1, "prohibited": 2}
    position = 0

    def atom():
        nonlocal position
        if position >= len(tokens):
            raise ValueError
        token = tokens[position]
        position += 1
        if token == "(":
            result = expression()
            if position >= len(tokens) or tokens[position] != ")":
                raise ValueError
            position += 1
            return result
        if token in ("AND", "OR", "WITH", ")"):
            raise ValueError
        category = license_category(token.rstrip("+"), licenses)
        if position < len(tokens) and tokens[position] == "WITH":
            position += 2  # an SPDX exception changes the base license's terms: a person reads it (owner exception needed)
            return "review"
        return category

    def conjunction():
        nonlocal position
        result = atom()
        while position < len(tokens) and tokens[position] == "AND":
            position += 1
            result = max(result, atom(), key=order.get)
        return result

    def expression():
        nonlocal position
        result = conjunction()
        while position < len(tokens) and tokens[position] == "OR":
            position += 1
            result = min(result, conjunction(), key=order.get)
        return result

    try:
        category = expression()
        if position != len(tokens):
            raise ValueError
    except ValueError:
        # "GNU GPL", "MIT AND GPL v3": not SPDX, but plainly a prohibited family. With an OR a permissive choice may
        # exist, so a person reads it; otherwise it is prohibited.
        if re.search(r"(?:^|[\s(])(?:GNU[ -]?)?(?:A?GPL|SSPL|BUSL)(?:$|[-v\d. +)])", text, re.I):
            return ("review", "unparseable SPDX expression: " + text) if re.search(r"\bOR\b", text) else ("prohibited", text)
        return "review", "unparseable SPDX expression: " + text
    return category, text


# ---------------------------------------------------------------------------------------------------------------------
# Registry evidence
# ---------------------------------------------------------------------------------------------------------------------

def _version_key(version):
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?", version)
    if not match:
        return (-1, -1, -1, 0, ())
    pre = match.group(4)
    parts = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split(".")) if pre else ()
    return (int(match.group(1)), int(match.group(2)), int(match.group(3)), 0 if pre else 1, parts)


def prior_release(packument, version):
    """The highest earlier release published before this one. A stable release compares with stable releases, or with
    its prereleases when it is the first stable one (1.0.0 after 1.0.0-rc.3 is not a "first release")."""
    times = packument.get("time") or {}
    published = times.get(version)
    earlier = [v for v in (packument.get("versions") or {}) if v != version and v in times and published
               and times[v] < published and _version_key(v) < _version_key(version)]
    stable = [v for v in earlier if "-" not in v] if "-" not in version else earlier
    candidates = stable or earlier
    return max(candidates, key=_version_key) if candidates else None


def reduce_packument(document, versions):
    """Keep only what evaluation needs: the locked versions, their prior releases and the package history summary."""
    keep = {}
    for version in versions:
        keep[version] = None
        prior = prior_release(document, version) if version in (document.get("versions") or {}) else None
        if prior:
            keep[prior] = None
    times = document.get("time") or {}
    return {"name": document.get("name"),
            "versions": {v: document["versions"][v] for v in keep if v in (document.get("versions") or {})},
            "time": {v: times[v] for v in [*keep, "created"] if v in times},
            "version_count": len(document.get("versions") or {}),
            "prior": {v: prior_release(document, v) for v in versions if v in (document.get("versions") or {})}}


def _bootstrap_fetch():
    spec = importlib.util.spec_from_file_location("flofi_bootstrap_ci", ROOT / "scripts" / "bootstrap-ci.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.fetch


def registry_metadata(identities, fetch=None, workers=8):
    """One fresh full registry document per name (no cache), reduced per name as soon as it is parsed.

    Returns {name: reduced packument | {"error": text, "status": 404|None}}.
    """
    fetch = fetch or _bootstrap_fetch()
    grouped = {}
    for identity in sorted(identities):
        name, version = split_identity(identity)
        grouped.setdefault(name, []).append(version)

    def acquire(item):
        name, versions = item
        try:
            raw = fetch("https://registry.npmjs.org/" + name.replace("/", "%2f"), compressed=True, quiet=True)
            return name, reduce_packument(json.loads(raw), versions)
        except Exception as exc:  # noqa: BLE001 - every failure is recorded and fails closed
            text = re.sub(r"https?://\S+", "<url>", str(exc))[:200]
            return name, {"error": text, "status": 404 if "HTTP 404" in text else None}

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        return dict(pool.map(acquire, sorted(grouped.items())))


_SIGNATURE_VERIFIER = r"""
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const keys = new Map(input.keys.map(k => [k.keyid, createPublicKey({ key: Buffer.from(k.key, 'base64'), format: 'der', type: 'spki' })]));
const results = input.items.map(item => (item.signatures || []).map(sig => {
  const key = keys.get(sig.keyid);
  if (!key) return 'unknown-key';
  try { return verify('sha256', Buffer.from(item.message, 'utf8'), key, Buffer.from(String(sig.sig), 'base64')) ? 'valid' : 'invalid'; }
  catch { return 'invalid'; }
}));
process.stdout.write(JSON.stringify(results));
"""


def verify_signatures(items, keys, node=None):
    """npm registry ECDSA P-256 signatures, verified by Node's crypto (no third-party code). items: [{message, signatures}]."""
    node = node or shutil.which("node")
    if not node:
        raise EvidenceError("Node.js is required to verify npm registry signatures")
    if not items:
        return []
    result = subprocess.run([node, "--input-type=module", "-e", _SIGNATURE_VERIFIER], input=json.dumps(
        {"keys": [{"keyid": k["keyid"], "key": k["key"]} for k in keys], "items": items}),
        capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        raise EvidenceError("npm registry signature verifier failed")
    try:
        verdicts = json.loads(result.stdout)
    except ValueError:
        raise EvidenceError("npm registry signature verifier returned invalid output") from None
    if not isinstance(verdicts, list) or len(verdicts) != len(items):
        raise EvidenceError("npm registry signature verifier returned an incomplete result")
    return verdicts


def run_audit(root, pnpm=None, registry="https://registry.npmjs.org/"):
    """Advisories from the policy registry's advisory service, whatever .npmrc says (a substituted registry is BLOCKed
    separately); the separate `pnpm audit --audit-level low` CI step keeps the repository configuration."""
    pnpm = pnpm or shutil.which("pnpm")
    if not pnpm:
        raise EvidenceError("pnpm is required for the advisory check")
    result = subprocess.run([pnpm, "audit", "--json", "--registry", registry], cwd=root, capture_output=True, text=True, timeout=300)
    try:
        document = json.loads(result.stdout)
    except ValueError:
        raise EvidenceError("pnpm audit did not return JSON (registry advisory service unavailable?)") from None
    if not isinstance(document, dict) or not isinstance(document.get("advisories"), dict):
        raise EvidenceError("pnpm audit returned an unexpected document")
    return document


def advisories_by_identity(audit, block_at):
    threshold = SEVERITIES.index(block_at)
    result = {}
    for key, advisory in sorted((audit.get("advisories") or {}).items()):
        severity = advisory.get("severity")
        if severity not in SEVERITIES:
            raise EvidenceError("pnpm audit advisory without a known severity: " + str(key))
        for finding in advisory.get("findings") or []:
            identity = f"{advisory.get('module_name')}@{finding.get('version')}"
            result.setdefault(identity, []).append({
                "id": advisory.get("github_advisory_id") or str(advisory.get("id")),
                "severity": severity, "blocking": SEVERITIES.index(severity) >= threshold,
                "title": str(advisory.get("title") or "")[:200],
                "vulnerable_versions": advisory.get("vulnerable_versions"),
                "patched_versions": advisory.get("patched_versions"),
                "paths": list(finding.get("paths") or [])[:20]})
    return result


# ---------------------------------------------------------------------------------------------------------------------
# Content capability scan (bounded, only for packages with a stateless trigger)
# ---------------------------------------------------------------------------------------------------------------------

def installed_directory(root, name, version):
    store = Path(root) / "node_modules" / ".pnpm"
    if not store.is_dir():
        return None
    prefix = name.replace("/", "+") + "@" + version
    for candidate in sorted(store.glob(glob_escape(prefix) + "*")):
        if candidate.name != prefix and candidate.name[len(prefix)] not in "_(":
            continue
        directory = candidate / "node_modules" / name
        try:
            manifest = json.loads((directory / "package.json").read_text())
        except (OSError, ValueError):
            continue
        if manifest.get("name") == name and manifest.get("version") == version and not directory.is_symlink():
            return directory
    return None


# Full-text markers of the standard license texts a package may ship without declaring them in package.json.
_LICENSE_TEXTS = {
    "Apache-2.0": ("Apache License", "Version 2.0, January 2004", "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION"),
    "MIT": ("Permission is hereby granted, free of charge, to any person obtaining a copy",
            "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND"),
    "ISC": ("Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted",
            "THE SOFTWARE IS PROVIDED \"AS IS\" AND THE AUTHOR DISCLAIMS ALL WARRANTIES"),
}


def archive_license(directory):
    """The single standard license text shipped in an installed package's top-level LICENSE/LICENCE/COPYING file, or None
    when there is none, several, or an unrecognized one (then a person reads it)."""
    candidates = [path for path in sorted(directory.iterdir()) if path.is_file() and not path.is_symlink()
                  and re.match(r"^(?:LICEN[CS]E|COPYING)(?:[.-][\w.-]+)?$", path.name, re.I)]
    found = set()
    for path in candidates:
        text = " ".join(path.read_text(errors="replace")[:65536].split())
        matches = [spdx for spdx, markers in _LICENSE_TEXTS.items() if all(" ".join(m.split()) in text for m in markers)]
        if len(matches) != 1:
            return None
        found.add(matches[0])
    return found.pop() if len(found) == 1 else None


def glob_escape(text):
    return re.sub(r"([*?[])", r"[\1]", text)


def capability_scan(directory, limits):
    capabilities, files, scanned, oversize = {}, {}, 0, []
    extensions = tuple(limits.get("extensions") or (".js", ".cjs", ".mjs"))
    for path in sorted(directory.rglob("*")):
        if path.is_symlink() or not path.is_file() or "node_modules" in path.relative_to(directory).parts:
            continue
        if path.suffix not in extensions:
            continue
        if path.stat().st_size > limits.get("max_file_bytes", 4 << 20):
            oversize.append(path.relative_to(directory).as_posix())  # recorded, never silently treated as clean
            continue
        if scanned + path.stat().st_size > limits.get("max_package_bytes", 32 << 20):
            capabilities["scan-truncated"] = True
            break
        text = path.read_text(errors="replace")
        scanned += len(text)
        for label, pattern in CAPABILITY_PATTERNS.items():
            if pattern.search(text):
                capabilities[label] = True
                files.setdefault(label, []).append(path.relative_to(directory).as_posix())
    return {"capabilities": sorted(capabilities), "files": {k: v[:5] for k, v in sorted(files.items())},
            "scanned_bytes": scanned, "skipped_oversize_files": oversize[:20], "skipped_oversize_count": len(oversize)}


# ---------------------------------------------------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------------------------------------------------

def _finding(code, detail):
    decision = BLOCK if code in BLOCK_CODES else REVIEW
    return {"code": code, "decision": decision, "detail": detail}


def _distance(a, b, limit):
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    previous2, previous = None, list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        current = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            current[j] = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb))
            if previous2 is not None and i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                current[j] = min(current[j], previous2[j - 2] + 1)
        previous2, previous = previous, current
    return previous[-1]


def _instant(text):
    try:
        return datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00"))
    except ValueError:
        return None


def _repository(document):
    """Normalized source repository (URL plus monorepo directory) of a registry version document."""
    value = (document or {}).get("repository")
    url, directory = (value.get("url"), value.get("directory")) if isinstance(value, dict) else (value, None)
    if not isinstance(url, str) or not url.strip():
        return None
    url = url.strip().lower()
    url = re.sub(r"^github:", "https://github.com/", url) if url.startswith("github:") else url
    if re.fullmatch(r"[\w.-]+/[\w.-]+", url):
        url = "https://github.com/" + url
    url = re.sub(r"^(?:git\+)?(?:ssh://git@|git://|https?://|git@)", "", url).replace("github.com:", "github.com/")
    url = re.sub(r"\.git$|/$", "", url)
    return url + ("#" + str(directory).strip("/").lower() if directory else "")


def _install_hooks(document, hooks):
    scripts = document.get("scripts") if isinstance(document.get("scripts"), dict) else {}
    found = {hook: str(scripts[hook]) for hook in hooks if hook in scripts}
    if document.get("hasInstallScript") and not found:
        found["<binding.gyp>"] = "node-gyp rebuild"
    return found


def exception_matches(entry, identity, record, graph, code):
    """None when the exception applies; otherwise why it does not (shown so a stale exception is obvious)."""
    name, _ = split_identity(identity)
    if code not in entry["resolves"]:
        return "does not resolve " + code
    if "identity" in entry and entry["identity"] != identity:
        return "different identity"
    if "packages" in entry and name not in entry["packages"]:
        return "different package"
    if "integrity" in entry and entry["integrity"] != record["integrity"]:
        return "integrity differs from the reviewed archive"
    if "license" in entry and entry["license"] != record["license"]["declared"]:
        return f"license changed to {record['license']['declared']!r}"
    if "parents" in entry:
        unexpected = sorted(p for p in graph.parents.get(identity, set()) if p not in entry["parents"])
        if unexpected:
            return "new dependents " + ", ".join(unexpected)
    if entry.get("optional") and not graph.optional.get(identity, False):
        return "no longer optional-only"
    if entry.get("platform_restricted"):
        block = graph.packages.get(identity) or {}
        if not (block.get("os") or block.get("cpu")):
            return "no longer platform-restricted"
    return None


_SELECTOR = re.compile(r"^(?:(?P<parent>(?:@[^/@>]+/)?[^@>]+)(?:@(?P<parent_range>[^>]+))?>)?(?P<child>(?:@[^/@>]+/)?[^@>]+)(?:@(?P<child_range>.+))?$")


def _selectors(mapping, label):
    """pnpm `parent@range>child` selectors -> [(parent, parent_range, child, child_range, value)]."""
    result = []
    for selector, value in (mapping or {}).items():
        match = _SELECTOR.match(str(selector))
        if not match:
            raise EvidenceError(f"Unsupported {label} selector: {selector}")
        result.append((match.group("parent"), match.group("parent_range"), match.group("child"), match.group("child_range"), value))
    return result


_DIST_TAG = re.compile(r"^[A-Za-z][\w.-]*$")


def _version_matches(version, spec):
    """A semver range, or a dist-tag such as `latest` (which resolved to *some* release of the same package when the
    lockfile was written; the release itself is still evaluated on its own evidence). Other specs (git, URLs, files)
    never match a registry release."""
    try:
        return satisfies(version, spec)
    except ValueError:
        return bool(_DIST_TAG.fullmatch(spec)) and not re.match(r"^(?:file|link|git|github|https?|workspace)\b", spec)


def _spec_satisfied(name, target, spec):
    """Does the locked target identity satisfy one declared dependency spec (a range, a dist-tag or an npm: alias)?"""
    target_name, target_version = split_identity(target)
    spec = str(spec).strip()
    if spec.startswith("npm:"):
        alias_name, _, alias_range = spec[4:].rpartition("@") if "@" in spec[5:] else (spec[4:], "", "")
        if not alias_name:
            alias_name, alias_range = spec[4:], ""
        return target_name == alias_name and _version_matches(target_version, alias_range or "*")
    return target_name == name and _version_matches(target_version, spec)


def graph_edge_findings(graph, metadata, workspace):
    """Every lockfile edge must be requested by its parent's published manifest (dependencies, optional or peer
    dependencies, after the workspace's overrides, packageExtensions and peerDependencyRules), so a lockfile cannot point
    a dependency at another package or version than the registry-signed manifests ask for. Returns
    ({parent identity: [finding]}, [global finding])."""
    workspace = workspace or {}
    overrides = _selectors(workspace.get("overrides") or graph.overrides, "override")
    extensions = _selectors(workspace.get("packageExtensions"), "packageExtensions")
    rules = (workspace.get("peerDependencyRules") or {})
    allowed = _selectors(rules.get("allowedVersions"), "peerDependencyRules")
    allow_any = set(rules.get("allowAny") or [])
    per_package, global_findings = {}, []

    def matches(parent, parent_range, name, version):
        return parent == name and (parent_range is None or satisfies(version, parent_range))

    for key, body in sorted(graph.snapshots.items()):
        identity = base_identity(key)
        name, version = split_identity(identity)
        document = (metadata.get(name) or {}).get("versions", {}).get(version)
        if document is None:
            continue  # the package itself is already BLOCKed as metadata-inconsistent
        declared = {**(document.get("dependencies") or {}), **(document.get("optionalDependencies") or {})}
        peers = dict(document.get("peerDependencies") or {})
        for peer in document.get("peerDependenciesMeta") or {}:
            peers.setdefault(peer, "*")  # pnpm treats a peer named only in peerDependenciesMeta as an optional `*` peer
        for _, _, selector, selector_range, extension in extensions:  # packageExtensions keys are `name@range`
            if selector == name and (selector_range is None or satisfies(version, selector_range)):
                declared.update((extension or {}).get("dependencies") or {})
                declared.update((extension or {}).get("optionalDependencies") or {})
                peers.update((extension or {}).get("peerDependencies") or {})
        for group in ("dependencies", "optionalDependencies"):
            for child_name, reference in ((body or {}).get(group) or {}).items():
                target = dependency_identity(child_name, reference)
                if target is None:
                    continue  # link:/file: references are BLOCKed separately
                applicable = [(p, v) for p, pr, c, cr, v in overrides if c == child_name and (p is None or matches(p, pr, name, version))]
                applicable.sort(key=lambda item: item[0] is None)  # a parent-scoped override wins over a global one
                problem = None
                if applicable:
                    value = str(applicable[0][1])
                    if value == "-":
                        problem = "removed by an override but still resolved"
                    elif not _spec_satisfied(child_name, target, value):
                        problem = f"override requires {value}"
                elif child_name in declared:
                    if not _spec_satisfied(child_name, target, declared[child_name]):
                        problem = f"published manifest requests {declared[child_name]}"
                elif child_name in peers:
                    spec = peers[child_name]
                    if not _spec_satisfied(child_name, target, spec) and child_name not in allow_any and not any(
                            c == child_name and (p is None or matches(p, pr, name, version)) and _spec_satisfied(child_name, target, v)
                            for p, pr, c, cr, v in allowed):
                        problem = f"published peer range is {spec}"
                else:
                    problem = "not declared by the published manifest"
                if problem:
                    per_package.setdefault(identity, []).append(_finding(
                        "graph-substitution", f"lockfile resolves {name}@{version} -> {child_name} to {target}: {problem}"))
    for path, dependencies in sorted(graph.direct.items()):
        for child_name, entry in sorted(dependencies.items()):
            specifier, target = str(entry["specifier"]), dependency_identity(child_name, entry["version"] or "")
            if target is None or specifier.startswith(("workspace:", "link:", "file:")):
                continue
            applicable = [v for p, pr, c, cr, v in overrides if c == child_name and p is None]
            expected = str(applicable[0]) if applicable else specifier
            if not _spec_satisfied(child_name, target, expected):
                global_findings.append(_finding("graph-substitution",
                                                f"{path}: {child_name}@{specifier} resolves to {target}"))
    return per_package, global_findings


def evaluate(root, *, policy, policy_sha256, graph, metadata, audit, signature_verdicts=None, verifier=None,
             base_graph=None, now=None, revision=None, workspace=None, npmrc=None, policy_changed=None, extra_lockfiles=()):
    """Pure evaluation of collected evidence. Returns the evidence document."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    licenses = policy["licenses"]
    supply = policy["supply_chain"]
    hooks = supply["install_script_hooks"]
    global_findings = []
    package_findings = {}  # findings raised outside a package's own evaluation (aliases, lockfile edges)
    manifests = workspace_manifests(root, workspace)
    workspace_names = {m.get("name") for m in manifests.values() if m.get("name")}

    # -- Configuration controls ---------------------------------------------------------------------------------------
    # pnpm 11 reads only registry and authentication settings from .npmrc (quoted keys included); everything else,
    # including ignoreScripts and the audit settings, comes from pnpm-workspace.yaml.
    npmrc_lines = {}
    for line in (npmrc or "").splitlines():
        stripped = line.strip()
        if "=" in stripped and not stripped.startswith(("#", ";")):
            key, value = stripped.split("=", 1)
            npmrc_lines[key.strip().strip("'\"").strip()] = value.strip().strip("'\"").strip()
    if npmrc_lines.get("registry") != policy["registry"]["url"]:
        global_findings.append(_finding("source-substitution", ".npmrc registry is not " + policy["registry"]["url"]))
    for key in npmrc_lines:
        if key.endswith(":registry") or key == "registries":
            global_findings.append(_finding("source-substitution", ".npmrc custom registry " + key))
    workspace = workspace or {}
    for key in ("registry", "registries"):
        if key in workspace:
            global_findings.append(_finding("source-substitution", f"pnpm-workspace.yaml sets {key}"))
    for key in ("audit", "auditConfig", "auditLevel"):
        if workspace.get(key) not in (None, {}, []):
            global_findings.append(_finding("policy-bypass", f"pnpm-workspace.yaml {key} can ignore advisories or raise the audit level"))
    if workspace.get("ignoreScripts") is not True:
        global_findings.append(_finding("policy-bypass", "pnpm-workspace.yaml must keep ignoreScripts: true (pnpm 11 ignores .npmrc ignore-scripts)"))
    if workspace.get("dangerouslyAllowAllBuilds") or workspace.get("onlyBuiltDependencies") or workspace.get("allowBuilds"):
        global_findings.append(_finding("policy-bypass", "pnpm-workspace.yaml enables dependency lifecycle scripts"))
    lockfile_settings = {"gitBranchLockfile": True, "mergeGitBranchLockfiles": True, "mergeGitBranchLockfilesBranchPattern": None,
                         "lockfileDir": None, "useLockfile": False, "lockfile": False, "sharedWorkspaceLockfile": False,
                         "optional": False}
    for key, forbidden in lockfile_settings.items():
        if key in workspace and (forbidden is None or workspace[key] == forbidden):
            global_findings.append(_finding("policy-bypass", f"pnpm-workspace.yaml {key}: {workspace[key]} changes which lockfile or "
                                            "dependencies pnpm installs and audits"))
    for path in extra_lockfiles:
        global_findings.append(_finding("policy-bypass", f"{path}: only the root pnpm-lock.yaml may define the installed graph"))
    release_age = workspace.get("minimumReleaseAge")
    for selector, value in sorted({**(workspace.get("overrides") or {}), **graph.overrides}.items()):
        value = str(value)
        if value == "-" or _EXACT_VERSION.fullmatch(value):
            continue
        if value.startswith("npm:"):
            target = value[4:]
            target = target if "@" in target.lstrip("@") else None
            (package_findings.setdefault(target, []) if target in graph.packages else global_findings).append(
                _finding("alias-substitution", f"override {selector} -> {value}"))
        elif re.match(r"^(?:link:|file:|git|github:|https?:|[\w.-]+/[\w.-]+#)", value):
            global_findings.append(_finding("source-substitution", f"override {selector} -> {value}"))
        else:
            global_findings.append(_finding("non-exact-direct-specifier", f"override {selector} -> {value} is not exact"))

    # -- Workspace importers: exact direct pins and workspace-only links -------------------------------------------------
    if set(graph.importers) != set(manifests):
        global_findings.append(_finding("workspace-constraint", "lock importers "
                                        f"{sorted(graph.importers)} differ from workspace packages {sorted(manifests)}"))
    for path, dependencies in sorted(graph.direct.items()):
        for name, entry in sorted(dependencies.items()):
            specifier, resolved = str(entry["specifier"]), str(entry["version"])
            where = f"{path}: {name}@{specifier}"
            if specifier.startswith("workspace:"):
                target = resolved.removeprefix("link:")
                linked = PurePosixPath(path) / target if resolved.startswith("link:") else None
                normalized = os.path.normpath(str(linked)) if linked else None
                if normalized not in manifests or manifests[normalized].get("name") != name:
                    global_findings.append(_finding("source-substitution", where + " does not link a workspace package"))
            elif specifier.startswith("npm:"):
                target = dependency_identity(name, resolved)
                (package_findings.setdefault(target, []) if target in graph.packages else global_findings).append(
                    _finding("alias-substitution", where))
            elif re.match(r"^(?:link:|file:|git|github:|https?:|[\w.-]+/[\w.-]+#)", specifier) or resolved.startswith(("link:", "file:")):
                global_findings.append(_finding("source-substitution", where))
            elif not _EXACT_VERSION.fullmatch(specifier) and policy["direct_dependencies"]["exact_versions"]:
                global_findings.append(_finding("non-exact-direct-specifier", where))
    snapshot_identities = {base_identity(key) for key in graph.snapshots}
    if snapshot_identities != set(graph.packages):
        global_findings.append(_finding("metadata-inconsistent", "pnpm-lock.yaml packages and snapshots differ: "
                                        + ", ".join(sorted(snapshot_identities ^ set(graph.packages))[:10])))
    for path, dependencies in sorted(graph.direct.items()):
        for name, entry in sorted(dependencies.items()):
            target = dependency_identity(name, entry["version"] or "")
            if target and target not in graph.packages:
                global_findings.append(_finding("metadata-inconsistent", f"{path}: {name} resolves to {target}, absent from packages"))
    for parent, children in sorted(graph.children.items()):
        for child in sorted(children - set(graph.packages)):
            global_findings.append(_finding("metadata-inconsistent", f"{parent} depends on {child}, absent from packages"))
    for reference in graph.local_references:
        global_findings.append(_finding("source-substitution", "local reference in the registry graph: " + reference))
    for constraint in policy.get("workspace", {}).get("constraints", []):
        dependencies = graph.direct.get(constraint["importer"], {})
        registry = [n for n, e in dependencies.items() if not str(e["specifier"]).startswith("workspace:")]
        if len(dependencies) > constraint.get("max_dependencies", len(dependencies)) or len(registry) > constraint.get(
                "max_registry_dependencies", len(registry)):
            global_findings.append(_finding("workspace-constraint", f"{constraint['importer']} has {len(dependencies)} dependencies "
                                            f"({len(registry)} from the registry): {constraint['reason']}"))
    for path, manifest in sorted(manifests.items()):
        if path != "." and (manifest.get("private") is not True or manifest.get("license") not in policy["workspace"]["licenses"]):
            global_findings.append(_finding("workspace-constraint", f"{path} must be private with a workspace license"))

    # -- Registry signatures (one Node process for the whole graph) -----------------------------------------------------
    identities = graph.identities()
    keys = {k["keyid"]: k for k in policy["registry_signatures"]["keys"]}
    if signature_verdicts is None:
        items = []
        for identity in identities:
            name, version = split_identity(identity)
            document = (metadata.get(name) or {}).get("versions", {}).get(version) or {}
            items.append({"message": f"{identity}:{graph.integrity(identity)}",
                          "signatures": (document.get("dist") or {}).get("signatures") or []})
        verdicts = (verifier or verify_signatures)(items, list(keys.values()))
        signature_verdicts = dict(zip(identities, verdicts))

    protected = set(supply["typosquat"]["protected_names"])
    for manifest in manifests.values():
        for group in ("dependencies", "devDependencies", "optionalDependencies"):
            protected |= {n for n, v in (manifest.get(group) or {}).items() if not str(v).startswith("workspace:")}
    recent_limit = datetime.timedelta(hours=supply["recent_publication_hours"])
    base_names = {}
    if base_graph is not None:
        for identity in base_graph.identities():
            name, version = split_identity(identity)
            base_names.setdefault(name, set()).add(version)
    current_names = {}
    for identity in identities:
        name, version = split_identity(identity)
        current_names.setdefault(name, set()).add(version)

    edge_findings, edge_global = graph_edge_findings(graph, metadata, workspace)
    global_findings.extend(edge_global)
    for identity, items in edge_findings.items():
        package_findings.setdefault(identity, []).extend(items)

    records = []
    exceptions = policy.get("exceptions") or []
    used_exceptions = set()
    for identity in identities:
        name, version = split_identity(identity)
        block = graph.packages.get(identity) or {}
        findings, signals = list(package_findings.get(identity, [])), []
        resolution = block.get("resolution") if isinstance(block.get("resolution"), dict) else {}
        integrity = resolution.get("integrity")
        if set(resolution) - {"integrity"}:
            findings.append(_finding("source-substitution", "lock resolution is not the registry tarball: "
                                     + ", ".join(sorted(set(resolution) - {"integrity"}))))
        if not isinstance(integrity, str) or not integrity.startswith("sha512-"):
            findings.append(_finding("integrity-missing", "no sha512 integrity in pnpm-lock.yaml"))
        if any(name.startswith(scope) for scope in supply["reserved_scopes"]) or name in workspace_names:
            findings.append(_finding("dependency-confusion", "registry package uses an internal workspace scope or name"))
        if re.fullmatch(r"0\.0\.1-security(?:\.\d+)?", version):
            findings.append(_finding("malicious-indicator", "npm security placeholder release (package removed for malware)"))

        packument = metadata.get(name) or {"error": "not fetched", "status": None}
        if "error" in packument:
            if packument.get("status") == 404:
                findings.append(_finding("metadata-inconsistent", "the registry no longer serves this package"))
                document = {}
            else:
                raise EvidenceError(f"Registry metadata unavailable for {name}: {packument['error']}")
        else:
            document = (packument.get("versions") or {}).get(version)
            if document is None:
                findings.append(_finding("metadata-inconsistent", "the registry no longer serves this exact release"))
                document = {}
        dist = document.get("dist") or {}
        published = (packument.get("time") or {}).get(version)
        prior_version = (packument.get("prior") or {}).get(version)
        prior = (packument.get("versions") or {}).get(prior_version) or {} if prior_version else None
        if document:
            if document.get("name") != name or document.get("version") != version:
                findings.append(_finding("metadata-inconsistent", "registry name/version differ from the locked identity"))
            if dist.get("integrity") != integrity:
                findings.append(_finding("integrity-mismatch", "lockfile integrity differs from registry dist.integrity"))
            tarball = urllib.parse.urlsplit(str(dist.get("tarball") or ""))
            if tarball.scheme != "https" or tarball.hostname != policy["registry"]["tarball_host"] or not tarball.path.startswith(
                    "/" + name + "/-/"):
                findings.append(_finding("source-substitution", "registry tarball is not on " + policy["registry"]["tarball_host"]))
            if isinstance(document.get("deprecated"), str):
                if MALWARE_NOTICE.search(document["deprecated"]):
                    findings.append(_finding("malicious-indicator", "deprecation notice: " + document["deprecated"][:160]))
                else:
                    signals.append("deprecated")

        # Registry signatures: valid by a pinned key that had not expired when this release was published.
        verdicts = signature_verdicts.get(identity, [])
        signature_state, verified_by = "missing", []
        published_at = _instant(published) if published else None
        for signature, verdict in zip(dist.get("signatures") or [], verdicts):
            key = keys.get(signature.get("keyid"))
            expired = bool(key and key.get("expires") and published_at and published_at > _instant(key["expires"]))
            if verdict == "invalid" or (verdict == "valid" and expired):
                signature_state = "invalid"
                break
            if verdict == "valid":
                verified_by.append(signature["keyid"])
                signature_state = "verified"
            elif verdict == "unknown-key" and signature_state == "missing":
                signature_state = "untrusted-key"
        if document:
            if signature_state == "invalid":
                findings.append(_finding("registry-signature-invalid", "npm registry signature does not verify"))
            elif signature_state != "verified":
                findings.append(_finding("registry-signature-missing", "no valid signature by a pinned npm registry key"
                                         + (" (signed by an unpinned key)" if signature_state == "untrusted-key" else "")))

        # License.
        archive_detected = None
        declared = document.get("license") if document else None
        if isinstance(declared, dict):
            declared = declared.get("type")
        category, license_detail = evaluate_license(declared, licenses) if document else ("missing", "no metadata")
        if document and category == "prohibited":
            findings.append(_finding("license-prohibited", license_detail))
        elif document and category == "review":
            findings.append(_finding("license-review", license_detail))
        elif document and category == "missing":
            # The registry declares nothing: read the archive's own license file before asking a person.
            directory = installed_directory(root, name, version)
            shipped = archive_license(directory) if directory is not None else None
            if shipped and license_category(shipped, licenses) == "allowed":
                archive_detected = shipped
                signals.append("license-from-archive")
            else:
                findings.append(_finding("license-missing", license_detail + (
                    "" if directory is not None else " (archive not installed: run after pnpm install to read its LICENSE)")))

        # Supply-chain risk (stateless: compared with this package's own prior release on the registry).
        install = _install_hooks(document, hooks) if document else {}
        prior_install = _install_hooks(prior, hooks) if prior else {}
        publisher = (document.get("_npmUser") or {}).get("name") if document else None
        prior_publisher = (prior.get("_npmUser") or {}).get("name") if prior else None
        attested = bool(dist.get("attestations"))
        prior_attested = bool(((prior or {}).get("dist") or {}).get("attestations"))
        first_release = bool(document) and prior is None
        publisher_changed = prior is not None and publisher != prior_publisher
        # A move to (or within) attested publishing from the same source is a security improvement, not a risk trigger:
        # the release carries npm provenance and is trusted-published or built from the prior release's repository.
        attested_same_source = attested and (bool((document.get("_npmUser") or {}).get("trustedPublisher"))
                                             or (prior is not None and _repository(document) and _repository(document) == _repository(prior)))
        provenance_dropped = prior_attested and not attested
        for hook, command in install.items():
            if DOWNLOAD_EXECUTE.search(command):
                findings.append(_finding("malicious-indicator", f"{hook} hook downloads and executes code: {command[:160]}"))
        if install and (first_release or not prior_install):
            findings.append(_finding("install-script-introduced", "install hook "
                                     + ", ".join(f"{h}: {c[:80]}" for h, c in install.items())
                                     + (" in the package's first release" if first_release else f" not present in {prior_version}")))
        if provenance_dropped and publisher_changed:
            findings.append(_finding("provenance-regression", f"{prior_version} had npm provenance from {prior_publisher}; "
                                     f"this release has none, published by {publisher}"))
        if install:
            signals.append("install-script-present")
        if first_release:
            signals.append("first-release")
        if publisher_changed:
            signals.append("publisher-changed")
        if provenance_dropped:
            signals.append("provenance-dropped")
        if published_at and now - published_at < recent_limit:
            signals.append("recently-published")
        typosquat = supply["typosquat"]
        unscoped = name.rsplit("/", 1)[-1]
        if name not in typosquat["protected_names"] and len(name) >= typosquat["min_name_length"]:
            for target in sorted(protected - {name}):  # a direct dependency is checked too (a typo'd one is "protected")
                if target.rsplit("/", 1)[-1] == unscoped:
                    continue  # @types/react and react are different packages, not one-letter look-alikes
                if _distance(name, target, typosquat["max_distance"]) <= typosquat["max_distance"]:
                    created = _instant((packument.get("time") or {}).get("created"))
                    established = (packument.get("version_count", 0) >= typosquat["established_min_versions"]
                                   and bool(created and published_at and published_at - created
                                            >= datetime.timedelta(days=typosquat["established_min_age_days"])))
                    if not established:
                        findings.append(_finding("typosquat-suspect", f"one edit from protected package {target}"))
                    else:
                        signals.append("similar-name-established")
                    break

        # Content scan only where a stateless trigger exists; recent publication only widens what is inspected.
        scan = None
        triggers = {"install-script-present", "first-release", "publisher-changed", "provenance-dropped", "recently-published"}
        if document and (triggers & set(signals) or any(f["code"] == "typosquat-suspect" for f in findings)):
            directory = installed_directory(root, name, version)
            if directory is None:
                store = (Path(root) / "node_modules" / ".pnpm").is_dir()
                scan = {"status": "not-installed" if store else "store-unavailable"}
            else:
                scan = {"status": "scanned", **capability_scan(directory, supply.get("capability_scan") or {})}
                caps = set(scan["capabilities"])
                strong = {"install-script-present", "first-release", "publisher-changed", "provenance-dropped"} & set(signals)
                if attested_same_source:
                    strong.discard("publisher-changed")
                if "credential-access" in caps and caps & {"network", "subprocess"} and strong:
                    findings.append(_finding("suspicious-capabilities", "credential access with "
                                             + "/".join(sorted(caps & {"network", "subprocess"})) + " in "
                                             + ", ".join(scan["files"].get("credential-access", [])[:3])))

        record = {"identity": identity, "name": name, "version": version, "source": policy["registry"]["tarball_host"],
                  "integrity": integrity, "license": {"declared": declared, "category": category, "archive": archive_detected},
                  "published": published, "publisher": publisher,
                  "provenance": {"registry_signature": signature_state, "verified_keys": verified_by,
                                 "npm_provenance_attestation": attested},
                  "install_hooks": install, "prior_release": prior_version, "signals": sorted(set(signals)),
                  "optional": graph.optional.get(identity, False),
                  "dependents": sorted(graph.parents.get(identity, set())), "advisories": audit.get(identity, [])}
        for advisory in record["advisories"]:
            if advisory["blocking"]:
                findings.append(_finding("vulnerability", f"{advisory['id']} ({advisory['severity']}): {advisory['title']}"))
        if scan is not None:
            record["capability_scan"] = scan
        if base_graph is not None:
            before = base_names.get(name)
            if not before:
                record["change"] = "added"
            elif version in before:
                record["change"] = "unchanged"
            else:
                # Compare with the base release of the same major line (a 7.x patch next to 8.x is an upgrade).
                same_line = [v for v in before if v.split(".", 1)[0] == version.split(".", 1)[0]] or list(before)
                nearest = max(same_line, key=_version_key)
                record["change"] = "upgraded" if _version_key(version) > _version_key(nearest) else "downgraded"
        else:
            record["change"] = "unknown (no baseline)"
        for finding in findings:
            if finding["decision"] != REVIEW:
                continue
            reasons = []
            for entry in exceptions:
                why = exception_matches(entry, identity, record, graph, finding["code"])
                if why is None:
                    finding["resolved_by"] = entry["id"]
                    used_exceptions.add(entry["id"])
                    break
                if why not in ("does not resolve " + finding["code"], "different identity", "different package"):
                    reasons.append(f"{entry['id']}: {why}")
            if "resolved_by" not in finding and reasons:
                finding["exception_mismatch"] = reasons
        record["findings"] = findings
        unresolved = [f for f in findings if "resolved_by" not in f]
        record["decision"] = max((f["decision"] for f in unresolved), key=RANK.get, default=PASS)
        records.append(record)

    for identity in audit:
        if identity not in graph.packages:
            raise EvidenceError("pnpm audit reported an advisory for an identity absent from pnpm-lock.yaml: " + identity)

    decision = max([r["decision"] for r in records] + [f["decision"] for f in global_findings], key=RANK.get, default=PASS)
    counts = {d: sum(1 for r in records if r["decision"] == d) for d in (PASS, REVIEW, BLOCK)}
    changes = {}
    for record in records:
        changes[record["change"]] = changes.get(record["change"], 0) + 1
    if base_graph is not None:
        removed = set(base_graph.identities()) - set(identities)
        replaced = {i for i in removed if split_identity(i)[0] in current_names}
        if removed - replaced:
            changes["removed"] = len(removed - replaced)
        if replaced:
            changes["replaced (prior version left the graph)"] = len(replaced)
    license_inventory = {}
    for record in records:
        key = record["license"]["declared"] if isinstance(record["license"]["declared"], str) else "NOASSERTION"
        license_inventory[key] = license_inventory.get(key, 0) + 1
    return {
        "kind": EVIDENCE_KIND, "schema_version": EVIDENCE_SCHEMA,
        "generated_at": now.isoformat().replace("+00:00", "Z"), "revision": revision,
        "policy": {"path": POLICY_PATH, "version": policy["version"], "sha256": policy_sha256,
                   "changed_in_revision": policy_changed},
        "lockfile": {"path": "pnpm-lock.yaml", "sha256": graph.sha256, "lockfileVersion": graph.version,
                     "registry_packages": len(identities), "snapshots": len(graph.snapshots),
                     "importers": sorted(graph.importers), "patched": sorted(graph.patched)},
        "release_age_minutes": release_age,
        "baseline": {"available": base_graph is not None, "lockfile_sha256": base_graph.sha256 if base_graph else None},
        "decision": decision,
        "summary": {"packages": len(identities), "decisions": counts, "changes": dict(sorted(changes.items())),
                    "licenses": dict(sorted(license_inventory.items())),
                    "advisories": sum(len(r["advisories"]) for r in records),
                    "registry_signatures_verified": sum(1 for r in records if r["provenance"]["registry_signature"] == "verified"),
                    "npm_provenance_attestations": sum(1 for r in records if r["provenance"]["npm_provenance_attestation"]),
                    "install_hooks": sorted(r["identity"] for r in records if r["install_hooks"]),
                    "exceptions_used": sorted(used_exceptions),
                    "exceptions_unused": sorted(e["id"] for e in exceptions if e["id"] not in used_exceptions)},
        "global_findings": global_findings,
        "packages": records,
    }


# ---------------------------------------------------------------------------------------------------------------------
# CI entry point
# ---------------------------------------------------------------------------------------------------------------------

def current_revision(root=ROOT):
    for variable in ("FLOFI_CI_REVISION", "CIRCLE_SHA1", "GITHUB_SHA"):
        if re.fullmatch(r"[0-9a-f]{40}", os.environ.get(variable, "")):
            return os.environ[variable]
    try:
        value = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        value = ""
    return value if re.fullmatch(r"[0-9a-f]{40}", value) else "UNKNOWN"


def extra_lockfiles(root):
    """Lockfiles other than the root pnpm-lock.yaml (per-branch or per-project) that pnpm could install from instead."""
    try:
        listed = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard"], cwd=root, capture_output=True,
                                text=True, timeout=60, check=True).stdout.splitlines()
    except (OSError, subprocess.SubprocessError):
        listed = [path.relative_to(root).as_posix() for path in Path(root).rglob("pnpm-lock*.yaml") if "node_modules" not in path.parts]
    return sorted(path for path in listed if re.fullmatch(r"(?:.*/)?pnpm-lock(?:\.[^/]+)?\.yaml", path) and path != "pnpm-lock.yaml")


def baseline(root, ref):
    """The lockfile at the merge base with ref, when git history has it; change classification only, never decisions."""
    try:
        base = subprocess.run(["git", "merge-base", "HEAD", ref], cwd=root, capture_output=True, text=True, timeout=30)
        if base.returncode != 0:
            return None, None
        commit = base.stdout.strip()
        lock = subprocess.run(["git", "show", f"{commit}:pnpm-lock.yaml"], cwd=root, capture_output=True, text=True, timeout=60)
        policy = subprocess.run(["git", "diff", "--quiet", commit, "--", POLICY_PATH], cwd=root, capture_output=True, timeout=30)
        return (Graph(lock.stdout) if lock.returncode == 0 else None), policy.returncode == 1
    except (OSError, subprocess.SubprocessError, ValueError, EvidenceError):
        return None, None


def report(evidence, stream=None):
    stream = stream or sys.stdout
    summary = evidence["summary"]
    print(f"Dependency security policy {evidence['policy']['version']} (sha256 {evidence['policy']['sha256'][:12]}) "
          f"at revision {evidence['revision']}", file=stream)
    print(f"Registry packages (computed from pnpm-lock.yaml): {summary['packages']}; decisions {summary['decisions']}; "
          f"changes {summary['changes']}", file=stream)
    print(f"Registry signatures verified: {summary['registry_signatures_verified']}/{summary['packages']}; "
          f"npm provenance attestations: {summary['npm_provenance_attestations']}; advisories: {summary['advisories']}; "
          f"install hooks: {summary['install_hooks'] or 'none'}", file=stream)
    print("License inventory:", summary["licenses"], file=stream)
    print("Exceptions used:", summary["exceptions_used"] or "none", "| unused (remove when convenient):",
          summary["exceptions_unused"] or "none", file=stream)
    if evidence["release_age_minutes"] not in (0, None):
        print("Note: pnpm-workspace.yaml sets minimumReleaseAge", evidence["release_age_minutes"], file=stream)
    if evidence["policy"].get("changed_in_revision"):
        print("NOTICE: this revision changes the dependency security policy; the owner reviews it in the PR.", file=stream)
    lines = []
    for finding in evidence["global_findings"]:
        lines.append((finding["decision"], "<configuration>", finding))
    for record in evidence["packages"]:
        for finding in record["findings"]:
            if "resolved_by" not in finding:
                lines.append((finding["decision"], record["identity"], finding))
    for decision, subject, finding in sorted(lines, key=lambda row: (-RANK[row[0]], row[1])):
        print(f"{decision} {subject}: {finding['code']}: {finding['detail']}", file=stream)
        print(f"  resolve: {REMEDIATION[finding['code']]}", file=stream)
        for reason in finding.get("exception_mismatch", []):
            print(f"  exception not applicable: {reason}", file=stream)
    print(f"Dependency security decision: {evidence['decision']}", file=stream)


def verify(root=ROOT, evidence_path=None, base_ref="origin/main", fetch=None, now=None):
    root = Path(root)
    policy, policy_sha256 = load_policy(root)
    if not (root / "pnpm-lock.yaml").is_file():
        raise EvidenceError("pnpm-lock.yaml missing")
    graph = Graph((root / "pnpm-lock.yaml").read_bytes())
    if graph.version != "9.0":
        raise EvidenceError("Unsupported lockfile version " + graph.version)
    workspace = parse_yaml(load_text(root, "pnpm-workspace.yaml") or "")
    identities = graph.identities()
    metadata = registry_metadata(identities, fetch=fetch)
    audit = advisories_by_identity(run_audit(root, registry=policy["registry"]["url"]), policy["vulnerabilities"]["block_at_or_above"])
    base_graph, policy_changed = baseline(root, base_ref) if base_ref else (None, None)
    evidence = evaluate(root, policy=policy, policy_sha256=policy_sha256, graph=graph, metadata=metadata, audit=audit,
                        base_graph=base_graph, policy_changed=policy_changed, now=now, revision=current_revision(root),
                        workspace=workspace, npmrc=load_text(root, ".npmrc"), extra_lockfiles=extra_lockfiles(root))
    destination = Path(evidence_path or Path(os.environ.get("RUNNER_TEMP", root)) / EVIDENCE_NAME)
    destination.write_text(json.dumps(evidence, indent=1, sort_keys=True) + "\n")
    report(evidence)
    print("Dependency evidence:", destination, "SHA-256", hashlib.sha256(destination.read_bytes()).hexdigest(), flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as summary:
            summary.write(f"Dependency security: {evidence['decision']} — {evidence['summary']['packages']} registry packages, "
                          f"{evidence['summary']['decisions']}\n")
    return evidence


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("verify", help="evaluate the locked graph and write evidence")
    run.add_argument("--evidence", help="evidence path (default: $RUNNER_TEMP/" + EVIDENCE_NAME + ")")
    run.add_argument("--base-ref", default="origin/main", help="git ref for change classification (decisions never depend on it)")
    commands.add_parser("check-policy", help="validate the policy file offline")
    args = parser.parse_args(argv)
    try:
        if args.command == "check-policy":
            policy, digest = load_policy(ROOT)
            print(f"Dependency policy {policy['version']} valid (sha256 {digest})")
            return 0
        evidence = verify(ROOT, args.evidence, args.base_ref or None)
    except (EvidenceError, ValueError, OSError) as exc:
        print("Dependency security evidence INVALID (certification must not pass):", exc, file=sys.stderr, flush=True)
        return 1
    return EXIT[evidence["decision"]]


if __name__ == "__main__":
    raise SystemExit(main())
