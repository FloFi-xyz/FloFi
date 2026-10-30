"""Claude Code hook contracts: read-only reviewer guard and non-sensitive lifecycle ledger.

Runs in every existing governance job; uses a disposable Git repository and never
starts Claude Code, a model, the network or a financial operation.
"""

import importlib.util
import json
import os
from pathlib import Path
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
    def test_main_session_and_other_agents_are_never_restricted(self):
        for agent in [None, "", "Explore", "general-purpose", "security-reviewer"]:
            with self.subTest(agent=agent):
                self.assertIsNone(self.guard(agent=agent, command="git push origin HEAD"))
                self.assertIsNone(self.guard("Edit", agent=agent, file_path="src/a.ts"))

    def test_reviewers_cannot_use_write_network_agent_or_mcp_tools(self):
        for tool in ["Edit", "Write", "NotebookEdit", "Agent", "Task", "WebFetch", "WebSearch", "SendMessage",
                     "EnterWorktree", "mcp__github__create_pull_request", "mcp__claude_ai_Flofi__authenticate"]:
            with self.subTest(tool=tool):
                self.assertIn("not available to read-only FloFi reviewers", self.guard(tool, file_path="src/a.ts"))

    def test_read_grep_and_glob_stay_inside_tracked_repository_content(self):
        self.assertIsNone(self.guard("Read", file_path=str(self.root / "src/a.ts")))
        self.assertIsNone(self.guard("Read", file_path="src/a.ts"))
        self.assertIsNone(self.guard("Read", file_path=".env.example"))
        self.assertIsNone(self.guard("Read", file_path="node_modules/pkg/index.js"))
        self.assertIsNone(self.guard("Grep", pattern="a", path="src"))
        self.assertIsNone(self.guard("Glob", pattern="**/*.ts"))
        for path in ["/etc/hostname", str(self.outside / "secret.txt"), "../outside/secret.txt", "~/.ssh/id_rsa",
                     ".env.local", ".git/config", ".mode-a/journal", "local-state/notes", "src/link.ts",
                     "deploy/key.pem", ".claude/flofi-agent-runs/s.jsonl", "", None]:
            with self.subTest(path=path):
                self.assertIsNotNone(self.guard("Read", file_path=path))
        self.assertIsNotNone(self.guard("Grep", pattern="a", path="/etc"))
        self.assertIsNotNone(self.guard("Glob", pattern="../**/*.ts"))
        self.assertIsNotNone(self.guard("Glob", pattern="/etc/*"))

    def test_repository_scoped_inspection_commands_are_allowed(self):
        for command in ["git diff --stat origin/main...HEAD", "git diff -- src", "git log --oneline -5 | head -3",
                        "git show HEAD:CLAUDE.md", "git status --short", "git grep -n export -- src",
                        "git --no-pager log -1", "git merge-base HEAD origin/main", "git blame src/a.ts",
                        "rg -n 'export' src 2>/dev/null", "rg -g '*.ts' export", "grep -n export src/a.ts",
                        "sed -n '1,40p' src/a.ts", "find src -name '*.ts' | wc -l", "cat CLAUDE.md", "ls -la src",
                        "head -n 5 src/a.ts", "tail -n 5 src/a.ts", "sort -n src/a.ts | head",
                        "git diff origin/main...HEAD | sed -n '1,200p'", "git log -1 | tail -1",
                        "python3 scripts/agent_guard.py impact --base origin/main",
                        "python3 scripts/agent_guard.py domain flofi-swap --base origin/main", "pwd"]:
            with self.subTest(command=command):
                self.assertIsNone(self.guard(command=command))

    def test_mutation_execution_network_and_escape_commands_are_denied(self):
        for command in [
            "git commit -m x", "git push origin HEAD", "git checkout main", "git reset --hard", "git stash",
            "git branch -D main", "git add .", "git tag v1", "git apply x.patch", "git -C /tmp log",
            "git -c core.pager=sh log", "git diff --output=x", "git diff --ext-diff", "git diff --no-index /etc/passwd x",
            "git grep -Ovi x", "git grep --no-exclude-standard --untracked KEY", "git show HEAD -- ../outside",
            "git blame --contents=.env.local src/a.ts", "git blame --contents .mode-a/journal src/a.ts",
            "git grep -f .env.local -- src", "git diff HEAD -- local-state/notes", "git log -- src/link.ts",
            "rm -rf src", "mv src x", "cp src/a.ts x", "touch x", "mkdir x", "chmod +x x", "tee x", "dd if=x of=y",
            "cat src/a.ts > x", "cat src/a.ts >> x", "cat < src/a.ts", "echo $HOME", "cat ${HOME}/x", "cat $(echo x)",
            "cat `echo x`", 'cat "$HOME/x"', "ls; rm x", "ls && rm x", "ls || true", "ls & rm x", "(ls)", "{ ls; }",
            "ls\nrm x", "ls \\\nsrc", "cat 'unterminated", "FOO=1 git status", "env git status", "sudo ls",
            "bash -c ls", "sh -c ls", "xargs rm", "awk '{print}' src/a.ts", "node -e 1", "python3 -c 'print(1)'",
            "python3 scripts/agent_guard.py claude-agents --write", "python3 scripts/agent_guard.py review --base x",
            "python3 scripts/other.py", "pnpm test", "pnpm exec vitest run src/b.test.ts", "npx vitest", "make",
            "curl https://example.com", "wget https://example.com", "gh pr view 1", "ssh host", "cast send 0x0",
            "cat .env.local", "cat src/../.env.local", "grep -n LOCAL .env*", "cat .mode-a/journal",
            "cat local-state/notes", "cat src/link.ts", "cat /etc/passwd", "cat ../outside/secret.txt",
            "cat ~/.ssh/id_rsa", "cat .git/config", "head -c 99 /proc/self/environ", "ls ..", "find / -name x",
            "find . -delete", "find . -exec cat {} +", "find -L . -name x", "grep -rn KEY .", "grep -R KEY src",
            "grep --recursive KEY src", "rg --no-ignore KEY", "rg -uu KEY", "rg -u KEY", "rg --pre cat KEY",
            "rg -L KEY", "rg -z KEY", "rg KEY .env.local", "sed -i 's/a/b/' src/a.ts", "sed -n '1w out' src/a.ts",
            "sed -n '1,2p' src/a.ts -i", "sed 'e ls' src/a.ts", "tail -f src/a.ts", "sort -o out src/a.ts",
            "sort --compress-program=sh src/a.ts", "cd /tmp", "", "jq -n '$ENV'", "jq -n env",
            "diff -r src local-state", "rg --hostname-bin=sh KEY", "git grep -nOvi KEY", "git -C . status --short",
        ]:
            with self.subTest(command=command):
                self.assertIsNotNone(self.guard(command=command))

    def test_reviewers_may_read_only_this_sessions_saved_tool_output(self):
        projects = Path(self.outside, "projects/slug")
        saved = projects / SESSION / "tool-results"
        saved.mkdir(parents=True)
        (saved / "b1el7won7.txt").write_text("long output\n")
        (projects / SESSION / "secret.txt").write_text("not tool output\n")
        other = projects / "11111111-1111-1111-1111-111111111111/tool-results"
        other.mkdir(parents=True)
        (other / "x.txt").write_text("another session\n")

        def read(path, transcript=str(projects / f"{SESSION}.jsonl"), session=SESSION):
            return hooks.guard_reason({"agent_type": "flofi-swap", "tool_name": "Read", "tool_input": {"file_path": path},
                                       "cwd": str(self.root), "session_id": session, "transcript_path": transcript}, self.root)
        self.assertIsNone(read(str(saved / "b1el7won7.txt")))
        for path in [str(projects / SESSION / "secret.txt"), str(other / "x.txt"), str(saved / "missing.txt"),
                     str(saved / ".." / "secret.txt")]:
            with self.subTest(path=path):
                self.assertIsNotNone(read(path))
        self.assertIsNotNone(read(str(saved / "b1el7won7.txt"), transcript=str(projects / "other.jsonl")))
        self.assertIsNotNone(read(str(saved / "b1el7won7.txt"), session="../x"))
        (saved / "link.txt").symlink_to(self.outside / "secret.txt")
        self.assertIsNotNone(read(str(saved / "link.txt")))

    def test_background_and_oversized_commands_are_denied(self):
        self.assertIsNotNone(self.guard(command="git status", run_in_background=True))
        self.assertIsNotNone(self.guard(command="ls " + "src " * 2000))

    def test_cli_returns_a_deny_decision_only_for_flofi_reviewers(self):
        def run(event):
            return subprocess.run([sys.executable, str(HOOK), "guard"], input=json.dumps(event), text=True,
                                  capture_output=True, timeout=15)
        denied = run({"agent_type": "flofi-security", "tool_name": "Bash", "tool_input": {"command": "git push"}})
        self.assertEqual(denied.returncode, 0)
        decision = json.loads(denied.stdout)["hookSpecificOutput"]
        self.assertEqual((decision["hookEventName"], decision["permissionDecision"]), ("PreToolUse", "deny"))
        self.assertIn("FloFi read-only review guard", decision["permissionDecisionReason"])
        allowed = run({"tool_name": "Bash", "tool_input": {"command": "git push"}})
        self.assertEqual((allowed.returncode, allowed.stdout), (0, ""))

    def test_cli_fails_closed_on_malformed_input_so_onfailure_blocks(self):
        for body in ["", "{broken", "[]"]:
            with self.subTest(body=body):
                result = subprocess.run([sys.executable, str(HOOK), "guard"], input=body, text=True,
                                        capture_output=True, timeout=15)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("allow", result.stdout)


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
            ("pnpm check", ["pnpm-check"], False),
            ("cd /repo && pnpm check 2>&1 | tail -20", ["pnpm-check"], True),
            ("DATABASE_URL=postgres://owner:hunter2@db.invalid/flofi pnpm test:postgres", ["pnpm-test-postgres"], False),
            ("pnpm test --reporter=default --reporter=json --outputFile=/tmp/u.json", ["pnpm-test"], False),
            ("pnpm exec vitest run packages/a/test/x.test.ts apps/b/src/y.test.tsx", ["vitest-focused"], False),
            ("python3 scripts/agent_guard.py check && python3 scripts/governance_lite.py", ["agent-guard-check", "governance-lite"], False),
            ("python3 -m unittest discover -s scripts -p 'test_ci_*.py'", ["governance-unittests"], False),
            ("node scripts/guarded-release-browser.mjs critical", ["guarded-browser"], False),
        ]
        for command, gates, piped in cases:
            with self.subTest(command=command):
                entry = hooks.gate_record({"hook_event_name": "PostToolUse", "tool_name": "Bash",
                                           "tool_input": {"command": command}, "tool_response": {"stdout": "ok", "interrupted": False}})
                self.assertEqual((entry["gates"], entry["piped"], entry["ok"], entry["exit"]), (gates, piped, True, 0))
                self.assertNotIn("command", entry)
                self.assertNotIn("hunter2", json.dumps(entry))
        entry = hooks.gate_record({"hook_event_name": "PostToolUse", "tool_input": {"command": cases[4][0]}, "tool_response": {}})
        self.assertEqual(entry["suites"], ["apps/b/src/y.test.tsx", "packages/a/test/x.test.ts"])
        for command in ["ls", "git status", "echo pnpm check", "pnpm install", "rm -rf node_modules"]:
            self.assertIsNone(hooks.gate_record({"hook_event_name": "PostToolUse", "tool_input": {"command": command}}))

    def test_failed_interrupted_and_background_gates_are_not_reported_as_passing(self):
        failed = hooks.gate_record({"hook_event_name": "PostToolUseFailure", "tool_input": {"command": "pnpm test"},
                                    "error": "Exit code 1\nFAIL packages/a/test/x.test.ts"})
        self.assertEqual((failed["ok"], failed["exit"]), (False, 1))
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

    def test_record_cli_never_blocks_or_prints(self):
        env = {**os.environ, "FLOFI_AGENT_TELEMETRY": "off"}
        for body in ["", "{broken", "[]", json.dumps({"hook_event_name": "SubagentStop", "session_id": SESSION})]:
            with self.subTest(body=body):
                result = subprocess.run([sys.executable, str(HOOK), "record"], input=body, text=True,
                                        capture_output=True, timeout=15, env=env)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, "", ""))


class ProjectWiring(unittest.TestCase):
    def test_settings_route_every_hook_to_an_implemented_mode(self):
        settings = json.loads((HOOK.parents[1] / "settings.json").read_text())
        for event, groups in settings["hooks"].items():
            for group in groups:
                for hook in group["hooks"]:
                    self.assertEqual((hook["type"], hook["command"]), ("command", "python3"))
                    self.assertEqual(hook["args"][0], "${CLAUDE_PROJECT_DIR}/.claude/hooks/flofi_agent_hooks.py")
                    self.assertEqual(hook["args"][1], "guard" if event == "PreToolUse" else "record")
        guard = settings["hooks"]["PreToolUse"][0]
        self.assertEqual((guard["matcher"], guard["hooks"][0]["onFailure"]), ("*", "block"))


if __name__ == "__main__":
    unittest.main()
