#!/usr/bin/env python3
"""Inspect installed Codex discovery with a local rejecting model endpoint.

Optional developer acceptance check; CI needs no Codex binary or AI account.
No model response, external request, credentials, tool execution or real agent
session work is used. The harness must publish all project roles in its actual
spawn tool schema before the deliberately rejected first model request.
"""

import http.server
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import tomllib

from agent_guard import DOMAINS, ROOT


def main():
    captured = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            for namespace in request.get("tools", []):
                for tool in [namespace, *namespace.get("tools", [])]:
                    if tool.get("name") == "spawn_agent":
                        captured.append(tool.get("parameters", {}).get("properties", {}).get("agent_type", {}).get("description", ""))
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"Offline discovery inspection complete","type":"invalid_request_error"}}')

        def log_message(self, *_args):
            pass

    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with tempfile.TemporaryDirectory(prefix="flofi-agent-discovery-") as scratch:
                config = ('model_provider = "offline_probe"\nmodel = "flofi-discovery-probe"\n'
                          '[model_providers.offline_probe]\nname = "Offline discovery"\n'
                          f'base_url = "http://127.0.0.1:{server.server_port}/v1"\n'
                          'wire_api = "responses"\nrequires_openai_auth = false\n'
                          f'[projects.{json.dumps(str(ROOT))}]\ntrust_level = "trusted"\n')
                Path(scratch, "config.toml").write_text(config)
                env = {"PATH": os.environ["PATH"], "HOME": scratch, "CODEX_HOME": scratch}
                version = subprocess.check_output(["codex", "--version"], env=env, text=True, stderr=subprocess.DEVNULL).strip()
                subprocess.run(["codex", "--strict-config", "exec", "--ephemeral", "--skip-git-repo-check",
                                "-C", str(ROOT), "Inspect project agent discovery only."],
                               env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=30, check=False)
        finally:
            server.shutdown()
            worker.join()
    if not captured:
        raise RuntimeError("Installed Codex did not expose a spawn_agent role schema; discovery unverified")
    roles = captured[0]
    discovered = set(re.findall(r"(?m)^(flofi-[a-z-]+): \{", roles))
    if discovered != set(DOMAINS):
        raise RuntimeError(f"Installed Codex role mismatch: missing={sorted(set(DOMAINS) - discovered)}, extra={sorted(discovered - set(DOMAINS))}")
    for domain in DOMAINS:
        agent = tomllib.loads((ROOT / f".codex/agents/{domain}.toml").read_text())
        if f"{domain}: {{\n{agent['description']}\n}}" not in roles:
            raise RuntimeError(f"Installed Codex did not load the expected description for {domain}")
    print(f"Codex discovery: PASS ({version}; 19 project roles in the actual spawn tool schema; zero model responses)")


if __name__ == "__main__":
    main()
