"""Claude Code hook contracts: Read-only reviewer guard and non-sensitive lifecycle ledger.

Runs in every existing governance job; uses a disposable Git repository and never
starts Claude Code, a model, the network or a financial operation.
"""

import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest

HOOK = Path(__file__).resolve().parents[1] / ".claude/hooks/flofi_agent_hooks.py"
SPEC = importlib.util.spec_from_file_location("flofi_agent_hooks", HOOK)
hooks = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(hooks)
SESSION = "0f6c7a52-3b1e-4a7e-9d61-6d5f1c2b9a10"


class Repository(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name, "repo")
        self.outside = Path(scratch.name, "outside")
        self.outside.mkdir()
        (self.outside / "secret.txt").write_text("outside\n")
        files = {".gitignore": ".env*\n!.env.example\n.mode-a/\nnode_modules/\nlocal-state/\n.claude/flofi-agent-runs/\n",
                 "CLAUDE.md": "rules\n", "src/a.ts": "export const a = 1;\n", "src/b.test.ts": "test\n",
                 ".env.example": "EXAMPLE=1\n", ".env.local": "LOCAL=1\n", ".mode-a/journal": "state\n",
                 "local-state/notes": "ignored\n", "node_modules/pkg/index.js": "module\n",
                 "scripts/agent_guard.py": "# guard\n", ".claude/agents/flofi-swap.md": "---\nname: flofi-swap\n---\n"}
        for path, body in files.items():
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            (self.root / path).write_text(body)
        (self.root / "src/link.ts").symlink_to(self.outside / "secret.txt")
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)

    def guard(self, tool="Bash", agent="flofi-swap", **tool_input):
        return hooks.guard_reason({"agent_type": agent, "tool_name": tool, "tool_input": tool_input,
                                   "cwd": str(self.root)}, self.root)


