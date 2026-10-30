"""Adversarial ownership/evidence tests; discovered by every existing CI governance job."""

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("agent_guard", Path(__file__).with_name("agent_guard.py"))
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


class EngineeringGuard(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.paths = []
        self.data = {"version": 1, "suites": {"boundary": {
            "path": "packages/example/test/boundary.test.ts", "stage": "unit"},
            "pg-boundary": {"path": "packages/example/test/tenancy.pg.test.ts", "stage": "postgres"}},
            "requiredUnitSuites": ["boundary"], "requiredPostgresSuites": ["pg-boundary"], "modules": []}
        self.write("packages/example/test/boundary.test.ts", "// deterministic fixture\n")
        self.write("packages/example/test/tenancy.pg.test.ts", "// disposable PG fixture\n")
        for i, domain in enumerate(guard.DOMAINS):
            self.write(f".codex/agents/{domain}.toml", f'name = "{domain}"\ndescription = "Review"\ndeveloper_instructions = "Read-only"\n')
            path = f"packages/{domain}/src/index.ts"
            self.write(path, "// source\n")
            self.data["modules"].append({"id": domain, "primary": domain,
                "dependencies": [guard.DOMAINS[(i + 1) % len(guard.DOMAINS)]],
                "sources": [path], "suites": ["boundary"], "gaps": [],
                "sharedFinancialCore": domain == "flofi-workflow"})
        self.write(".codex/config.toml", "[agents]\nmax_concurrent_threads_per_session = 3\n")
        self.data["modules"][0]["sources"].append(".codex/config.toml")

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
        self.paths.append(path)

    def errors(self):
        return guard.validate(self.data, self.paths, self.root)

    def assert_error(self, text):
        self.assertIn(text, "\n".join(self.errors()))

    def test_complete_explicit_inventory_passes(self):
        self.assertEqual(self.errors(), [])

    def test_new_module_in_known_or_unknown_root_fails(self):
        for path in ["packages/flofi-swap/src/new.ts", "services/partner-api/index.ts", "new-runtime.py"]:
            self.write(path, "// not assigned\n")
            self.assert_error("Unmapped maintained source: " + path)

    def test_deleted_source_and_suite_fail(self):
        (self.root / self.data["modules"][0]["sources"][0]).unlink()
        (self.root / self.data["suites"]["boundary"]["path"]).unlink()
        self.assert_error("missing or unsafe source")
        self.assert_error("missing or unsafe suite")

    def test_reclassifying_source_as_documentation_or_fixture_does_not_leave_stale_inventory(self):
        self.data["modules"][0]["sources"].append("docs/stale.ts")
        self.write("docs/stale.ts", "")
        self.assert_error("Stale/non-production inventory entry")

    def test_duplicate_source_or_module_is_refused(self):
        self.data["modules"].append(copy.deepcopy(self.data["modules"][0]))
        self.assert_error("Duplicate or invalid module")
        self.assert_error("multiple primary owners")

    def test_missing_primary_and_unknown_domain_fail(self):
        self.data["modules"][0]["primary"] = "flofi-invented"
        self.assert_error("unknown primary domain")
        self.assert_error("Domains without primary ownership")

    def test_dependencies_must_be_known_disjoint_and_unique(self):
        for dependencies in [[], ["flofi-invented"], ["flofi-swap"], ["flofi-chat", "flofi-chat"]]:
            self.data["modules"][0]["dependencies"] = dependencies
            self.assert_error("invalid cross-domain dependencies")

    def test_unknown_or_missing_tests_cannot_silently_claim_coverage(self):
        # A module may have an honest gap while its domain still has required
        # behavior coverage in another maintained module.
        other = copy.deepcopy(self.data["modules"][0])
        other.update(id="swap-covered-boundary", sources=["packages/another-swap/src/index.ts"])
        self.write(other["sources"][0], "// covered module\n")
        self.data["modules"].append(other)
        self.data["modules"][0]["suites"] = ["invented"]
        self.assert_error("unknown suite references")
        self.data["modules"][0]["suites"] = []
        self.assert_error("tests or explicit coverage gap required")
        self.data["modules"][0]["gaps"] = ["No deterministic module test exists; review required."]
        self.assertEqual(self.errors(), [])
        self.assertIn("Modules with no mapped deterministic suite: flofi-swap.", guard.coverage_report(self.data))

    def test_required_list_cannot_be_empty_duplicated_unknown_or_nonunit(self):
        for required in [[], ["boundary", "boundary"], ["missing"]]:
            self.data["requiredUnitSuites"] = required
            self.assertTrue(self.errors())
        self.data["requiredUnitSuites"] = ["boundary"]
        self.data["suites"]["boundary"]["stage"] = "fork"
        self.assert_error("must belong to the unit stage")

    def test_required_postgres_contract_cannot_be_empty_or_misclassified(self):
        self.data["requiredPostgresSuites"] = []
        self.assert_error("Required postgres regression suite list is empty")
        self.data["requiredPostgresSuites"] = ["boundary"]
        self.assert_error("must belong to the postgres stage")

    def test_suite_cannot_claim_a_runner_that_excludes_it(self):
        self.data["suites"]["boundary"]["path"] = "packages/example/test/owner.live.test.ts"
        self.write("packages/example/test/owner.live.test.ts", "// optional provider acceptance\n")
        self.assert_error("outside the unit runner's selection")

    def test_each_product_domain_retains_a_required_unit_regression(self):
        self.data["modules"][0]["suites"] = []
        self.data["modules"][0]["gaps"] = ["Known missing source-level test"]
        self.assert_error("Domains without required unit regressions")

    def test_unsafe_source_and_suite_paths_fail_closed(self):
        for path in ["/tmp/source", "../source", "packages/../source", "bad\\source"]:
            self.data["modules"][0]["sources"] = [path]
            self.data["suites"]["boundary"]["path"] = path
            self.assert_error("missing or unsafe source")
            self.assert_error("missing or unsafe suite")

    def test_symlink_is_not_a_source_or_suite(self):
        target = self.root / "outside.ts"
        target.write_text("// outside inventory\n")
        for path in [self.data["modules"][0]["sources"][0], self.data["suites"]["boundary"]["path"]]:
            (self.root / path).unlink()
            (self.root / path).symlink_to(target)
        self.assert_error("missing or unsafe source")
        self.assert_error("missing or unsafe suite")

    def test_exact_agent_schema_and_domain_inventory(self):
        path = f".codex/agents/{guard.DOMAINS[0]}.toml"
        for body in ['name = "flofi-swap"\n', 'name = [broken', 'name = "unknown"\ndescription = ""\ndeveloper_instructions = "Review"\n']:
            (self.root / path).write_text(body)
            self.assertTrue(self.errors())

    def test_legacy_combined_mcp_channels_agent_is_refused(self):
        self.write(".codex/agents/flofi-mcp-channels.toml", 'name = "flofi-mcp-channels"\ndescription = "Review"\ndeveloper_instructions = "Review"\n')
        self.assert_error("exactly the 19 FloFi domains")

    def test_concurrency_cap_is_checked(self):
        (self.root / ".codex/config.toml").write_text("[agents]\nmax_concurrent_threads_per_session = 19\n")
        self.assert_error("bounded agent pool")

    def test_shared_core_impact_expands_across_financial_and_consumer_boundaries(self):
        module = next(m for m in self.data["modules"] if m["primary"] == "flofi-workflow")
        plan = guard.impact(self.data, module["sources"])
        for domain in ["flofi-workflow", "flofi-security", "flofi-swap", "flofi-bridge", "flofi-mcp", "flofi-developers", "flofi-channels", "flofi-automations"]:
            self.assertIn(domain, plan["domains"])
        self.assertEqual(plan["maxConcurrentSubagents"], 3)
        self.assertEqual(plan["unmapped"], [])

    def test_selective_impact_and_unmapped_sensitive_change(self):
        plan = guard.impact(self.data, self.data["modules"][0]["sources"][:1])
        self.assertEqual(plan["domains"], ["flofi-bridge", "flofi-swap"])
        self.assertEqual(guard.impact(self.data, ["new-service/api.ts"])["unmapped"], ["new-service/api.ts"])

    def test_changes_to_mapped_tests_select_their_owners(self):
        plan = guard.impact(self.data, [self.data["suites"]["boundary"]["path"]])
        self.assertEqual(set(plan["domains"]), set(guard.DOMAINS))

    def test_manifest_or_governance_change_requires_all_ownership_review(self):
        for path in [guard.MANIFEST, "AGENTS.md", "CLAUDE.md", "docs/SCOPE_GUARD.md"]:
            self.assertEqual(set(guard.impact(self.data, [path])["domains"]), set(guard.DOMAINS))

    def test_agent_instruction_change_selects_domain_and_infrastructure_review(self):
        plan = guard.impact(self.data, [".codex/agents/flofi-mcp.toml"])
        self.assertEqual(plan["domains"], ["flofi-infrastructure-ci", "flofi-mcp"])

    def test_production_universe_includes_routes_sql_assets_config_and_unknown_roots(self):
        for path in ["apps/reference-dapp/src/app/api/new/route.ts", "packages/cloud-runtime/migrations/new.sql",
                     "apps/reference-dapp/public/new.png", ".github/workflows/new.yml", "backend/main.go",
                     "docs/developer/openapi.json", "docs/security/new-policy.json"]:
            self.assertTrue(guard.maintained(path), path)
        for path in ["docs/report.md", "apps/reference-dapp/src/a.test.ts", "packages/example/test/fixtures/a.json"]:
            self.assertFalse(guard.maintained(path), path)

    def report(self, stage="unit"):
        return {"success": True, "testResults": [{
            "name": str(self.root / self.data["suites"]["pg-boundary" if stage == "postgres" else "boundary"]["path"]), "status": "passed",
            "assertionResults": [{"status": "passed", "fullName": "required contract"}]}]}

    def test_real_passing_required_result_is_accepted(self):
        self.assertEqual(guard.verify_results(self.data, self.report(), self.root), [])

    def test_postgres_identity_contracts_must_run_and_cannot_skip(self):
        report = self.report("postgres")
        self.assertEqual(guard.verify_results(self.data, report, self.root, stage="postgres"), [])
        self.assertTrue(guard.verify_results(self.data, self.report(), self.root, stage="postgres"))
        report["testResults"][0]["assertionResults"][0]["status"] = "pending"
        self.assertTrue(guard.verify_results(self.data, report, self.root, stage="postgres"))

    def test_missing_duplicate_and_zero_test_suite_fail(self):
        for change in ["missing", "duplicate", "zero"]:
            report = self.report()
            if change == "missing": report["testResults"] = []
            elif change == "duplicate": report["testResults"] *= 2
            else: report["testResults"][0]["assertionResults"] = []
            self.assertTrue(guard.verify_results(self.data, report, self.root), change)

    def test_failed_skipped_todo_pending_disabled_required_cases_never_pass(self):
        for status in ["failed", "skipped", "pending", "todo", "disabled", None]:
            report = self.report()
            report["testResults"][0]["assertionResults"][0]["status"] = status
            self.assertTrue(guard.verify_results(self.data, report, self.root), status)

    def test_unsuccessful_run_and_failed_suite_never_pass(self):
        report = self.report()
        report["success"] = False
        self.assertTrue(guard.verify_results(self.data, report, self.root))
        report = self.report()
        report["testResults"][0]["status"] = "failed"
        self.assertTrue(guard.verify_results(self.data, report, self.root))

    def test_report_is_deterministic_and_surfaces_evidence_limit(self):
        self.assertEqual(guard.coverage_report(self.data), guard.coverage_report(copy.deepcopy(self.data)))
        self.assertIn("not claims of passing tests", guard.coverage_report(self.data))

    def test_repository_dispatch_contracts_cover_sensitive_boundaries(self):
        data = guard.load()
        boundaries = {
            "apps/reference-dapp/src/app/api/payments/woovi/webhook/route.ts": ["flofi-payments-billing", "flofi-security"],
            "apps/reference-dapp/src/app/card-action.ts": ["flofi-payments-billing"],
            "apps/reference-dapp/src/components/card-secure-fields.ts": ["flofi-payments-billing", "flofi-security"],
            "packages/cloud-runtime/src/db.ts": ["flofi-data-privacy", "flofi-workflow"],
            "packages/workflow-contracts/src/semantic-workflow.ts": ["flofi-chat", "flofi-workflow", "flofi-mcp", "flofi-frontend-ux"],
            "apps/reference-dapp/src/channels/learning-runtime.ts": ["flofi-data-privacy", "flofi-channels"],
            "docs/developer/openapi.json": ["flofi-developers"],
            "docs/security/COLOSSEUM-DEPENDENCY-AGE-WAIVER.json": ["flofi-security", "flofi-infrastructure-ci"],
        }
        for path, expected in boundaries.items():
            with self.subTest(path=path):
                plan = guard.impact(data, [path])
                self.assertEqual(plan["unmapped"], [])
                self.assertTrue(set(expected) <= set(plan["domains"]), plan)
        direct_suites = {
            "packages/cloud-runtime/src/db.ts": "packages/cloud-runtime/test/storage.pg.test.ts",
            "apps/reference-dapp/src/workflow-runs/service.ts": "apps/reference-dapp/src/workflow-runs/confirm-run.pg.test.ts",
            "apps/reference-dapp/src/channels/learning-runtime.ts": "apps/reference-dapp/src/channels/telegram/learning.pg.test.ts",
        }
        for path, expected_suite in direct_suites.items():
            plan = guard.impact(data, [path])
            self.assertIn(expected_suite, [data["suites"][name]["path"] for name in plan["suites"]])


if __name__ == "__main__":
    unittest.main()
