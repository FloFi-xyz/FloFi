#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Owner-run removal of obsolete FloFi Vercel deployments (BUILD-FLOFI-VERCEL-STORAGE-001).

A one-shot tool for the backlog that native Vercel retention has not removed yet; it is not scheduled automation. A plain run
only plans and writes the plan (`--report`). `--apply PLAN` deletes only deployments listed in that reviewed plan that are
still removable under a fresh evaluation of every rule, and fetches each one again immediately before deleting it.

Never removed: production or custom-environment deployments, rollback candidates, aliased deployments (custom domains and
branch URLs), anything created in the last 24 hours or still building, every deployment of a branch with an open pull request
or with no pull request history at all (its status is uncertain), the latest two deployments of an active branch (a commit or
a deployment in the last 24 hours), the newest READY deployment of every branch, and anything whose project, repository,
branch or GitHub state is not known. Removable: superseded READY previews and ERROR/CANCELED deployments that pass all of that.

Credentials come from the owner's environment and are never printed or sent anywhere but their API: VERCEL_TOKEN (a token
with access to the team), and GITHUB_TOKEN or an authenticated `gh` CLI for pull request and branch state. HTTP redirects are
refused, so a token never follows one. Without complete GitHub state nothing is removed.
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
KIND = {'READY': 'superseded preview', 'ERROR': 'errored', 'CANCELED': 'canceled'}


def state_of(deployment):
    return deployment.get('readyState') or deployment.get('state')


def created_at(deployment):
    return datetime.fromtimestamp((deployment.get('created') or deployment['createdAt']) / 1000, timezone.utc)