class ReadOnlyGuard(Repository):
    """Specialists have no shell: only Read, under a fail-closed path rule."""

    def read(self, path, agent="flofi-swap"):
        return self.guard("Read", agent=agent, file_path=path)

    def test_main_session_and_other_agents_are_never_restricted(self):
        for agent in [None, "", "Explore", "general-purpose", "security-reviewer"]:
            with self.subTest(agent=agent):
                self.assertIsNone(self.guard(agent=agent, command="git push origin HEAD"))
                self.assertIsNone(self.guard("Edit", agent=agent, file_path="src/a.ts"))

    def test_every_tool_except_read_is_denied_to_specialists(self):
        for tool in ["Bash", "Grep", "Glob", "Edit", "Write", "NotebookEdit", "Agent", "Task", "WebFetch", "WebSearch",
                     "SendMessage", "EnterWorktree", "Monitor", "ToolSearch", "Skill", "mcp__github__create_pull_request",
                     "mcp__claude_ai_Flofi__authenticate", None, ""]:
            with self.subTest(tool=tool):
                self.assertIn("not available to FloFi reviewers", self.guard(tool, command="git status", file_path="src/a.ts"))

    def test_read_is_allowed_for_repository_files(self):
        for path in [str(self.root / "src/a.ts"), "src/a.ts", "CLAUDE.md", ".env.example", str(self.root / "src"),
                     str(self.root / "src" / "." / "a.ts")]:
            with self.subTest(path=path):
                self.assertIsNone(self.read(path))

    def test_read_outside_scope_is_denied(self):
        (self.root / "src/inner-link.ts").symlink_to(self.root / ".env.local")
        (self.root / "docs").mkdir()
        (self.root / "docs/.GIT").mkdir()
        for path in ["/etc/hostname", str(self.outside / "secret.txt"), "../outside/secret.txt",
                     str(self.root / ".." / "outside" / "secret.txt"), str(self.root / "src/../.env.local"),
                     "~/.ssh/id_rsa", "~", ".env.local", str(self.root / ".env.local"), ".git/config", ".GIT/config",
                     "docs/.GIT/x", ".mode-a/journal", "local-state/notes", "node_modules/pkg/index.js", "src/link.ts",
                     "src/inner-link.ts", "deploy/key.pem", "keys/id_ed25519", ".claude/flofi-agent-runs/s.jsonl",
                     "", None, 5, "a\0b"]:
            with self.subTest(path=path):
                self.assertIsNotNone(self.read(path))

    def test_overlong_or_odd_paths_are_decided_without_crashing(self):
        for path in ["a" * 300, "/".join(["b" * 255] * 20), str(self.root) + "/" + "c" * 5000]:
            with self.subTest(length=len(path)):
                self.read(path)

    def test_internal_errors_and_unreadable_input_deny_without_relying_on_onfailure(self):
        original = hooks.guard_reason
        self.addCleanup(setattr, hooks, "guard_reason", original)

        def broken(*_args):
            raise OSError("simulated")
        hooks.guard_reason = broken
        decision = hooks.guard({"agent_type": "flofi-swap", "tool_name": "Read", "tool_input": {"file_path": "x"}}, self.root)
        self.assertEqual(decision["hookSpecificOutput"]["permissionDecision"], "deny")
        hooks.guard_reason = original
        for event in [None, [], "text"]:
            self.assertEqual(hooks.guard(event, self.root)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_cli_returns_a_deny_decision_only_for_flofi_reviewers(self):
        def run(event):
            return subprocess.run([sys.executable, "-I", str(HOOK), "guard"], input=json.dumps(event), text=True,
                                  capture_output=True, timeout=15)
        denied = run({"agent_type": "flofi-security", "tool_name": "Bash", "tool_input": {"command": "git status"}})
        self.assertEqual(denied.returncode, 0)
        decision = json.loads(denied.stdout)["hookSpecificOutput"]
        self.assertEqual((decision["hookEventName"], decision["permissionDecision"]), ("PreToolUse", "deny"))
        self.assertIn("FloFi read-only review guard", decision["permissionDecisionReason"])
        allowed = run({"tool_name": "Bash", "tool_input": {"command": "git push"}})
        self.assertEqual((allowed.returncode, allowed.stdout), (0, ""))

    def test_cli_denies_malformed_input_explicitly(self):
        for body in ["", "{broken", "[]"]:
            with self.subTest(body=body):
                result = subprocess.run([sys.executable, "-I", str(HOOK), "guard"], input=body, text=True,
                                        capture_output=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")

    def test_the_command_parsing_layer_is_gone(self):
        for name in ["pipeline_words", "parse_options", "segment_reason", "bash_reason", "COMMANDS", "GIT"]:
            self.assertFalse(hasattr(hooks, name), name)


class LifecycleLedger(Repository):
    def ledger(self, session=SESSION):
        path = self.root / hooks.RUNS / f"{session}.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def record(self, **event):
        hooks.record({"session_id": SESSION, "transcript_path": "/home/user/.claude/projects/x.jsonl",
                      "cwd": str(self.root), **event}, self.root)

    def test_session_start_records_defined_agents_with_private_permissions(self):
        self.record(hook_event_name="SessionStart", source="startup")
        row = self.ledger()[0]
        self.assertEqual((row["event"], row["source"], list(row["definitions"])), ("session_start", "startup", ["flofi-swap"]))
        runs = self.root / hooks.RUNS
        self.assertEqual(stat.S_IMODE(runs.stat().st_mode) & 0o077, 0)
        self.assertEqual(stat.S_IMODE((runs / f"{SESSION}.jsonl").stat().st_mode) & 0o077, 0)

    def test_subagent_lifecycle_keeps_only_validated_identity_and_result(self):
        secret = "seed phrase abandon ability able about above absent absorb abstract absurd abuse access accident"
        message = (f"Findings mention {secret} and the user prompt.\n```\nFLOFI_REVIEW_RESULT "
                   '{"domain":"flofi-swap","result":"findings","findings":2,"highest":"high"}\n```')
        self.record(hook_event_name="SubagentStart", agent_type="flofi-swap", agent_id="a1b2c3", prompt=secret)
        self.record(hook_event_name="SubagentStop", agent_type="flofi-swap", agent_id="a1b2c3",
                    agent_transcript_path="/home/user/secret.jsonl", last_assistant_message=message)
        start, stop = self.ledger()
        self.assertEqual({k: start[k] for k in ("event", "agent", "agentId")},
                         {"event": "subagent_start", "agent": "flofi-swap", "agentId": "a1b2c3"})
        self.assertEqual(stop["review"], {"result": "findings", "findings": 2, "highest": "high"})
        raw = (self.root / hooks.RUNS / f"{SESSION}.jsonl").read_text()
        for leaked in [secret, "user prompt", "secret.jsonl", "/home/user", "transcript"]:
            self.assertNotIn(leaked, raw)

    def test_untrusted_result_trailers_are_never_promoted(self):
        for message in [None, "", "No trailer here.", 'FLOFI_REVIEW_RESULT {"domain":"flofi-mcp","result":"no-findings","findings":0,"highest":"none"}',
                        'FLOFI_REVIEW_RESULT {"domain":"flofi-swap","result":"certified","findings":0,"highest":"none"}',
                        'FLOFI_REVIEW_RESULT {"domain":"flofi-swap","result":"no-findings","findings":true,"highest":"none"}',
                        'FLOFI_REVIEW_RESULT {"domain":"flofi-swap","result":"no-findings","findings":-1,"highest":"none"}',
                        'FLOFI_REVIEW_RESULT {"domain":"flofi-swap","result":"no-findings","findings":7,"highest":"critical"}',
                        'FLOFI_REVIEW_RESULT {"domain":"flofi-swap","result":"findings","findings":0,"highest":"high"}',
                        'FLOFI_REVIEW_RESULT {"domain":"flofi-swap","result":"findings","findings":2,"highest":"none"}',
                        'FLOFI_REVIEW_RESULT {"result":"no-findings","findings":0,"highest":"none"}',
                        'FLOFI_REVIEW_RESULT {broken']:
            with self.subTest(message=message):
                self.assertIsNone(hooks.review_result("flofi-swap", message))

    def test_invalid_identifiers_never_choose_the_path_or_reach_the_ledger(self):
        for session in ["../../escape", "a/b", "", None, "x" * 200]:
            hooks.record({"session_id": session, "hook_event_name": "SessionStart"}, self.root)
        self.assertFalse((self.root / hooks.RUNS).exists() and any((self.root / hooks.RUNS).iterdir()))
        self.assertFalse(any(self.root.parent.glob("escape*")))
        self.record(hook_event_name="SubagentStart", agent_type="flofi swap; rm -rf", agent_id="../x")
        self.assertEqual({k: self.ledger()[0][k] for k in ("agent", "agentId")}, {"agent": "other", "agentId": None})

    def test_internal_agents_without_a_type_are_not_reported_as_specialists(self):
        self.record(hook_event_name="SubagentStop", agent_type="", agent_id="internal", last_assistant_message="x")
        self.assertEqual(self.ledger(), [])

    def test_test_gates_are_classified_without_storing_commands(self):
        cases = [
            ("pnpm check", ["pnpm-check"], False, True),
            ("cd /repo && pnpm check 2>&1", ["pnpm-check"], False, True),
            # A pipeline, ||, ; or & hides the gate's own status (flofi-infrastructure-ci finding 2).
            ("cd /repo && pnpm check 2>&1 | tail -20", ["pnpm-check"], True, None),
            ("pnpm test || true", ["pnpm-test"], False, None),
            ("pnpm test; echo done", ["pnpm-test"], False, None),
            ("pnpm test & wait", ["pnpm-test"], False, None),
            ("pnpm test 2>&1 && echo done", ["pnpm-test"], False, True),
            ("DATABASE_URL=postgres://owner:hunter2@db.invalid/flofi pnpm test:postgres", ["pnpm-test-postgres"], False, True),
            ("pnpm test --reporter=default --reporter=json --outputFile=/tmp/u.json", ["pnpm-test"], False, True),
            ("pnpm exec vitest run packages/a/test/x.test.ts apps/b/src/y.test.tsx", ["vitest-focused"], False, True),
            ("python3 scripts/agent_guard.py check && python3 scripts/governance_lite.py", ["agent-guard-check", "governance-lite"], False, True),
            ("python3 -m unittest discover -s scripts -p 'test_ci_*.py'", ["governance-unittests"], False, True),
            ("node scripts/guarded-release-browser.mjs critical", ["guarded-browser"], False, True),
        ]
        for command, gates, piped, ok in cases:
            with self.subTest(command=command):
                entry = hooks.gate_record({"hook_event_name": "PostToolUse", "tool_name": "Bash",
                                           "tool_input": {"command": command}, "tool_response": {"stdout": "ok", "interrupted": False}})
                self.assertEqual((entry["gates"], entry["piped"], entry["ok"], entry["exit"]),
                                 (gates, piped, ok, 0 if ok else None))
                self.assertNotIn("command", entry)
                self.assertNotIn("hunter2", json.dumps(entry))
        vitest = "pnpm exec vitest run packages/a/test/x.test.ts apps/b/src/y.test.tsx"
        entry = hooks.gate_record({"hook_event_name": "PostToolUse", "tool_input": {"command": vitest}, "tool_response": {}})
        self.assertEqual(entry["suites"], ["apps/b/src/y.test.tsx", "packages/a/test/x.test.ts"])
        def scope(command, cwd=None):
            entry = hooks.gate_record({"hook_event_name": "PostToolUse", "tool_input": {"command": command},
                                       "tool_response": {}, "cwd": cwd or str(self.root)}, self.root)
            return list(entry["scopes"].values())[0]
        self.assertEqual(scope("pnpm test"), scope("pnpm test --reporter=json --outputFile=/tmp/u.json"))
        self.assertEqual(scope("pnpm test:fork"), scope("pnpm test:fork --testTimeout=30000"))
        self.assertEqual(scope("python3 scripts/agent_guard.py verify-results /tmp/a.json"),
                         scope("python3 scripts/agent_guard.py verify-results /tmp/b.json"))
        distinct = [scope("pnpm typecheck"), scope("cd src && pnpm typecheck"), scope("pnpm typecheck", str(self.root / "src")),
                    scope("pnpm test -t name"), scope("pnpm test -t other"), scope("pnpm test:fork -t x"),
                    scope("node scripts/guarded-release-browser.mjs critical"),
                    scope("node scripts/guarded-release-browser.mjs profile wallet-isolation"),
                    scope("node scripts/guarded-release-browser.mjs profile canvas"),
                    scope("node scripts/guarded-release-browser.mjs extended --shard 1/4"),
                    scope("pnpm --filter a exec vitest run x.test.ts"), scope("pnpm --filter b exec vitest run x.test.ts"),
                    scope("python3 -m unittest discover -s scripts -p 'test_governance_lite.py'"),
                    scope("python3 scripts/agent_guard.py verify-results /tmp/u.json"),
                    scope("python3 scripts/agent_guard.py verify-results --stage postgres /tmp/p.json")]
        self.assertEqual(len(set(distinct)), len(distinct), distinct)
        self.assertTrue(all(re.fullmatch(r"run-[0-9a-f]{12}", s) for s in distinct))
        key = self.root / hooks.RUNS / ".scope-key"
        self.assertEqual((stat.S_IMODE(key.stat().st_mode) & 0o077, key.stat().st_size), (0, 32))
        other = Path(self.outside, "other-repo")
        (other / ".claude").mkdir(parents=True)
        self.assertNotEqual(hooks.gate_scope("pnpm-test", ["pnpm", "test"], ".", other),
                            hooks.gate_scope("pnpm-test", ["pnpm", "test"], ".", self.root))  # keyed per checkout
        self.assertIsNone(hooks.gate_record({"hook_event_name": "PostToolUse", "tool_input": {
            "command": "node scripts/guarded-release-browser.mjs list"}, "tool_response": {}}, self.root))
        self.assertNotIn("asus", json.dumps(hooks.gate_record({"hook_event_name": "PostToolUse", "tool_input": {
            "command": "pnpm exec vitest run /home/asus/x.test.ts"}, "tool_response": {}})))
        self.assertEqual(hooks.gate_record({"hook_event_name": "PostToolUse", "tool_input": {
            "command": "pnpm lint # first && pnpm test"}, "tool_response": {}})["gates"], ["pnpm-lint"])
        command = (f"pnpm exec vitest run {self.root}/src/b.test.ts /home/someone/other/x.test.ts "
                   f"../escape/y.test.ts {'a' * 300}.test.ts")
        entry = hooks.gate_record({"hook_event_name": "PostToolUse", "tool_input": {"command": command}, "tool_response": {}}, self.root)
        self.assertEqual(entry["suites"], ["src/b.test.ts"])
        self.assertNotIn("someone", json.dumps(entry))
        for command in ["ls", "git status", "echo pnpm check", "pnpm install", "rm -rf node_modules",
                        "grep -e 'x && pnpm test ' a.txt", "echo 'pnpm check; pnpm test'", "ls # && pnpm test"]:
            self.assertIsNone(hooks.gate_record({"hook_event_name": "PostToolUse", "tool_input": {"command": command}}))

    def test_failed_interrupted_and_background_gates_are_not_reported_as_passing(self):
        failed = hooks.gate_record({"hook_event_name": "PostToolUseFailure", "tool_input": {"command": "pnpm test"},
                                    "error": "Exit code 1\nFAIL packages/a/test/x.test.ts"})
        self.assertEqual((failed["ok"], failed["exit"]), (False, 1))
        for command in ["pnpm test | tail", "pnpm test && echo after", "pnpm test; true"]:
            unknown = hooks.gate_record({"hook_event_name": "PostToolUseFailure", "tool_input": {"command": command},
                                         "error": "Exit code 1"})
            self.assertEqual((unknown["ok"], unknown["exit"]), (None, None), command)
        interrupted = hooks.gate_record({"hook_event_name": "PostToolUse", "tool_input": {"command": "pnpm test"},
                                         "tool_response": {"interrupted": True}})
        self.assertEqual((interrupted["ok"], interrupted["exit"]), (False, None))
        background = hooks.gate_record({"hook_event_name": "PostToolUse", "tool_input": {
            "command": "pnpm test", "run_in_background": True}, "tool_response": {}})
        self.assertEqual((background["ok"], background["exit"]), (None, None))
        self.record(hook_event_name="PostToolUseFailure", tool_name="Bash", agent_type="flofi-swap",
                    tool_input={"command": "pnpm check"}, error="Exit code 2")
        self.assertEqual({k: self.ledger()[0][k] for k in ("event", "gates", "ok", "exit", "agent")},
                         {"event": "test", "gates": ["pnpm-check"], "ok": False, "exit": 2, "agent": "flofi-swap"})

    def test_symlinked_ledger_directory_and_disabled_telemetry_write_nothing(self):
        (self.root / hooks.RUNS).symlink_to(self.outside, target_is_directory=True)
        self.record(hook_event_name="SessionStart", source="startup")
        self.assertEqual(sorted(p.name for p in self.outside.iterdir()), ["secret.txt"])
        (self.root / hooks.RUNS).unlink()
        os.environ["FLOFI_AGENT_TELEMETRY"] = "off"
        self.addCleanup(os.environ.pop, "FLOFI_AGENT_TELEMETRY", None)
        self.record(hook_event_name="SessionStart", source="startup")
        self.assertFalse((self.root / hooks.RUNS).exists())

    def test_existing_loose_or_linked_ledgers_are_tightened_or_refused(self):
        runs = self.root / hooks.RUNS
        runs.mkdir(mode=0o755)
        os.chmod(runs, 0o755)
        (runs / f"{SESSION}.jsonl").write_text("")
        os.chmod(runs / f"{SESSION}.jsonl", 0o644)
        self.record(hook_event_name="SessionStart", source="startup")
        self.assertEqual(stat.S_IMODE(runs.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((runs / f"{SESSION}.jsonl").stat().st_mode), 0o600)
        os.link(self.outside / "secret.txt", runs / "hardlinked.jsonl")
        (runs / "symlinked.jsonl").symlink_to(self.outside / "secret.txt")
        for session in ["hardlinked", "symlinked"]:
            with self.subTest(session=session):
                try:
                    hooks.record({"session_id": session, "hook_event_name": "SessionStart"}, self.root)
                except OSError:
                    pass
        self.assertEqual((self.outside / "secret.txt").read_text(), "outside\n")

    def test_fifo_and_oversized_ledgers_neither_hang_nor_grow(self):
        runs = self.root / hooks.RUNS
        runs.mkdir(mode=0o700)
        os.mkfifo(runs / "fifo.jsonl")
        hooks.record({"session_id": "fifo", "hook_event_name": "SessionStart"}, self.root)  # must return, not block
        (runs / f"{SESSION}.jsonl").write_bytes(b"x" * (hooks.LEDGER_LIMIT + 1))
        os.chmod(runs / f"{SESSION}.jsonl", 0o600)
        self.record(hook_event_name="SessionEnd", reason="other")
        self.assertEqual((runs / f"{SESSION}.jsonl").stat().st_size, hooks.LEDGER_LIMIT + 1)

    def test_session_start_binds_the_ledger_to_the_reviewed_commit(self):
        subprocess.run(["git", "add", "CLAUDE.md"], cwd=self.root, check=True)
        subprocess.run(["git", "-c", "user.email=f@example.invalid", "-c", "user.name=f", "commit", "-qm", "fixture"],
                       cwd=self.root, check=True)
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True).stdout.strip()
        self.record(hook_event_name="SessionStart", source="startup")
        self.assertEqual(self.ledger()[0]["head"], head)

    def test_specialist_rows_record_the_reviewed_commit_and_uncommitted_state(self):
        subprocess.run(["git", "add", "CLAUDE.md"], cwd=self.root, check=True)
        subprocess.run(["git", "-c", "user.email=f@example.invalid", "-c", "user.name=f", "commit", "-qm", "fixture"],
                       cwd=self.root, check=True)
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True).stdout.strip()
        self.record(hook_event_name="SubagentStart", agent_type="flofi-swap", agent_id="a1")
        self.record(hook_event_name="SubagentStop", agent_type="flofi-swap", agent_id="a1", last_assistant_message="")
        start, stop = self.ledger()
        self.assertEqual((start["head"], stop["head"], stop["dirty"]), (head, head, True))  # fixture has untracked files

    def test_worktree_state_is_unknown_not_clean_when_git_fails(self):
        self.assertEqual(hooks.worktree_state(self.outside), {"head": None, "dirty": None})
        original = hooks.subprocess.run
        self.addCleanup(setattr, hooks.subprocess, "run", original)

        def slow(*_args, **_kwargs):
            raise hooks.subprocess.TimeoutExpired("git", 5)
        hooks.subprocess.run = slow
        self.assertEqual(hooks.worktree_state(self.root), {"head": None, "dirty": None})
        hooks.subprocess.run = original
        self.record(hook_event_name="SubagentStart", agent_type="flofi-swap", agent_id="a1")
        self.assertEqual(self.ledger()[0]["event"], "subagent_start")  # the row is never dropped

    def test_session_start_without_git_still_records_the_row(self):
        hooks.record({"session_id": SESSION, "hook_event_name": "SessionStart", "source": "startup"}, self.root)
        self.assertEqual((self.ledger()[0]["event"], self.ledger()[0]["head"]), ("session_start", None))

    def test_symlinked_claude_directory_writes_nothing(self):
        moved = Path(self.outside, "claude")
        (self.root / ".claude").rename(moved)
        (self.root / ".claude").symlink_to(moved, target_is_directory=True)
        self.record(hook_event_name="SessionStart", source="startup")
        self.assertFalse((moved / "flofi-agent-runs").exists())

    def test_guard_denials_record_only_agent_identity_and_tool(self):
        decision = hooks.guard({"session_id": SESSION, "agent_type": "flofi-security", "agent_id": "a1",
                                "tool_name": "Read", "tool_input": {"file_path": ".env.local-SECRET=abc"},
                                "cwd": str(self.root)}, self.root)
        self.assertEqual(decision["hookSpecificOutput"]["permissionDecision"], "deny")
        hooks.guard({"session_id": SESSION, "agent_type": "flofi-security", "agent_id": "a1", "tool_name": "Bash",
                     "tool_input": {"command": "echo SECRET"}}, self.root)
        rows = self.ledger()
        self.assertEqual(set(rows[0]), {"v", "t", "event", "agent", "agentId", "tool"})
        self.assertEqual([(r["event"], r["agent"], r["tool"]) for r in rows],
                         [("guard_deny", "flofi-security", "Read"), ("guard_deny", "flofi-security", "other")])
        self.assertNotIn("SECRET", (self.root / hooks.RUNS / f"{SESSION}.jsonl").read_text())
        self.assertIsNone(hooks.guard({"session_id": SESSION, "tool_name": "Edit", "tool_input": {}}, self.root))

    def test_record_cli_never_blocks_or_prints(self):
        env = {**os.environ, "FLOFI_AGENT_TELEMETRY": "off"}
        for body in ["", "{broken", "[]", json.dumps({"hook_event_name": "SubagentStop", "session_id": SESSION})]:
            with self.subTest(body=body):
                result = subprocess.run([sys.executable, str(HOOK), "record"], input=body, text=True,
                                        capture_output=True, timeout=15, env=env)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))


class ProjectWiring(unittest.TestCase):
    def test_docker_build_context_excludes_claude_development_state(self):
        rules = (HOOK.parents[2] / ".dockerignore").read_text().splitlines()
        self.assertIn("**/.claude", rules)

    def test_settings_route_every_hook_to_an_implemented_mode(self):
        settings = json.loads((HOOK.parents[1] / "settings.json").read_text())
        for event, groups in settings["hooks"].items():
            for group in groups:
                for hook in group["hooks"]:
                    self.assertEqual((hook["type"], hook["command"]), ("command", "python3"))
                    self.assertEqual(hook["args"], ["-I", "${CLAUDE_PROJECT_DIR}/.claude/hooks/flofi_agent_hooks.py",
                                                    "guard" if event == "PreToolUse" else "record"])
        guard = settings["hooks"]["PreToolUse"][0]
        self.assertEqual((guard["matcher"], guard["hooks"][0]["onFailure"]), ("*", "block"))


if __name__ == "__main__":
    unittest.main()
