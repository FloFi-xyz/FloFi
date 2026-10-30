#!/usr/bin/env python3
"""Exercise installed Claude Code against the project agents with a scripted loopback model.

Optional developer acceptance check; CI needs no Claude binary or AI account.
A local HTTP server plays the Messages API: it makes the main session spawn each
of the 19 flofi-* agents in turn and makes each one try an allowed read-only
command, a forbidden command and an out-of-repository read. No real model,
credentials, external AI service, repository change or financial operation is
used. The run proves harness discovery, resolved tool restriction, the live
read-only guard and lifecycle hooks; it does not measure model judgment.
"""

from collections import Counter
import http.server
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import uuid

from agent_guard import CLAUDE_FRONTMATTER, CLAUDE_RUNS, DOMAINS, ROOT, parse_claude_agent

MARKER = re.compile(r"# (flofi-[a-z-]+) — FloFi engineering review specialist")
LISTING = re.compile(r"(?m)^- (flofi-[a-z-]+): (.*) \(Tools: ([^)]*)\)$")
ALLOWED = "git rev-parse --is-inside-work-tree"
FORBIDDEN = "echo flofi-guard-probe"
OUTSIDE = "/etc/hostname"
GUARD = "FloFi read-only review guard"


def stream(blocks, stop):
    events = [("message_start", {"type": "message_start", "message": {
        "id": "msg_flofi_probe", "type": "message", "role": "assistant", "model": "flofi-probe", "content": [],
        "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}}})]
    for index, block in enumerate(blocks):
        if block["type"] == "text":
            start, delta = {"type": "text", "text": ""}, {"type": "text_delta", "text": block["text"]}
        else:
            start = {"type": "tool_use", "id": block["id"], "name": block["name"], "input": {}}
            delta = {"type": "input_json_delta", "partial_json": json.dumps(block["input"])}
        events += [("content_block_start", {"type": "content_block_start", "index": index, "content_block": start}),
                   ("content_block_delta", {"type": "content_block_delta", "index": index, "delta": delta}),
                   ("content_block_stop", {"type": "content_block_stop", "index": index})]
    events += [("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                                  "usage": {"output_tokens": 1}}), ("message_stop", {"type": "message_stop"})]
    return "".join(f"event: {name}\ndata: {json.dumps(data)}\n\n" for name, data in events).encode()


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(text_of(item.get("content", "")) if item.get("type") == "tool_result" else item.get("text", "")
                     for item in content if isinstance(item, dict))


def main():
    captured = {"listing": None, "agents": {}, "other": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            system = text_of(body.get("system") or "")
            tools = [tool.get("name") for tool in body.get("tools", [])]
            results = {item["tool_use_id"]: item for message in body.get("messages", []) if message["role"] == "user"
                       and isinstance(message["content"], list) for item in message["content"]
                       if isinstance(item, dict) and item.get("type") == "tool_result"}
            marker = MARKER.search(system)
            if marker:
                domain = marker[1]
                captured["agents"].setdefault(domain, {"tools": tools, "system": system, "results": {}})
                if not results:
                    reply = ([{"type": "tool_use", "id": "toolu_probe_allowed", "name": "Bash", "input": {"command": ALLOWED, "description": "probe"}},
                              {"type": "tool_use", "id": "toolu_probe_forbidden", "name": "Bash", "input": {"command": FORBIDDEN, "description": "probe"}},
                              {"type": "tool_use", "id": "toolu_probe_outside", "name": "Read", "input": {"file_path": OUTSIDE}}], "tool_use")
                else:
                    captured["agents"][domain]["results"] = {key: {"error": bool(item.get("is_error")), "text": text_of(item.get("content", ""))}
                                                             for key, item in results.items()}
                    reply = ([{"type": "text", "text": "Offline probe.\nFLOFI_REVIEW_RESULT " + json.dumps(
                        {"domain": domain, "result": "no-findings", "findings": 0, "highest": "none"}, separators=(",", ":"))}], "end_turn")
            elif "Agent" in tools:
                if captured["listing"] is None:
                    captured["listing"] = "\n".join(text_of(m["content"]) for m in body.get("messages", []))
                done = sum(key.startswith("toolu_probe_agent_") for key in results)
                reply = ([{"type": "tool_use", "id": f"toolu_probe_agent_{done}", "name": "Agent", "input": {
                    "description": "Offline FloFi probe", "prompt": "Offline harness probe.", "subagent_type": DOMAINS[done],
                    "run_in_background": False}}], "tool_use") if done < len(DOMAINS) else ([{"type": "text", "text": "Probe complete."}], "end_turn")
            else:
                captured["other"] += 1
                reply = ([{"type": "text", "text": "ok"}], "end_turn")
            data = stream(*reply)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *_args):
            pass

    session_id = str(uuid.uuid4())
    ledger = ROOT / CLAUDE_RUNS / f"{session_id}.jsonl"
    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory(prefix="flofi-claude-probe-") as scratch:
                env = {"PATH": os.environ["PATH"], "HOME": scratch, "CLAUDE_CONFIG_DIR": scratch,
                       "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{server.server_port}", "ANTHROPIC_API_KEY": "offline-probe",
                       "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "DISABLE_AUTOUPDATER": "1", "DISABLE_TELEMETRY": "1"}
                version = subprocess.check_output(["claude", "--version"], env=env, text=True, stderr=subprocess.DEVNULL).strip()
                run = subprocess.run(["claude", "-p", "--output-format", "stream-json", "--verbose", "--session-id", session_id,
                                      f"--allowedTools=Bash({ALLOWED})", "Offline FloFi agent probe."],
                                     cwd=ROOT, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=600)
        finally:
            server.shutdown()
            worker.join()
            # Scripted probe evidence is not a review session, even after a timeout.
            rows = [json.loads(line) for line in ledger.read_text().splitlines()] if ledger.is_file() else []
            ledger.unlink(missing_ok=True)
    events = [json.loads(line) for line in run.stdout.splitlines() if line.startswith("{")]
    init = next((e for e in events if e.get("type") == "system" and e.get("subtype") == "init"), None)
    if run.returncode or not init or init.get("session_id") != session_id:
        raise RuntimeError(f"Claude Code probe run failed (exit {run.returncode}): {run.stderr.strip()[-500:]}")
    errors = []
    if set(DOMAINS) - set(init.get("agents", [])):
        errors.append(f"Not discovered: {sorted(set(DOMAINS) - set(init.get('agents', [])))}")
    listing = {name: (description, tools) for name, description, tools in LISTING.findall(captured["listing"] or "")}
    for domain in DOMAINS:
        fields, body = parse_claude_agent((ROOT / f".claude/agents/{domain}.md").read_text())
        if listing.get(domain) != (fields["description"], CLAUDE_FRONTMATTER["tools"]):
            errors.append(f"{domain}: delegation listing differs from the definition")
        agent = captured["agents"].get(domain)
        if not agent:
            errors.append(f"{domain}: subagent never started")
            continue
        if not {"Read", "Bash"} <= set(agent["tools"]) <= {"Read", "Grep", "Glob", "Bash"}:
            errors.append(f"{domain}: resolved subagent tools {agent['tools']} are not the read-only set")
        if body.strip()[:400] not in agent["system"]:
            errors.append(f"{domain}: subagent system prompt is not the project definition")
        results = agent["results"]
        allowed, forbidden, outside = (results.get(f"toolu_probe_{key}", {}) for key in ("allowed", "forbidden", "outside"))
        if allowed.get("error") is not False or allowed.get("text", "").strip() != "true":
            errors.append(f"{domain}: allowed read-only command did not run ({allowed.get('text', 'no result')[:200]})")
        for label, result in (("forbidden command", forbidden), ("outside read", outside)):
            if not result.get("error") or GUARD not in result.get("text", ""):
                errors.append(f"{domain}: {label} was not denied by the read-only guard")
    starts ={row["agent"] for row in rows if row["event"] == "subagent_start"}
    stops = {row["agent"] for row in rows if row["event"] == "subagent_stop"
             and row.get("review") == {"result": "no-findings", "findings": 0, "highest": "none"}}
    denials = Counter(row["agent"] for row in rows if row["event"] == "guard_deny")
    session = [row for row in rows if row["event"] == "session_start"]
    if not session or set(session[0]["definitions"]) != set(DOMAINS):
        errors.append("SessionStart hook did not record the 19 definitions")
    for domain in DOMAINS:
        if domain not in starts or domain not in stops or denials[domain] != 2:
            errors.append(f"{domain}: hook ledger lacks start, structured completion or both guard denials")
    if not any(row["event"] == "session_end" for row in rows):
        errors.append("SessionEnd hook was not recorded")
    if errors:
        raise RuntimeError("Claude agent probe failed:\n" + "\n".join(errors))
    print(f"Claude agents: PASS ({version}; 19 discovered with exact descriptions; each resolved to read-only tools, "
          "ran an allowed command, had a forbidden command and an outside read denied, and was recorded by "
          f"SubagentStart/SubagentStop; scripted loopback model, {captured['other']} auxiliary requests, zero real model responses)")


if __name__ == "__main__":
    main()
