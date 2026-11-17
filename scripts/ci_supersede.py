#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Stop this CircleCI job when a newer push superseded the pull-request branch revision it certifies (BUILD-FLOFI-CI-ARCHITECTURE-002).

CircleCI's "Auto-cancel redundant workflows" project setting is the primary mechanism; this repository-side guard keeps a stale
revision from spending runner time when the setting is off or does not reach a pipeline. It only ever stops ITS OWN job:

- it acts only when FLOFI_CI_SUPERSEDE_CHECK=1 (the CircleCI executors set it; GitHub Actions, Cloud Build and local runs never do);
- it never acts on main (every main revision is certified), on a fork's pull request, or without a branch and an exact 40-hex revision;
- it compares the branch's current head on the remote with the job's revision (`git ls-remote`, the checkout's own read access);
- a superseded job exits 75 and is never a pass: the stage records `superseded` and the certification ledger refuses it;
- any error, timeout, deleted branch or unreadable answer lets the job continue (fail-open for a cost guard, never for certification);
- at most one remote read per FLOFI_CI_SUPERSEDE_INTERVAL seconds (default 45) per job, so profile loops stay cheap.
"""

import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

SUPERSEDED = 75
PROTECTED_BRANCHES = frozenset({'main', 'master'})
STAMP = 'flofi-supersede-last-check'


def remote_head(branch, timeout=20):
    """The branch's current commit on origin, or None when it cannot be read (the caller then continues)."""
    ref = 'refs/heads/' + branch
    try:
        # Its own process group, so a timeout also stops an ssh child that would otherwise keep the pipes open.
        process = subprocess.Popen(['git', 'ls-remote', '--heads', 'origin', ref], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, text=True,
                                   cwd=Path(__file__).resolve().parents[1], start_new_session=True,
                                   env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
    except OSError as error:
        print(f'Supersede check skipped: the remote branch could not be read ({type(error).__name__}).', file=sys.stderr, flush=True)
        return None
    try:
        output, _ = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        print('Supersede check skipped: the remote did not answer in time.', file=sys.stderr, flush=True)
        return None
    if process.returncode != 0:
        print(f'Supersede check skipped: git ls-remote exited {process.returncode}.', file=sys.stderr, flush=True)
        return None
    heads = [line.split('\t') for line in output.splitlines() if '\t' in line]
    matches = [sha for sha, name in heads if name == ref and re.fullmatch(r'[0-9a-f]{40}', sha)]
    return matches[0] if len(matches) == 1 else None


def check(environ=os.environ, now=time.time, read=remote_head):
    """0 to continue, SUPERSEDED when the branch moved to another revision."""
    if environ.get('FLOFI_CI_SUPERSEDE_CHECK') != '1':
        return 0
    branch, revision = environ.get('CIRCLE_BRANCH', ''), environ.get('CIRCLE_SHA1', '')
    if not branch or branch in PROTECTED_BRANCHES or not re.fullmatch(r'[0-9a-f]{40}', revision):
        return 0
    # A fork's pull request names the fork's branch; origin's branch of the same name is another line of work. CircleCI sets
    # CIRCLE_PR_USERNAME / CIRCLE_PR_REPONAME only for forked pull requests.
    if branch.startswith('pull/') or environ.get('CIRCLE_PR_USERNAME') or environ.get('CIRCLE_PR_REPONAME'):
        return 0
    temp = environ.get('RUNNER_TEMP')
    stamp = Path(temp) / STAMP if temp else None
    try:
        interval = max(0.0, float(environ.get('FLOFI_CI_SUPERSEDE_INTERVAL', '45')))
    except ValueError:
        interval = 45.0
    if stamp is not None:
        try:
            if now() - float(stamp.read_text()) < interval:
                return 0
        except (OSError, ValueError):
            pass
        try:
            stamp.write_text(repr(now()))
        except OSError:
            pass
    head = read(branch)
    if head is None or head == revision:
        if head == revision:
            print(f'Supersede check: {branch} still points to this revision ({revision[:12]}).', file=sys.stderr, flush=True)
        return 0
    print(f'SUPERSEDED: branch {branch} now points to {head[:12]}; revision {revision[:12]} is no longer its head, so this job '
          'stops here. Nothing of this revision is certified; the newer revision runs its own complete certification.',
          file=sys.stderr, flush=True)
    return SUPERSEDED


if __name__ == '__main__':
    raise SystemExit(check())
