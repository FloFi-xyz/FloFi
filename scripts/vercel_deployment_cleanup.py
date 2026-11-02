#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Owner-run removal of obsolete FloFi Vercel deployments (BUILD-FLOFI-VERCEL-STORAGE-001).

A one-shot tool for the backlog that native Vercel retention has not removed yet; it is not scheduled automation. It plans by
default and deletes only with `--apply --expect N`, where N is the number of deployments the plan just listed. Every rule is
evaluated on live state at run time, and each deployment is fetched again immediately before its deletion.

Never removed: production or custom-environment deployments, rollback candidates, aliased deployments (custom domains and
branch URLs), anything created in the last 24 hours or still building, every deployment of a branch with an open pull request,
the latest two deployments of an active branch (open PR, a commit or a deployment in the last 24 hours), the latest READY
deployment of every branch, and anything whose project, repository or branch is not known. Removable: superseded READY
previews and ERROR/CANCELED deployments that pass all of that.

Credentials come from the owner's environment and are never printed: VERCEL_TOKEN (a token with access to the team), and
GITHUB_TOKEN or an authenticated `gh` CLI for pull request and branch state. Without GitHub state nothing is removed.
"""

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

TEAM_ID = 'team_absG3FziUYYbVkInIRrJDUYU'
PROJECT_ID = 'prj_2fqdtcn7AUVmGxGswx6OAAIleIe6'
GITHUB_REPOSITORY = 'FloFi-xyz/FloFi'
# The repository was renamed (gryloo) and moved (alrimarleskovar -> FloFi-xyz); its earlier deployments carry the old names.
REPOSITORIES = {'FloFi-xyz/FloFi', 'alrimarleskovar/FloFi', 'alrimarleskovar/gryloo'}
MIN_AGE = timedelta(hours=24)
REMOVABLE_STATES = {'READY', 'ERROR', 'CANCELED'}


def classify(deployments, aliases, open_branches, branch_commits, now):
    """Pure decision: (removable, preserved). `deployments` are Vercel list entries; `aliases` maps id -> alias names;
    `open_branches` is the set of head refs with an open PR; `branch_commits` maps branch -> last commit time or None."""
    by_branch = {}
    for deployment in deployments:
        by_branch.setdefault((deployment.get('meta') or {}).get('githubCommitRef'), []).append(deployment)
    for items in by_branch.values():
        items.sort(key=lambda d: d['created'], reverse=True)
    removable, preserved = [], []
    for deployment in deployments:
        meta, reasons = deployment.get('meta') or {}, []
        branch, created = meta.get('githubCommitRef'), datetime.fromtimestamp(deployment['created'] / 1000, timezone.utc)
        state = deployment.get('state') or deployment.get('readyState')
        if deployment.get('projectId', PROJECT_ID) != PROJECT_ID:
            reasons.append('other project')
        if deployment.get('target') == 'production':
            reasons.append('production')
        elif deployment.get('target') not in (None, 'preview') or deployment.get('customEnvironment'):
            reasons.append('custom environment')
        if deployment.get('isRollbackCandidate'):
            reasons.append('rollback candidate')
        if aliases.get(deployment['uid']):
            reasons.append('aliased: ' + ', '.join(sorted(aliases[deployment['uid']])))
        if now - created < MIN_AGE:
            reasons.append('created in the last 24 hours')
        if state not in REMOVABLE_STATES:
            reasons.append(f'state {state}')
        if not branch or f"{meta.get('githubOrg')}/{meta.get('githubRepo')}" not in REPOSITORIES:
            reasons.append('unknown repository or branch')
        else:
            siblings = by_branch[branch]
            rank = next(i for i, d in enumerate(siblings) if d['uid'] == deployment['uid'])
            last_commit = branch_commits.get(branch)
            active = (branch in open_branches or (last_commit is not None and now - last_commit < MIN_AGE)
                      or any(now - datetime.fromtimestamp(d['created'] / 1000, timezone.utc) < MIN_AGE for d in siblings))
            if branch in open_branches:
                reasons.append('branch has an open pull request')
            if active and rank < 2:
                reasons.append('latest two of an active branch')
            if rank == 0 and state == 'READY':
                reasons.append('latest of its branch')
        entry = {'id': deployment['uid'], 'url': deployment.get('url'), 'created': created.isoformat(), 'state': state,
                 'target': deployment.get('target') or 'preview', 'branch': branch, 'sha': (meta.get('githubCommitSha') or '')[:7]}
        if reasons:
            preserved.append(entry | {'reasons': reasons})
        else:
            removable.append(entry | {'kind': {'READY': 'superseded preview', 'ERROR': 'errored', 'CANCELED': 'canceled'}[state]})
    return removable, preserved


class Vercel:
    def __init__(self, token, opener=urllib.request.urlopen):
        self.token, self.opener = token, opener

    def request(self, method, path, **query):
        url = 'https://api.vercel.com' + path + '?' + urllib.parse.urlencode({'teamId': TEAM_ID, **query})
        request = urllib.request.Request(url, method=method, headers={'Authorization': f'Bearer {self.token}'})
        try:
            with self.opener(request, timeout=60) as response:
                return json.loads(response.read() or b'{}')
        except urllib.error.HTTPError as error:
            raise SystemExit(f'Vercel {method} {path}: HTTP {error.code}') from None

    def deployments(self):
        found, until = [], None
        while True:
            page = self.request('GET', '/v6/deployments', projectId=PROJECT_ID, limit=100, **({'until': until} if until else {}))
            found += page.get('deployments', [])
            until = (page.get('pagination') or {}).get('next')
            if not until:
                return found

    def aliases(self, deployment_id):
        return [alias.get('alias') for alias in self.request('GET', f'/v2/deployments/{deployment_id}/aliases').get('aliases', [])]

    def deployment(self, deployment_id):
        return self.request('GET', f'/v13/deployments/{deployment_id}')

    def delete(self, deployment_id):
        return self.request('DELETE', f'/v13/deployments/{deployment_id}')


def github(path):
    """GitHub REST through GITHUB_TOKEN or the owner's `gh` login; None for 404. Fails closed without either."""
    token = os.environ.get('GITHUB_TOKEN')
    if token:
        request = urllib.request.Request('https://api.github.com' + path, headers={'Authorization': f'Bearer {token}',
                                                                                    'Accept': 'application/vnd.github+json'})
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return None
            raise SystemExit(f'GitHub {path}: HTTP {error.code}') from None
    if shutil.which('gh'):
        result = subprocess.run(['gh', 'api', path], capture_output=True, text=True)
        if result.returncode == 0:
            return json.loads(result.stdout)
        if 'HTTP 404' in result.stderr:
            return None
        raise SystemExit(f'GitHub {path}: gh api failed')
    raise SystemExit('GitHub state is required: set GITHUB_TOKEN or log in with gh (nothing was removed)')


