"""Offline regression tests for the advisory Agent Evolution report."""

import datetime as dt
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import agent_evolution as evolution
import agent_guard as guard
import skill_registry as registry


class AgentEvolutionTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.today = dt.date(2026, 11, 18)
        self.git("init", "-q")
        for directory in (".codex/agents", ".claude/agents", "skills"):
            shutil.copytree(guard.ROOT / directory, self.root / directory)
        self.source = "packages/action-registry/src/execution-capabilities.ts"
        self.suite = "packages/action-registry/test/execution-capabilities.test.ts"
        self.data = {
            "modules": [{"id": "core", "primary": "flofi-workflow", "dependencies": ["flofi-security"],
                         "sources": [self.source], "suites": ["core.test"], "gaps": ["Hosted acceptance"]},
                        {"id": "skills", "primary": "flofi-infrastructure-ci",
                         "dependencies": ["flofi-protocol-integrations"],
                         "sources": [str(path.relative_to(self.root)) for path in sorted((self.root / "skills").rglob("*.json"))],
                         "suites": [], "gaps": []}],
            "suites": {"core.test": {"path": self.suite}},
        }
        self.write(guard.MANIFEST, json.dumps(self.data))
        self.write(self.source, "registered action\n")
        self.write(self.suite, "registered suite\n")
        self.git("add", ".")
        self.git("-c", "user.email=ci@example.invalid", "-c", "user.name=CI", "commit", "-qm", "baseline")
        self.base = self.git("rev-parse", "HEAD").strip()

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, text=True)

    def write(self, path, body):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body)

    def assess(self):
        return evolution.assess(self.root, self.base, self.today)

    def test_clean_diff_does_not_claim_weekly_review(self):
        report = self.assess()
        self.assertEqual("no-signal", report["maintenance"])
        self.assertEqual(self.base, report["comparisonBase"])
        self.assertFalse(report["upstreamReportProvided"])

    def test_renamed_capability_exposes_both_paths_and_ownership_gap(self):
        renamed = "packages/action-registry/src/new-network.ts"
        self.git("mv", self.source, renamed)
        self.assertEqual("review-required", self.assess()["maintenance"])
        report = self.assess()
        self.assertEqual([self.source, renamed], report["capabilityCandidates"])
        self.assertEqual([renamed], report["capabilityCandidatesWithoutSkillMatch"])
        self.assertEqual([renamed], report["missingOwners"])
        self.assertEqual([self.source], report["staleOwners"])
        self.assertEqual(["flofi-security", "flofi-workflow"], report["affectedDomains"])
        self.assertIn("operations/execution", report["suggestedSkills"])

    def test_regression_removal_and_unlinked_replacement_are_visible(self):
        (self.root / self.suite).unlink()
        replacement = "packages/action-registry/test/recovery.test.ts"
        self.write(replacement, "replacement test\n")
        report = self.assess()
        self.assertEqual([self.suite], report["missingSuites"])
        self.assertEqual([replacement], report["unlinkedChangedTests"])
        self.assertEqual({"core": ["Hosted acceptance"]}, report["coverageGaps"])

    def test_ownership_only_change_exposes_old_and_new_reviews(self):
        self.data["modules"][0]["primary"] = "flofi-wallet-execution"
        self.write(guard.MANIFEST, json.dumps(self.data))
        report = self.assess()
        self.assertEqual(["core"], report["inventoryChanges"])
        self.assertEqual(["flofi-security", "flofi-wallet-execution", "flofi-workflow"], report["affectedDomains"])

    def test_required_suite_change_identifies_affected_domain(self):
        self.data["requiredUnitSuites"] = ["core.test"]
        self.write(guard.MANIFEST, json.dumps(self.data))
        report = self.assess()
        self.assertEqual({"requiredUnitSuites": {"added": ["core.test"], "removed": []}},
                         report["requiredSuiteChanges"])
        self.assertEqual(["flofi-security", "flofi-workflow"], report["affectedDomains"])

    def test_engineering_instruction_changes_prompt_review(self):
        self.write("CLAUDE.md", "updated project instructions\n")
        self.write("docs/DECISIONS.md", "changed design decision\n")
        report = self.assess()
        self.assertEqual("review-required", report["maintenance"])
        self.assertEqual(["CLAUDE.md", "docs/DECISIONS.md"], report["engineeringDocChanges"])

    def test_inventory_reports_parity_staleness_and_upstream_results_without_editing(self):
        twin = ".claude/agents/flofi-swap.md"
        self.write(twin, "out of sync\n")
        _, skills = registry.load(self.root)
        url = skills["operations/execution"]["sources"][0]["url"]
        report = evolution.assess(self.root, None, dt.date(2028, 1, 1), [
            {"skill": "operations/execution", "url": url, "state": "CHANGED"},
        ])
        self.assertEqual("inventory", report["mode"])
        self.assertEqual("drift", report["claudeParity"])
        self.assertIn(f"operations/execution: CHANGED {url}", report["upstreamActions"])
        self.assertIn("flofi-wallet-execution", report["skillReviewDomains"]["operations/execution"])
        self.assertTrue(any("days old" in note for note in report["skillReviewNotes"]))
        self.assertEqual("out of sync\n", (self.root / twin).read_text())

    def test_role_inventory_reports_missing_or_extra_definitions_as_drift(self):
        extra = ".claude/agents/flofi-extra.md"
        self.write(extra, "extra definition\n")
        self.assertEqual("drift", self.assess()["claudeParity"])
        (self.root / extra).unlink()
        (self.root / ".codex/agents/flofi-swap.toml").unlink()
        self.assertEqual("drift", self.assess()["claudeParity"])

    def test_circleci_reports_with_local_base_without_gating_certification(self):
        config = (guard.ROOT / ".circleci/config.yml").read_text()
        governance = config.split("  governance:\n", 1)[1].split("  certification-build:\n", 1)[0]
        self.assertLess(governance.index("git fetch --no-tags origin main"),
                        governance.index('if ! python3 scripts/agent_evolution.py --base "$base"; then'))
        self.assertIn("base=FETCH_HEAD", governance)
        self.assertIn('= main ]; then base=HEAD^1;', governance)
        self.assertNotIn("--fetch;", governance)


if __name__ == "__main__":
    unittest.main()
