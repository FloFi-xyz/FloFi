#!/usr/bin/env python3
"""Canonical CycloneDX 1.6 SBOM gate shared by CircleCI, GitHub Actions and Cloud Build (scripts/ci-sbom.sh).

The expected inventory is computed, never pinned: pnpm-lock.yaml gives the registry identities, their integrities,
the importers and the graph; the dependency security evidence (scripts/dependency_security.py) gives each package's
registry-declared license and must be a PASS for this exact revision, lockfile and policy. The SBOM is removed after
validation whether it passes or fails.

pnpm 11.22.0 writes no workspace components and lists each component's dependency edges once per traversal, so the
graph check requires: every SBOM edge exists in the lockfile, the root edges equal the importers' direct registry
dependencies, and every component is reachable from the root.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import sys

from dependency_security import (EVIDENCE_KIND, EVIDENCE_NAME, EVIDENCE_SCHEMA, PASS, POLICY_PATH, ROOT, Graph,
                                 current_revision, dependency_identity, parse_yaml, split_identity, workspace_manifests)


class SbomError(RuntimeError):
    pass


def purl(identity):
    name, version = split_identity(identity)
    return "pkg:npm/" + name.replace("@", "%40", 1) + "@" + version


def component_identity(component):
    group = component.get("group")
    return (group + "/" if group else "") + str(component.get("name", "")) + "@" + str(component.get("version", ""))


def license_value(expression):
    if expression is None:
        return None
    if " AND " in expression or " OR " in expression or " WITH " in expression:
        return [{"expression": expression}]
    return [{"license": {"id": expression}}]


def load_evidence(path, root, graph):
    """Fail unless the evidence is a PASS for this revision, this lockfile and this policy (no stale or foreign evidence)."""
    try:
        evidence = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        raise SbomError("Dependency security evidence missing or unreadable: run scripts/dependency_security.py verify first") from None
    policy_sha256 = hashlib.sha256((Path(root) / POLICY_PATH).read_bytes()).hexdigest()
    checks = {
        "kind": evidence.get("kind") == EVIDENCE_KIND and evidence.get("schema_version") == EVIDENCE_SCHEMA,
        "decision": evidence.get("decision") == PASS,
        "revision": evidence.get("revision") == current_revision(root) and evidence.get("revision") != "UNKNOWN",
        "lockfile": (evidence.get("lockfile") or {}).get("sha256") == graph.sha256,
        "policy": (evidence.get("policy") or {}).get("sha256") == policy_sha256,
        "packages": isinstance(evidence.get("packages"), list),
    }
    failed = [name for name, ok in checks.items() if not ok]
    if failed:
        raise SbomError("Dependency security evidence is not valid for this revision: " + ", ".join(failed))
    records = {}
    for record in evidence["packages"]:
        if record.get("decision") != PASS or record.get("identity") in records:
            raise SbomError("Dependency evidence package is not a unique PASS: " + str(record.get("identity")))
        records[record["identity"]] = record
    if set(records) != set(graph.identities()):
        raise SbomError("Dependency evidence does not cover exactly the locked registry packages")
    return evidence, records


def validate(sbom_path, evidence_path, root=ROOT, summary=None):
    root = Path(root)
    graph = Graph((root / "pnpm-lock.yaml").read_text())
    evidence, records = load_evidence(evidence_path, root, graph)
    expected = set(graph.identities())
    document = json.loads(Path(sbom_path).read_text())
    if document.get("bomFormat") != "CycloneDX" or document.get("specVersion") != "1.6":
        raise SbomError("Unexpected SBOM format or version")
    components = document.get("components")
    if not isinstance(components, list):
        raise SbomError("SBOM components missing")

    # Inventory: exactly the locked registry identities, each once, with the lockfile's integrity and registry source.
    seen, references = {}, {}
    for component in components:
        identity = component_identity(component)
        if identity not in expected:
            raise SbomError("SBOM component absent from pnpm-lock.yaml: " + identity)
        if identity in seen:
            raise SbomError("Duplicate SBOM component: " + identity)
        reference = component.get("bom-ref")
        if reference != purl(identity) or component.get("purl") != purl(identity) or reference in references:
            raise SbomError("SBOM component reference differs from its package URL: " + identity)
        integrity = graph.integrity(identity)
        digests = [h.get("content") for ref in component.get("externalReferences") or []
                   if ref.get("type") == "distribution" and str(ref.get("url", "")).startswith("https://registry.npmjs.org/")
                   for h in ref.get("hashes") or [] if h.get("alg") == "SHA-512"]
        if digests != [base64.b64decode(integrity.removeprefix("sha512-")).hex()]:
            raise SbomError("SBOM integrity or registry source differs from pnpm-lock.yaml: " + identity)
        seen[identity] = component
        references[reference] = identity
    missing = sorted(expected - set(seen))
    if missing:
        raise SbomError(f"SBOM omits {len(missing)} locked component(s): " + ", ".join(missing[:10]))

    # Licenses: the registry-declared expression recorded by the dependency evidence (none for a reviewed undeclared one).
    for identity, component in seen.items():
        declared = records[identity]["license"]["declared"]
        value = license_value(declared if isinstance(declared, str) else None)
        if value is None:
            component.pop("licenses", None)
        else:
            component["licenses"] = value

    # Root and workspace importers, derived from the manifests (no fixed list).
    manifest = json.loads((root / "package.json").read_text())
    root_component = (document.get("metadata") or {}).get("component") or {}
    if (root_component.get("name"), root_component.get("version"), root_component.get("licenses")) != (
            manifest.get("name"), manifest.get("version"), license_value(manifest.get("license"))):
        raise SbomError("SBOM root identity or license differs from package.json")
    root_ref = root_component.get("bom-ref")
    if not root_ref or root_ref in references:
        raise SbomError("SBOM root reference missing or reused")
    workspace = parse_yaml((root / "pnpm-workspace.yaml").read_text())
    manifests = workspace_manifests(root, workspace)
    if set(manifests) != set(graph.importers):
        raise SbomError("Workspace manifests differ from lock importers: "
                        f"{sorted(set(manifests) ^ set(graph.importers))}")
    workspace_names = {m.get("name") for m in manifests.values()}
    if any(component_identity(c).rpartition("@")[0] in workspace_names for c in components):
        raise SbomError("A workspace package appears as a registry component")

    # Graph: every edge is a lockfile edge, the root edges are the direct registry dependencies, nothing is orphaned.
    dependencies = document.get("dependencies")
    if not isinstance(dependencies, list):
        raise SbomError("SBOM dependency graph missing")
    edges = {}
    for entry in dependencies:
        reference, targets = entry.get("ref"), entry.get("dependsOn", [])
        if reference in edges or (reference not in references and reference != root_ref):
            raise SbomError("SBOM dependency reference inventory differs: " + str(reference))
        if not isinstance(targets, list) or len(targets) != len(set(targets)) or set(targets) - set(references):
            raise SbomError("Invalid SBOM dependency references from " + str(reference))
        edges[reference] = set(targets)
    if set(edges) != set(references) | {root_ref}:
        raise SbomError("SBOM dependency graph does not list every component")
    for reference, targets in edges.items():
        if reference == root_ref:
            continue
        allowed = {purl(child) for child in graph.children.get(references[reference], set())}
        if targets - allowed:
            raise SbomError(f"SBOM edge absent from pnpm-lock.yaml: {references[reference]} -> {sorted(targets - allowed)[:3]}")
    direct = set()
    for importer in graph.direct.values():
        for name, entry in importer.items():
            child = dependency_identity(name, entry["version"])
            if child:
                direct.add(purl(child))
    if edges[root_ref] != direct:
        raise SbomError("SBOM root dependencies differ from the importers' direct registry dependencies")
    reachable, stack = set(), [root_ref]
    while stack:
        for target in edges.get(stack.pop(), ()):
            if target not in reachable:
                reachable.add(target)
                stack.append(target)
    if reachable != set(references):
        raise SbomError(f"SBOM components unreachable from the root: {len(set(references) - reachable)}")

    # Rewrite with reconciled licenses, read back and check every expression survived.
    raw = (json.dumps(document, indent=2, sort_keys=True) + "\n").encode()
    Path(sbom_path).write_bytes(raw)
    for component in json.loads(Path(sbom_path).read_text())["components"]:
        identity = component_identity(component)
        value = component.get("licenses", [{}])[0]
        actual = value.get("expression", value.get("license", {}).get("id"))
        declared = records[identity]["license"]["declared"]
        if actual != (declared if isinstance(declared, str) else None):
            raise SbomError("SBOM license expression changed: " + identity)
    excepted = sorted({f["resolved_by"] for r in records.values() for f in r.get("findings", []) if "resolved_by" in f})
    message = (f"Ephemeral CycloneDX 1.6 SBOM: {len(seen)} registry components = pnpm-lock.yaml (computed), "
               f"{len(manifests)} workspace importers checked from manifests, {sum(len(t) for t in edges.values())} edges "
               f"all in the lockfile, every component reachable, licenses from dependency evidence {evidence['policy']['version']} "
               f"(exceptions {', '.join(excepted) or 'none'}), SHA-256 {hashlib.sha256(raw).hexdigest()}")
    print(message, flush=True)
    summary = summary or os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as stream:
            stream.write(message + "\n")
    return message


def main(argv=None):
    temp = Path(os.environ.get("RUNNER_TEMP", "."))
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("sbom", nargs="?", default=str(temp / "flofi-sbom.cdx.json"))
    parser.add_argument("evidence", nargs="?", default=str(temp / EVIDENCE_NAME))
    parser.add_argument("--root", default=str(ROOT), help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        validate(args.sbom, args.evidence, root=args.root)
    except (SbomError, OSError, ValueError, KeyError, TypeError) as exc:
        print("SBOM validation FAILED:", exc, file=sys.stderr, flush=True)
        return 1
    finally:
        Path(args.sbom).unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