def github_state(branches):
    pulls = github(f'/repos/{GITHUB_REPOSITORY}/pulls?state=open&per_page=100')
    if pulls is None or len(pulls) >= 100:
        raise SystemExit('Open pull requests could not be listed completely (nothing was removed)')
    open_branches = {pr['head']['ref'] for pr in pulls}
    commits = {}
    for branch in sorted(b for b in branches if b):
        data = github(f'/repos/{GITHUB_REPOSITORY}/branches/{urllib.parse.quote(branch, safe="")}')
        commits[branch] = None if data is None else datetime.fromisoformat(data['commit']['commit']['committer']['date'].replace('Z', '+00:00'))
    return open_branches, commits


def plan(vercel, now=None):
    now = now or datetime.now(timezone.utc)
    deployments = vercel.deployments()
    aliases = {d['uid']: vercel.aliases(d['uid']) for d in deployments}
    open_branches, commits = github_state({(d.get('meta') or {}).get('githubCommitRef') for d in deployments})
    return classify(deployments, aliases, open_branches, commits, now)


def recheck(vercel, entry, now):
    """Immediately before deleting: the live deployment must still be this project's unaliased, settled, non-production preview."""
    live = vercel.deployment(entry['id'])
    problems = []
    if live.get('projectId') != PROJECT_ID:
        problems.append('project changed')
    if live.get('target') not in (None, 'preview') or live.get('customEnvironment'):
        problems.append('no longer a preview')
    if (live.get('readyState') or live.get('state')) != entry['state']:
        problems.append('state changed')
    if now - datetime.fromtimestamp(live['createdAt'] / 1000, timezone.utc) < MIN_AGE:
        problems.append('too recent')
    if vercel.aliases(entry['id']):
        problems.append('now aliased')
    return problems


def main(argv=None, vercel=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--apply', action='store_true', help='delete the planned deployments (default: plan only)')
    parser.add_argument('--expect', type=int, help='with --apply: the removable count the plan printed')
    parser.add_argument('--report', help='write the plan and outcomes as JSON to this path')
    args = parser.parse_args(argv)
    if args.apply and args.expect is None:
        parser.error('--apply needs --expect N (the removable count of a plan you reviewed)')
    if vercel is None:
        if not os.environ.get('VERCEL_TOKEN'):
            raise SystemExit('VERCEL_TOKEN is not set (nothing was removed)')
        vercel = Vercel(os.environ['VERCEL_TOKEN'])
    now = datetime.now(timezone.utc)
    removable, preserved = plan(vercel, now)
    for entry in removable:
        print(f"REMOVE   {entry['id']}  {entry['kind']:<18} {entry['created'][:16]}  {entry['branch']} {entry['sha']}")
    for entry in preserved:
        print(f"PRESERVE {entry['id']}  {entry['target']:<10} {entry['state']:<8} {entry['branch']}: {'; '.join(entry['reasons'])}")
    print(f'Plan: {len(removable)} removable, {len(preserved)} preserved (project {PROJECT_ID})')
    outcomes = []
    if args.apply:
        if args.expect != len(removable):
            raise SystemExit(f'--expect {args.expect} does not match the {len(removable)} removable now; review the plan again')
        for entry in removable:
            problems = recheck(vercel, entry, datetime.now(timezone.utc))
            if problems:
                outcomes.append({'id': entry['id'], 'result': 'skipped', 'problems': problems})
            else:
                vercel.delete(entry['id'])
                outcomes.append({'id': entry['id'], 'result': 'deleted'})
            print(f"{outcomes[-1]['result'].upper():<8} {entry['id']} {'; '.join(outcomes[-1].get('problems', []))}")
        print(f"Removed {sum(o['result'] == 'deleted' for o in outcomes)}, skipped {sum(o['result'] == 'skipped' for o in outcomes)}")
    if args.report:
        with open(args.report, 'w') as handle:
            json.dump({'project': PROJECT_ID, 'at': now.isoformat(), 'removable': removable, 'preserved': preserved, 'outcomes': outcomes},
                      handle, indent=2)
    return 0


if __name__ == '__main__':
    sys.exit(main())
