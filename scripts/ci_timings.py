#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Refresh scripts/ci-browser-timings.json, the measured profile seconds the browser shard balancer reads (BUILD-FLOFI-CI-ARCHITECTURE-002).

Usage: python3 scripts/ci_timings.py update REPORT_OR_DIRECTORY... [--output scripts/ci-browser-timings.json]

Reads guarded-browser reports (`guarded-*.json` from CircleCI's playwright-results artifacts, or `flofi-ci-metrics/browser/*.json`),
keeps only PASS rows of revisions' completed profiles, and writes the median seconds per currently planned profile. A planned profile
with no new measurement keeps its previous value; a profile that no longer exists is dropped. Timings only place profiles in shards:
they never decide a result, and every planned profile still runs exactly once (scripts/ci-observe.py verify).
"""

import argparse
import json
from pathlib import Path
import statistics
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DEFAULT = ROOT / 'scripts/ci-browser-timings.json'


def planned_profiles():
    plan = json.loads(subprocess.run(['node', 'scripts/guarded-release-browser.mjs', 'list'], cwd=ROOT, check=True, capture_output=True,
                                     text=True).stdout)
    return [*plan['critical'], *plan['extended']]


def reports(paths):
    for path in map(Path, paths):
        files = sorted(path.rglob('*.json')) if path.is_dir() else [path]
        for file in files:
            try:
                report = json.loads(file.read_text())
            except (OSError, ValueError):
                continue
            if isinstance(report, dict) and report.get('kind') == 'guarded-browser' and isinstance(report.get('profiles'), list):
                yield report


def measurements(paths):
    seconds = {}
    for report in reports(paths):
        for row in report['profiles']:
            if row.get('status') == 'PASS' and isinstance(row.get('seconds'), (int, float)) and row['seconds'] > 0:
                seconds.setdefault(row['name'], []).append(float(row['seconds']))
    return seconds


def update(paths, output, planned=None):
    previous = json.loads(output.read_text()) if output.exists() else {}
    known = previous.get('profiles', {})
    measured = measurements(paths)
    planned = planned_profiles() if planned is None else planned
    profiles = {}
    for name in sorted(planned):
        if measured.get(name):
            profiles[name] = round(statistics.median(measured[name]), 1)
        elif name in known:
            profiles[name] = known[name]
    document = {'kind': 'flofi-browser-profile-timings', 'version': 1, 'unit': 'seconds',
                'note': previous.get('note', 'Median CircleCI guarded-browser seconds per profile; only shard placement reads them.'),
                'fixedShardSeconds': previous.get('fixedShardSeconds', {'composition': 30.0}), 'profiles': profiles}
    output.write_text(json.dumps(document, indent=2) + '\n')
    missing = [name for name in planned if name not in profiles]
    print(f'Wrote {output}: {len(profiles)} profiles measured or kept'
          + (f'; no measurement yet (balanced at the median): {", ".join(missing)}' if missing else ''))
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('operation', choices=['update'])
    parser.add_argument('reports', nargs='+')
    parser.add_argument('--output', type=Path, default=DEFAULT)
    arguments = parser.parse_args()
    sys.exit(update(arguments.reports, arguments.output))