def classify(deployments, aliases, branches, now):
    """Pure decision: (removable, preserved). `deployments` are Vercel list entries; `aliases` maps id -> alias names;
    `branches` maps branch -> {'open_pr': bool, 'had_pr': bool, 'last_commit': datetime | None} (a missing branch is unknown)."""
    by_branch = {}
    for deployment in deployments:
        by_branch.setdefault((deployment.get('meta') or {}).get('githubCommitRef'), []).append(deployment)
    for items in by_branch.values():
        items.sort(key=created_at, reverse=True)
    removable, preserved = [], []
    for deployment in deployments:
        meta, reasons, state, created = deployment.get('meta') or {}, [], state_of(deployment), created_at(deployment)
        branch = meta.get('githubCommitRef')
        if deployment.get('projectId', PROJECT_ID) != PROJECT_ID:
            reasons.append('other project')
        if deployment.get('target') == 'production':
            reasons.append('production')
        elif deployment.get('target') not in (None, 'preview') or deployment.get('customEnvironment'):
            reasons.append('custom environment')
        if deployment.get('isRollbackCandidate'):
            reasons.append('rollback candidate')
        if deployment.get('softDeletedByRetention') or deployment.get('deleted'):
            reasons.append('already deleted')
        if aliases.get(deployment['uid']):
            reasons.append('aliased: ' + ', '.join(sorted(aliases[deployment['uid']])))
        if now - created < MIN_AGE:
            reasons.append('created in the last 24 hours')
        if state not in REMOVABLE_STATES:
            reasons.append(f'state {state}')
        if not branch or f"{meta.get('githubOrg')}/{meta.get('githubRepo')}" not in REPOSITORIES:
            reasons.append('unknown repository or branch')
        elif branch not in branches:
            reasons.append('branch state unknown')
        else:
            siblings, info = by_branch[branch], branches[branch]
            rank = next(i for i, d in enumerate(siblings) if d['uid'] == deployment['uid'])
            newest_ready = next((d['uid'] for d in siblings if state_of(d) == 'READY'), None)
            last_commit = info.get('last_commit')
            active = (info.get('open_pr') or not info.get('had_pr') or (last_commit is not None and now - last_commit < MIN_AGE)
                      or any(now - created_at(d) < MIN_AGE for d in siblings))
            if info.get('open_pr'):
                reasons.append('branch has an open pull request')
            elif not info.get('had_pr'):
                reasons.append('branch has no pull request history')
            if active and rank < 2:
                reasons.append('latest two of an active branch')
            if deployment['uid'] == newest_ready:
                reasons.append('newest READY deployment of its branch')
        entry = {'id': deployment['uid'], 'url': deployment.get('url'), 'created': created.isoformat(), 'state': state,
                 'target': deployment.get('target') or 'preview', 'branch': branch, 'sha': (meta.get('githubCommitSha') or '')[:7]}
        if reasons:
            preserved.append(entry | {'reasons': reasons})
        else:
            removable.append(entry | {'kind': KIND[state]})
    return removable, preserved


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """A redirect would forward the Authorization header to wherever it points: refuse it instead."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, 'redirect refused', headers, fp)


OPENER = urllib.request.build_opener(NoRedirect)


class Vercel:
    def __init__(self, token, opener=OPENER.open):
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
        found, until = {}, None
        while True:
            page = self.request('GET', '/v7/deployments', projectId=PROJECT_ID, limit=100, **({'until': until} if until else {}))
            for deployment in page.get('deployments', []):
                found.setdefault(deployment['uid'], deployment)  # pages may overlap at a boundary; count each once
            until = (page.get('pagination') or {}).get('next')
            if not until:
                return list(found.values())

    def aliases(self, deployment_id):
        response = self.request('GET', f'/v2/deployments/{deployment_id}/aliases')
        if not isinstance(response.get('aliases'), list):
            raise SystemExit(f'Vercel aliases of {deployment_id}: unexpected response (nothing more is removed)')
        return [alias.get('alias') for alias in response['aliases']]

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
            with OPENER.open(request, timeout=60) as response:
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


def branch_state(branch):
    """Open PR, any PR history and last commit of one branch. A branch missing under both path spellings was deleted."""
    owner = GITHUB_REPOSITORY.split('/')[0]
    pulls = github(f'/repos/{GITHUB_REPOSITORY}/pulls?state=all&per_page=100&head='
                   + urllib.parse.quote(f'{owner}:{branch}', safe=''))
    if pulls is None or len(pulls) >= 100:
        raise SystemExit(f'Pull requests of {branch} could not be listed completely (nothing was removed)')
    data = None
    for spelling in (urllib.parse.quote(branch, safe='/'), urllib.parse.quote(branch, safe='')):
        data = github(f'/repos/{GITHUB_REPOSITORY}/branches/{spelling}')
        if data is not None:
            break
    last = None if data is None else datetime.fromisoformat(data['commit']['commit']['committer']['date'].replace('Z', '+00:00'))
    return {'open_pr': any(pr.get('state') == 'open' for pr in pulls), 'had_pr': bool(pulls), 'last_commit': last}


def github_state(branches):
    pulls = github(f'/repos/{GITHUB_REPOSITORY}/pulls?state=open&per_page=100')
    if pulls is None or len(pulls) >= 100:
        raise SystemExit('Open pull requests could not be listed completely (nothing was removed)')
    open_heads = {pr['head']['ref'] for pr in pulls}  # also catches heads from forks
    state = {branch: branch_state(branch) for branch in sorted(b for b in branches if b)}
    for branch, info in state.items():
        info['open_pr'] = info['open_pr'] or branch in open_heads
    return state


def plan(vercel, now=None):
    now = now or datetime.now(timezone.utc)
    deployments = vercel.deployments()
    aliases = {d['uid']: vercel.aliases(d['uid']) for d in deployments}
    branches = github_state({(d.get('meta') or {}).get('githubCommitRef') for d in deployments})
    return classify(deployments, aliases, branches, now)


def recheck(vercel, entry, now):
    """Immediately before deleting: the live deployment must still be this project's unaliased, settled, non-production,
    non-rollback preview, and its branch must still have no open pull request."""
    live = vercel.deployment(entry['id'])
    problems = []
    if live.get('projectId') != PROJECT_ID:
        problems.append('project changed')
    if live.get('target') not in (None, 'preview') or live.get('customEnvironment'):
        problems.append('no longer a preview')
    if live.get('isRollbackCandidate'):
        problems.append('rollback candidate')
    if live.get('deleted') or live.get('softDeletedByRetention'):
        problems.append('already deleted')
    if state_of(live) != entry['state']:
        problems.append('state changed')
    if now - created_at(live) < MIN_AGE:
        problems.append('too recent')
    if vercel.aliases(entry['id']):
        problems.append('now aliased')
    if entry.get('branch') and branch_state(entry['branch'])['open_pr']:
        problems.append('branch now has an open pull request')
    return problems


def write(path, document):
    if path:
        with open(path, 'w') as handle:
            json.dump(document, handle, indent=2)


def main(argv=None, vercel=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--report', help='write the plan (and outcomes) as JSON to this path')
    parser.add_argument('--apply', metavar='PLAN', help='delete the removable deployments of this reviewed plan file that are still removable')
    args = parser.parse_args(argv)
    reviewed = None
    if args.apply:
        with open(args.apply) as handle:
            document = json.load(handle)
        if document.get('project') != PROJECT_ID or not isinstance(document.get('removable'), list):
            raise SystemExit(f'{args.apply} is not a plan of project {PROJECT_ID}')
        reviewed = {entry['id'] for entry in document['removable']}
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
    report = {'project': PROJECT_ID, 'at': now.isoformat(), 'removable': removable, 'preserved': preserved, 'outcomes': []}
    write(args.report, report)
    if reviewed is None:
        return 0
    still = {entry['id'] for entry in removable}
    outcomes = report['outcomes']
    try:
        for deployment_id in sorted(reviewed - still):
            outcomes.append({'id': deployment_id, 'result': 'skipped', 'problems': ['no longer removable']})
        for entry in (e for e in removable if e['id'] in reviewed):
            problems = recheck(vercel, entry, datetime.now(timezone.utc))
            if not problems:
                vercel.delete(entry['id'])
            outcomes.append({'id': entry['id'], 'result': 'skipped' if problems else 'deleted', **({'problems': problems} if problems else {})})
            print(f"{outcomes[-1]['result'].upper():<8} {entry['id']} {'; '.join(problems)}")
            write(args.report, report)
    finally:
        write(args.report, report)
    unreviewed = len(still - reviewed)
    print(f"Removed {sum(o['result'] == 'deleted' for o in outcomes)}, skipped {sum(o['result'] == 'skipped' for o in outcomes)}"
          + (f'; {unreviewed} newly removable deployment(s) were not in the reviewed plan and were left alone' if unreviewed else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
